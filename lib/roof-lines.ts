import type {
  GeoBounds,
  LatLng,
  RoofFeatureType,
  RoofLineFeature,
  RoofLineMeasurement,
  RoofSegment,
  SolarScan,
} from "@/lib/types";

type XY = { x: number; y: number };
type Rect = { minX: number; maxX: number; minY: number; maxY: number };
type Plane = { a: number; b: number; c: number; center: XY };

const METRES_PER_DEGREE = 111_320;

function circularDifference(a: number, b: number) {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

function coordinateTools(origin: LatLng) {
  const longitudeScale =
    METRES_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180);
  return {
    toXY(point: LatLng): XY {
      return {
        x: (point.lng - origin.lng) * longitudeScale,
        y: (point.lat - origin.lat) * METRES_PER_DEGREE,
      };
    },
    toLatLng(point: XY): LatLng {
      return {
        lat: origin.lat + point.y / METRES_PER_DEGREE,
        lng: origin.lng + point.x / longitudeScale,
      };
    },
  };
}

function boundsToRect(
  bounds: GeoBounds,
  toXY: (point: LatLng) => XY,
): Rect {
  const southWest = toXY({ lat: bounds.south, lng: bounds.west });
  const northEast = toXY({ lat: bounds.north, lng: bounds.east });
  return {
    minX: Math.min(southWest.x, northEast.x),
    maxX: Math.max(southWest.x, northEast.x),
    minY: Math.min(southWest.y, northEast.y),
    maxY: Math.max(southWest.y, northEast.y),
  };
}

function overlapRect(a: Rect, b: Rect): Rect | null {
  const overlap = {
    minX: Math.max(a.minX, b.minX),
    maxX: Math.min(a.maxX, b.maxX),
    minY: Math.max(a.minY, b.minY),
    maxY: Math.min(a.maxY, b.maxY),
  };
  if (overlap.maxX - overlap.minX <= 0.05) return null;
  if (overlap.maxY - overlap.minY <= 0.05) return null;
  return overlap;
}

function segmentPlane(
  segment: RoofSegment,
  toXY: (point: LatLng) => XY,
): Plane | null {
  if (!segment.center || segment.planeHeightAtCenterMeters === undefined) {
    return null;
  }
  const center = toXY(segment.center);
  const pitchTangent = Math.tan((segment.pitchDegrees * Math.PI) / 180);
  const azimuth = (segment.azimuthDegrees * Math.PI) / 180;
  const a = pitchTangent * Math.sin(azimuth);
  const b = pitchTangent * Math.cos(azimuth);
  return {
    a,
    b,
    c:
      segment.planeHeightAtCenterMeters +
      a * center.x +
      b * center.y,
    center,
  };
}

function lineRectangleIntersections(
  a: number,
  b: number,
  c: number,
  rect: Rect,
): XY[] {
  const points: XY[] = [];
  const epsilon = 1e-8;
  const add = (point: XY) => {
    if (
      point.x < rect.minX - 0.01 ||
      point.x > rect.maxX + 0.01 ||
      point.y < rect.minY - 0.01 ||
      point.y > rect.maxY + 0.01
    ) {
      return;
    }
    if (
      points.some(
        (existing) =>
          Math.hypot(existing.x - point.x, existing.y - point.y) < 0.02,
      )
    ) {
      return;
    }
    points.push(point);
  };

  if (Math.abs(b) > epsilon) {
    add({ x: rect.minX, y: (c - a * rect.minX) / b });
    add({ x: rect.maxX, y: (c - a * rect.maxX) / b });
  }
  if (Math.abs(a) > epsilon) {
    add({ x: (c - b * rect.minY) / a, y: rect.minY });
    add({ x: (c - b * rect.maxY) / a, y: rect.maxY });
  }

  return points;
}

function longestPair(points: XY[]): [XY, XY] | null {
  let result: [XY, XY] | null = null;
  let maxDistance = 0;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      const distance = Math.hypot(
        points[first].x - points[second].x,
        points[first].y - points[second].y,
      );
      if (distance > maxDistance) {
        maxDistance = distance;
        result = [points[first], points[second]];
      }
    }
  }
  return result;
}

function classifyFeature(
  segmentA: RoofSegment,
  segmentB: RoofSegment,
  planeA: Plane,
  planeB: Plane,
  midpoint: XY,
) {
  const directionA = {
    x: Math.sin((segmentA.azimuthDegrees * Math.PI) / 180),
    y: Math.cos((segmentA.azimuthDegrees * Math.PI) / 180),
  };
  const directionB = {
    x: Math.sin((segmentB.azimuthDegrees * Math.PI) / 180),
    y: Math.cos((segmentB.azimuthDegrees * Math.PI) / 180),
  };
  const sideA =
    (planeA.center.x - midpoint.x) * directionA.x +
    (planeA.center.y - midpoint.y) * directionA.y;
  const sideB =
    (planeB.center.x - midpoint.x) * directionB.x +
    (planeB.center.y - midpoint.y) * directionB.y;
  const azimuthDifference = circularDifference(
    segmentA.azimuthDegrees,
    segmentB.azimuthDegrees,
  );
  const sideThreshold = 0.2;

  if (sideA < -sideThreshold && sideB < -sideThreshold) {
    return {
      type: "valley" as const,
      reason: "Both segment downslope vectors point toward the plane intersection.",
      sideStrength: Math.min(Math.abs(sideA), Math.abs(sideB)),
      azimuthDifference,
    };
  }
  if (sideA > sideThreshold && sideB > sideThreshold) {
    if (azimuthDifference >= 135) {
      return {
        type: "ridge" as const,
        reason:
          "Opposing segment downslope vectors point away from the plane intersection.",
        sideStrength: Math.min(sideA, sideB),
        azimuthDifference,
      };
    }
    return {
      type: "hip" as const,
      reason:
        "Non-opposing segment downslope vectors point away from the plane intersection.",
      sideStrength: Math.min(sideA, sideB),
      azimuthDifference,
    };
  }
  return {
    type: "unresolved" as const,
    reason:
      "Segment centres and downslope vectors do not consistently identify a convex or concave junction.",
    sideStrength: Math.min(Math.abs(sideA), Math.abs(sideB)),
    azimuthDifference,
  };
}

