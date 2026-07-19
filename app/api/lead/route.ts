import { preflight, withCors } from "@/lib/cors";

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

function isLeadPayload(value: unknown): value is LeadPayload {
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

async function handlePost(request: Request) {
  let payload: LeadPayload;
  try {
    const body: unknown = await request.json();
    if (!isLeadPayload(body)) throw new Error("Invalid lead payload");
    payload = body;
  } catch {
    return NextResponse.json(
      { error: "Please complete your name and phone number." },
      { status: 400 },
    );
  }

  const leadId = randomUUID();
  const webhookBody = {
    ...payload,
    leadId,
    receivedAt: new Date().toISOString(),
  };

  const webhookUrl = process.env.LEAD_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
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
      return NextResponse.json(
        {
          error:
            "We could not send your request just now. Please try once more.",
        },
        { status: 502 },
      );
    }
  } else {
    console.warn("LEAD_WEBHOOK_URL is not configured; lead accepted locally.");
  }

  return NextResponse.json({ ok: true, leadId }, { status: 202 });
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
