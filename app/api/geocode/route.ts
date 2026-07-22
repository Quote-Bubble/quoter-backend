import { preflight, withCors } from "@/lib/cors";

import { NextResponse } from "next/server";

type GeocodeRequest = {
  address?: string;
  postcode?: string;
};

async function handlePost(request: Request) {
  let body: GeocodeRequest;
  try {
    body = (await request.json()) as GeocodeRequest;
  } catch {
    return NextResponse.json(
      { error: "Please enter a valid address." },
      { status: 400 },
    );
  }

  // Cap the inputs before they reach a billed API. No UK address needs this
  // much room, and without a cap an oversized body is free amplification.
  const address = body.address?.trim().slice(0, 200);
  const postcode = body.postcode?.trim().slice(0, 20) ?? "";
  if (!address) {
    return NextResponse.json(
      { error: "Please enter your address." },
      { status: 400 },
    );
  }

  const apiKey =
    process.env.GOOGLE_MAPS_SERVER_API_KEY ??
    process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Address lookup is temporarily unavailable.",
        code: "GEOCODING_UNAVAILABLE",
      },
      { status: 503 },
    );
  }

  const query = postcode ? `${address}, ${postcode}, UK` : `${address}, UK`;
  const params = new URLSearchParams({
    address: query,
    region: "uk",
    components: "country:GB",
    key: apiKey,
  });

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Geocoding returned ${response.status}.`);
    }

    const data = (await response.json()) as {
      status: string;
      results?: Array<{
        formatted_address: string;
        place_id: string;
        geometry: {
          location: { lat: number; lng: number };
        };
      }>;
    };

    const result = data.results?.[0];
    if (data.status === "ZERO_RESULTS" || !result) {
      return NextResponse.json(
        {
          error: "We could not find that property.",
          code: "ADDRESS_NOT_FOUND",
        },
        { status: 404 },
      );
    }

    if (data.status !== "OK") {
      throw new Error(`Geocoding status was ${data.status}.`);
    }

    return NextResponse.json({
      coords: result.geometry.location,
      formattedAddress: result.formatted_address,
      placeId: result.place_id,
      debug:
        process.env.NODE_ENV === "development"
          ? {
              request: {
                address: `${address}, ${postcode}, UK`,
                region: "uk",
                country: "GB",
              },
              rawResponse: data,
            }
          : undefined,
    });
  } catch (error) {
    console.error("Geocoding request failed", error);
    return NextResponse.json(
      {
        error: "Address lookup is temporarily unavailable.",
        code: "GEOCODING_UNAVAILABLE",
      },
      { status: 502 },
    );
  }
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
