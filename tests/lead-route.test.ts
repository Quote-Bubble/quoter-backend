import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isLeadPayload, POST, resetWebhookConfigCache } from "@/app/api/lead/route";
import { makeLeadPayload } from "@/tests/fixtures/lead";

const persistLead = vi.hoisted(() => vi.fn());
const getServiceSupabase = vi.hoisted(() => vi.fn());

vi.mock("@/lib/leads", async () => {
  const actual = await vi.importActual<typeof import("@/lib/leads")>("@/lib/leads");
  return {
    ...actual,
    persistLead,
  };
});

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

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function leadRequest(overrides: Record<string, unknown> = {}) {
  return {
    ...makeLeadPayload(),
    _hp: "",
    _elapsedMs: 5_000,
    ...overrides,
  };
}

describe("isLeadPayload", () => {
  it("accepts a complete payload", () => {
    expect(isLeadPayload(makeLeadPayload())).toBe(true);
  });

  it("rejects missing contact phone", () => {
    expect(
      isLeadPayload(
        makeLeadPayload({
          contact: { name: "Alex", phone: "  ", email: "" },
        }),
      ),
    ).toBe(false);
  });

  it("rejects unknown job types", () => {
    expect(
      isLeadPayload({
        ...makeLeadPayload(),
        jobType: "not_a_job",
      }),
    ).toBe(false);
  });

  it("rejects a payload missing address", () => {
    const payload = makeLeadPayload();
    // @ts-expect-error — intentional incomplete fixture
    delete payload.address;
    expect(isLeadPayload(payload)).toBe(false);
  });
});

describe("POST /api/lead", () => {
  beforeEach(() => {
    persistLead.mockReset();
    getServiceSupabase.mockReset();
    resetWebhookConfigCache();
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.LEAD_WEBHOOK_URL;
    delete process.env.LEAD_WEBHOOK_SECRET;
    delete process.env.LEAD_WEBHOOK_ALLOWED_HOSTS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetWebhookConfigCache();
  });

  it("returns 400 for invalid JSON bodies", async () => {
    getServiceSupabase.mockReturnValue(null);
    const request = new Request("http://localhost/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns 400 when address is omitted (not 502)", async () => {
    getServiceSupabase.mockReturnValue(null);
    const body = leadRequest();
    delete (body as { address?: unknown }).address;
    const response = await POST(jsonRequest(body));
    expect(response.status).toBe(400);
    expect(persistLead).not.toHaveBeenCalled();
  });

  it("rejects when _elapsedMs is omitted (fake 202)", async () => {
    getServiceSupabase.mockReturnValue(null);
    const body = { ...makeLeadPayload(), _hp: "" };
    const response = await POST(jsonRequest(body));
    expect(response.status).toBe(202);
    expect(persistLead).not.toHaveBeenCalled();
  });

  it("persists then accepts when Supabase is configured", async () => {
    getServiceSupabase.mockReturnValue({ from: vi.fn() });
    persistLead.mockResolvedValue({ row: { id: "lead" }, inserted: true });

    const response = await POST(jsonRequest(leadRequest()));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.leadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(persistLead).toHaveBeenCalledTimes(1);
    expect(persistLead.mock.calls[0][1].rooferId).toBe("quoter-landing-demo");
  });

  it("returns 202 (indistinguishable) when the roofer slug is unknown", async () => {
    const { LeadPersistError } = await import("@/lib/leads");
    getServiceSupabase.mockReturnValue({ from: vi.fn() });
    persistLead.mockRejectedValue(
      new LeadPersistError("unknown_roofer", "unknown"),
    );

    const response = await POST(jsonRequest(leadRequest()));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.leadId).toBeTruthy();
  });

  it("returns 502 when persist fails for other reasons", async () => {
    const { LeadPersistError } = await import("@/lib/leads");
    getServiceSupabase.mockReturnValue({ from: vi.fn() });
    persistLead.mockRejectedValue(
      new LeadPersistError("insert_failed", "save failed"),
    );

    const response = await POST(jsonRequest(leadRequest()));
    expect(response.status).toBe(502);
  });

  it("skips persist when Supabase env is missing", async () => {
    getServiceSupabase.mockReturnValue(null);

    const response = await POST(jsonRequest(leadRequest()));
    expect(response.status).toBe(202);
    expect(persistLead).not.toHaveBeenCalled();
  });

  it("forwards to the webhook after a successful persist", async () => {
    process.env.LEAD_WEBHOOK_URL = "https://hooks.example/lead";
    resetWebhookConfigCache();
    getServiceSupabase.mockReturnValue({ from: vi.fn() });
    persistLead.mockResolvedValue({ row: { id: "lead" }, inserted: true });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const response = await POST(jsonRequest(leadRequest()));
    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledWith(
      "https://hooks.example/lead",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(persistLead.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fetch).mock.invocationCallOrder[0],
    );
  });

  it("signs the webhook body when LEAD_WEBHOOK_SECRET is set", async () => {
    process.env.LEAD_WEBHOOK_URL = "https://hooks.example/lead";
    process.env.LEAD_WEBHOOK_SECRET = "test-secret";
    resetWebhookConfigCache();
    getServiceSupabase.mockReturnValue({ from: vi.fn() });
    persistLead.mockResolvedValue({ row: { id: "lead" }, inserted: true });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    await POST(jsonRequest(leadRequest()));
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-quoter-signature"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("still accepts the lead when the webhook fails after a successful persist", async () => {
    process.env.LEAD_WEBHOOK_URL = "https://hooks.example/lead";
    resetWebhookConfigCache();
    getServiceSupabase.mockReturnValue({ from: vi.fn() });
    persistLead.mockResolvedValue({ row: { id: "lead" }, inserted: true });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));

    const response = await POST(jsonRequest(leadRequest()));
    expect(response.status).toBe(202);
    expect(persistLead).toHaveBeenCalled();
  });

  it("does not re-fire the webhook on a duplicate resend", async () => {
    process.env.LEAD_WEBHOOK_URL = "https://hooks.example/lead";
    resetWebhookConfigCache();
    getServiceSupabase.mockReturnValue({ from: vi.fn() });
    persistLead.mockResolvedValue({ row: { id: "lead" }, inserted: false });

    const response = await POST(jsonRequest(leadRequest()));
    expect(response.status).toBe(202);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 502 when the webhook fails and the lead was never persisted", async () => {
    process.env.LEAD_WEBHOOK_URL = "https://hooks.example/lead";
    resetWebhookConfigCache();
    getServiceSupabase.mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));

    const response = await POST(jsonRequest(leadRequest()));
    expect(response.status).toBe(502);
    expect(persistLead).not.toHaveBeenCalled();
  });
});
