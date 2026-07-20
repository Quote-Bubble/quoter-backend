import type { LeadPayload } from "@/lib/types";

export function makeLeadPayload(
  overrides: Partial<LeadPayload> = {},
): LeadPayload {
  return {
    rooferId: "quoter-landing-demo",
    leadType: "quote",
    jobType: "full_replacement",
    otherJobDescription: null,
    address: {
      postcode: "LS1 1AA",
      line: "12 Oakfield Road",
      formatted: "12 Oakfield Road, Leeds, LS1 1AA",
    },
    coords: { lat: 53.8, lng: -1.55 },
    solar: {
      areaM2: 92,
      groundAreaM2: 80,
      pitchDegrees: 35,
      roofType: "gable",
      measurementMethod: "segment_bbox_overlap",
      segmentContributions: [],
      segments: [],
      wholeRoofStats: null,
      imageryQuality: "HIGH",
      imageryDate: "2024-06-01",
    },
    polygonCoords: null,
    conditionAnswer: "yes",
    conditionFlagged: false,
    material: "concrete_tile",
    quoteRange: { minExVat: 4200, maxExVat: 5800 },
    contact: {
      name: "Alex Example",
      phone: "07123456789",
      email: "alex@example.com",
    },
    fallbackReason: null,
    timestamp: "2026-07-20T01:00:00.000Z",
    roofline: null,
    obstructions: { chimneys: 1, rooflights: 0 },
    ...overrides,
  };
}
