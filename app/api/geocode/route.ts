import { preflight, withCors } from "@/lib/cors";
import { loggedFetch } from "@/lib/logged-fetch";

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
  return (
    compact === "GIR0AA" ||
    /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)
  );
}

/** "SW194EH" -> "SW19 4EH" for display. */
function prettyPostcode(compact: string): string {
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/** "2 whitehouse lane" -> "2 Whitehouse Lane" — the street line is free text
 *  the homeowner typed with no case enforced, so tidy it up for display. */
function titleCase(value: string): string {
  return value.replace(
    /\p{L}[\p{L}'’]*/gu,
    (word) => word[0].toUpperCase() + word.slice(1).toLowerCase(),
  );
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
  const response = await loggedFetch(
    "postcodes.io",
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
  // postcodes.io uses HTTP 404 for a postcode that does not exist. A 200
  // without a usable result is a malformed upstream response, so let Google
  // be the fallback rather than incorrectly reporting a real postcode missing.
  if (!result) return null;
  if (!Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) {
    return null;
  }

  // postcodes.io has no street name, so compose something a roofer can read:
  // whatever the caller typed (if anything), the district, and the tidied
  // postcode. The widget itself no longer sends a street line — that now
  // comes from a one-shot reverse-geocode once the pin is confirmed — but
  // the field stays optional so this route's contract doesn't narrow.
  const parts = [
    address ? titleCase(address) : undefined,
    result.admin_district ?? undefined,
    prettyPostcode(compact),
  ];
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

  const addressQuery = [address, postcode, "UK"].filter(Boolean).join(", ");
  const params = new URLSearchParams({
    address: addressQuery,
    region: "uk",
    components: "country:GB",
    key: apiKey,
  });

  const response = await loggedFetch(
    "google-geocode",
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

  if (data.status === "ZERO_RESULTS") return "not_found";
  if (data.status !== "OK") return null;
  const result = data.results?.[0];
  if (
    !result ||
    !Number.isFinite(result.geometry?.location?.lat) ||
    !Number.isFinite(result.geometry?.location?.lng)
  ) {
    return null;
  }

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
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid request body");
    }
    body = parsed as GeocodeRequest;
  } catch {
    return NextResponse.json(
      { error: "Please enter a valid address." },
      { status: 400 },
    );
  }

  // Cap the inputs. No UK address needs this much room, and an oversized body
  // is free amplification against whatever we forward it to. `address` is
  // optional — the widget no longer collects a street line up front; it's
  // only ever a display extra when a caller happens to provide one.
  if (
    (body.address !== undefined && typeof body.address !== "string") ||
    (body.postcode !== undefined && typeof body.postcode !== "string")
  ) {
    return NextResponse.json(
      { error: "Please enter a valid address." },
      { status: 400 },
    );
  }
  const address = body.address?.trim().slice(0, 200) ?? "";
  const postcode = body.postcode?.trim().slice(0, 20) ?? "";

  const compact = normalisePostcode(postcode);
  const usable = looksLikeUkPostcode(compact);
  if (!usable) {
    return NextResponse.json(
      { error: "Please enter your postcode." },
      { status: 400 },
    );
  }

  let found: GeocodeSuccess | "not_found" | null = null;

  try {
    found = await lookupPostcodesIo(compact, address);
  } catch (error) {
    console.warn("postcodes.io lookup failed, falling back to Google", error);
    found = null;
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
