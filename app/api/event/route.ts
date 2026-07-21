import { preflight, withCors } from "@/lib/cors";
import { getServiceSupabase } from "@/lib/supabase";

import { NextResponse } from "next/server";

/**
 * Funnel analytics sink for the embedded widget. The widget fires small,
 * fire-and-forget events (widget_opened, step_viewed, quote_shown,
 * lead_submitted, ...) so we can see where homeowners drop off across all the
 * roofer sites the widget is embedded on.
 *
 * This endpoint is deliberately forgiving: it always returns 204 and never
 * errors the client, because analytics failing must be invisible. Events are
 * written to Supabase when configured; otherwise they're logged.
 *
 * Requires an `analytics_events` table (nullable roofer_slug — NOT a FK — so
 * unknown/misconfigured embeds still record):
 *
 *   create table if not exists analytics_events (
 *     id uuid primary key default gen_random_uuid(),
 *     event text not null,
 *     roofer_slug text,
 *     session_id text,
 *     source_url text,
 *     props jsonb not null default '{}'::jsonb,
 *     created_at timestamptz not null default now()
 *   );
 */

const KNOWN_EVENTS = new Set([
  "widget_opened",
  "widget_closed",
  "step_viewed",
  "quote_shown",
  "lead_submitted",
  "lead_failed",
]);

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

async function handlePost(request: Request) {
  // sendBeacon uses text/plain to skip preflight; request.json() parses the
  // body regardless of content-type, so both beacon and fetch paths work.
  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const event = str(body?.event, 64);
  // Ignore anything that isn't a recognised event name (keeps junk out).
  if (!event || !KNOWN_EVENTS.has(event)) {
    return new NextResponse(null, { status: 204 });
  }

  const row = {
    event,
    roofer_slug: str(body?.rooferId, 128),
    session_id: str(body?.sessionId, 128),
    source_url: str(body?.url, 512),
    props:
      body?.props && typeof body.props === "object" ? body.props : {},
    created_at: str(body?.ts, 40) ?? new Date().toISOString(),
  };

  const supabase = getServiceSupabase();
  if (supabase) {
    try {
      await supabase.from("analytics_events").insert(row);
    } catch (error) {
      console.error("analytics insert failed", error);
    }
  } else {
    console.info("[event]", row.event, row.roofer_slug, row.props);
  }

  return new NextResponse(null, { status: 204 });
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
