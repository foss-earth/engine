import { describe, expect, it } from "vitest";
import { childTiles, tileContains, tileKey, type TileId } from "./imageryGeometry";
import {
  createImagerySelector,
  estimateFocusPages,
  imageKey,
  measureImageryView,
  type ImageryPlan,
  type ImageryPlanLeaf,
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

/** The calibration the catalogue starts from. */
const HYSTERESIS = { refineAbove: 1.2, coarsenBelow: 0.8, coarsenAfterMs: 500, pinMs: 1000 };

function input(view: TestViewOptions, overrides: Partial<ImagerySelectionInput> = {}): ImagerySelectionInput {
  return {
    view: createTestView(view),
    source: PHOTO,
    offset: 0,
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }) },
    availability: { isResident: () => true, isMissing: () => false },
    maxPages: 4096,
    maxNodes: 12_000,
    hysteresis: HYSTERESIS,
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
  it("measures disjoint root fallback outside selected leaves without a new selection", () => {
    const root = { z: 2, x: 0, y: 0 };
    const leaf = { z: 4, x: 1, y: 1 };
    const measured = measureImageryView(input(OVERHEAD), [leaf], [root]);
    expect(measured).toHaveLength(7);
    expect(measured.map(region => region.tile)).toContainEqual(leaf);
    expect(measured.reduce((sum, region) => sum + 4 ** (root.z - region.tile.z), 0)).toBe(1);
    for (const region of measured) for (const other of measured) {
      if (region === other) continue;
      expect(tileContains(region.tile, other.tile)).toBe(false);
    }
  });

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

  it.each([1, 3])("keeps resident detail when an optional ancestor %i levels above arrives missing", (gap) => {
    const selector = createImagerySelector();
    const resident = new Set<string>();
    const missing = new Set<string>();
    const availability = {
      isResident: (key: string) => resident.has(key),
      isMissing: (key: string) => missing.has(key),
    };
    const initial = selector.step(input(OVERHEAD, { availability }), Infinity).plan!;
    for (const leaf of initial.leaves) resident.add(leaf.imageKey);
    for (const root of initial.coverage) resident.add(imageKey(PHOTO, root, null));

    // A fallback request may finish after every selected fine image has
    // loaded. No camera, surface, target or budget changed in the meantime.
    const detailed = initial.leaves.reduce((best, leaf) => leaf.screenArea > best.screenArea ? leaf : best);
    const ancestor = { z: detailed.tile.z - gap, x: detailed.tile.x >> gap, y: detailed.tile.y >> gap };
    const ancestorKey = imageKey(PHOTO, ancestor, null);
    expect(ancestor.z).toBeGreaterThan(2);
    expect(resident.has(ancestorKey)).toBe(false);
    missing.add(ancestorKey);

    const after = selector.step(input(OVERHEAD, { availability, now: 2000 }), Infinity).plan!;
    expectRefinementOf(initial, after);
    expect(after.limits).toEqual(initial.limits);
  });

  it("stops speculative refinement below a missing ancestor when no selected descendant has loaded", () => {
    const selector = createImagerySelector();
    const initial = selector.step(input(OVERHEAD, { availability: { isResident: () => false, isMissing: () => false } }), Infinity).plan!;
    const detailed = initial.leaves.reduce((best, leaf) => leaf.screenArea > best.screenArea ? leaf : best);
    const ancestor = { z: detailed.tile.z - 3, x: detailed.tile.x >> 3, y: detailed.tile.y >> 3 };
    const ancestorKey = imageKey(PHOTO, ancestor, null);
    const after = selector.step(input(OVERHEAD, {
      availability: { isResident: () => false, isMissing: key => key === ancestorKey },
      now: 2000,
    }), Infinity).plan!;
    expect(after.leaves.find(leaf => leaf.imageKey === ancestorKey)?.limit).toBe("source");
    expect(after.leaves.some(leaf => leaf.tile.z > ancestor.z && tileContains(ancestor, leaf.tile))).toBe(false);
  });

  describe("below an image the source does not have", () => {
    /** A selector that has shown the overhead view, with the residency the test sets. */
    function shown(source = PHOTO) {
      const selector = createImagerySelector();
      const resident = new Set<string>();
      const missing = new Set<string>();
      let revision = 0;
      const availability = {
        isResident: (key: string) => resident.has(key),
        isMissing: (key: string) => missing.has(key),
        getRevision: () => revision,
      };
      const initial = selector.step(input(OVERHEAD, { source, availability }), Infinity).plan!;
      for (const root of initial.coverage) resident.add(imageKey(source, root, null));
      const detailed = initial.leaves.reduce((best, leaf) => leaf.screenArea > best.screenArea ? leaf : best);
      const above = (gap: number): TileId => ({ z: detailed.tile.z - gap, x: detailed.tile.x >> gap, y: detailed.tile.y >> gap });
      const under = (plan: ImageryPlan, tile: TileId) => plan.leaves.filter(leaf => tileContains(tile, leaf.tile));
      return {
        selector, resident, missing, availability, initial, above, under,
        changed: () => { revision += 1; },
        reselect: (overrides: Partial<ImagerySelectionInput> = {}) => selector.step(input(OVERHEAD, { source, availability, now: 2000, ...overrides }), Infinity).plan!,
      };
    }
    const keys = (leaves: ImageryPlanLeaf[]) => leaves.map(leaf => leaf.imageKey).sort();

    it("keeps resident leaves and the stand-ins shown for loading ones, and stops where nothing has loaded", () => {
      const test = shown();
      const ancestor = test.above(2);
      const [loaded, standingIn, ...empty] = childTiles(ancestor).filter(child => test.under(test.initial, child).length > 0);
      expect(empty.length).toBeGreaterThan(0);
      // One quadrant has loaded; another shows its own stand-in while its leaves load.
      for (const leaf of test.under(test.initial, loaded)) test.resident.add(leaf.imageKey);
      test.resident.add(imageKey(PHOTO, standingIn, null));
      test.missing.add(imageKey(PHOTO, ancestor, null));

      const after = test.reselect();
      expect(keys(test.under(after, loaded))).toEqual(keys(test.under(test.initial, loaded)));
      // Below a resident stand-in selection is as usual: its leaves are still asked for.
      expect(keys(test.under(after, standingIn))).toEqual(keys(test.under(test.initial, standingIn)));
      expect(test.under(after, standingIn).every(leaf => !leaf.presumedMissing && leaf.limit === null)).toBe(true);
      // Nothing resident shows the source has the rest: as before, it is not asked for,
      // and its region shows the nearest resident ancestor.
      for (const quadrant of empty) {
        expect(test.under(after, quadrant)).toEqual([expect.objectContaining({ key: tileKey(quadrant), limit: "source", shortfall: "missing", presumedMissing: true })]);
      }
      expect(after.leaves.some(leaf => leaf.key === tileKey(ancestor))).toBe(false);
      expect(after.shortfall.refinedPastMissing).toBe(1);
      expect(after.shortfall.regions.missing).toBe(empty.length);
    });

    it("refines past four missing children only toward resident grandchildren", () => {
      const test = shown();
      const parent = test.above(2);
      const children = childTiles(parent);
      for (const child of children) test.missing.add(imageKey(PHOTO, child, null));
      const [loaded, ...others] = children.filter(child => test.under(test.initial, child).length > 0);
      for (const leaf of test.under(test.initial, loaded)) test.resident.add(leaf.imageKey);

      const after = test.reselect();
      expect(keys(test.under(after, loaded))).toEqual(keys(test.under(test.initial, loaded)));
      for (const child of others) {
        // No unsupported expansion: each sibling stays one missing leaf.
        expect(test.under(after, child)).toEqual([expect.objectContaining({ key: tileKey(child), limit: "source", presumedMissing: true })]);
      }
      // With nothing resident below, the shortcut keeps the parent as before.
      test.resident.clear();
      for (const root of test.initial.coverage) test.resident.add(imageKey(PHOTO, root, null));
      test.changed();
      const bare = test.reselect({ now: 4000 });
      expect(test.under(bare, parent)).toEqual([expect.objectContaining({ key: tileKey(parent), limit: "source", shortfall: "missing" })]);
    });

    it("takes no evidence from another source version or from evicted imagery", () => {
      const nothingBelow = (test: ReturnType<typeof shown>, plan: ImageryPlan, ancestor: TileId) =>
        expect(test.under(plan, ancestor).map(leaf => leaf.key)).toEqual([tileKey(ancestor)]);
      // A new version of the source: the old version's images, still resident, are not its own.
      const switched = shown();
      for (const leaf of switched.initial.leaves) switched.resident.add(leaf.imageKey);
      const next = { ...PHOTO, version: "2" };
      switched.missing.add(imageKey(next, switched.above(3), null));
      nothingBelow(switched, switched.reselect({ source: next }), switched.above(3));
      // Evicted: what the plan showed is no longer resident.
      const evicted = shown();
      for (const leaf of evicted.initial.leaves) evicted.resident.add(leaf.imageKey);
      const ancestor = evicted.above(3);
      evicted.missing.add(imageKey(PHOTO, ancestor, null));
      expectRefinementOf(evicted.initial, evicted.reselect());
      for (const leaf of evicted.under(evicted.initial, ancestor)) evicted.resident.delete(leaf.imageKey);
      evicted.changed();
      nothingBelow(evicted, evicted.reselect({ now: 4000 }), ancestor);
    });

    it("keeps a resident variant below a missing standard image, and the standard image when a variant is missing", () => {
      const retina = { ...OVERHEAD, renderWidth: 2560, renderHeight: 1440, logicalWidth: 1280, logicalHeight: 720 };
      const selector = createImagerySelector();
      const resident = new Set<string>();
      const missing = new Set<string>();
      const availability = { isResident: (key: string) => resident.has(key), isMissing: (key: string) => missing.has(key) };
      const step = (now: number) => selector.step(input(retina, { source: CARTO, availability, now }), Infinity).plan!;
      const initial = step(0);
      const dense = initial.leaves.filter(leaf => leaf.variant === "2x" && leaf.tile.z > 4);
      expect(dense.length).toBeGreaterThan(0);
      for (const leaf of initial.leaves) resident.add(leaf.imageKey);
      for (const root of initial.coverage) resident.add(imageKey(CARTO, root, null));
      const leaf = dense.reduce((best, candidate) => candidate.screenArea > best.screenArea ? candidate : best);
      const parent = { z: leaf.tile.z - 1, x: leaf.tile.x >> 1, y: leaf.tile.y >> 1 };
      missing.add(imageKey(CARTO, parent, null));
      missing.add(imageKey(CARTO, leaf.tile, null));
      const after = step(2000);
      expectRefinementOf(initial, after);
      expect(after.leaves.find(candidate => candidate.key === leaf.key)).toMatchObject({ variant: "2x", limit: leaf.limit, presumedMissing: false });
      // A missing variant leaves the standard image to stand.
      missing.clear();
      missing.add(imageKey(CARTO, leaf.tile, "2x"));
      resident.add(imageKey(CARTO, leaf.tile, null));
      const standard = step(4000);
      expect(standard.leaves.find(candidate => candidate.key === leaf.key)).toMatchObject({ variant: null, imageKey: imageKey(CARTO, leaf.tile, null) });
    });

    it("does not discard imagery that arrives while a sliced traversal runs, and finishes while downloads continue", () => {
      const test = shown();
      const ancestor = test.above(2);
      const ancestorKey = imageKey(PHOTO, ancestor, null);
      test.missing.add(ancestorKey);
      const arriving = test.under(test.initial, ancestor).map(leaf => leaf.imageKey);
      // The ancestor's own decision asks whether it is missing; so does its
      // parent's four-children check, but only when it is the first child.
      const parent = { z: ancestor.z - 1, x: ancestor.x >> 1, y: ancestor.y >> 1 };
      const asksBeforeDecision = tileKey(childTiles(parent)[0]) === tileKey(ancestor) ? 1 : 0;
      let asked = 0;
      const availability = { ...test.availability, isMissing: (key: string) => {
        if (key === ancestorKey) asked += 1;
        return test.missing.has(key);
      } };
      // Each update's deadline has passed by its first clock check, so every
      // slice decides only a few nodes.
      let time = 0;
      const clock = () => (time += 0.01);
      let step = test.selector.step(input(OVERHEAD, { availability, now: 2000 }), time, clock);
      let steps = 1;
      let arrivedAfterDecision = 0;
      // Once the missing ancestor was decided with nothing resident below it,
      // its leaves arrive one per update, each shown meanwhile under the
      // previous plan; every update also changes residency elsewhere.
      while (!step.completed && steps < 10_000) {
        expect(step.plan).toBe(test.initial);
        if (asked > asksBeforeDecision && arriving.length > 0) {
          test.resident.add(arriving.shift()!);
          arrivedAfterDecision += 1;
        }
        test.changed();
        step = test.selector.step(input(OVERHEAD, { availability, now: 2000 }), time, clock);
        steps += 1;
      }
      expect(step.completed).toBe(true);
      expect(arrivedAfterDecision).toBeGreaterThan(0);
      const after = step.plan!;
      // Whatever arrived before the traversal finished is kept.
      for (const leaf of test.under(test.initial, ancestor)) {
        if (!test.resident.has(leaf.imageKey)) continue;
        expect(after.leaves.find(candidate => candidate.key === leaf.key), leaf.key).toMatchObject({ limit: null, presumedMissing: false });
      }
      expect(test.under(test.initial, ancestor).some(leaf => test.resident.has(leaf.imageKey))).toBe(true);
    });

    it("still coarsens when asked, merging only into imagery it can show", () => {
      const test = shown();
      for (const leaf of test.initial.leaves) test.resident.add(leaf.imageKey);
      const ancestor = test.above(2);
      test.missing.add(imageKey(PHOTO, ancestor, null));
      expectRefinementOf(test.initial, test.reselect());
      const finest = (plan: ImageryPlan) => Math.max(...test.under(plan, ancestor).map(leaf => leaf.tile.z));
      let plan = test.initial;
      for (let now = 2000; now <= 20_000; now += 500) {
        plan = test.reselect({ offset: -2, now });
        // Each merge needs its parent's image: those the source has load, as the runtime asks.
        for (const tile of plan.mergeCandidates) {
          const key = imageKey(PHOTO, tile, null);
          if (!test.missing.has(key)) test.resident.add(key);
        }
        test.changed();
      }
      expect(finest(plan)).toBeLessThan(finest(test.initial));
      // The missing image itself can never be shown, so its children stay.
      expect(test.under(plan, ancestor).every(leaf => leaf.tile.z > ancestor.z && !leaf.presumedMissing)).toBe(true);
      expect(Math.max(...plan.leaves.map(leaf => leaf.tile.z))).toBeLessThan(Math.max(...test.initial.leaves.map(leaf => leaf.tile.z)));
    });

    it("explains a page budget it reaches with at least the pages the view needs beyond it", () => {
      const test = shown();
      for (const leaf of test.initial.leaves) test.resident.add(leaf.imageKey);
      test.missing.add(imageKey(PHOTO, test.above(2), null));
      const tight = test.reselect({ maxPages: 24 });
      expect(tight.leaves.reduce((sum, leaf) => sum + leaf.pages, 0)).toBeLessThanOrEqual(24);
      expect(tight.limits).toContain("memory");
      expect(tight.shortfall.regions.pages).toBeGreaterThan(0);
      expect(tight.shortfall.morePages).toBeGreaterThanOrEqual(tight.shortfall.regions.pages);
    });

    it("tells detail a budget took away from detail it never reached", () => {
      // A view first selected under a tight budget has lost nothing.
      const never = select(input(OVERHEAD, { maxPages: 24 }));
      expect(never.shortfall.regions.pages).toBeGreaterThan(0);
      expect(never.shortfall.reduced).toEqual({ pages: 0, nodes: 0 });
      // The same budget after the whole view was shown merges regions that had finer imagery.
      const test = shown();
      for (const leaf of test.initial.leaves) test.resident.add(leaf.imageKey);
      const tight = test.reselect({ maxPages: 24 });
      expect(tight.shortfall.reduced.pages).toBeGreaterThan(0);
      expect(tight.shortfall.reduced.pages).toBeLessThanOrEqual(tight.shortfall.regions.pages);
      // Each merge is counted once: staying under the budget takes nothing more.
      expect(test.reselect({ maxPages: 24, now: 3000 }).shortfall.reduced).toEqual({ pages: 0, nodes: 0 });
      // The node cap is counted the same way, as its own cause.
      const capped = shown();
      for (const leaf of capped.initial.leaves) capped.resident.add(leaf.imageKey);
      const cut = capped.reselect({ maxNodes: 60 });
      expect(cut.truncated).toBe(true);
      expect(cut.shortfall.reduced.nodes).toBeGreaterThan(0);
      expect(cut.shortfall.reduced.pages).toBe(0);
    });
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

  it("counts a region that lies around the camera as on screen, so its limit is reported", () => {
    // Terrain patches so coarse that one image, 130 km wide, holds the whole view from 1500 m.
    const plan = select(input(OBLIQUE, { maxLevelFor: () => 8 }));
    const under = plan.leaves.filter(leaf => leaf.limit === "backend" && leaf.screenArea > 0);
    expect(under.length).toBeGreaterThan(0);
    for (const leaf of under) expect(leaf.tile.z).toBe(8);
    // The view is 1280 x 720 pixels and every part of it shows one of these regions.
    expect(under.reduce((sum, leaf) => sum + leaf.screenArea, 0)).toBeGreaterThan(0.5 * 1280 * 720);
    expect(Math.max(...under.map(leaf => leaf.screenArea))).toBeLessThanOrEqual(1280 * 720);
    expect(plan.limits).toEqual(["backend"]);
    expect(plan.shortfall.regions.binding).toBe(under.length);
    expect(plan.shortfall.bindingLevels).toEqual({ min: 8, max: 8 });
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
    expect(held.wakeAt).toBe(HYSTERESIS.pinMs);
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

describe("imagery around a focus point", () => {
  const focusAt = (latDeg: number, lonDeg: number, heightMeters = 0) => {
    const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
    const a = 6378137, e2 = 6.69437999014e-3;
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    return { x: (n + heightMeters) * Math.cos(lat) * Math.cos(lon), y: (n + heightMeters) * Math.cos(lat) * Math.sin(lon), z: (n * (1 - e2) + heightMeters) * Math.sin(lat) };
  };
  const focus = (mode: "around" | "both", overrides: Partial<import("./imagerySelector").ImageryFocus> = {}) => ({
    mode, position: focusAt(36.1, -112.1), radiusMeters: 5000, minDistanceMeters: 1500,
    pixelAngle: 0.8 / 720, offset: 0, horizonCull: true, ...overrides,
  });
  const leaves = (plan: ImageryPlan) => plan.leaves.map(leaf => `${leaf.key}:${leaf.variant ?? ""}`).sort();

  it("loads the same imagery whichever way the camera turns around the point", () => {
    const plans = [0, 90, 200, 310].map(headingDeg => select(input({ ...OBLIQUE, headingDeg }, { focus: focus("around") })));
    expect(plans[0].leaves.length).toBeGreaterThan(16);
    for (const plan of plans.slice(1)) expect(leaves(plan)).toEqual(leaves(plans[0]));
    // A camera looking away from the point changes nothing either.
    const away = select(input({ latDeg: 36.2, lonDeg: -112.0, altitudeMeters: 1500, pitchDeg: 80, headingDeg: 45 }, { focus: focus("around") }));
    expect(leaves(away)).toEqual(leaves(plans[0]));
  });

  it("refines nothing beyond the radius", () => {
    const plan = select(input(OBLIQUE, { focus: focus("around", { radiusMeters: 2000 }) }));
    const wide = select(input(OBLIQUE, { focus: focus("around", { radiusMeters: 50_000 }) }));
    expect(plan.leaves.length).toBeLessThan(wide.leaves.length);
    expect(Math.max(...plan.leaves.map(leaf => leaf.tile.z))).toBeGreaterThan(8);
  });

  it("adds the region to the view, never coarsening what the view asked for", () => {
    const view = select(input(OBLIQUE));
    const both = select(input(OBLIQUE, { focus: focus("both") }));
    expectRefinementOf(view, both);
    expect(both.leaves.length).toBeGreaterThan(view.leaves.length);
  });

  it("asks the region for less where its own offset is coarser, and measures it no nearer than the camera", () => {
    const normal = select(input(OBLIQUE, { focus: focus("around") }));
    const coarser = select(input(OBLIQUE, { focus: focus("around", { offset: -2 }) }));
    const farther = select(input(OBLIQUE, { focus: focus("around", { minDistanceMeters: 15_000 }) }));
    expect(coarser.leaves.length).toBeLessThan(normal.leaves.length);
    expect(farther.leaves.length).toBeLessThan(normal.leaves.length);
  });
});

describe("the focus region's page estimate", () => {
  const EARTH = 6_378_137;
  const region = (overrides: Partial<Parameters<typeof estimateFocusPages>[0]> = {}) => ({
    position: { x: EARTH, y: 0, z: 0 }, radiusMeters: 10_000, minDistanceMeters: 1000,
    pixelAngle: 1e-3, offset: 0, horizonCull: false, ...overrides,
  });

  it("grows with the square of the radius inside the camera's distance, and with its log beyond", () => {
    const perRing = (2 * Math.PI) / (256 * 1e-3) ** 2;
    expect(estimateFocusPages(region({ radiusMeters: 500 }))).toBeCloseTo(perRing / 4);
    expect(estimateFocusPages(region({ radiusMeters: 1000 }))).toBeCloseTo(perRing);
    expect(estimateFocusPages(region({ radiusMeters: 20_000 })) - estimateFocusPages(region()))
      .toBeCloseTo(perRing * 2 * Math.log(2));
  });

  it("costs four times the pages one level finer, and stops at the horizon when that is culled", () => {
    expect(estimateFocusPages(region({ offset: 1 }))).toBeCloseTo(4 * estimateFocusPages(region()));
    // 1 km up, the horizon is about 113 km away.
    const horizon = Math.sqrt(2 * EARTH * 1000 + 1000 ** 2);
    expect(estimateFocusPages(region({ radiusMeters: 200_000, horizonCull: true })))
      .toBeCloseTo(estimateFocusPages(region({ radiusMeters: horizon })));
  });
});
