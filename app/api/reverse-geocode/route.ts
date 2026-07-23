import { preflight, withCors } from "@/lib/cors";
import { loggedFetch } from "@/lib/logged-fetch";

import { NextResponse } from "next/server";

import type { LatLng } from "@/lib/types";

/**
 * Coordinates -> street address. Fired exactly once per completed quote, at
 * the moment the homeowner confirms the pin on their roof (LocateStep's
 * "Continue") — the same click that already fires one billed Solar API call,
 * so this adds no new cost gate. The result is a display upgrade only: if it
 * fails, the caller keeps the postcode+district label it already has from
 * the earlier postcodes.io lookup, never blocking the roof scan itself.
 */

const NOT_FOUND = {
  error: "No address found for that location.",
  code: "REVERSE_GEOCODE_NOT_FOUND",
} as const;

const UNAVAILABLE = {
  error: "Address lookup is temporarily unavailable.",
  code: "REVERSE_GEOCODE_UNAVAILABLE",
} as const;

async function handlePost(request: Request) {
  let coords: LatLng;
  try {
    const body = (await request.json()) as { coords?: LatLng };
    // Number.isFinite, not typeof: NaN and Infinity are both "number" and
    // would otherwise be forwarded to Google as a billed request.
    if (
      !Number.isFinite(body.coords?.lat) ||
      !Number.isFinite(body.coords?.lng) ||
      Math.abs(body.coords!.lat) > 90 ||
      Math.abs(body.coords!.lng) > 180
    ) {
      throw new Error("Invalid coordinates");
    }
    coords = body.coords!;
  } catch {
    return NextResponse.json(
      { error: "Valid coordinates are required." },
      { status: 400 },
    );
  }

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
      { cache: "no-store", signal: AbortSignal.timeout(12_000) },
    );

    if (!response.ok) {
      throw new Error(`Reverse geocode returned ${response.status}.`);
    }

    const data = (await response.json()) as {
      status: string;
      results?: Array<{ formatted_address: string; place_id: string }>;
    };

    const result = data.results?.[0];
    if (data.status === "ZERO_RESULTS" || !result) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }
    if (data.status !== "OK") {
      throw new Error(`Reverse geocode status ${data.status}.`);
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
