import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { createTerrainRegions } from "../src/surface/terrainRegionController.js";
import { createTerrainRegionDemand, terrainRegionPriority, terrainRegionTilePriority } from "../src/babylon/terrainRegionBounds.js";
import { validateTerrainRegion, type TerrainRegionCoverage, type TerrainRegionOptions } from "../src/surface/terrainRegion.js";
import { selectTerrain } from "../src/terrain/terrainSelector.js";

const options = (): TerrainRegionOptions => ({ region: { center: { latDeg: 0, lonDeg: 0, altitudeMeters: 1 }, radiusMeters: 15 },
  minimum: { googleErrorMeters: 8, rasterZoom: 14 }, final: { googleErrorMeters: 1, rasterZoom: 16 } });
const coverage = (readyTiles: number, totalTiles = 4): TerrainRegionCoverage => ({ readyTiles, totalTiles, pendingTiles: totalTiles - readyTiles, unavailable: false });

function fixture() {
  let now = 0, source = 1, minimum = coverage(0), final = coverage(0), unavailable: string | null = null;
  const begin = vi.fn(), end = vi.fn(), onProgress = vi.fn();
  const owner = createTerrainRegions({ nowMs: () => now, sourceGeneration: () => source,
    coverage: (_demand, tier) => tier === "minimum" ? minimum : final,
    groundHeight: () => 0, unavailableReason: () => unavailable,
    beginContinuous: begin, endContinuous: end, requestRender: vi.fn() });
  const lease = owner.prepare({ ...options(), onProgress });
  return { owner, lease, begin, end, onProgress,
    step(ms = 200) { now += ms; owner.tick(now); },
    set(min: TerrainRegionCoverage, fine = min) { minimum = min; final = fine; },
    changeSource() { source++; }, fail() { unavailable = "Map unavailable"; } };
}

