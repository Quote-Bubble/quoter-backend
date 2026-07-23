import { preflight, withCors } from "@/lib/cors";
import { LeadPersistError, persistLead } from "@/lib/leads";
import { loggedFetch } from "@/lib/logged-fetch";
import { getServiceSupabase } from "@/lib/supabase";

import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import type { LeadPayload } from "@/lib/types";

const VALID_JOB_TYPES = new Set([
  "full_replacement",
  "tile_or_slate_repair",
  "flat_roof_replacement",
  "leak_investigation",
  "gutters_fascias_soffits",
  "other",
]);

export function isLeadPayload(value: unknown): value is LeadPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<LeadPayload>;
  return Boolean(
    payload.rooferId &&
      payload.jobType &&
      VALID_JOB_TYPES.has(payload.jobType) &&
      payload.contact?.name?.trim() &&
      payload.contact.phone?.trim() &&
      payload.timestamp,
  );
}

// Submitted faster than this (ms) is almost certainly a bot. Kept deliberately
// low so it never catches a real person — even an autofill user takes ~1s of
// clicking. The honeypot is the primary signal; this is just a backstop
// against scripted instant submits (which fire in tens of ms).
const MIN_HUMAN_FILL_MS = 800;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handlePost(request: Request) {
  let payload: LeadPayload;
  let submissionId: string | null = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;

    // Spam gate. The widget sends a honeypot field (`_hp`, hidden from humans)
    // and how long the form was on screen (`_elapsedMs`). A filled honeypot or
    // an implausibly fast submit means a bot — pretend success so it doesn't
    // adapt or retry, but drop the junk instead of forwarding it to the roofer.
    const honeypot = typeof body._hp === "string" ? body._hp.trim() : "";
    const elapsedMs =
      typeof body._elapsedMs === "number" ? body._elapsedMs : Infinity;
    if (honeypot !== "" || elapsedMs < MIN_HUMAN_FILL_MS) {
      return NextResponse.json(
        { ok: true, leadId: randomUUID() },
        { status: 202 },
      );
    }

    // Stable per-submission id from the widget — used as the lead's primary
    // key so retries / resend-on-mount collapse into one row (idempotency).
    // Only trust a well-formed UUID; anything else falls back to a fresh id.
    if (typeof body._submissionId === "string" && UUID_RE.test(body._submissionId)) {
      submissionId = body._submissionId;
    }

    // Strip the control fields so they never reach storage / the webhook.
    delete body._hp;
    delete body._elapsedMs;
    delete body._submissionId;

    if (!isLeadPayload(body)) throw new Error("Invalid lead payload");
    payload = body;
  } catch {
    return NextResponse.json(
      { error: "Please complete your name and phone number." },
      { status: 400 },
    );
  }

  const leadId = submissionId ?? randomUUID();
  const receivedAt = new Date().toISOString();
  const webhookBody = {
    ...payload,
    leadId,
    receivedAt,
  };

  let persisted = false;
  // True only when this call actually created the row. A duplicate resend
  // (same _submissionId) persists nothing new and must not re-fire the webhook.
  let insertedNew = false;

  const supabase = getServiceSupabase();
  if (supabase) {
    try {
      const result = await persistLead(supabase, payload, leadId, receivedAt);
      persisted = true;
      insertedNew = result.inserted;
    } catch (error) {
      if (error instanceof LeadPersistError) {
        if (error.code === "unknown_roofer") {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error("Lead Supabase persist failed", error);
        return NextResponse.json({ error: error.message }, { status: 502 });
      }
      console.error("Lead Supabase persist failed", error);
      return NextResponse.json(
        {
          error:
            "We could not save your request just now. Please try once more.",
        },
        { status: 502 },
      );
    }
  } else {
    console.warn(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured; lead not persisted.",
    );
  }

  // Fire the webhook only for a genuinely new lead. On a duplicate resend the
  // lead was already delivered on the first attempt, so re-firing would double-
  // notify the roofer. When Supabase isn't configured we can't tell, so fall
  // back to always delivering (best effort).
  const shouldDeliver = insertedNew || !supabase;
  const webhookUrl = process.env.LEAD_WEBHOOK_URL;
  if (webhookUrl && shouldDeliver) {
    try {
      const response = await loggedFetch("lead-webhook", webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookBody),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });

      if (!response.ok) {
        throw new Error(`Lead webhook returned ${response.status}.`);
      }
    } catch (error) {
      console.error("Lead webhook delivery failed", error);

      // The lead is already safe in Supabase and will show in the dashboard.
      // Reporting the webhook failure to the widget would make it retry, and
      // each retry inserts the row again — a webhook outage would multiply
      // every lead in the roofer's inbox. Delivery is a side effect of
      // accepting the lead, not part of accepting it.
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
  } else if (!webhookUrl) {
    console.warn("LEAD_WEBHOOK_URL is not configured; lead accepted locally.");
  }

  return NextResponse.json({ ok: true, leadId }, { status: 202 });
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
