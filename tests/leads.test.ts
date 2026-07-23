import { describe, expect, it, vi } from "vitest";

import {
  LeadPersistError,
  mapLeadToRow,
  persistLead,
} from "@/lib/leads";
import { makeLeadPayload } from "@/tests/fixtures/lead";

import type { SupabaseClient } from "@supabase/supabase-js";

function mockSupabase(options: {
  roofer?: { id: string } | null;
  rooferError?: { message: string } | null;
  insertError?: { message: string } | null;
  /** Rows returned by the upsert().select() — empty simulates a duplicate
   *  resend (ON CONFLICT DO NOTHING inserted nothing). Defaults to one row. */
  insertedRows?: Array<{ id: string }>;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: options.roofer === undefined ? { id: "roofer-uuid" } : options.roofer,
    error: options.rooferError ?? null,
  });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  // leads: .upsert(row, opts).select("id") -> { data, error }
  const upsertSelect = vi.fn().mockResolvedValue({
    data: options.insertError
      ? null
      : (options.insertedRows ?? [{ id: "lead-uuid" }]),
    error: options.insertError ?? null,
  });
  const upsert = vi.fn().mockReturnValue({ select: upsertSelect });
  const from = vi.fn((table: string) => {
    if (table === "roofers") return { select };
    if (table === "leads") return { upsert };
    throw new Error(`Unexpected table ${table}`);
  });

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    select,
    eq,
    maybeSingle,
    upsert,
    upsertSelect,
  };
}

describe("mapLeadToRow", () => {
  it("maps inbox fields and embeds leadId in payload", () => {
    const payload = makeLeadPayload();
    const row = mapLeadToRow(
      payload,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "2026-07-20T02:00:00.000Z",
    );

    expect(row).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      roofer_id: "22222222-2222-2222-2222-222222222222",
      status: "new",
      lead_type: "quote",
      job_type: "full_replacement",
      contact_name: "Alex Example",
      contact_phone: "07123456789",
      contact_email: "alex@example.com",
      address_formatted: "12 Oakfield Road, Leeds, LS1 1AA",
      address_postcode: "LS1 1AA",
      quote_min_ex_vat: 4200,
      quote_max_ex_vat: 5800,
      received_at: "2026-07-20T02:00:00.000Z",
    });
    expect(row.payload.leadId).toBe("11111111-1111-1111-1111-111111111111");
    expect(row.payload.rooferId).toBe("quoter-landing-demo");
  });

  it("falls back to address.line when formatted is null", () => {
    const payload = makeLeadPayload({
      address: {
        postcode: "LS1 1AA",
        line: "12 Oakfield Road",
        formatted: null,
      },
    });
    const row = mapLeadToRow(payload, "lead", "roofer", "2026-07-20T02:00:00.000Z");
    expect(row.address_formatted).toBe("12 Oakfield Road");
  });

  it("falls back to the postcode for postcode-only leads", () => {
    const payload = makeLeadPayload({
      address: { postcode: "LS1 1AA", line: "", formatted: null },
    });
    const row = mapLeadToRow(payload, "lead", "roofer", "2026-07-20T02:00:00.000Z");
    expect(row.address_formatted).toBe("LS1 1AA");
  });
});

describe("persistLead", () => {
  it("looks up the roofer by slug and upserts the mapped row", async () => {
    const mock = mockSupabase({
      roofer: { id: "roofer-uuid" },
    });
    const payload = makeLeadPayload({ rooferId: "quoter-landing-demo" });

    const result = await persistLead(
      mock.client,
      payload,
      "lead-uuid",
      "2026-07-20T02:00:00.000Z",
    );

    expect(mock.from).toHaveBeenCalledWith("roofers");
    expect(mock.eq).toHaveBeenCalledWith("slug", "quoter-landing-demo");
    expect(mock.from).toHaveBeenCalledWith("leads");
    expect(mock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "lead-uuid",
        roofer_id: "roofer-uuid",
        contact_name: "Alex Example",
      }),
      expect.objectContaining({ onConflict: "id", ignoreDuplicates: true }),
    );
    expect(result.row.roofer_id).toBe("roofer-uuid");
    expect(result.inserted).toBe(true);
  });

  it("reports inserted:false on a duplicate resend (upsert returns no rows)", async () => {
    const mock = mockSupabase({
      roofer: { id: "roofer-uuid" },
      insertedRows: [], // ON CONFLICT DO NOTHING inserted nothing
    });

    const result = await persistLead(
      mock.client,
      makeLeadPayload(),
      "lead-uuid",
      "2026-07-20T02:00:00.000Z",
    );

    expect(result.inserted).toBe(false);
  });

  it("throws unknown_roofer when the slug is missing", async () => {
    const mock = mockSupabase({ roofer: null });
    const payload = makeLeadPayload({ rooferId: "nope" });

    await expect(
      persistLead(mock.client, payload, "lead-uuid", "2026-07-20T02:00:00.000Z"),
    ).rejects.toMatchObject({
      name: "LeadPersistError",
      code: "unknown_roofer",
    } satisfies Partial<LeadPersistError>);

    expect(mock.upsert).not.toHaveBeenCalled();
  });

  it("throws lookup_failed when the roofer query errors", async () => {
    const mock = mockSupabase({
      roofer: null,
      rooferError: { message: "db down" },
    });

    await expect(
      persistLead(
        mock.client,
        makeLeadPayload(),
        "lead-uuid",
        "2026-07-20T02:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "lookup_failed" });
  });

  it("throws insert_failed when insert errors", async () => {
    const mock = mockSupabase({
      roofer: { id: "roofer-uuid" },
      insertError: { message: "unique violation" },
    });

    await expect(
      persistLead(
        mock.client,
        makeLeadPayload(),
        "lead-uuid",
        "2026-07-20T02:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "insert_failed" });
  });
});