describe("aircraft region loading lifetime", () => {
  it("distinguishes minimum coverage from final detail and retains its demand after readiness", () => {
    const f = fixture(); expect(f.onProgress).not.toHaveBeenCalled(); expect(f.begin).toHaveBeenCalledOnce();
    f.step(); expect(f.lease.read().state).toBe("loading");
    f.set(coverage(4), coverage(1)); f.step();
    expect(f.lease.read()).toMatchObject({ state: "minimum", minimumReady: true, finalReady: false, readyTiles: 1, pendingTiles: 3 });
    expect(f.lease.read().estimatedRemainingMs).toBeGreaterThan(0);
    f.set(coverage(4)); f.step();
    expect(f.lease.read()).toMatchObject({ state: "ready", estimatedRemainingMs: 0 }); expect(f.end).toHaveBeenCalledOnce();
    expect(f.owner.demands()).toHaveLength(1);
    f.lease.update({ ...options().region, center: { latDeg: 0, lonDeg: 1, altitudeMeters: 1 } });
    expect(f.begin).toHaveBeenCalledTimes(2);
    f.set(coverage(0)); f.step(); expect(f.lease.read().state).toBe("loading");
    f.lease.release(); f.lease.release(); expect(f.owner.demands()).toHaveLength(0); expect(f.end).toHaveBeenCalledTimes(2);
  });
  it("reports unavailable targets without pretending they are ready and resets estimates on source replacement", () => {
    const f = fixture(); f.step(); f.set(coverage(4), coverage(2)); f.step(); expect(f.lease.read().estimatedRemainingMs).not.toBeNull();
    f.changeSource(); expect(f.lease.read()).toMatchObject({ minimumReady: false, finalReady: false });
    f.set(coverage(0)); f.step(); expect(f.lease.read().estimatedRemainingMs).toBeNull();
    f.set(coverage(4), { ...coverage(0), unavailable: true }); f.step();
    expect(f.lease.read()).toMatchObject({ state: "unavailable", minimumReady: true, finalReady: false });
    expect(f.end).toHaveBeenCalledOnce();
  });
  it("reports a moved region even when its readiness matches the previous region", () => {
    const f = fixture(); f.set(coverage(4)); f.step();
    expect(f.onProgress).toHaveBeenCalledTimes(1); expect(f.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready" }));
    f.lease.update({ ...options().region, center: { latDeg: 0, lonDeg: 0, altitudeMeters: 40 } });
    f.step();
    expect(f.onProgress).toHaveBeenCalledTimes(2); expect(f.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready" }));
  });
  it("shows a region on request, with the boxes of the tiles its final detail waits for", () => {
    let now = 0, boxes = [Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0, z: 0 }))];
    const requestRender = vi.fn(), sinks: Array<[string, boolean]> = [];
    const owner = createTerrainRegions({ nowMs: () => now, sourceGeneration: () => 1,
      coverage: (_demand, tier, outline) => {
        sinks.push([tier, outline !== undefined]);
        if (tier === "final") for (const corners of boxes) outline?.(corners);
        return coverage(3);
      },
      groundHeight: () => 0, unavailableReason: () => null, beginContinuous: vi.fn(), endContinuous: vi.fn(), requestRender });
    const lease = owner.prepare(options());
    const step = () => { now += 200; owner.tick(now); };
    // Hidden by default: nothing is shown and no boxes are collected.
    step();
    expect(owner.displays()).toEqual([]);
    expect(sinks).toEqual([["minimum", false], ["final", false]]);
    requestRender.mockClear();
    lease.setVisible(true);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(owner.displays()).toMatchObject([{ demand: owner.demands()[0], outlines: [], revision: 0 }]);
    // Checked at once, not after the usual interval.
    now += 1; owner.tick(now);
    expect(sinks.at(-1)).toEqual(["final", true]);
    expect(owner.displays()[0]).toMatchObject({ outlines: [boxes[0]], revision: 1 });
    // The boxes are copies, and the same boxes are no new revision.
    boxes[0]![0]!.x = 0.5;
    expect(owner.displays()[0]!.outlines[0]![0]!.x).toBe(0);
    boxes = [Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0, z: 0 }))];
    step();
    expect(owner.displays()[0]!.revision).toBe(1);
    boxes = [];
    step();
    expect(owner.displays()[0]).toMatchObject({ outlines: [], revision: 2 });
    // A moved region is shown where it is now, its boxes measured at the next check.
    boxes = [Array.from({ length: 8 }, (_, i) => ({ x: 0, y: i, z: 0 }))];
    lease.update({ ...options().region, center: { latDeg: 0, lonDeg: 1, altitudeMeters: 1 } });
    expect(owner.displays()[0]).toMatchObject({ demand: owner.demands()[0], outlines: [], revision: 3 });
    step();
    expect(owner.displays()[0]).toMatchObject({ outlines: boxes, revision: 4 });
    lease.setVisible(false);
    expect(owner.displays()).toEqual([]);
    sinks.length = 0; step();
    expect(sinks).toEqual([["minimum", false], ["final", false]]);
    lease.setVisible(true); lease.release(); lease.setVisible(true);
    expect(owner.displays()).toEqual([]);
  });
  it("releases render demand on abort and disposal, including an already aborted request", () => {
    const f = fixture(), abort = new AbortController();
    const second = f.owner.prepare({ ...options(), signal: abort.signal }); abort.abort(); second.update(options().region);
    expect(f.owner.demands()).toHaveLength(1);
    f.owner.prepare({ ...options(), signal: abort.signal }); expect(f.owner.demands()).toHaveLength(1);
    f.owner.dispose(); expect(f.owner.demands()).toHaveLength(0); expect(f.begin.mock.calls.length).toBe(f.end.mock.calls.length);
  });
});

