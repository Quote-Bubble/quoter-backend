export type JobType =
  | "full_replacement"
  | "tile_or_slate_repair"
  | "flat_roof_replacement"
  | "leak_investigation"
  | "gutters_fascias_soffits"
  | "other";

export type MeasuredJobType =
  | "full_replacement"
  | "flat_roof_replacement";

export type RoofType = "gable" | "hip" | "flat";
export type PricingMode = "replacement" | "repair" | "roofline";
export type PropertyType =
  | "detached"
  | "semi_detached"
  | "terraced"
  | "bungalow"
  | "flat";
export type StoreyBand = 1 | 2 | 3;
export type RooflineScope = "gutters_only" | "gutters_fascias";
export type RoofObstructionKind = "chimney" | "rooflight";
export type RoofObstruction = {
  kind: RoofObstructionKind;
  bounds: GeoBounds;
  /** Four corners in map order when the obstruction was marked with the
   * oriented three-point tool. `bounds` remains for pricing calculations. */
  path?: LatLng[];
};
export type DrawnRoof = {
  path: LatLng[];
  gutterEdgeIndices: number[];
  obstructions: RoofObstruction[];
};
export type ReplacementMaterial =
  | "concrete_tile"
  | "clay_tile"
  | "natural_slate"
  | "flat_bitumen"
  | "flat_epdm"
  | "flat_grp"
  | "not_sure";
export type RepairMaterial =
  | "concrete_tile"
  | "clay_tile"
  | "natural_slate"
  | "fibre_cement"
  | "flat_bitumen"
  | "flat_epdm"
  | "flat_grp"
  | "polycarbonate"
  | "glass_plain"
  | "glass_laminated"
  | "felt"
  | "not_sure";
export type Material = ReplacementMaterial | RepairMaterial;
export type ConditionAnswer = "yes" | "no" | "not_sure";

export type LatLng = {
  lat: number;
  lng: number;
};

export type GeoBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type RoofStats = {
  areaMeters2: number;
  groundAreaMeters2: number;
};

export type RoofSegment = {
  pitchDegrees: number;
  azimuthDegrees: number;
  areaMeters2: number;
  groundAreaMeters2: number;
  boundingBox: GeoBounds;
  center?: LatLng;
  planeHeightAtCenterMeters?: number;
};

export type SolarScan = {
  center: LatLng;
  boundingBox: GeoBounds;
  imageryQuality: string;
  imageryDate: string | null;
  wholeRoofStats: RoofStats;
  roofSegmentStats: RoofSegment[];
};

export type SegmentContribution = {
  segmentIndex: number;
  bboxAreaM2: number;
  polygonIntersectionAreaM2: number;
  overlapRatio: number;
  selectedGroundAreaM2: number;
  pitchMultiplier: number;
  uncalibratedSurfaceAreaM2: number;
  selectedSurfaceAreaM2: number;
  pitchDegrees: number;
  azimuthDegrees: number;
};

export type RoofMeasurement = {
  surfaceAreaM2: number;
  groundAreaM2: number;
  averagePitchDegrees: number;
  roofType: RoofType;
  intersectedSegments: number;
  method: "solar_whole_roof" | "segment_bbox_overlap";
  surfaceCalibrationFactor: number;
  contributions: SegmentContribution[];
};

export type QuoteLineItem = {
  label: string;
  detail?: string;
  min: number;
  max: number;
  rateId?: string;
  unit?: "m²" | "m" | "week" | "hour" | "day" | "fixed";
  quantity?: number;
  unitRateMin?: number;
  unitRateMax?: number;
  sourceTitle?: string;
  sourceAsOf?: string;
  quantityM2?: number;
};

export type QuoteResult = {
  estimateType: "indicative_estimate";
  pricingMode: PricingMode;
  min: number;
  max: number;
  pricingAreaM2: number | null;
  confidenceWidth: number;
  modelAssumptions: string[];
  lineItems: QuoteLineItem[];
};

export type RoofFeatureType = "ridge" | "hip" | "valley" | "unresolved";

export type RoofLineFeature = {
  segmentA: number;
  segmentB: number;
  type: RoofFeatureType;
  lengthM: number;
  start: LatLng;
  end: LatLng;
  midpoint: LatLng;
  confidence: "low" | "medium";
  azimuthDifferenceDegrees: number;
  reason: string;
};

export type RoofLineMeasurement = {
  method: "solar_plane_intersection_bbox_clip";
  totals: Record<RoofFeatureType, number>;
  features: RoofLineFeature[];
  skippedPairs: number;
  warning: string;
};

export type ContactDetails = {
  name: string;
  phone: string;
  email: string;
};

export type LeadPayload = {
  rooferId: string;
  leadType: "quote" | "manual_consultation";
  jobType: JobType;
  otherJobDescription: string | null;
  address: {
    postcode: string;
    line: string;
    formatted: string | null;
  };
  coords: LatLng | null;
  solar: {
    areaM2: number | null;
    groundAreaM2: number | null;
    pitchDegrees: number | null;
    roofType: RoofType | null;
    measurementMethod: RoofMeasurement["method"] | null;
    segmentContributions: SegmentContribution[];
    segments: RoofSegment[];
    wholeRoofStats: RoofStats | null;
    imageryQuality: string | null;
    imageryDate: string | null;
  };
  polygonCoords: LatLng[] | null;
  conditionAnswer: ConditionAnswer | null;
  conditionFlagged: boolean;
  material: Material | null;
  quoteRange: {
    minExVat: number;
    maxExVat: number;
  } | null;
  contact: ContactDetails;
  fallbackReason: string | null;
  timestamp: string;
  roofline: {
    perimeterM: number | null;
    gutterLengthM: number | null;
    scope: RooflineScope | null;
  } | null;
  obstructions: {
    chimneys: number;
    rooflights: number;
  } | null;
};
