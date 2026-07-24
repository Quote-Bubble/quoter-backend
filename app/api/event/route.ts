import { NextResponse } from "next/server";

import { preflight, withCors } from "@/lib/cors";
import { limitOr429 } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase";
import { parseEventBody, readJsonBody } from "@/lib/validate";

/**
 * Funnel analytics sink for the embedded widget. Always returns 204 — analytics
 * failing must be invisible to the homeowner.
 *
 * Table definition lives in quoter-dashboard-frontend migration
 * 0006_analytics_events.sql (RLS enabled, no anon/authenticated policies).
 */

async function handlePost(request: Request) {
  const limited = await limitOr429(request, "event");
  if (limited) {
    // Still 204 — don't teach clients about rate limits on analytics.
    return new NextResponse(null, { status: 204 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return new NextResponse(null, { status: 204 });
  }

  const eventParsed = parseEventBody(parsed.value);
  if (!eventParsed.ok) {
    return new NextResponse(null, { status: 204 });
  }

  const { event, rooferId, sessionId, sourceUrl, props, clientTs } =
    eventParsed.value;

  const propsWithTs =
    clientTs !== null ? { ...props, clientTs } : props;

  const row = {
    event,
    roofer_slug: rooferId,
    session_id: sessionId,
    source_url: sourceUrl,
    request_origin: request.headers.get("origin"),
    props: propsWithTs,
    // created_at left to DB default (now()) — never trust client ts.
  };

  const supabase = getServiceSupabase();
  if (supabase) {
    const { error } = await supabase.from("analytics_events").insert(row);
    if (error) {
      console.error("analytics insert failed", {
        code: error.code,
        event: row.event,
      });
    }
  } else {
    console.info("[event]", row.event, row.roofer_slug);
  }

  return new NextResponse(null, { status: 204 });
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
