import { preflight, withCors } from "@/lib/cors";
import { getServiceSupabase } from "@/lib/supabase";

import { NextResponse } from "next/server";

/**
 * Public roofer lookup by slug — powers the hosted Quote Link page
 * (quoter-widget-frontend `/l/[roofer]`), which needs the roofer's display
 * name to brand the page. The `roofers` table is RLS-locked, so this trusted
 * server route reads it with the service role and returns ONLY public fields
 * (slug + name). Nothing sensitive is exposed.
 */
async function handleGet(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug")?.trim();
  if (!slug) {
    return NextResponse.json({ error: "A roofer slug is required." }, { status: 400 });
  }

  const supabase = getServiceSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Roofer lookup is temporarily unavailable." },
      { status: 503 },
    );
  }

  const { data, error } = await supabase
    .from("roofers")
    .select("slug,name")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    console.error("Roofer lookup failed", error);
    return NextResponse.json(
      { error: "Roofer lookup is temporarily unavailable." },
      { status: 502 },
    );
  }

  if (!data) {
    return NextResponse.json({ error: "Roofer not found." }, { status: 404 });
  }

  return NextResponse.json({ roofer: { slug: data.slug, name: data.name } });
}

export const GET = withCors(handleGet);
export const OPTIONS = preflight;
