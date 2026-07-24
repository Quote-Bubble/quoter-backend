import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/reverse-geocode/route";

vi.mock("@/lib/rate-limit", () => ({
  limitOr429: vi.fn(async () => null),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  clientIp: () => "127.0.0.1",
  resetRateLimitCache: vi.fn(),
}));

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/reverse-geocode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOGLE_OK = {
  status: "OK",
  results: [
    {
      formatted_address: "12 Braeside Ave, London SW19 4EH, UK",
      place_id: "PLACE_123",
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  process.env.GOOGLE_MAPS_SERVER_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
});

describe("POST /api/reverse-geocode", () => {
  it("resolves a coordinate to a formatted address", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(GOOGLE_OK), { status: 200 }),
    );

    const response = await POST(
      jsonRequest({ coords: { lat: 51.4141, lng: -0.2123 } }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.formattedAddress).toBe("12 Braeside Ave, London SW19 4EH, UK");
    expect(body.placeId).toBe("PLACE_123");
  });

  it("returns 404 on ZERO_RESULTS without treating it as a server error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), {
        status: 200,
      }),
    );

    const response = await POST(
      jsonRequest({ coords: { lat: 51.4141, lng: -0.2123 } }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("REVERSE_GEOCODE_NOT_FOUND");
  });

  it("returns unavailable for a Google API error even without results", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ status: "OVER_QUERY_LIMIT", results: [] }),
        { status: 200 },
      ),
    );

    const response = await POST(
      jsonRequest({ coords: { lat: 51.4141, lng: -0.2123 } }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.code).toBe("REVERSE_GEOCODE_UNAVAILABLE");
  });

  it("returns unavailable for an OK response without an address result", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: "OK", results: [] }), { status: 200 }),
    );

    const response = await POST(
      jsonRequest({ coords: { lat: 51.4141, lng: -0.2123 } }),
    );

    expect(response.status).toBe(502);
  });

  it("rejects invalid coordinates without calling Google", async () => {
    const response = await POST(
      jsonRequest({ coords: { lat: 999, lng: -0.2123 } }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ROOF_NOT_FOUND" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects missing coordinates without calling Google", async () => {
    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ROOF_NOT_FOUND" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns 503 when no API key is configured", async () => {
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY;

    const response = await POST(
      jsonRequest({ coords: { lat: 51.4141, lng: -0.2123 } }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe("REVERSE_GEOCODE_UNAVAILABLE");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns 502 when the request fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const response = await POST(
      jsonRequest({ coords: { lat: 51.4141, lng: -0.2123 } }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.code).toBe("REVERSE_GEOCODE_UNAVAILABLE");
  });
});