function pointInPolygon(point: LatLng, polygon: LatLng[]) {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current, current += 1
  ) {
    const a = polygon[current];
    const b = polygon[previous];
    const intersects =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng <
        ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}

function lineAngle(feature: RoofLineFeature) {
  return Math.atan2(
    feature.end.lat - feature.start.lat,
    feature.end.lng - feature.start.lng,
  );
}

function directionDifference(a: number, b: number) {
  const difference = Math.abs(a - b) % Math.PI;
  return Math.min(difference, Math.PI - difference);
}

function deduplicateFeatures(
  features: RoofLineFeature[],
  toXY: (point: LatLng) => XY,
) {
  const accepted: RoofLineFeature[] = [];
  for (const candidate of [...features].sort((a, b) => b.lengthM - a.lengthM)) {
    const candidateMidpoint = toXY(candidate.midpoint);
    const duplicate = accepted.some((existing) => {
      if (existing.type !== candidate.type) return false;
      const existingMidpoint = toXY(existing.midpoint);
      const midpointDistance = Math.hypot(
        candidateMidpoint.x - existingMidpoint.x,
        candidateMidpoint.y - existingMidpoint.y,
      );
      return (
        midpointDistance < 1.5 &&
        directionDifference(lineAngle(existing), lineAngle(candidate)) <
          (10 * Math.PI) / 180
      );
    });
    if (!duplicate) accepted.push(candidate);
  }
  return accepted;
}

export function measureRoofLines(
  scan: SolarScan,
  selection?: LatLng[],
): RoofLineMeasurement {
  const { toXY, toLatLng } = coordinateTools(scan.center);
  const candidates: RoofLineFeature[] = [];
  let skippedPairs = 0;

  for (let first = 0; first < scan.roofSegmentStats.length; first += 1) {
    for (
      let second = first + 1;
      second < scan.roofSegmentStats.length;
      second += 1
    ) {
      const segmentA = scan.roofSegmentStats[first];
      const segmentB = scan.roofSegmentStats[second];
      const azimuthDifference = circularDifference(
        segmentA.azimuthDegrees,
        segmentB.azimuthDegrees,
      );
      if (azimuthDifference < 25) {
        skippedPairs += 1;
        continue;
      }

      const planeA = segmentPlane(segmentA, toXY);
      const planeB = segmentPlane(segmentB, toXY);
      const overlap = overlapRect(
        boundsToRect(segmentA.boundingBox, toXY),
        boundsToRect(segmentB.boundingBox, toXY),
      );
      if (!planeA || !planeB || !overlap) {
        skippedPairs += 1;
        continue;
      }

      const lineA = planeA.a - planeB.a;
      const lineB = planeA.b - planeB.b;
      const lineC = planeA.c - planeB.c;
      const endpoints = longestPair(
        lineRectangleIntersections(lineA, lineB, lineC, overlap),
      );
      if (!endpoints) {
        skippedPairs += 1;
        continue;
      }

      const lengthM = Math.hypot(
        endpoints[1].x - endpoints[0].x,
        endpoints[1].y - endpoints[0].y,
      );
      if (lengthM < 0.3) {
        skippedPairs += 1;
        continue;
      }

      const midpointXY = {
        x: (endpoints[0].x + endpoints[1].x) / 2,
        y: (endpoints[0].y + endpoints[1].y) / 2,
      };
      const midpoint = toLatLng(midpointXY);
      if (selection?.length && !pointInPolygon(midpoint, selection)) {
        skippedPairs += 1;
        continue;
      }

      const classification = classifyFeature(
        segmentA,
        segmentB,
        planeA,
        planeB,
        midpointXY,
      );
      candidates.push({
        segmentA: first,
        segmentB: second,
        type: classification.type,
        lengthM,
        start: toLatLng(endpoints[0]),
        end: toLatLng(endpoints[1]),
        midpoint,
        confidence:
          classification.sideStrength >= 0.75 && lengthM >= 1
            ? "medium"
            : "low",
        azimuthDifferenceDegrees: classification.azimuthDifference,
        reason: classification.reason,
      });
    }
  }

  const features = deduplicateFeatures(candidates, toXY);
  const totals: Record<RoofFeatureType, number> = {
    ridge: 0,
    hip: 0,
    valley: 0,
    unresolved: 0,
  };
  for (const feature of features) totals[feature.type] += feature.lengthM;

  return {
    method: "solar_plane_intersection_bbox_clip",
    totals,
    features,
    skippedPairs,
    warning:
      "Experimental only: plane intersections are clipped to overlapping rectangular segment bounds, deduplicated heuristically, and are not surveyed roof edges. Do not price automatically without review.",
  };
}
