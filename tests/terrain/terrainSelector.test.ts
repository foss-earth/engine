import { describe, expect, it } from "vitest";
import { ecefToGeodetic, geodeticToEcef } from "../../src/camera/cameraMath.js";
import { tileContains, type TileId } from "../../src/terrain/imagery/imageryGeometry.js";
import { createTestView, type TestViewOptions } from "../../src/terrain/imagery/imageryTestViews.js";
import { selectTerrain, terrainTileErrorMeters, type TerrainSelection, type TerrainSelectionInput } from "../../src/terrain/terrainSelector.js";

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

describe("terrain measured from a point", () => {
  // The globe camera turns and tilts around its target, at a fixed distance from it.
  const lat = (36.1 * Math.PI) / 180, lon = (-112.1 * Math.PI) / 180;
  const target = geodeticToEcef(lat, lon, 0);
  const orbit = (headingDeg: number, pitchDeg: number, distanceMeters = 1500): TestViewOptions => {
    const up = { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
    const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
    const north = { x: up.y * east.z - up.z * east.y, y: up.z * east.x - up.x * east.z, z: up.x * east.y - up.y * east.x };
    const h = (headingDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180;
    const toTarget = (axis: "x" | "y" | "z") => -up[axis] * Math.cos(p) + (north[axis] * Math.cos(h) + east[axis] * Math.sin(h)) * Math.sin(p);
    const eye = ecefToGeodetic(target.x - distanceMeters * toTarget("x"), target.y - distanceMeters * toTarget("y"), target.z - distanceMeters * toTarget("z"));
    return { latDeg: (eye.latRad * 180) / Math.PI, lonDeg: (eye.lonRad * 180) / Math.PI, altitudeMeters: eye.altMeters, pitchDeg, headingDeg };
  };
  /** Needed leaves of two selections that overlap, and how many of them are not the same tile. */
  const compare = (a: TerrainSelection, b: TerrainSelection) => {
    let overlapping = 0, different = 0;
    for (const leaf of a.leaves) for (const other of b.leaves) {
      if (!leaf.needed || !other.needed || (!tileContains(leaf.tile, other.tile) && !tileContains(other.tile, leaf.tile))) continue;
      overlapping += 1;
      if (leaf.key !== other.key) different += 1;
    }
    return { overlapping, different };
  };
  const VIEWS = [[0, 60], [90, 60], [200, 75], [310, 40], [45, 0]].map(([headingDeg, pitchDeg]) => orbit(headingDeg, pitchDeg));
  const refineFrom = { position: target, minDistanceMeters: 1500 };

  it("keeps every tile whichever way the camera turns or tilts around the point", () => {
    const selections = VIEWS.map(view => selectTerrain(input(view, { refineFrom })));
    for (const a of selections) for (const b of selections) {
      if (a === b) continue;
      const { overlapping, different } = compare(a, b);
      expect(overlapping).toBeGreaterThan(4);
      expect(different).toBe(0);
    }
    // Measured from the camera, the same turns change tiles both views see.
    const fromCamera = VIEWS.map(view => selectTerrain(input(view)));
    expect(compare(fromCamera[0], fromCamera[1]).different).toBeGreaterThan(0);
  });

  it("refines ground nearer the camera than the point no further than the point", () => {
    const low = orbit(30, 75);
    const measured = selectTerrain(input(low, { refineFrom }));
    const finest = (selection: TerrainSelection) => Math.max(...selection.leaves.map(leaf => leaf.tile.z));
    expect(finest(measured)).toBeLessThan(finest(selectTerrain(input(low))));
    expect(finest(measured)).toBe(levelAt(measured, 36.1, -112.1));
    expectCover(measured);
  });

  it("refines terrain directly beneath the pitched camera eye so safe-space ground sampling does not fall back to coarse tiles", () => {
    // Target is ~1.2km south of the equator (a z=2 root tile boundary).
    // When orbiting at heading=180, pitch=75, distance=1500m, the camera eye is ~250m north of the equator
    // at ~388m altitude, looking south. Because the bottom plane of the 60deg vertical frustum is angled 45deg
    // south of nadir, it intersects the ground ~388m south of the eye (south of the equator), leaving the
    // northern z=2 tile directly beneath the camera eye outside the view frustum.
    const nearBoundaryLat = (-0.011 * Math.PI) / 180, nearBoundaryLon = (-112.1 * Math.PI) / 180;
    const boundaryTarget = geodeticToEcef(nearBoundaryLat, nearBoundaryLon, 0);
    const up = { x: Math.cos(nearBoundaryLat) * Math.cos(nearBoundaryLon), y: Math.cos(nearBoundaryLat) * Math.sin(nearBoundaryLon), z: Math.sin(nearBoundaryLat) };
    const east = { x: -Math.sin(nearBoundaryLon), y: Math.cos(nearBoundaryLon), z: 0 };
    const north = { x: up.y * east.z - up.z * east.y, y: up.z * east.x - up.x * east.z, z: up.x * east.y - up.y * east.x };
    const h = Math.PI, p = (75 * Math.PI) / 180, distanceMeters = 1500;
    const toTarget = (axis: "x" | "y" | "z") => -up[axis] * Math.cos(p) + (north[axis] * Math.cos(h) + east[axis] * Math.sin(h)) * Math.sin(p);
    const eye = ecefToGeodetic(
      boundaryTarget.x - distanceMeters * toTarget("x"),
      boundaryTarget.y - distanceMeters * toTarget("y"),
      boundaryTarget.z - distanceMeters * toTarget("z"),
    );
    const viewAtHeading: TestViewOptions = {
      latDeg: (eye.latRad * 180) / Math.PI,
      lonDeg: (eye.lonRad * 180) / Math.PI,
      altitudeMeters: eye.altMeters,
      pitchDeg: 75,
      headingDeg: 180,
    };
    // Baseline (robustOrbitLOD: false / default): under-eye tile stays coarse outside view frustum
    const baseline = selectTerrain(input(viewAtHeading, { refineFrom: { position: boundaryTarget, minDistanceMeters: distanceMeters } }));
    const underEyeBaseline = levelAt(baseline, viewAtHeading.latDeg, viewAtHeading.lonDeg);
    expect(underEyeBaseline).toBeLessThan(14);

    // Opt-in (robustOrbitLOD: true): under-eye tile refines to match target detail
    const selection = selectTerrain(input(viewAtHeading, { refineFrom: { position: boundaryTarget, minDistanceMeters: distanceMeters }, robustOrbitLOD: true }));
    const targetLevel = levelAt(selection, -0.011, -112.1);
    const underEyeLevel = levelAt(selection, viewAtHeading.latDeg, viewAtHeading.lonDeg);
    expect(underEyeLevel).toBeGreaterThanOrEqual(targetLevel - 1);
  });
});


