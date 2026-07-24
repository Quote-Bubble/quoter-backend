import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildLeadEmail,
  getLeadEmailConfig,
  getRooferNotifyEmails,
  resetLeadEmailConfigCache,
  sendLeadEmail,
} from "@/lib/lead-email";

import type { LeadRow } from "@/lib/leads";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeRow(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: "lead-1",
    roofer_id: "roofer-uuid",
    status: "new",
    lead_type: "instant",
    job_type: "full_replacement",
    contact_name: "Alex Homeowner",
    contact_phone: "07700 900123",
    contact_email: "alex@example.com",
    address_formatted: "1 Test St, HP13 6TS",
    address_postcode: "HP13 6TS",
    quote_min_ex_vat: 4200,
    quote_max_ex_vat: 5800,
    payload: {} as LeadRow["payload"],
    received_at: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

function mockSupabase(opts: {
  members?: { user_id: string }[];
  emails?: Record<string, string | null>;
}): SupabaseClient {
  const members = opts.members ?? [];
  const emails = opts.emails ?? {};
  return {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: members, error: null }),
      }),
    }),
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve({
            data: { user: emails[id] ? { email: emails[id] } : null },
            error: null,
          }),
      },
    },
  } as unknown as SupabaseClient;
}

describe("buildLeadEmail", () => {
  it("puts the name and postcode in the subject", () => {
    expect(buildLeadEmail(makeRow()).subject).toBe(
      "New roof lead: Alex Homeowner — HP13 6TS",
    );
  });

  it("shows the quote range when the roof was measured", () => {
    expect(buildLeadEmail(makeRow()).text).toContain("£4,200–£5,800 (ex VAT)");
  });

  it("falls back to survey wording when not measured", () => {
    const { text } = buildLeadEmail(
      makeRow({ quote_min_ex_vat: null, quote_max_ex_vat: null }),
    );
    expect(text).toContain("Not measured");
  });

  it("escapes HTML in user-supplied fields", () => {
    const { html } = buildLeadEmail(
      makeRow({ contact_name: "<script>x</script>" }),
    );
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("getLeadEmailConfig", () => {
  beforeEach(() => {
    resetLeadEmailConfigCache();
    delete process.env.RESEND_API_KEY;
    delete process.env.LEAD_NOTIFY_FROM;
  });
  afterEach(() => {
    resetLeadEmailConfigCache();
    delete process.env.RESEND_API_KEY;
    delete process.env.LEAD_NOTIFY_FROM;
  });

  it("is disabled without an API key", () => {
    expect(getLeadEmailConfig()).toEqual({ ok: false, reason: "no_api_key" });
  });

  it("uses the onboarding from-address by default", () => {
    process.env.RESEND_API_KEY = "re_test";
    expect(getLeadEmailConfig()).toMatchObject({
      ok: true,
      from: "Quoter <onboarding@resend.dev>",
    });
  });
});

describe("getRooferNotifyEmails", () => {
  it("resolves member ids to deduped, lowercased emails", async () => {
    const supabase = mockSupabase({
      members: [{ user_id: "u1" }, { user_id: "u2" }, { user_id: "u3" }],
      emails: { u1: "A@Example.com", u2: "a@example.com", u3: "b@example.com" },
    });
    const emails = await getRooferNotifyEmails(supabase, "roofer-uuid");
    expect(emails.sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("returns [] when the roofer has no members", async () => {
    const emails = await getRooferNotifyEmails(mockSupabase({}), "roofer-uuid");
    expect(emails).toEqual([]);
  });
});

describe("sendLeadEmail", () => {
  beforeEach(() => {
    resetLeadEmailConfigCache();
    delete process.env.RESEND_API_KEY;
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetLeadEmailConfigCache();
    delete process.env.RESEND_API_KEY;
  });

  it("no-ops without an API key", async () => {
    const res = await sendLeadEmail(mockSupabase({}), makeRow());
    expect(res).toEqual({ sent: false, reason: "no_api_key" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips when the roofer has no linked email", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const res = await sendLeadEmail(mockSupabase({ members: [] }), makeRow());
    expect(res).toEqual({ sent: false, reason: "no_recipient" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to Resend with recipients + reply-to when configured", async () => {
    process.env.RESEND_API_KEY = "re_test";
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "e1" }), { status: 200 }),
    );
    const supabase = mockSupabase({
      members: [{ user_id: "u1" }],
      emails: { u1: "roofer@example.com" },
    });

    const res = await sendLeadEmail(supabase, makeRow());
    expect(res.sent).toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(["roofer@example.com"]);
    expect(body.reply_to).toBe("alex@example.com");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test");
  });

  it("throws when Resend rejects the request", async () => {
    process.env.RESEND_API_KEY = "re_test";
    vi.mocked(fetch).mockResolvedValue(new Response("bad", { status: 422 }));
    const supabase = mockSupabase({
      members: [{ user_id: "u1" }],
      emails: { u1: "roofer@example.com" },
    });
    await expect(sendLeadEmail(supabase, makeRow())).rejects.toThrow(
      /Resend returned 422/,
    );
  });
});
