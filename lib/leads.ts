import type { SupabaseClient } from "@supabase/supabase-js";

import type { LeadPayload } from "@/lib/types";

export type LeadStatus = "new" | "contacted" | "won" | "lost";

export type LeadRow = {
  id: string;
  roofer_id: string;
  status: LeadStatus;
  lead_type: string | null;
  job_type: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address_formatted: string | null;
  address_postcode: string | null;
  quote_min_ex_vat: number | null;
  quote_max_ex_vat: number | null;
  payload: LeadPayload & { leadId: string };
  received_at: string;
};

export class LeadPersistError extends Error {
  readonly code: "unknown_roofer" | "insert_failed" | "lookup_failed";

  constructor(
    code: LeadPersistError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LeadPersistError";
    this.code = code;
  }
}

export function mapLeadToRow(
  payload: LeadPayload,
  leadId: string,
  rooferUuid: string,
  receivedAt: string,
): LeadRow {
  return {
    id: leadId,
    roofer_id: rooferUuid,
    status: "new",
    lead_type: payload.leadType ?? null,
    job_type: payload.jobType ?? null,
    contact_name: payload.contact.name.trim(),
    contact_phone: payload.contact.phone.trim(),
    contact_email: payload.contact.email?.trim() || null,
    address_formatted:
      payload.address.formatted?.trim() ||
      payload.address.line?.trim() ||
      payload.address.postcode?.trim() ||
      null,
    address_postcode: payload.address.postcode?.trim() || null,
    quote_min_ex_vat: payload.quoteRange?.minExVat ?? null,
    quote_max_ex_vat: payload.quoteRange?.maxExVat ?? null,
    payload: { ...payload, leadId },
    received_at: receivedAt,
  };
}

/**
 * Resolve roofer slug → uuid, then insert the lead.
 * Uses the service-role client (RLS bypass).
 *
 * The insert is an upsert with `ignoreDuplicates` keyed on the lead `id`: the
 * widget generates a stable per-submission id and can resend it (retry /
 * resend-on-mount), so an insert that conflicts on that id is a resend of a
 * lead we already have — a no-op, not a new row. `inserted` reports whether
 * this call actually created the row (false = it was a duplicate resend), so
 * the caller can avoid re-firing the webhook for a lead already delivered.
 */
export async function persistLead(
  supabase: SupabaseClient,
  payload: LeadPayload,
  leadId: string,
  receivedAt: string,
): Promise<{ row: LeadRow; inserted: boolean }> {
  const { data: roofer, error: rooferError } = await supabase
    .from("roofers")
    .select("id")
    .eq("slug", payload.rooferId)
    .maybeSingle();

  if (rooferError) {
    throw new LeadPersistError(
      "lookup_failed",
      "Could not look up the roofing company for this quote.",
      { cause: rooferError },
    );
  }

  if (!roofer?.id) {
    throw new LeadPersistError(
      "unknown_roofer",
      "This quote form is not linked to a known roofing company.",
    );
  }

  const row = mapLeadToRow(payload, leadId, roofer.id, receivedAt);

  // ON CONFLICT (id) DO NOTHING. `.select()` returns only genuinely-inserted
  // rows, so an empty result means this was a duplicate resend.
  const { data, error: insertError } = await supabase
    .from("leads")
    .upsert(row, { onConflict: "id", ignoreDuplicates: true })
    .select("id");

  if (insertError) {
    throw new LeadPersistError(
      "insert_failed",
      "We could not save your request just now. Please try once more.",
      { cause: insertError },
    );
  }

  return { row, inserted: (data?.length ?? 0) > 0 };
}
