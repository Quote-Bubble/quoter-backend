import type {
  ConditionAnswer,
  JobType,
  LatLng,
  LeadPayload,
  Material,
  RoofMeasurement,
  RoofType,
  RooflineScope,
} from "@/lib/types";

export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; error: string };
export type ParseResult<T> = ParseOk<T> | ParseErr;

const MAX_BODY_BYTES = 64 * 1024;

const VALID_JOB_TYPES = new Set<JobType>([
  "full_replacement",
  "tile_or_slate_repair",
  "flat_roof_replacement",
  "leak_investigation",
  "gutters_fascias_soffits",
  "other",
]);

const VALID_LEAD_TYPES = new Set(["quote", "manual_consultation"]);
const VALID_ROOF_TYPES = new Set<RoofType>(["gable", "hip", "flat"]);
const VALID_MEASUREMENT_METHODS = new Set<RoofMeasurement["method"]>([
  "solar_whole_roof",
  "segment_bbox_overlap",
]);
const VALID_CONDITION = new Set<ConditionAnswer>(["yes", "no", "not_sure"]);
const VALID_ROOFLINE_SCOPE = new Set<RooflineScope>([
  "gutters_only",
  "gutters_fascias",
]);
const VALID_MATERIALS = new Set<Material>([
  "concrete_tile",
  "clay_tile",
  "natural_slate",
  "flat_bitumen",
  "flat_epdm",
  "flat_grp",
  "not_sure",
  "fibre_cement",
  "polycarbonate",
  "glass_plain",
  "glass_laminated",
  "felt",
]);

/** UK bounding box — stops the Solar/Geocoding routes acting as a free worldwide proxy. */
export const UK_BBOX = {
  latMin: 49.8,
  latMax: 61.0,
  lngMin: -8.7,
  lngMax: 2.0,
} as const;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_EVENTS = new Set([
  "widget_opened",
  "widget_closed",
  "step_viewed",
  "quote_shown",
  "lead_submitted",
  "lead_failed",
]);

function fail(error: string): ParseErr {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(
  value: unknown,
  max: number,
  opts: { required?: boolean; allowEmpty?: boolean } = {},
): string | null | undefined {
  if (value === null || value === undefined) {
    return opts.required ? undefined : null;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed && !opts.allowEmpty) {
    return opts.required ? undefined : null;
  }
  if (trimmed.length > max) return undefined;
  return trimmed;
}

function asFiniteNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") return undefined;
  return value;
}

export function parseLatLng(value: unknown): LatLng | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined;
  const lat = asFiniteNumber(value.lat);
  const lng = asFiniteNumber(value.lng);
  if (lat === undefined || lng === undefined) return undefined;
  if (lat === null || lng === null) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

export function isInUkBbox(coords: LatLng): boolean {
  return (
    coords.lat >= UK_BBOX.latMin &&
    coords.lat <= UK_BBOX.latMax &&
    coords.lng >= UK_BBOX.lngMin &&
    coords.lng <= UK_BBOX.lngMax
  );
}

/**
 * Reject oversized bodies before JSON.parse. Checks Content-Length when
 * present, then still caps the buffered string.
 */
export async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<ParseResult<unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > maxBytes) {
      return fail("Request body too large.");
    }
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return fail("Could not read request body.");
  }

  // UTF-16 code units ≈ bytes for ASCII JSON; reject obvious oversize.
  if (text.length > maxBytes) {
    return fail("Request body too large.");
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return fail("Invalid JSON body.");
  }
}

export function parseCoords(body: unknown): ParseResult<LatLng> {
  if (!isPlainObject(body)) {
    return fail("Valid property coordinates are required.");
  }
  const coords = parseLatLng(body.coords);
  if (!coords) {
    return fail("Valid property coordinates are required.");
  }
  if (!isInUkBbox(coords)) {
    return fail("Satellite roof data is not available for this address.");
  }
  return { ok: true, value: coords };
}