describe("continuous spherical and forward cone demand", () => {
  it("prepares a grounded plane's required detail inside the flight patch budget", () => {
    const ground = createTerrainRegionDemand({ center: { latDeg: 44.9794, lonDeg: -93.2705, altitudeMeters: 1 }, radiusMeters: 200 },
      { googleErrorMeters: 32, rasterZoom: 12 }, { googleErrorMeters: 8, rasterZoom: 14 });
    const selection = selectTerrain({ view: null, focus: null, targetPx: 4, errorPerSpacing: .25, segments: 32,
      minLevel: 0, maxLevel: 18, maxTiles: 256, hysteresis: { refineAbove: 1.2, coarsenBelow: .8 }, previous: null,
      boundsFor: () => ({ min: 0, max: 0 }), regionRequirement: (tile, heights) => {
        const priority = terrainRegionTilePriority(ground, tile, heights); return priority === null ? null : { level: 14, priority };
      } });
    expect(selection.leaves.filter(leaf => leaf.regionLevel !== undefined).every(leaf => leaf.tile.z === 14)).toBe(true);
    expect(selection.leaves.some(leaf => leaf.regionLevel !== undefined)).toBe(true);
    expect(selection.leaves.length).toBeLessThanOrEqual(256);
  });
  it("excludes ground below an airborne volume even when a coarse tile's enclosing sphere overlaps it", () => {
    const airborne = createTerrainRegionDemand({ center: { latDeg: 0, lonDeg: 0, altitudeMeters: 1500 }, radiusMeters: 200 }, options().minimum, options().final);
    const tile = { z: 2, x: 2, y: 2 };
    expect(terrainRegionTilePriority(airborne, tile, { min: 0, max: 0 })).toBeNull();
    expect(terrainRegionTilePriority(airborne, tile, { min: -500, max: 9000 })).not.toBeNull();
    expect(terrainRegionTilePriority(airborne, tile, { min: 1400, max: 1600 })).not.toBeNull();
    const descending = createTerrainRegionDemand({ ...airborne.region,
      cone: { directionEcef: { x: -1, y: 0, z: 0 }, lengthMeters: 1500, halfAngleDeg: 15 } }, options().minimum, options().final);
    expect(terrainRegionTilePriority(descending, tile, { min: 0, max: 0 })).not.toBeNull();
    // Coarse ECEF triangles can sag below their vertex heights. Do not use
    // a lower height cutoff to exclude a volume below those vertices.
    const below = createTerrainRegionDemand({ center: { latDeg: 0, lonDeg: 0, altitudeMeters: -1500 }, radiusMeters: 200 }, options().minimum, options().final);
    expect(terrainRegionTilePriority(below, tile, { min: 0, max: 0 })).not.toBeNull();
  });
  const demand = createTerrainRegionDemand({ ...options().region,
    cone: { directionEcef: { x: 0, y: 1, z: 0 }, lengthMeters: 1000, halfAngleDeg: 15 } }, options().minimum, options().final);
  const priorityAt = (x: number, y: number, z: number) => terrainRegionPriority(demand,
    point => Vector3.Distance(point, new Vector3(6378138 + x, y, z)));
  it("covers the sphere and every cone slice edge, including points away from the motion axis", () => {
    expect(priorityAt(0, 0, 0)).toBe(0);
    for (let reach = 20; reach <= 1000; reach += 20) {
      expect(priorityAt(0, reach, reach * Math.tan(Math.PI / 12))).not.toBeNull();
    }
    expect(priorityAt(0, -100, 0)).toBeNull(); expect(priorityAt(0, 500, 1000)).toBeNull();
  });
  it("refines region tiles with no render camera and preserves full globe coverage", () => {
    const selection = selectTerrain({ view: null, focus: null, targetPx: 4, errorPerSpacing: .25, segments: 64,
      minLevel: 0, maxLevel: 16, maxTiles: 2000, hysteresis: { refineAbove: 1.2, coarsenBelow: .8 }, previous: null,
      boundsFor: () => ({ min: 0, max: 0 }), regionRequirement: (tile, heights) => {
        const priority = terrainRegionTilePriority(demand, tile, heights); return priority === null ? null : { level: 16, priority };
      } });
    const here = selection.leaves.filter(leaf => leaf.regionLevel !== undefined);
    expect(here.length).toBeGreaterThan(0); expect(here.every(leaf => leaf.tile.z === 16)).toBe(true);
    expect(selection.truncated).toBe(false);
    expect(selection.leaves.some(leaf => leaf.regionLevel === undefined && leaf.tile.z < 16)).toBe(true);
  });
  it("rejects invalid targets and degenerate motion direction", () => {
    expect(() => validateTerrainRegion({ ...options(), final: { googleErrorMeters: 9, rasterZoom: 16 } })).toThrow();
    expect(() => validateTerrainRegion({ ...options(), region: { ...options().region,
      cone: { directionEcef: { x: 0, y: 0, z: 0 }, lengthMeters: 10, halfAngleDeg: 15 } } })).toThrow();
  });
});

it("keeps center-height discovery active after an empty airborne volume is ready", () => {
  let ground: number | null = null;
  const begin = vi.fn(), end = vi.fn();
  const owner = createTerrainRegions({ nowMs: () => 0, sourceGeneration: () => 1,
    coverage: () => coverage(0, 0), groundHeight: () => ground, unavailableReason: () => null,
    beginContinuous: begin, endContinuous: end, requestRender: vi.fn() });
  const lease = owner.prepare(options()); owner.tick(200);
  expect(lease.read()).toMatchObject({ finalReady: true, groundHeightMeters: null });
  expect(end).not.toHaveBeenCalled(); expect(owner.demands()[0].supportRequired).toBe(true);
  ground = 250; owner.tick(400);
  expect(lease.read().groundHeightMeters).toBe(250); expect(end).toHaveBeenCalledOnce();
  expect(owner.demands()[0].supportRequired).toBe(false); owner.dispose();
});
