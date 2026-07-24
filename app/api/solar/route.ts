import { preflight, withCors } from "@/lib/cors";
import { loggedFetch } from "@/lib/logged-fetch";
import { cacheGet, cacheSet, limitOr429 } from "@/lib/rate-limit";
import { parseCoords, readJsonBody } from "@/lib/validate";

import { NextResponse } from "next/server";

import type { GeoBounds, LatLng, RoofSegment } from "@/lib/types";

export const maxDuration = 12;

type RawLatLng = {
  latitude?: number;
  longitude?: number;
};

type RawBounds = {
  sw?: RawLatLng;
  ne?: RawLatLng;
};

type RawRoofStats = {
  areaMeters2?: number;
  groundAreaMeters2?: number;
};

type RawRoofSegment = {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  center?: RawLatLng;
  planeHeightAtCenterMeters?: number;
  boundingBox?: RawBounds;
  stats?: RawRoofStats;
};

type SolarApiResponse = {
  center?: RawLatLng;
  boundingBox?: RawBounds;
  imageryQuality?: string;
  imageryDate?: {
    year?: number;
    month?: number;
    day?: number;
  };
  solarPotential?: {
    wholeRoofStats?: RawRoofStats;
    roofSegmentStats?: RawRoofSegment[];
  };
};

const ROOF_NOT_FOUND = {
  error: "Satellite roof data is not available for this address.",
  code: "ROOF_NOT_FOUND",
} as const;

const SOLAR_CACHE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

function normaliseLatLng(value: RawLatLng | undefined): LatLng | null {
  if (
    typeof value?.latitude !== "number" ||
    typeof value.longitude !== "number"
  ) {
    return null;
  }
  return { lat: value.latitude, lng: value.longitude };
}

function normaliseBounds(value: RawBounds | undefined): GeoBounds | null {
  const southWest = normaliseLatLng(value?.sw);
  const northEast = normaliseLatLng(value?.ne);
  if (!southWest || !northEast) return null;

  return {
    north: northEast.lat,
    south: southWest.lat,
    east: northEast.lng,
    west: southWest.lng,
  };
}

function normaliseImageryDate(
  value: SolarApiResponse["imageryDate"],
): string | null {
  if (!value?.year || !value.month || !value.day) return null;
  return [
    value.year.toString().padStart(4, "0"),
    value.month.toString().padStart(2, "0"),
    value.day.toString().padStart(2, "0"),
  ].join("-");
}

function cacheKey(coords: LatLng): string {
  return `solar:${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
}

async function handlePost(request: Request) {
  const limited = await limitOr429(request, "solar");
  if (limited) return limited;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json({ error: bodyResult.error }, { status: 400 });
  }

  const coordsResult = parseCoords(bodyResult.value);
  if (!coordsResult.ok) {
    // UK bbox / invalid coords — same shape as a real miss so we don't leak
    // that the reject was geographic.
    return NextResponse.json(ROOF_NOT_FOUND, { status: 404 });
  }
  const coords = coordsResult.value;

  const cached = await cacheGet<{ scan: unknown }>(cacheKey(coords));
  if (cached?.scan) {
    return NextResponse.json({
      scan: cached.scan,
      debug:
        process.env.NODE_ENV === "development"
          ? { cache: "hit", coords }
          : undefined,
    });
  }

  const apiKey =
    process.env.GOOGLE_SOLAR_API_KEY ??
    process.env.GOOGLE_MAPS_SERVER_API_KEY ??
    process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Roof scanning is temporarily unavailable.",
        code: "SOLAR_UNAVAILABLE",
      },
      { status: 503 },
    );
  }

  const params = new URLSearchParams({
    "location.latitude": String(coords.lat),
    "location.longitude": String(coords.lng),
    requiredQuality: "LOW",
    key: apiKey,
  });

  try {
    const response = await loggedFetch(
      "google-solar",
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?${params}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(9_000),
      },
    );

    if (response.status === 404) {
      return NextResponse.json(ROOF_NOT_FOUND, { status: 404 });
    }

    if (!response.ok) {
      throw new Error(`Solar API returned ${response.status}.`);
    }

    const raw = (await response.json()) as SolarApiResponse;
    const center = normaliseLatLng(raw.center) ?? coords;
    const boundingBox = normaliseBounds(raw.boundingBox);
    const whole = raw.solarPotential?.wholeRoofStats;
    const areaMeters2 = whole?.areaMeters2;
    const groundAreaMeters2 = whole?.groundAreaMeters2;

    if (
      !boundingBox ||
      typeof areaMeters2 !== "number" ||
      typeof groundAreaMeters2 !== "number"
    ) {
      throw new Error("Solar API response did not contain roof geometry.");
    }

    const roofSegmentStats: RoofSegment[] = (
      raw.solarPotential?.roofSegmentStats ?? []
    ).flatMap((segment) => {
      const segmentBounds = normaliseBounds(segment.boundingBox);
      const segmentCenter = normaliseLatLng(segment.center);
      if (
        !segmentBounds ||
        typeof segment.pitchDegrees !== "number" ||
        typeof segment.azimuthDegrees !== "number"
      ) {
        return [];
      }

      return [
        {
          pitchDegrees: segment.pitchDegrees,
          azimuthDegrees: segment.azimuthDegrees,
          areaMeters2: segment.stats?.areaMeters2 ?? 0,
          groundAreaMeters2: segment.stats?.groundAreaMeters2 ?? 0,
          boundingBox: segmentBounds,
          center: segmentCenter ?? undefined,
          planeHeightAtCenterMeters:
            typeof segment.planeHeightAtCenterMeters === "number"
              ? segment.planeHeightAtCenterMeters
              : undefined,
        },
      ];
    });

    if (!roofSegmentStats.length) {
      throw new Error("Solar API response did not contain roof segments.");
    }

    const scan = {
      center,
      boundingBox,
      imageryQuality: raw.imageryQuality ?? "UNKNOWN",
      imageryDate: normaliseImageryDate(raw.imageryDate),
      wholeRoofStats: {
        areaMeters2,
        groundAreaMeters2,
      },
      roofSegmentStats,
    };

    await cacheSet(cacheKey(coords), { scan }, SOLAR_CACHE_TTL_SECONDS);

    return NextResponse.json({
      scan,
      debug:
        process.env.NODE_ENV === "development"
          ? {
              request: {
                coords,
                requiredQuality: "LOW",
              },
              rawResponse: raw,
            }
          : undefined,
    });
  } catch (error) {
    console.error("Solar roof scan failed", error);
    return NextResponse.json(
      {
        error: "Roof scanning is temporarily unavailable.",
        code: "SOLAR_UNAVAILABLE",
      },
      { status: 502 },
    );
  }
}

export const POST = withCors(handlePost);
export const OPTIONS = preflight;
