import area from "@turf/area";
import intersect from "@turf/intersect";
import { featureCollection, polygon } from "@turf/helpers";

import type {
  GeoBounds,
  LatLng,
  RoofMeasurement,
  RoofSegment,
  RoofType,
  SolarScan,
} from "@/lib/types";

function boundsDimensions(bounds: GeoBounds) {
  const middleLat = (bounds.north + bounds.south) / 2;
  const latMeters = Math.abs(bounds.north - bounds.south) * 111_320;
  const lngMeters =
    Math.abs(bounds.east - bounds.west) *
    111_320 *
    Math.cos((middleLat * Math.PI) / 180);

  return { latMeters, lngMeters };
}

export function selectBoundsShare(
  bounds: GeoBounds,
  shareCount: number,
  shareIndex = 0,
): LatLng[] {
  const safeShareCount = Math.max(1, Math.min(20, Math.round(shareCount)));
  const safeShareIndex = Math.max(
    0,
    Math.min(safeShareCount - 1, Math.round(shareIndex)),
  );
  const { latMeters, lngMeters } = boundsDimensions(bounds);
  const splitLongitude = lngMeters >= latMeters;

  let north = bounds.north;
  let south = bounds.south;
  let east = bounds.east;
  let west = bounds.west;

  if (splitLongitude) {
    const width = (bounds.east - bounds.west) / safeShareCount;
    west = bounds.west + safeShareIndex * width;
    east = west + width;
  } else {
    const height = (bounds.north - bounds.south) / safeShareCount;
    south = bounds.south + safeShareIndex * height;
    north = south + height;
  }

  return [
    { lat: north, lng: west },
    { lat: north, lng: east },
    { lat: south, lng: east },
    { lat: south, lng: west },
  ];
}

function ringFromPath(path: LatLng[]): [number, number][] {
  if (path.length < 3) return [];
  const ring = path.map(({ lat, lng }) => [lng, lat] as [number, number]);
  ring.push(ring[0]);
  return ring;
}