export type ParsedEvent = {
  event: string;
  rooferId: string | null;
  sessionId: string | null;
  sourceUrl: string | null;
  props: Record<string, unknown>;
  clientTs: string | null;
};

export function parseEventBody(body: unknown): ParseResult<ParsedEvent> {
  if (!isPlainObject(body)) {
    return fail("Invalid event body.");
  }

  const event = asString(body.event, 64, { required: true });
  if (!event || !KNOWN_EVENTS.has(event)) {
    return fail("Unknown event.");
  }

  let props: Record<string, unknown> = {};
  if (body.props !== undefined && body.props !== null) {
    if (!isPlainObject(body.props) || Array.isArray(body.props)) {
      return fail("Event props must be a plain object.");
    }
    const serialised = JSON.stringify(body.props);
    if (serialised.length > 4096) {
      return fail("Event props too large.");
    }
    props = body.props;
  }

  // Client clock data is untrusted for timestamptz — keep as a prop only.
  const clientTs = asString(body.ts, 40);

  return {
    ok: true,
    value: {
      event,
      rooferId: asString(body.rooferId, 128) ?? null,
      sessionId: asString(body.sessionId, 128) ?? null,
      sourceUrl: asString(body.url, 512) ?? null,
      props,
      clientTs: clientTs ?? null,
    },
  };
}

function parseSegmentContributions(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 64) return undefined;
  return value;
}

function parseRoofSegments(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 64) return undefined;
  return value;
}

function parsePolygonCoords(value: unknown): LatLng[] | null | undefined {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return undefined;
  if (value.length > 512) return undefined;
  const out: LatLng[] = [];
  for (const entry of value) {
    const ll = parseLatLng(entry);
    if (!ll) return undefined;
    out.push(ll);
  }
  return out;
}

/**
 * Validates every field of LeadPayload. Replaces the shallow isLeadPayload
 * that let missing address through to mapLeadToRow (TypeError → 502).
 */
