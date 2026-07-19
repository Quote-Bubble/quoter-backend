import { loadEnvConfig } from "@next/env";

import { POST as geocode } from "../app/api/geocode/route";
import { POST as fetchSolar } from "../app/api/solar/route";
import {
  measureBoundary,
  pathFromBounds,
  selectBoundsShare,
} from "../lib/roof-geometry";
import { measureRoofLines } from "../lib/roof-lines";
import type { LatLng, SolarScan } from "../lib/types";

loadEnvConfig(process.cwd());

const PROPERTIES = [
  {
    name: "10 Downing Street",
    address: "10 Downing Street, London",
    postcode: "SW1A 2AA",
  },
  {
    name: "Birmingham Council House",
    address: "Victoria Square, Birmingham",
    postcode: "B1 1BB",
  },
  {
    name: "Shakespeare’s Birthplace",
    address: "Henley Street, Stratford-upon-Avon",
    postcode: "CV37 6QW",
  },
];

type VerificationRow = {
  property: string;
  postcode: string;
  solarWholeM2: number;
  fullSelectionM2: number;
  fullDifferencePct: number;
  halfSelectionM2: number;
  halfOfFullPct: number;
  segments: number;
  ridgeM: number;
  hipM: number;
  valleyM: number;
  lineCandidates: number;
  quality: string;
  result: "PASS" | "FAIL";
};

async function postJson<T>(
  handler: (request: Request) => Promise<Response>,
  url: string,
  body: unknown,
): Promise<T> {
  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `${url} returned ${response.status}`);
  }
  return data;
}

async function verifyProperty(
  property: (typeof PROPERTIES)[number],
): Promise<VerificationRow> {
  const geocoded = await postJson<{
    coords: LatLng;
    formattedAddress: string;
  }>(geocode, "http://local.test/api/geocode", {
    address: property.address,
    postcode: property.postcode,
  });

  const solar = await postJson<{ scan: SolarScan }>(
    fetchSolar,
    "http://local.test/api/solar",
    { coords: geocoded.coords },
  );

  const full = measureBoundary(
    solar.scan,
    pathFromBounds(solar.scan.boundingBox),
  );
  const half = measureBoundary(
    solar.scan,
    selectBoundsShare(solar.scan.boundingBox, 2, 0),
  );
  const roofLines = measureRoofLines(solar.scan);
  const fullDifferencePct =
    Math.abs(full.surfaceAreaM2 - solar.scan.wholeRoofStats.areaMeters2) /
    solar.scan.wholeRoofStats.areaMeters2 *
    100;
  const halfOfFullPct = half.surfaceAreaM2 / full.surfaceAreaM2 * 100;
  const passed =
    fullDifferencePct < 0.01 &&
    half.surfaceAreaM2 > 0 &&
    half.surfaceAreaM2 < full.surfaceAreaM2;

  return {
    property: property.name,
    postcode: property.postcode,
    solarWholeM2: Number(
      solar.scan.wholeRoofStats.areaMeters2.toFixed(2),
    ),
    fullSelectionM2: Number(full.surfaceAreaM2.toFixed(2)),
    fullDifferencePct: Number(fullDifferencePct.toFixed(4)),
    halfSelectionM2: Number(half.surfaceAreaM2.toFixed(2)),
    halfOfFullPct: Number(halfOfFullPct.toFixed(1)),
    segments: solar.scan.roofSegmentStats.length,
    ridgeM: Number(roofLines.totals.ridge.toFixed(2)),
    hipM: Number(roofLines.totals.hip.toFixed(2)),
    valleyM: Number(roofLines.totals.valley.toFixed(2)),
    lineCandidates: roofLines.features.length,
    quality: solar.scan.imageryQuality,
    result: passed ? "PASS" : "FAIL",
  };
}

async function main() {
  console.log(
    "Reference: Google Solar wholeRoofStats (not an independent physical survey).\n",
  );

  const rows: VerificationRow[] = [];
  for (const property of PROPERTIES) {
    try {
      rows.push(await verifyProperty(property));
    } catch (error) {
      console.error(
        `${property.name}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      process.exitCode = 1;
    }
  }

  console.table(rows);
  if (rows.some((row) => row.result === "FAIL")) process.exitCode = 1;
}

void main();
