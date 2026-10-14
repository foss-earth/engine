import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { geodeticToEcef } from "../../src/camera/cameraMath.js";
import { WEB_MERCATOR_MAX_LAT_DEG, lonLatToMercator, lonLatToTileXY, type TileId } from "../../src/terrain/imagery/imageryGeometry.js";
import { createTestView, type TestViewOptions } from "../../src/terrain/imagery/imageryTestViews.js";
import { selectTerrain, type TerrainSelectionInput } from "../../src/terrain/terrainSelector.js";

// The selections below were taken from the shipped selector; a faster one must
// give the same leaves, distances and errors, bit for bit.
const SHIPPED_DIGEST = "b38c2c51a8a1ca194c791866180728fbfaf88970d5dcde42ac574883ab69976f";

/** The shipped tile coordinates, as one expression per zoom. */
function shippedTileXY(lonDeg: number, latDeg: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-WEB_MERCATOR_MAX_LAT_DEG, Math.min(WEB_MERCATOR_MAX_LAT_DEG, latDeg)) * (Math.PI / 180);
  const wrapped = ((((lonDeg + 180) % 360) + 360) % 360) / 360;
  return { x: wrapped * n, y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n };
}

function bounds(tile: TileId): { min: number; max: number } {
  // Uneven per tile, so distances depend on which tile is measured.
  const seed = ((tile.z * 73856093) ^ (tile.x * 19349663) ^ (tile.y * 83492791)) >>> 0;
  const min = (seed % 2000) - 400;
  return { min, max: min + (seed >>> 11) % 1500 };
}
const at = (latDeg: number, lonDeg: number, altitude: number) => geodeticToEcef(latDeg * Math.PI / 180, lonDeg * Math.PI / 180, altitude);
function input(view: TestViewOptions, overrides: Partial<TerrainSelectionInput> = {}): TerrainSelectionInput {
  return {
    view: createTestView({ renderWidth: 1280, renderHeight: 720, ...view }), focus: null, targetPx: 4, errorPerSpacing: 0.25,
    segments: 64, minLevel: 0, maxLevel: 16, maxTiles: 2000, hysteresis: { refineAbove: 1.2, coarsenBelow: 0.8 },
    previous: null, boundsFor: bounds, ...overrides,
  };
}
const CANYON: TestViewOptions = { latDeg: 36.1, lonDeg: -112.1, altitudeMeters: 1500, pitchDeg: 70, headingDeg: 30 };
const CASES: { name: string; view: TestViewOptions; overrides?: Partial<TerrainSelectionInput> }[] = [
  { name: "oblique", view: CANYON },
  { name: "overhead", view: { latDeg: 44.97, lonDeg: -93.23, altitudeMeters: 3000 } },
  { name: "antimeridian", view: { latDeg: -16.5, lonDeg: 179.97, altitudeMeters: 2500, pitchDeg: 60, headingDeg: 90 } },
  { name: "past the Mercator limit", view: { latDeg: 84.9, lonDeg: 20, altitudeMeters: 40_000, pitchDeg: 50, headingDeg: 10 } },
  { name: "refine point", view: CANYON, overrides: { refineFrom: { position: at(36.12, -112.05, 900), minDistanceMeters: 2400 } } },
  { name: "focus, both", view: CANYON, overrides: { focus: { mode: "both", position: at(36.2, -112.2, 1200), radiusMeters: 20_000, minDistanceMeters: 5000, horizonCull: true } } },
  { name: "focus, around", view: CANYON, overrides: { focus: { mode: "around", position: at(36.0, -111.9, 800), radiusMeters: 8000, minDistanceMeters: 1500, horizonCull: false } } },
];

function digestOf(selection: ReturnType<typeof selectTerrain>): string {
  const hash = createHash("sha256");
  for (const leaf of selection.leaves) {
    hash.update(`${leaf.key} ${leaf.needed} `);
    hash.update(new Uint8Array(Float64Array.of(leaf.distanceMeters, leaf.errorPx).buffer));
  }
  hash.update(`${[...selection.split].sort().join(",")} ${selection.truncated} ${selection.nodes}`);
  return hash.digest("hex");
}

describe("selection identity", () => {
  it("gives the shipped tile coordinates at every zoom from one Mercator position", () => {
    const lons = [-540, -360, -180.0000001, -180, -179.9999999, -93.23, -0, 0, 1e-12, 112.5, 179.9999999, 180, 360.5, 719];
    const lats = [-90, -85.06, -WEB_MERCATOR_MAX_LAT_DEG, -60.5, -1e-9, 0, 1e-9, 44.97, 66.6, WEB_MERCATOR_MAX_LAT_DEG, 85.06, 90];
    let state = 12345;
    const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let index = 0; index < 400; index++) { lons.push(random() * 720 - 360); lats.push(random() * 180 - 90); }
    for (const lon of lons) for (const lat of lats) {
      const world = lonLatToMercator(lon, lat);
      for (let z = 0; z <= 26; z++) {
        const expected = shippedTileXY(lon, lat, z), actual = lonLatToTileXY(lon, lat, z), n = 2 ** z;
        if (!Object.is(actual.x, expected.x) || !Object.is(actual.y, expected.y)
          || !Object.is(world.x * n, expected.x) || !Object.is(world.y * n, expected.y)) {
          throw new Error(`lon ${lon} lat ${lat} z ${z}: ${JSON.stringify([actual, expected, world])}`);
        }
      }
    }
  });
  it("selects the shipped selector's tiles, distances and errors", () => {
    const digests = CASES.map(test => {
      const first = selectTerrain(input(test.view, test.overrides));
      // The camera climbs and turns, and the first selection holds through the hysteresis.
      const moved = { ...test.view, altitudeMeters: test.view.altitudeMeters * 1.4, headingDeg: (test.view.headingDeg ?? 0) + 25 };
      const again = selectTerrain(input(moved, { ...test.overrides, previous: { split: first.split, leaves: new Set(first.leaves.map(leaf => leaf.key)) } }));
      expect(first.leaves.length, test.name).toBeGreaterThan(16);
      return `${test.name}: ${digestOf(first)} ${digestOf(again)}`;
    });
    expect(createHash("sha256").update(digests.join("\n")).digest("hex"), digests.join("\n")).toBe(SHIPPED_DIGEST);
  });
});
