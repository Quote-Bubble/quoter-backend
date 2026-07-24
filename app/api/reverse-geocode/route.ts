import { preflight, withCors } from "@/lib/cors";
import { loggedFetch } from "@/lib/logged-fetch";
import { limitOr429 } from "@/lib/rate-limit";
import { parseCoords, readJsonBody } from "@/lib/validate";

import { NextResponse } from "next/server";

/**
 * Coordinates -> street address. Fired exactly once per completed quote, at
 * the moment the homeowner confirms the pin on their roof.
 */

const NOT_FOUND = {
  error: "No address found for that location.",
  code: "REVERSE_GEOCODE_NOT_FOUND",
} as const;

const UNAVAILABLE = {
  error: "Address lookup is temporarily unavailable.",
  code: "REVERSE_GEOCODE_UNAVAILABLE",
} as const;

const ROOF_NOT_FOUND = {
  error: "Satellite roof data is not available for this address.",
  code: "ROOF_NOT_FOUND",
} as const;

async function handlePost(request: Request) {
  const limited = await limitOr429(request, "reverse-geocode");
  if (limited) return limited;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json({ error: bodyResult.error }, { status: 400 });
  }

  const coordsResult = parseCoords(bodyResult.value);
  if (!coordsResult.ok) {
    // Outside UK bbox — reject without calling Google.
    return NextResponse.json(ROOF_NOT_FOUND, { status: 404 });
  }
  const coords = coordsResult.value;

  const apiKey =
    process.env.GOOGLE_MAPS_SERVER_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(UNAVAILABLE, { status: 503 });
  }

  const params = new URLSearchParams({
    latlng: `${coords.lat},${coords.lng}`,
    region: "uk",
    key: apiKey,
  });

  try {
    const response = await loggedFetch(
      "google-reverse-geocode",
      `https://maps.googleapis.com/maps/api/geocode/json?${params}`,
      { cache: "no-store", signal: AbortSignal.timeout(9_000) },
    );

    if (!response.ok) {
      throw new Error(`Reverse geocode returned ${response.status}.`);
    }

    const data = (await response.json()) as {
      status: string;
      results?: Array<{ formatted_address: string; place_id: string }>;
    };

    if (data.status === "ZERO_RESULTS") {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }
    if (data.status !== "OK") {
      throw new Error(`Reverse geocode status ${data.status}.`);
    }
    const result = data.results?.[0];
    if (!result || !result.formatted_address || !result.place_id) {
      throw new Error("Reverse geocode response did not contain an address.");
    }

    return NextResponse.json({
      formattedAddress: result.formatted_address,
      placeId: result.place_id,
    });
  } catch (error) {
    console.error("Reverse geocode failed", error);
    return NextResponse.json(UNAVAILABLE, { status: 502 });
  }
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
