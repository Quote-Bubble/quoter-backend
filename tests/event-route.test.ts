import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/event/route";

const insert = vi.hoisted(() => vi.fn());
const getServiceSupabase = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({
  getServiceSupabase,
  resetServiceSupabaseCache: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  limitOr429: vi.fn(async () => null),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  clientIp: () => "127.0.0.1",
  resetRateLimitCache: vi.fn(),
}));

function jsonRequest(body: unknown, origin = "https://widget.example") {
  return new Request("http://localhost/api/event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/event", () => {
  beforeEach(() => {
    insert.mockReset();
    insert.mockResolvedValue({ error: null });
    getServiceSupabase.mockReturnValue({
      from: () => ({ insert }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts without a client-controlled created_at", async () => {
    const response = await POST(
      jsonRequest({
        event: "step_viewed",
        rooferId: "demo",
        sessionId: "s1",
        url: "https://example.com",
        ts: "infinity",
        props: { step: "address" },
      }),
    );
    expect(response.status).toBe(204);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.created_at).toBeUndefined();
    expect(row.props.clientTs).toBe("infinity");
    expect(row.request_origin).toBe("https://widget.example");
  });

  it("logs DB errors instead of swallowing via dead catch", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockResolvedValue({ error: { code: "42P01", message: "missing" } });

    const response = await POST(
      jsonRequest({ event: "widget_opened", rooferId: "demo" }),
    );
    expect(response.status).toBe(204);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores unknown events", async () => {
    const response = await POST(jsonRequest({ event: "not_real" }));
    expect(response.status).toBe(204);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects oversized props silently", async () => {
    const big = { x: "y".repeat(5000) };
    const response = await POST(
      jsonRequest({ event: "step_viewed", props: big }),
    );
    expect(response.status).toBe(204);
    expect(insert).not.toHaveBeenCalled();
  });
});