export function parseLeadBody(body: unknown): ParseResult<LeadPayload> {
  if (!isPlainObject(body)) {
    return fail("Please complete your name and phone number.");
  }

  const rooferId = asString(body.rooferId, 128, { required: true });
  if (!rooferId) {
    return fail("Please complete your name and phone number.");
  }

  const leadTypeRaw = asString(body.leadType, 40, { required: true });
  if (!leadTypeRaw || !VALID_LEAD_TYPES.has(leadTypeRaw)) {
    return fail("Please complete your name and phone number.");
  }

  const jobTypeRaw = asString(body.jobType, 64, { required: true });
  if (!jobTypeRaw || !VALID_JOB_TYPES.has(jobTypeRaw as JobType)) {
    return fail("Please complete your name and phone number.");
  }
  const jobType = jobTypeRaw as JobType;

  const otherJobDescription =
    body.otherJobDescription === null || body.otherJobDescription === undefined
      ? null
      : asString(body.otherJobDescription, 500);
  if (otherJobDescription === undefined) {
    return fail("Please complete your name and phone number.");
  }

  if (!isPlainObject(body.address)) {
    return fail("Please complete your name and phone number.");
  }
  const postcode = asString(body.address.postcode, 20, { required: true });
  const line = asString(body.address.line, 200, {
    required: true,
    allowEmpty: true,
  });
  if (line === undefined || !postcode) {
    return fail("Please complete your name and phone number.");
  }
  const formatted =
    body.address.formatted === null || body.address.formatted === undefined
      ? null
      : asString(body.address.formatted, 300);
  if (formatted === undefined) {
    return fail("Please complete your name and phone number.");
  }

  const coords = parseLatLng(body.coords);
  if (coords === undefined) {
    return fail("Please complete your name and phone number.");
  }

  if (!isPlainObject(body.solar)) {
    return fail("Please complete your name and phone number.");
  }
  const solar = body.solar;
  const areaM2 = asFiniteNumber(solar.areaM2);
  const groundAreaM2 = asFiniteNumber(solar.groundAreaM2);
  const pitchDegrees = asFiniteNumber(solar.pitchDegrees);
  if (
    areaM2 === undefined ||
    groundAreaM2 === undefined ||
    pitchDegrees === undefined
  ) {
    return fail("Please complete your name and phone number.");
  }

  let roofType: RoofType | null = null;
  if (solar.roofType !== null && solar.roofType !== undefined) {
    const rt = asString(solar.roofType, 20);
    if (!rt || !VALID_ROOF_TYPES.has(rt as RoofType)) {
      return fail("Please complete your name and phone number.");
    }
    roofType = rt as RoofType;
  }

  let measurementMethod: RoofMeasurement["method"] | null = null;
  if (
    solar.measurementMethod !== null &&
    solar.measurementMethod !== undefined
  ) {
    const mm = asString(solar.measurementMethod, 40);
    if (!mm || !VALID_MEASUREMENT_METHODS.has(mm as RoofMeasurement["method"])) {
      return fail("Please complete your name and phone number.");
    }
    measurementMethod = mm as RoofMeasurement["method"];
  }

  const segmentContributions = parseSegmentContributions(
    solar.segmentContributions,
  );
  const segments = parseRoofSegments(solar.segments);
  if (segmentContributions === undefined || segments === undefined) {
    return fail("Please complete your name and phone number.");
  }

  let wholeRoofStats: LeadPayload["solar"]["wholeRoofStats"] = null;
  if (solar.wholeRoofStats !== null && solar.wholeRoofStats !== undefined) {
    if (!isPlainObject(solar.wholeRoofStats)) {
      return fail("Please complete your name and phone number.");
    }
    const am = asFiniteNumber(solar.wholeRoofStats.areaMeters2);
    const gm = asFiniteNumber(solar.wholeRoofStats.groundAreaMeters2);
    if (am === undefined || gm === undefined || am === null || gm === null) {
      return fail("Please complete your name and phone number.");
    }
    wholeRoofStats = { areaMeters2: am, groundAreaMeters2: gm };
  }

  const imageryQuality =
    solar.imageryQuality === null || solar.imageryQuality === undefined
      ? null
      : asString(solar.imageryQuality, 40);
  const imageryDate =
    solar.imageryDate === null || solar.imageryDate === undefined
      ? null
      : asString(solar.imageryDate, 40);
  if (imageryQuality === undefined || imageryDate === undefined) {
    return fail("Please complete your name and phone number.");
  }

  const polygonCoords = parsePolygonCoords(body.polygonCoords);
  if (polygonCoords === undefined) {
    return fail("Please complete your name and phone number.");
  }

  let conditionAnswer: ConditionAnswer | null = null;
  if (body.conditionAnswer !== null && body.conditionAnswer !== undefined) {
    const ca = asString(body.conditionAnswer, 20);
    if (!ca || !VALID_CONDITION.has(ca as ConditionAnswer)) {
      return fail("Please complete your name and phone number.");
    }
    conditionAnswer = ca as ConditionAnswer;
  }

  const conditionFlagged = asBoolean(body.conditionFlagged);
  if (conditionFlagged === undefined) {
    return fail("Please complete your name and phone number.");
  }

  let material: Material | null = null;
  if (body.material !== null && body.material !== undefined) {
    const m = asString(body.material, 40);
    if (!m || !VALID_MATERIALS.has(m as Material)) {
      return fail("Please complete your name and phone number.");
    }
    material = m as Material;
  }

  let quoteRange: LeadPayload["quoteRange"] = null;
  if (body.quoteRange !== null && body.quoteRange !== undefined) {
    if (!isPlainObject(body.quoteRange)) {
      return fail("Please complete your name and phone number.");
    }
    const minExVat = asFiniteNumber(body.quoteRange.minExVat);
    const maxExVat = asFiniteNumber(body.quoteRange.maxExVat);
    if (
      minExVat === undefined ||
      maxExVat === undefined ||
      minExVat === null ||
      maxExVat === null
    ) {
      return fail("Please complete your name and phone number.");
    }
    quoteRange = { minExVat, maxExVat };
  }

  if (!isPlainObject(body.contact)) {
    return fail("Please complete your name and phone number.");
  }
  const name = asString(body.contact.name, 100, { required: true });
  const phone = asString(body.contact.phone, 20, { required: true });
  const email = asString(body.contact.email, 254, {
    required: true,
    allowEmpty: true,
  });
  if (!name || !phone || email === undefined) {
    return fail("Please complete your name and phone number.");
  }

  const fallbackReason =
    body.fallbackReason === null || body.fallbackReason === undefined
      ? null
      : asString(body.fallbackReason, 500);
  if (fallbackReason === undefined) {
    return fail("Please complete your name and phone number.");
  }

  const timestamp = asString(body.timestamp, 40, { required: true });
  if (!timestamp) {
    return fail("Please complete your name and phone number.");
  }

  let roofline: LeadPayload["roofline"] = null;
  if (body.roofline !== null && body.roofline !== undefined) {
    if (!isPlainObject(body.roofline)) {
      return fail("Please complete your name and phone number.");
    }
    const perimeterM = asFiniteNumber(body.roofline.perimeterM);
    const gutterLengthM = asFiniteNumber(body.roofline.gutterLengthM);
    if (perimeterM === undefined || gutterLengthM === undefined) {
      return fail("Please complete your name and phone number.");
    }
    let scope: RooflineScope | null = null;
    if (body.roofline.scope !== null && body.roofline.scope !== undefined) {
      const s = asString(body.roofline.scope, 40);
      if (!s || !VALID_ROOFLINE_SCOPE.has(s as RooflineScope)) {
        return fail("Please complete your name and phone number.");
      }
      scope = s as RooflineScope;
    }
    roofline = { perimeterM, gutterLengthM, scope };
  }

  let obstructions: LeadPayload["obstructions"] = null;
  if (body.obstructions !== null && body.obstructions !== undefined) {
    if (!isPlainObject(body.obstructions)) {
      return fail("Please complete your name and phone number.");
    }
    const chimneys = asFiniteNumber(body.obstructions.chimneys);
    const rooflights = asFiniteNumber(body.obstructions.rooflights);
    if (
      chimneys === undefined ||
      rooflights === undefined ||
      chimneys === null ||
      rooflights === null
    ) {
      return fail("Please complete your name and phone number.");
    }
    obstructions = { chimneys, rooflights };
  }

  // Cast nested solar arrays — we validated length/shape; full deep segment
  // validation would duplicate the wire types without buying more safety.
  return {
    ok: true,
    value: {
      rooferId,
      leadType: leadTypeRaw as LeadPayload["leadType"],
      jobType,
      otherJobDescription,
      address: { postcode, line: line ?? "", formatted },
      coords,
      solar: {
        areaM2,
        groundAreaM2,
        pitchDegrees,
        roofType,
        measurementMethod,
        segmentContributions:
          segmentContributions as LeadPayload["solar"]["segmentContributions"],
        segments: segments as LeadPayload["solar"]["segments"],
        wholeRoofStats,
        imageryQuality,
        imageryDate,
      },
      polygonCoords,
      conditionAnswer,
      conditionFlagged,
      material,
      quoteRange,
      contact: { name, phone, email: email ?? "" },
      fallbackReason,
      timestamp,
      roofline,
      obstructions,
    },
  };
}

/** Keep isLeadPayload for existing tests — delegates to parseLeadBody. */
export function isLeadPayload(value: unknown): value is LeadPayload {
  return parseLeadBody(value).ok;
}
