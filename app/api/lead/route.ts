import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { preflight, withCors } from "@/lib/cors";
import { sendLeadEmail } from "@/lib/lead-email";
import { LeadPersistError, persistLead } from "@/lib/leads";
import { loggedFetch, redact } from "@/lib/logged-fetch";
import { limitOr429 } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase";
import {
  UUID_RE,
  isLeadPayload,
  parseLeadBody,
  readJsonBody,
} from "@/lib/validate";

import type { LeadRow } from "@/lib/leads";
import type { LeadPayload } from "@/lib/types";

export { isLeadPayload };

// Submitted faster than this (ms) is almost certainly a bot. Kept deliberately
// low so it never catches a real person — even an autofill user takes ~1s of
// clicking. The honeypot is the primary signal; this is just a backstop
// against scripted instant submits (which fire in tens of ms).
const MIN_HUMAN_FILL_MS = 800;

export const maxDuration = 15;

type WebhookConfig =
  | { ok: true; url: string; secret: string | null }
  | { ok: false; reason: string }
  | { ok: true; url: null };

let webhookConfigCache: WebhookConfig | undefined;
let warnedMissingSupabase = false;
let warnedMissingWebhook = false;

function getWebhookConfig(): WebhookConfig {
  if (webhookConfigCache !== undefined) return webhookConfigCache;

  const raw = process.env.LEAD_WEBHOOK_URL?.trim();
  if (!raw) {
    if (!warnedMissingWebhook) {
      console.warn("LEAD_WEBHOOK_URL is not configured; lead accepted locally.");
      warnedMissingWebhook = true;
    }
    webhookConfigCache = { ok: true, url: null };
    return webhookConfigCache;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.error("LEAD_WEBHOOK_URL is not a valid URL.");
    webhookConfigCache = { ok: false, reason: "invalid_url" };
    return webhookConfigCache;
  }
  if (parsed.protocol !== "https:") {
    console.error("LEAD_WEBHOOK_URL must use https.");
    webhookConfigCache = { ok: false, reason: "not_https" };
    return webhookConfigCache;
  }
  const allowlist = process.env.LEAD_WEBHOOK_ALLOWED_HOSTS?.trim();
  const hosts = allowlist
    ? new Set(
        allowlist
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
      )
    : null;
  if (hosts && !hosts.has(parsed.host.toLowerCase())) {
    console.error("LEAD_WEBHOOK_URL host is not in LEAD_WEBHOOK_ALLOWED_HOSTS.");
    webhookConfigCache = { ok: false, reason: "host_not_allowed" };
    return webhookConfigCache;
  }
  const secret = process.env.LEAD_WEBHOOK_SECRET?.trim() || null;
  webhookConfigCache = { ok: true, url: raw, secret };
  return webhookConfigCache;
}

/** Test helper — clears memoised webhook config between cases. */
export function resetWebhookConfigCache(): void {
  webhookConfigCache = undefined;
  warnedMissingWebhook = false;
}

