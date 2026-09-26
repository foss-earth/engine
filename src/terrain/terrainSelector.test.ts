import { describe, expect, it } from "vitest";
import { geodeticToEcef } from "../camera/cameraMath";
import { tileContains, type TileId } from "./imagery/imageryGeometry";
import { createTestView, type TestViewOptions } from "./imagery/imageryTestViews";
import { selectTerrain, terrainTileErrorMeters, type TerrainSelection, type TerrainSelectionInput } from "./terrainSelector";

const OVERHEAD: TestViewOptions = { latDeg: 36.1, lonDeg: -112.1, altitudeMeters: 3000 };
const OBLIQUE: TestViewOptions = { latDeg: 36.1, lonDeg: -112.1, altitudeMeters: 1500, pitchDeg: 70, headingDeg: 30 };

function input(view: TestViewOptions | null, overrides: Partial<TerrainSelectionInput> = {}): TerrainSelectionInput {
  return {
    view: view && createTestView({ renderWidth: 1280, renderHeight: 720, ...view }),
    focus: null,
    targetPx: 4,
    errorPerSpacing: 0.25,
    segments: 64,
    minLevel: 0,
    maxLevel: 16,
    maxTiles: 2000,
    hysteresis: { refineAbove: 1.2, coarsenBelow: 0.8 },
    previous: null,
    boundsFor: () => ({ min: 0, max: 0 }),
    ...overrides,
  };
}

function levelAt(selection: TerrainSelection, latDeg: number, lonDeg: number): number {
  const n = (z: number) => 2 ** z;
  const leaf = selection.leaves.find(({ tile }) => {
    const x = ((lonDeg + 180) / 360) * n(tile.z);
    const lat = (latDeg * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n(tile.z);
    return Math.floor(x) === tile.x && Math.floor(y) === tile.y;
  });
  expect(leaf).toBeDefined();
  return leaf!.tile.z;
}

/** The leaves tile the globe: each root is covered once, by itself or descendants that do not overlap. */
function expectCover(selection: TerrainSelection): void {
  const keys = new Set(selection.leaves.map(leaf => leaf.key));
  expect(keys.size).toBe(selection.leaves.length);
  for (const leaf of selection.leaves) {
    for (const other of selection.leaves) {
      if (other === leaf) continue;
      expect(tileContains(leaf.tile, other.tile), `${leaf.key} contains ${other.key}`).toBe(false);
    }
  }
  const area = selection.leaves.reduce((sum, leaf) => sum + 4 ** -leaf.tile.z, 0);
  expect(area).toBeCloseTo(1, 9);
}

describe("terrain selection by screen-space error", () => {
  it("keeps only the root level without a camera", () => {
    const selection = selectTerrain(input(null));
    expect(selection.leaves).toHaveLength(16);
    expect(selection.leaves.every(leaf => leaf.tile.z === 2 && !leaf.needed)).toBe(true);
  });

  it("refines under the camera until the projected error meets the target, and covers the globe once", () => {
    const selection = selectTerrain(input(OVERHEAD));
    expectCover(selection);
    const z = levelAt(selection, OVERHEAD.latDeg, OVERHEAD.lonDeg);
    const leaf = selection.leaves.find(candidate => candidate.tile.z === z && candidate.needed)!;
    // The leaf meets the target, and its parent would not have.
    const pixelAngle = 2 * Math.tan((60 * Math.PI) / 360) / 720;
    expect(leaf.errorPx).toBeLessThanOrEqual(4);
    const parent: TileId = { z: z - 1, x: leaf.tile.x >> 1, y: leaf.tile.y >> 1 };
    expect(terrainTileErrorMeters(parent, 64, 0.25) / (3000 * pixelAngle)).toBeGreaterThan(4);
  });

  it("asks for finer tiles with a smaller target, one level per halving", () => {
    const coarse = levelAt(selectTerrain(input(OVERHEAD, { targetPx: 8 })), 36.1, -112.1);
    const fine = levelAt(selectTerrain(input(OVERHEAD, { targetPx: 2 })), 36.1, -112.1);
    expect(fine - coarse).toBe(2);
  });

  it("refines toward the camera and leaves what it cannot see coarse", () => {
    const selection = selectTerrain(input(OBLIQUE));
    const near = levelAt(selection, 36.1, -112.1);
    // The far side of the globe stays at the root level.
    expect(levelAt(selection, -36.1, 67.9)).toBe(2);
    // Behind the camera's heading, outside the view, detail falls off.
    expect(levelAt(selection, 36.3, -112.3)).toBeLessThan(near);
  });

  it("stops at the level and tile limits, and says when the limit cut it short", () => {
    expect(levelAt(selectTerrain(input(OVERHEAD, { maxLevel: 9 })), 36.1, -112.1)).toBe(9);
    const capped = selectTerrain(input(OBLIQUE, { maxTiles: 40 }));
    expect(capped.leaves.length).toBeLessThanOrEqual(40);
    expect(capped.truncated).toBe(true);
    expectCover(capped);
  });

  it("keeps an existing level while the error hovers around the target", () => {
    const first = selectTerrain(input(OVERHEAD));
    const previous = { split: first.split, leaves: new Set(first.leaves.map(leaf => leaf.key)) };
    // 10% either way stays inside the 0.8–1.2 band.
    for (const targetPx of [3.64, 4.4]) {
      const next = selectTerrain(input(OVERHEAD, { targetPx, previous }));
      expect(next.leaves.map(leaf => leaf.key).sort()).toEqual([...previous.leaves].sort());
    }
  });
});

describe("terrain around a focus point", () => {
  const point = geodeticToEcef((36.1 * Math.PI) / 180, (-112.1 * Math.PI) / 180, 0);
  const focus = (mode: "around" | "both") => ({ mode, position: point, radiusMeters: 10_000, minDistanceMeters: 1500, horizonCull: true });

  it("selects the same tiles whichever way the camera turns around the point", () => {
    const keys = (headingDeg: number) => selectTerrain(input({ ...OBLIQUE, headingDeg }, { focus: focus("around") }))
      .leaves.map(leaf => leaf.key).sort();
    const first = keys(0);
    for (const heading of [90, 180, 270]) expect(keys(heading)).toEqual(first);
  });

  it("with the view, adds the region to what the camera sees", () => {
    const view = selectTerrain(input(OBLIQUE));
    const both = selectTerrain(input(OBLIQUE, { focus: focus("both") }));
    expect(both.leaves.length).toBeGreaterThan(view.leaves.length);
    // Behind the camera, within the radius, the region is refined.
    expect(levelAt(both, 36.15, -112.15)).toBeGreaterThan(levelAt(view, 36.15, -112.15));
  });
});