/** Proper segment intersection (shared endpoints alone do not count). */
function segmentsIntersect(
  a1: LatLng,
  a2: LatLng,
  b1: LatLng,
  b2: LatLng,
): boolean {
  const orient = (p: LatLng, q: LatLng, r: LatLng) => {
    const value =
      (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng);
    if (Math.abs(value) < 1e-15) return 0;
    return value > 0 ? 1 : 2;
  };
  const onSegment = (p: LatLng, q: LatLng, r: LatLng) =>
    q.lng <= Math.max(p.lng, r.lng) + 1e-15 &&
    q.lng >= Math.min(p.lng, r.lng) - 1e-15 &&
    q.lat <= Math.max(p.lat, r.lat) + 1e-15 &&
    q.lat >= Math.min(p.lat, r.lat) - 1e-15;

  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

/**
 * True when the closed ring does not cross itself. Checks pairwise
 * non-adjacent edges — fine for the ≤30-vertex outlines we draw.
 */
export function isSimpleRing(ring: LatLng[]): boolean {
  const n = ring.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip the same edge and edges that share a vertex (adjacent on the ring).
      const adjacent =
        j === i ||
        (i + 1) % n === j ||
        (j + 1) % n === i ||
        (i === 0 && j === n - 1) ||
        (j === 0 && i === n - 1);
      if (adjacent) continue;
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

/**
 * True when the intersection of `candidate` with `existing` covers more than
 * `threshold` (default 10%) of the candidate's area.
 */
export function ringsOverlapExcessively(
  candidate: LatLng[],
  existing: LatLng[],
  threshold = 0.1,
): boolean {
  const candidateRing = ringFromPath(candidate);
  const existingRing = ringFromPath(existing);
  if (candidateRing.length < 4 || existingRing.length < 4) return false;
  try {
    const candidateFeature = polygon([candidateRing]);
    const existingFeature = polygon([existingRing]);
    const candidateArea = area(candidateFeature);
    if (candidateArea <= 0) return false;
    const overlap = intersect(
      featureCollection([candidateFeature, existingFeature]),
    );
    if (!overlap) return false;
    return area(overlap) / candidateArea > threshold;
  } catch {
    return false;
  }
}

export function pathFromBounds(bounds: GeoBounds): LatLng[] {
  return [
    { lat: bounds.north, lng: bounds.west },
    { lat: bounds.north, lng: bounds.east },
    { lat: bounds.south, lng: bounds.east },
    { lat: bounds.south, lng: bounds.west },
  ];
}

function ringFromBounds(bounds: GeoBounds): [number, number][] {
  return ringFromPath(pathFromBounds(bounds));
}

function circularDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

export function deriveRoofType(segments: RoofSegment[]): RoofType {
  const azimuthGroups: number[] = [];
  const sortedAzimuths = segments
    .map((segment) => ((segment.azimuthDegrees % 360) + 360) % 360)
    .sort((a, b) => a - b);

  for (const azimuth of sortedAzimuths) {
    if (
      azimuthGroups.every(
        (existing) => circularDifference(existing, azimuth) > 30,
      )
    ) {
      azimuthGroups.push(azimuth);
    }
  }

  if (azimuthGroups.length >= 3) return "hip";

  const maxPitch = Math.max(
    0,
    ...segments.map((segment) => segment.pitchDegrees),
  );
  if (maxPitch < 15) return "flat";
  return "gable";
}

function weightedPitch(segments: RoofSegment[]): number {
  const totalArea = segments.reduce(
    (sum, segment) => sum + Math.max(segment.areaMeters2, 0),
    0,
  );
  if (!totalArea) return 0;

  return (
    segments.reduce(
      (sum, segment) =>
        sum + segment.pitchDegrees * Math.max(segment.areaMeters2, 0),
      0,
    ) / totalArea
  );
}

function pitchMultiplier(pitchDegrees: number): number {
  const safePitch = Math.max(0, Math.min(pitchDegrees, 85));
  return 1 / Math.cos((safePitch * Math.PI) / 180);
}

function segmentGroundArea(segment: RoofSegment): number {
  if (segment.groundAreaMeters2 > 0) return segment.groundAreaMeters2;
  if (segment.areaMeters2 <= 0) return 0;
  return segment.areaMeters2 / pitchMultiplier(segment.pitchDegrees);
}

function surfaceCalibrationFactor(scan: SolarScan): number {
  const uncalibratedTotal = scan.roofSegmentStats.reduce(
    (sum, segment) =>
      sum + segmentGroundArea(segment) * pitchMultiplier(segment.pitchDegrees),
    0,
  );
  if (uncalibratedTotal <= 0 || scan.wholeRoofStats.areaMeters2 <= 0) return 1;
  return scan.wholeRoofStats.areaMeters2 / uncalibratedTotal;
}

export function measureDetached(scan: SolarScan): RoofMeasurement {
  const calibrationFactor = surfaceCalibrationFactor(scan);
  const contributions = scan.roofSegmentStats.map((segment, segmentIndex) => {
    const segmentFeature = polygon([ringFromBounds(segment.boundingBox)]);
    const bboxAreaM2 = area(segmentFeature);
    const groundAreaM2 = segmentGroundArea(segment);
    const multiplier = pitchMultiplier(segment.pitchDegrees);
    const uncalibratedSurfaceAreaM2 = groundAreaM2 * multiplier;

    return {
      segmentIndex,
      bboxAreaM2,
      polygonIntersectionAreaM2: bboxAreaM2,
      overlapRatio: 1,
      selectedGroundAreaM2: groundAreaM2,
      pitchMultiplier: multiplier,
      uncalibratedSurfaceAreaM2,
      selectedSurfaceAreaM2:
        uncalibratedSurfaceAreaM2 * calibrationFactor,
      pitchDegrees: segment.pitchDegrees,
      azimuthDegrees: segment.azimuthDegrees,
    };
  });

  return {
    surfaceAreaM2: scan.wholeRoofStats.areaMeters2,
    groundAreaM2: scan.wholeRoofStats.groundAreaMeters2,
    averagePitchDegrees: weightedPitch(scan.roofSegmentStats),
    roofType: deriveRoofType(scan.roofSegmentStats),
    intersectedSegments: scan.roofSegmentStats.length,
    method: "solar_whole_roof",
    surfaceCalibrationFactor: calibrationFactor,
    contributions,
  };
}

export function measureBoundary(
  scan: SolarScan,
  userPath: LatLng[],
): RoofMeasurement {
  const userRing = ringFromPath(userPath);
  if (userRing.length < 4) {
    throw new Error("The roof boundary needs at least three points.");
  }

  const userFeature = polygon([userRing]);
  const includedSegments: RoofSegment[] = [];
  const contributions: RoofMeasurement["contributions"] = [];
  let weightedPitchTotal = 0;
  let selectedGroundTotal = 0;
  const calibrationFactor = surfaceCalibrationFactor(scan);

  for (const [segmentIndex, segment] of scan.roofSegmentStats.entries()) {
    const segmentFeature = polygon([ringFromBounds(segment.boundingBox)]);
    const bboxAreaM2 = area(segmentFeature);
    if (bboxAreaM2 <= 0) continue;

    const overlap = intersect(
      featureCollection([segmentFeature, userFeature]),
    );
    if (!overlap) continue;

    const polygonIntersectionAreaM2 = area(overlap);
    const overlapRatio = Math.min(
      1,
      Math.max(0, polygonIntersectionAreaM2 / bboxAreaM2),
    );
    if (overlapRatio <= 0.0001) continue;

    const selectedGroundAreaM2 =
      segmentGroundArea(segment) * overlapRatio;
    if (selectedGroundAreaM2 <= 0) continue;

    const multiplier = pitchMultiplier(segment.pitchDegrees);
    const uncalibratedSurfaceAreaM2 =
      selectedGroundAreaM2 * multiplier;
    const selectedSurfaceAreaM2 =
      uncalibratedSurfaceAreaM2 * calibrationFactor;

    weightedPitchTotal += segment.pitchDegrees * selectedGroundAreaM2;
    selectedGroundTotal += selectedGroundAreaM2;
    includedSegments.push(segment);
    contributions.push({
      segmentIndex,
      bboxAreaM2,
      polygonIntersectionAreaM2,
      overlapRatio,
      selectedGroundAreaM2,
      pitchMultiplier: multiplier,
      uncalibratedSurfaceAreaM2,
      selectedSurfaceAreaM2,
      pitchDegrees: segment.pitchDegrees,
      azimuthDegrees: segment.azimuthDegrees,
    });
  }

  const surfaceAreaM2 = contributions.reduce(
    (sum, contribution) => sum + contribution.selectedSurfaceAreaM2,
    0,
  );

  if (!includedSegments.length || surfaceAreaM2 <= 0) {
    throw new Error("Move the boundary so it overlaps the roof.");
  }

  return {
    surfaceAreaM2,
    groundAreaM2: selectedGroundTotal,
    averagePitchDegrees:
      selectedGroundTotal > 0
        ? weightedPitchTotal / selectedGroundTotal
        : 0,
    roofType: deriveRoofType(includedSegments),
    intersectedSegments: includedSegments.length,
    method: "segment_bbox_overlap",
    surfaceCalibrationFactor: calibrationFactor,
    contributions,
  };
}

export function isImageryOlderThanThreeYears(
  imageryDate: string | null,
  now = new Date(),
): boolean {
  if (!imageryDate) return true;
  const captured = new Date(`${imageryDate}T00:00:00Z`);
  if (Number.isNaN(captured.getTime())) return true;
  const threeYearsAgo = new Date(now);
  threeYearsAgo.setUTCFullYear(now.getUTCFullYear() - 3);
  return captured < threeYearsAgo;
}