function ensureSupabaseWarned(): void {
  if (warnedMissingSupabase) return;
  if (
    !process.env.SUPABASE_URL?.trim() ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  ) {
    console.warn(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured; leads will not be persisted.",
    );
    warnedMissingSupabase = true;
  }
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Exported for tests that assert signature shape.
export function verifyWebhookSignature(
  body: string,
  secret: string,
  signature: string,
): boolean {
  const expected = signBody(body, secret);
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

async function handlePost(request: Request) {
  ensureSupabaseWarned();

  const limited = await limitOr429(request, "lead-ip");
  if (limited) return limited;

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: 400 });
  }

  if (!parsedBody.value || typeof parsedBody.value !== "object") {
    return NextResponse.json(
      { error: "Please complete your name and phone number." },
      { status: 400 },
    );
  }

  const body = parsedBody.value as Record<string, unknown>;

  // Spam gate. Require _elapsedMs to be present and finite ≥ MIN_HUMAN_FILL_MS;
  // omitting it used to default to Infinity (pass). Filled honeypot or too-fast
  // submit → fake 202 so bots don't adapt.
  const honeypot = typeof body._hp === "string" ? body._hp.trim() : "";
  const elapsedPresent =
    typeof body._elapsedMs === "number" && Number.isFinite(body._elapsedMs);
  const elapsedMs = elapsedPresent ? (body._elapsedMs as number) : null;
  if (honeypot !== "" || elapsedMs === null || elapsedMs < MIN_HUMAN_FILL_MS) {
    return NextResponse.json(
      { ok: true, leadId: randomUUID() },
      { status: 202 },
    );
  }

  // Stable per-submission id from the widget — used as the lead's primary
  // key so retries / resend-on-mount collapse into one row (idempotency).
  let submissionId: string | null = null;
  if (
    typeof body._submissionId === "string" &&
    UUID_RE.test(body._submissionId)
  ) {
    submissionId = body._submissionId;
  }

  // Rate-limit distinct submission ids so legitimate retries of the same id
  // share one slot rather than burning the IP budget.
  const submissionKey = submissionId ?? randomUUID();
  const submissionLimited = await limitOr429(
    request,
    "lead-submission",
    submissionKey,
  );
  if (submissionLimited) return submissionLimited;

  delete body._hp;
  delete body._elapsedMs;
  delete body._submissionId;

  const validated = parseLeadBody(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const payload: LeadPayload = validated.value;

  const slugLimited = await limitOr429(request, "lead-slug", payload.rooferId);
  if (slugLimited) return slugLimited;

  const leadId = submissionId ?? randomUUID();
  const receivedAt = new Date().toISOString();
  const webhookBody = {
    ...payload,
    leadId,
    receivedAt,
  };

  let persisted = false;
  let insertedNew = false;
  let leadRow: LeadRow | null = null;

  const supabase = getServiceSupabase();
  if (supabase) {
    try {
      const result = await persistLead(supabase, payload, leadId, receivedAt);
      persisted = true;
      insertedNew = result.inserted;
      leadRow = result.row;
    } catch (error) {
      if (error instanceof LeadPersistError) {
        if (error.code === "unknown_roofer") {
          // Same 202 shape as success — do not leak slug existence.
          console.warn("unknown_roofer_slug", payload.rooferId);
          return NextResponse.json(
            { ok: true, leadId },
            { status: 202 },
          );
        }
        console.error("Lead Supabase persist failed", {
          leadId,
          ...redact(error),
        });
        return NextResponse.json({ error: error.message }, { status: 502 });
      }
      console.error("Lead Supabase persist failed", {
        leadId,
        ...redact(error),
      });
      return NextResponse.json(
        {
          error:
            "We could not save your request just now. Please try once more.",
        },
        { status: 502 },
      );
    }
  }

  const shouldDeliver = insertedNew || !supabase;
  const webhookConfig = getWebhookConfig();
  if (
    webhookConfig.ok &&
    webhookConfig.url &&
    shouldDeliver
  ) {
    try {
      const bodyText = JSON.stringify(webhookBody);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (webhookConfig.secret) {
        headers["x-quoter-signature"] = signBody(
          bodyText,
          webhookConfig.secret,
        );
      }
      const response = await loggedFetch("lead-webhook", webhookConfig.url, {
        method: "POST",
        headers,
        body: bodyText,
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        throw new Error(`Lead webhook returned ${response.status}.`);
      }
    } catch (error) {
      console.error("Lead webhook delivery failed", redact(error));

      if (!persisted) {
        return NextResponse.json(
          {
            error:
              "We could not send your request just now. Please try once more.",
          },
          { status: 502 },
        );
      }
    }
  }

  // Email the roofer about genuinely-new leads. Best-effort: the lead is
  // already saved, so a mail failure must never fail the request. Needs the
  // service-role client (to read the roofer's linked login emails), so it only
  // runs when we persisted here.
  if (supabase && insertedNew && leadRow) {
    try {
      await sendLeadEmail(supabase, leadRow);
    } catch (error) {
      console.error("Lead email delivery failed", redact(error));
    }
  }

  return NextResponse.json({ ok: true, leadId }, { status: 202 });
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
