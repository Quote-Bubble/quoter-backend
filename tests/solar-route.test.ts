import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/solar/route";

vi.mock("@/lib/rate-limit", () => ({
  limitOr429: vi.fn(async () => null),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  clientIp: () => "127.0.0.1",
  resetRateLimitCache: vi.fn(),
}));

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/solar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SOLAR_OK = {
  center: { latitude: 51.5, longitude: -0.12 },
  boundingBox: {
    sw: { latitude: 51.499, longitude: -0.121 },
    ne: { latitude: 51.501, longitude: -0.119 },
  },
  imageryQuality: "HIGH",
  imageryDate: { year: 2024, month: 6, day: 1 },
  solarPotential: {
    wholeRoofStats: { areaMeters2: 100, groundAreaMeters2: 90 },
    roofSegmentStats: [
      {
        pitchDegrees: 35,
        azimuthDegrees: 180,
        boundingBox: {
          sw: { latitude: 51.499, longitude: -0.121 },
          ne: { latitude: 51.501, longitude: -0.119 },
        },
        stats: { areaMeters2: 100, groundAreaMeters2: 90 },
      },
    ],
  },
};

function calledHosts(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) => String(input))
    .map((u) =>
      u.includes("solar.googleapis.com") ? "google-solar" : u,
    );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  process.env.GOOGLE_SOLAR_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GOOGLE_SOLAR_API_KEY;
});

describe("POST /api/solar", () => {
  it("returns a scan for UK coordinates", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(SOLAR_OK), { status: 200 }),
    );

    const response = await POST(
      jsonRequest({ coords: { lat: 51.5, lng: -0.12 } }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.scan.wholeRoofStats.areaMeters2).toBe(100);
    expect(calledHosts()).toEqual(["google-solar"]);
  });

  it("rejects NYC coordinates without calling Google", async () => {
    const response = await POST(
      jsonRequest({ coords: { lat: 40.7, lng: -74.0 } }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ROOF_NOT_FOUND" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not double-call Solar on a successful request", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(SOLAR_OK), { status: 200 }),
    );

    await POST(jsonRequest({ coords: { lat: 51.5, lng: -0.12 } }));
    expect(calledHosts()).toEqual(["google-solar"]);
  });
});
