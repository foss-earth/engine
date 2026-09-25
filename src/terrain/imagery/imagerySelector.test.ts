import { describe, expect, it } from "vitest";
import { tileContains, type TileId } from "./imageryGeometry";
import {
  createImagerySelector,
  IMAGERY_SELECTION_CONSTANTS,
  imageKey,
  type ImageryPlan,
  type ImagerySelectionInput,
  type ImagerySourceCapabilities,
} from "./imagerySelector";
import { createTestView, type TestViewOptions } from "./imageryTestViews";

const PHOTO: ImagerySourceCapabilities = {
  id: "photo", version: "1", kind: "photographic", minLevel: 0, maxLevel: 19,
  tileWidth: 256, tileHeight: 256, variants: [],
};
const CARTO: ImagerySourceCapabilities = {
  id: "carto", version: "1", kind: "cartographic", minLevel: 0, maxLevel: 19,
  tileWidth: 256, tileHeight: 256, variants: [{ id: "2x", width: 512, height: 512 }],
};

function input(view: TestViewOptions, overrides: Partial<ImagerySelectionInput> = {}): ImagerySelectionInput {
  return {
    view: createTestView(view),
    source: PHOTO,
    offset: 0,
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }) },
    availability: { isResident: () => true, isMissing: () => false },
    maxPages: 4096,
    now: 0,
    ...overrides,
  };
}

function select(value: ImagerySelectionInput): ImageryPlan {
  const selector = createImagerySelector();
  const step = selector.step(value, Infinity);
  expect(step.completed).toBe(true);
  return step.plan!;
}

