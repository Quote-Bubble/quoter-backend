import { preflight, withCors } from "@/lib/cors";

import { NextResponse } from "next/server";

/**
 * Address -> coordinates.
 *
 * Primary source is postcodes.io: free, no API key, and it reads the same ONS
 * postcode data Google does — spot checks across five UK postcodes put the two
 * within 1-2 m of each other. Google's Geocoding API is kept as a fallback for
 * when postcodes.io is unavailable (it is a community service with no SLA), so
 * we only pay on the rare failure.
 *
 * The result is a postcode centroid rather than a house-level pin. That is fine
 * here: LocateStep asks the homeowner to drag the pin onto their own roof, and
 * the dragged coordinate — not this one — is what gets measured.
 */

type GeocodeRequest = {
  address?: string;
  postcode?: string;
};

type GeocodeSuccess = {
  coords: { lat: number; lng: number };
  formattedAddress: string;
  placeId?: string;
  source: "postcodes.io" | "google";
};

const NOT_FOUND = {
  error: "We could not find that property.",
  code: "ADDRESS_NOT_FOUND",
} as const;

const UNAVAILABLE = {
  error: "Address lookup is temporarily unavailable.",
  code: "GEOCODING_UNAVAILABLE",
} as const;

/** "sw194eh" / "SW19 4EH" -> "SW194EH" for the URL path. */
function normalisePostcode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Rough UK postcode shape. Rejects junk before it leaves the building. */
function looksLikeUkPostcode(compact: string): boolean {
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact);
}

/** "SW194EH" -> "SW19 4EH" for display. */
function prettyPostcode(compact: string): string {
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

type PostcodesIoResult = {
  latitude: number;
  longitude: number;
  admin_district?: string | null;
  admin_ward?: string | null;
};

async function lookupPostcodesIo(
  compact: string,
  address: string,
): Promise<GeocodeSuccess | "not_found" | null> {
  const response = await fetch(
    `https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`,
    { cache: "no-store", signal: AbortSignal.timeout(6_000) },
  );

  if (response.status === 404) return "not_found";
  if (!response.ok) return null;

  const body = (await response.json()) as {
    status: number;
    result?: PostcodesIoResult | null;
  };
  const result = body.result;
  if (!result) return "not_found";
  if (!Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) {
    return null;
  }

  // postcodes.io has no street name, so compose something a roofer can read:
  // what the homeowner typed, the district, and the tidied postcode.
  const parts = [address, result.admin_district ?? undefined, prettyPostcode(compact)];
  return {
    coords: { lat: result.latitude, lng: result.longitude },
    formattedAddress: parts.filter(Boolean).join(", "),
    source: "postcodes.io",
  };
}

async function lookupGoogle(
  address: string,
  postcode: string,
): Promise<GeocodeSuccess | "not_found" | null> {
  const apiKey =
    process.env.GOOGLE_MAPS_SERVER_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    address: postcode ? `${address}, ${postcode}, UK` : `${address}, UK`,
    region: "uk",
    components: "country:GB",
    key: apiKey,
  });

  const response = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?${params}`,
    { cache: "no-store", signal: AbortSignal.timeout(12_000) },
  );
  if (!response.ok) return null;

  const data = (await response.json()) as {
    status: string;
    results?: Array<{
      formatted_address: string;
      place_id: string;
      geometry: { location: { lat: number; lng: number } };
    }>;
  };

  const result = data.results?.[0];
  if (data.status === "ZERO_RESULTS" || !result) return "not_found";
  if (data.status !== "OK") return null;

  return {
    coords: result.geometry.location,
    formattedAddress: result.formatted_address,
    placeId: result.place_id,
    source: "google",
  };
}

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

  // Cap the inputs. No UK address needs this much room, and an oversized body
  // is free amplification against whatever we forward it to.
  const address = body.address?.trim().slice(0, 200);
  const postcode = body.postcode?.trim().slice(0, 20) ?? "";
  if (!address) {
    return NextResponse.json(
      { error: "Please enter your address." },
      { status: 400 },
    );
  }

  const compact = normalisePostcode(postcode);
  const usable = looksLikeUkPostcode(compact);

  let found: GeocodeSuccess | "not_found" | null = null;

  if (usable) {
    try {
      found = await lookupPostcodesIo(compact, address);
    } catch (error) {
      console.warn("postcodes.io lookup failed, falling back to Google", error);
      found = null;
    }
  }

  // null means "couldn't reach it / bad shape" — worth paying Google for.
  // "not_found" means the postcode genuinely isn't real; Google won't help.
  if (found === null) {
    try {
      found = await lookupGoogle(address, postcode);
    } catch (error) {
      console.error("Geocoding request failed", error);
      return NextResponse.json(UNAVAILABLE, { status: 502 });
    }
  }

  if (found === "not_found") {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }
  if (!found) {
    return NextResponse.json(UNAVAILABLE, { status: 502 });
  }

  return NextResponse.json({
    coords: found.coords,
    formattedAddress: found.formattedAddress,
    placeId: found.placeId,
    debug:
      process.env.NODE_ENV === "development"
        ? { source: found.source, postcode: compact, address }
        : undefined,
  });
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
