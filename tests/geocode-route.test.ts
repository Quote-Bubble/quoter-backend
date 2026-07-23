import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/geocode/route";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/geocode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const POSTCODES_IO_OK = {
  status: 200,
  result: {
    latitude: 51.418796,
    longitude: -0.21136,
    admin_district: "Merton",
    admin_ward: "Hillside",
  },
};

const GOOGLE_OK = {
  status: "OK",
  results: [
    {
      formatted_address: "12 Braeside Ave, London SW19 4EH, UK",
      place_id: "PLACE_123",
      geometry: { location: { lat: 51.4141, lng: -0.2123 } },
    },
  ],
};

const isPostcodesIo = (url: string) => url.includes("api.postcodes.io");
const isGoogle = (url: string) => url.includes("maps.googleapis.com");

/** Which hosts did we actually call? Cost regressions show up here. */
function calledHosts(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) => String(input))
    .map((u) => (isPostcodesIo(u) ? "postcodes.io" : isGoogle(u) ? "google" : u));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  process.env.GOOGLE_MAPS_SERVER_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
});

describe("POST /api/geocode", () => {
  it("resolves a valid postcode through postcodes.io", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(POSTCODES_IO_OK), { status: 200 }),
    );

    const response = await POST(
      jsonRequest({ address: "12 Braeside Avenue", postcode: "SW19 4EH" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.coords).toEqual({ lat: 51.418796, lng: -0.21136 });
    expect(body.formattedAddress).toBe("12 Braeside Avenue, Merton, SW19 4EH");
  });

  // The street field is free text the widget no longer runs through any
  // address-validation API, so whatever case the homeowner typed it in
  // should still come out title-cased in the displayed address.
  it("title-cases a lower-case street address", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(POSTCODES_IO_OK), { status: 200 }),
    );

    const response = await POST(
      jsonRequest({ address: "2 whitehouse lane", postcode: "HP10 0NR" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.formattedAddress).toBe("2 Whitehouse Lane, Merton, HP10 0NR");
  });

  // The whole point of the swap: the happy path must not touch a billed API.
  it("does not call Google when postcodes.io succeeds", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(POSTCODES_IO_OK), { status: 200 }),
    );

    await POST(jsonRequest({ address: "12 Braeside Avenue", postcode: "SW19 4EH" }));

    expect(calledHosts()).toEqual(["postcodes.io"]);
  });

  it("accepts a postcode typed without a space or in lower case", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(POSTCODES_IO_OK), { status: 200 }),
    );

    const response = await POST(
      jsonRequest({ address: "12 Braeside Avenue", postcode: "sw194eh" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("SW194EH");
    expect(body.formattedAddress).toContain("SW19 4EH");
  });

  it("falls back to Google when postcodes.io is unreachable", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (isPostcodesIo(String(input))) throw new Error("network down");
      return new Response(JSON.stringify(GOOGLE_OK), { status: 200 });
    });

    const response = await POST(
      jsonRequest({ address: "12 Braeside Avenue", postcode: "SW19 4EH" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.placeId).toBe("PLACE_123");
    expect(calledHosts()).toEqual(["postcodes.io", "google"]);
  });

  // Every caller today (the bubble, the standalone AddressStep) validates the
  // postcode's shape client-side before this route is ever hit, so a bad
  // shape is rejected outright rather than spending a Google call guessing.
  it("rejects an invalid-shaped postcode without calling anything", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(GOOGLE_OK), { status: 200 }),
    );

    const response = await POST(
      jsonRequest({ address: "12 Braeside Avenue", postcode: "not-a-postcode" }),
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // A real-shaped postcode that doesn't exist is a dead end — paying Google to
  // confirm that would be waste.
  it("returns 404 without calling Google when the postcode does not exist", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 404 }));

    const response = await POST(
      jsonRequest({ address: "12 Nowhere Road", postcode: "ZZ99 9ZZ" }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("ADDRESS_NOT_FOUND");
    expect(calledHosts()).toEqual(["postcodes.io"]);
  });

  // The bubble is postcode-only now — no street line is ever sent up front.
  // A postcode-only request must still resolve, with a district-only label.
  it("resolves a postcode-only request (no address field) through postcodes.io", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(POSTCODES_IO_OK), { status: 200 }),
    );

    const response = await POST(jsonRequest({ postcode: "SW19 4EH" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.formattedAddress).toBe("Merton, SW19 4EH");
    expect(calledHosts()).toEqual(["postcodes.io"]);
  });

  it("rejects a missing postcode", async () => {
    const response = await POST(jsonRequest({ address: "12 Braeside Avenue" }));
    expect(response.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns 502 when both sources fail", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("everything is down"));

    const response = await POST(
      jsonRequest({ address: "12 Braeside Avenue", postcode: "SW19 4EH" }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.code).toBe("GEOCODING_UNAVAILABLE");
  });
});