/** The level of the leaf covering the view's center: the nadir for pitch 0. */
function levelUnder(plan: ImageryPlan, latDeg: number, lonDeg: number): number {
  const leaf = plan.leaves.find(candidate => {
    const n = 2 ** candidate.tile.z;
    const x = ((lonDeg + 180) / 360) * n;
    const lat = (latDeg * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n;
    return Math.floor(x) === candidate.tile.x && Math.floor(y) === candidate.tile.y;
  });
  expect(leaf).toBeDefined();
  return leaf!.tile.z;
}

/** Every leaf of `coarse` is covered by itself or its descendants in `fine`. */
function expectRefinementOf(coarse: ImageryPlan, fine: ImageryPlan): void {
  for (const leaf of coarse.leaves) {
    const covering = fine.leaves.filter(candidate => tileContains(leaf.tile, candidate.tile) || tileContains(candidate.tile, leaf.tile));
    expect(covering.length, leaf.key).toBeGreaterThan(0);
    for (const candidate of covering) expect(candidate.tile.z, `${leaf.key} -> ${candidate.key}`).toBeGreaterThanOrEqual(leaf.tile.z);
  }
}

const OVERHEAD: TestViewOptions = { latDeg: 36.1, lonDeg: -112.1, altitudeMeters: 3000 };
const OBLIQUE: TestViewOptions = { latDeg: 36.1, lonDeg: -112.1, altitudeMeters: 1500, pitchDeg: 70, headingDeg: 30 };
const HORIZON: TestViewOptions = { latDeg: 47.6, lonDeg: -122.3, altitudeMeters: 300, pitchDeg: 88, headingDeg: 90 };

describe("projected imagery selection", () => {
  it("selects about one finer level when image pixels project twice as large", () => {
    const base = select(input({ ...OVERHEAD, renderWidth: 1280, renderHeight: 720 }));
    const doubled = select(input({ ...OVERHEAD, renderWidth: 2560, renderHeight: 1440 }));
    expect(levelUnder(doubled, OVERHEAD.latDeg, OVERHEAD.lonDeg) - levelUnder(base, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBe(1);
    const halfAltitude = select(input({ ...OVERHEAD, altitudeMeters: 1500 }));
    expect(levelUnder(halfAltitude, OVERHEAD.latDeg, OVERHEAD.lonDeg) - levelUnder(base, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBe(1);
  });

  it("meets the target wherever the source allows it", () => {
    for (const view of [OVERHEAD, OBLIQUE, HORIZON]) {
      const plan = select(input(view));
      for (const leaf of plan.leaves) {
        if (leaf.limit === null) expect(leaf.footprintPx, leaf.key).toBeLessThanOrEqual(plan.physicalTarget + 1e-9);
      }
      expect(plan.limits).toEqual([]);
    }
  });

  it("chooses finer imagery near the camera than toward the horizon", () => {
    const plan = select(input(HORIZON));
    const levels = plan.leaves.map(leaf => leaf.tile.z);
    // The nadir is out of view; the nearest visible ground is a few hundred metres ahead.
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(16);
  });

  it("never shrinks coverage or asks for coarser imagery when detail increases", () => {
    for (const view of [OVERHEAD, OBLIQUE, HORIZON]) {
      let previous: ImageryPlan | null = null;
      for (const offset of [-3, -2, -1, -0.5, 0, 0.25, 0.5, 1]) {
        const plan = select(input(view, { offset }));
        if (previous) expectRefinementOf(previous, plan);
        previous = plan;
      }
    }
  });

  it("stays monotonic under a tight page budget and reports the memory limit", () => {
    let previous: ImageryPlan | null = null;
    for (const offset of [-2, -1, 0, 1]) {
      const plan = select(input(HORIZON, { offset, maxPages: 40 }));
      expect(plan.leaves.reduce((sum, leaf) => sum + leaf.pages, 0)).toBeLessThanOrEqual(40);
      if (previous) expectRefinementOf(previous, plan);
      previous = plan;
    }
    expect(previous!.limits).toContain("memory");
  });

  it("works with an orthographic projection", () => {
    const plan = select(input({ ...OVERHEAD, orthographicHalfHeight: 2000 }));
    const level = levelUnder(plan, OVERHEAD.latDeg, OVERHEAD.lonDeg);
    const wider = select(input({ ...OVERHEAD, orthographicHalfHeight: 4000 }));
    expect(level - levelUnder(wider, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBe(1);
  });

  it("is unchanged by a floating-origin world transform", () => {
    const plain = select(input(OBLIQUE));
    const moved = select(input({ ...OBLIQUE, worldTransform: { rotationZDeg: 33, translation: { x: -4e6, y: 2e6, z: -1e6 } } }));
    expect(moved.leaves.map(leaf => leaf.key).sort()).toEqual(plain.leaves.map(leaf => leaf.key).sort());
  });

  it("reacts to rotation and field of view, not only position", () => {
    const plan = select(input(OBLIQUE));
    const turned = select(input({ ...OBLIQUE, headingDeg: OBLIQUE.headingDeg! + 120 }));
    const zoomed = select(input({ ...OBLIQUE, fovYDeg: 20 }));
    expect(turned.leaves.map(leaf => leaf.key)).not.toEqual(plan.leaves.map(leaf => leaf.key));
    expect(zoomed.leaves.map(leaf => leaf.key)).not.toEqual(plan.leaves.map(leaf => leaf.key));
  });

  it("covers both sides of the dateline", () => {
    const plan = select(input({ latDeg: 0, lonDeg: 179.99, altitudeMeters: 2_000_000, pitchDeg: 0 }));
    const east = plan.leaves.filter(leaf => leaf.tile.x === 2 ** leaf.tile.z - 1 && leaf.tile.z > 2);
    const west = plan.leaves.filter(leaf => leaf.tile.x === 0 && leaf.tile.z > 2);
    expect(east.length).toBeGreaterThan(0);
    expect(west.length).toBeGreaterThan(0);
  });

  it("handles views over the poles and of the whole globe", () => {
    const pole = select(input({ latDeg: 84, lonDeg: 10, altitudeMeters: 400_000, pitchDeg: 30 }));
    expect(pole.leaves.length).toBeGreaterThan(0);
    expect(pole.leaves.every(leaf => Number.isFinite(leaf.footprintPx))).toBe(true);
    const globe = select(input({ latDeg: 20, lonDeg: 0, altitudeMeters: 20_000_000 }));
    expect(Math.max(...globe.leaves.map(leaf => leaf.tile.z))).toBeLessThanOrEqual(4);
    // The far side of the globe is not selected.
    expect(globe.leaves.some(leaf => leaf.tile.z >= 3 && Math.abs(leaf.tile.x / 2 ** leaf.tile.z - 0.5) > 0.4)).toBe(false);
  });

  it("stays bounded for a camera almost on the ground", () => {
    const plan = select(input({ latDeg: 10, lonDeg: 10, altitudeMeters: 2, pitchDeg: 80, near: 0.1 }, { maxNodes: 4000 }));
    expect(plan.nodesEvaluated).toBeLessThanOrEqual(4000);
    expect(Math.max(...plan.leaves.map(leaf => leaf.tile.z))).toBe(PHOTO.maxLevel);
    expect(plan.limits).toContain("source");
  });

  it("stops at the source's ceiling and keeps parents where children are missing", () => {
    const capped = select(input(OVERHEAD, { source: { ...PHOTO, maxLevel: 12 } }));
    expect(Math.max(...capped.leaves.map(leaf => leaf.tile.z))).toBe(12);
    expect(capped.limits).toContain("source");

    const missingBelow = (tile: TileId) => tile.z > 14;
    const missing = select(input(OVERHEAD, {
      availability: {
        isResident: () => true,
        isMissing: key => missingBelow({ z: Number(key.split("/").at(-3)), x: 0, y: 0 }),
      },
    }));
    expect(Math.max(...missing.leaves.map(leaf => leaf.tile.z))).toBe(14);
    expect(missing.limits).toContain("source");
  });

  it("does not refine below a tile the source is missing, before its children were ever asked for", () => {
    // A coastline: every other level-14 column came back missing; nothing
    // deeper has been requested, so nothing deeper is known to be missing.
    const missing = (tile: TileId) => tile.z === 14 && tile.x % 2 === 1;
    const parse = (key: string): TileId => {
      const [z, x, y] = key.split("/").slice(-3).map(Number);
      return { z, x, y };
    };
    const plan = select(input(OVERHEAD, { availability: { isResident: () => true, isMissing: key => missing(parse(key)) } }));
    for (const leaf of plan.leaves) {
      let { z, x, y } = leaf.tile;
      while (z > 0) {
        z -= 1; x >>= 1; y >>= 1;
        expect(missing({ z, x, y })).toBe(false);
      }
      if (missing(leaf.tile)) expect(leaf.limit).toBe("source");
    }
    expect(plan.leaves.some(leaf => missing(leaf.tile) && leaf.screenArea > 0)).toBe(true);
    expect(Math.max(...plan.leaves.map(leaf => leaf.tile.z))).toBeGreaterThan(14);
    expect(plan.limits).toContain("source");
  });

  it("does not refine outside the source's coverage", () => {
    const plan = select(input({ latDeg: -40, lonDeg: 150, altitudeMeters: 3000 }, {
      source: { ...PHOTO, coverage: { west: -180, south: -14, east: 180, north: 72 } },
    }));
    // Tiles reaching into the covered band still refine; wholly outside ones stop.
    expect(Math.max(...plan.leaves.map(leaf => leaf.tile.z))).toBeLessThanOrEqual(4);
    expect(plan.limits).toContain("source");
  });

  it("caps levels where the binding cannot show them", () => {
    const plan = select(input(OVERHEAD, { maxLevelFor: () => 10 }));
    expect(Math.max(...plan.leaves.map(leaf => leaf.tile.z))).toBe(10);
    expect(plan.limits).toContain("backend");
  });
});

describe("cartographic sources", () => {
  const retina = { ...OVERHEAD, renderWidth: 2560, renderHeight: 1440, logicalWidth: 1280, logicalHeight: 720 };

  it("keeps map scale when only the device pixel ratio changes", () => {
    const dpr1 = select(input(OVERHEAD, { source: CARTO }));
    const dpr2 = select(input(retina, { source: CARTO }));
    expect(dpr2.leaves.map(leaf => leaf.key).sort()).toEqual(dpr1.leaves.map(leaf => leaf.key).sort());
    // The sharper screen asks for the denser variant instead.
    expect(dpr1.leaves.every(leaf => leaf.variant === null)).toBe(true);
    expect(dpr2.leaves.some(leaf => leaf.variant === "2x")).toBe(true);
  });

  it("reports the source limit where no verified variant exists, and never guesses one", () => {
    const plan = select(input(retina, { source: { ...CARTO, variants: [] } }));
    expect(plan.leaves.every(leaf => leaf.variant === null)).toBe(true);
    expect(plan.limits).toContain("source");
  });

  it("uses parents for coarser offsets and never advances the level for finer ones", () => {
    const normal = select(input(OVERHEAD, { source: CARTO }));
    const finer = select(input(OVERHEAD, { source: CARTO, offset: 1 }));
    const coarser = select(input(OVERHEAD, { source: CARTO, offset: -1 }));
    expect(finer.leaves.map(leaf => leaf.key).sort()).toEqual(normal.leaves.map(leaf => leaf.key).sort());
    expect(finer.leaves.some(leaf => leaf.variant === "2x")).toBe(true);
    expect(levelUnder(normal, OVERHEAD.latDeg, OVERHEAD.lonDeg) - levelUnder(coarser, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBe(1);
  });

  it("counts variant pages against the budget", () => {
    const plan = select(input(retina, { source: CARTO, maxPages: 30 }));
    expect(plan.leaves.reduce((sum, leaf) => sum + leaf.pages, 0)).toBeLessThanOrEqual(30);
  });
});

describe("stability", () => {
  it("returns the same plan for a stationary view", () => {
    const selector = createImagerySelector();
    const first = selector.step(input(OBLIQUE, { now: 0 }), Infinity).plan!;
    const second = selector.step(input(OBLIQUE, { now: 16 }), Infinity).plan!;
    expect(second.leaves.map(leaf => leaf.imageKey)).toEqual(first.leaves.map(leaf => leaf.imageKey));
    expect(second.wakeAt).toBeNull();
  });

  it("bounds level changes while the camera jitters around a threshold", () => {
    const selector = createImagerySelector();
    let changes = 0;
    let previous: number | null = null;
    for (let frame = 0; frame < 120; frame++) {
      const altitude = 3000 * (1 + 0.06 * Math.sin(frame * 1.7));
      const plan = selector.step(input({ ...OVERHEAD, altitudeMeters: altitude }, { now: frame * 16 }), Infinity).plan!;
      const level = levelUnder(plan, OVERHEAD.latDeg, OVERHEAD.lonDeg);
      if (previous !== null && level !== previous) changes += 1;
      previous = level;
    }
    // Refinement may happen once; merging waits and pins, so there is no flip-flop.
    expect(changes).toBeLessThanOrEqual(1);
  });

  it("merges only after the coarsening delay and the pin, and says when to look again", () => {
    const selector = createImagerySelector();
    const near = select(input(OVERHEAD));
    const nearLevel = levelUnder(near, OVERHEAD.latDeg, OVERHEAD.lonDeg);
    selector.step(input(OVERHEAD, { now: 0 }), Infinity);
    const far = { ...OVERHEAD, altitudeMeters: 12_000 };
    const held = selector.step(input(far, { now: 100 }), Infinity).plan!;
    expect(levelUnder(held, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBe(nearLevel);
    expect(held.wakeAt).toBe(IMAGERY_SELECTION_CONSTANTS.pinMs);
    const stillHeld = selector.step(input(far, { now: 700 }), Infinity).plan!;
    expect(levelUnder(stillHeld, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBe(nearLevel);
    let merged = stillHeld;
    for (let now = 1000; now <= 4000; now += 500) merged = selector.step(input(far, { now }), Infinity).plan!;
    // Four times the altitude is two levels coarser; hysteresis may keep one of them.
    const fresh = levelUnder(select(input(far)), OVERHEAD.latDeg, OVERHEAD.lonDeg);
    expect(fresh).toBe(nearLevel - 2);
    expect(levelUnder(merged, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBeLessThan(nearLevel);
    expect([fresh, fresh + 1]).toContain(levelUnder(merged, OVERHEAD.latDeg, OVERHEAD.lonDeg));
  });

  it("does not merge into a parent that cannot be shown", () => {
    const selector = createImagerySelector();
    selector.step(input(OVERHEAD, { now: 0 }), Infinity);
    const far = { ...OVERHEAD, altitudeMeters: 12_000 };
    const plan = selector.step(input(far, {
      now: 5000,
      availability: { isResident: () => false, isMissing: () => false },
    }), Infinity).plan!;
    const nearLevel = levelUnder(select(input(OVERHEAD)), OVERHEAD.latDeg, OVERHEAD.lonDeg);
    expect(levelUnder(plan, OVERHEAD.latDeg, OVERHEAD.lonDeg)).toBe(nearLevel);
    // It asks for the parents it would merge into.
    expect(plan.mergeCandidates.length).toBeGreaterThan(0);
  });

  it("does not flip levels while the slider moves by quarter steps around a threshold", () => {
    const selector = createImagerySelector();
    let changes = 0;
    let previous: string | null = null;
    for (let frame = 0; frame < 60; frame++) {
      const offset = frame % 2 === 0 ? 0 : 0.25;
      const plan = selector.step(input(OBLIQUE, { now: frame * 16, offset }), Infinity).plan!;
      const keys = plan.leaves.map(leaf => leaf.key).sort().join();
      if (previous !== null && keys !== previous) changes += 1;
      previous = keys;
    }
    expect(changes).toBeLessThanOrEqual(1);
  });
});

describe("bounded work", () => {
  it("yields at the deadline, keeps the previous plan, and finishes to the same result", () => {
    const whole = select(input(HORIZON));
    const selector = createImagerySelector();
    let time = 0;
    const clock = () => (time += 0.01);
    let step = selector.step(input(HORIZON), 0.2, clock);
    expect(step.running).toBe(true);
    expect(step.plan).toBeNull();
    let guard = 0;
    while (!step.completed && guard++ < 10_000) step = selector.step(input(HORIZON), time + 0.2, clock);
    expect(step.plan!.leaves.map(leaf => leaf.imageKey)).toEqual(whole.leaves.map(leaf => leaf.imageKey));
  });

  it("marks a traversal cut short by the node cap", () => {
    const plan = select(input(HORIZON, { maxNodes: 60 }));
    expect(plan.truncated).toBe(true);
    expect(plan.nodesEvaluated).toBeLessThanOrEqual(64);
    expect(plan.limits).toContain("backend");
  });

  it("keys residency by source, version, variant and tile", () => {
    expect(imageKey(CARTO, { z: 3, x: 1, y: 2 }, "2x")).toBe("carto@1/2x/3/1/2");
    expect(imageKey(PHOTO, { z: 3, x: 1, y: 2 }, null)).toBe("photo@1/std/3/1/2");
  });
});
