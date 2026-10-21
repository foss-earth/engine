import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { geodeticToEcef } from "../../../src/camera/cameraMath.js";
import { lonLatToTileXY, tileLatDeg, tileLonDeg, type TileId } from "../../../src/terrain/imagery/imageryGeometry.js";
import {
  createImageryMeasurementCache,
  createImagerySelector,
  measureImageryView,
  type ImageryPlan,
  type ImagerySelectionInput,
  type ImagerySourceCapabilities,
  type ImagerySurface,
} from "../../../src/terrain/imagery/imagerySelector.js";
import { createTestView, type TestViewOptions } from "../../../src/terrain/imagery/imageryTestViews.js";

// The plans and measurements below were taken from the shipped selector, which
// asked the surface for every height each time; one that reuses heights must
// give the same leaves, footprints and areas, bit for bit.
const SHIPPED_DIGEST = "b2a7e123117cd19b3ce19096c5d40df6524d12468d361f1490b4a4750eed8100";
// The same for 400 random cases (`randomCase`), from the selector at engine `b2ddff9`.
const SHIPPED_RANDOM_DIGEST = "d28ae1399bcaf036109288e05c3bc881e7a91d11fb3bb85b989f8e32fafeb225";

const PHOTO: ImagerySourceCapabilities = {
  id: "photo", version: "1", kind: "photographic", minLevel: 0, maxLevel: 19,
  tileWidth: 256, tileHeight: 256, variants: [],
};
const CARTO: ImagerySourceCapabilities = {
  id: "carto", version: "1", kind: "cartographic", minLevel: 0, maxLevel: 19,
  tileWidth: 256, tileHeight: 256, variants: [{ id: "2x", width: 512, height: 512 }],
};
const at = (latDeg: number, lonDeg: number, altitude: number) => geodeticToEcef(latDeg * Math.PI / 180, lonDeg * Math.PI / 180, altitude);
const CANYON: TestViewOptions = { latDeg: 36.1, lonDeg: -112.1, altitudeMeters: 1500, pitchDeg: 70, headingDeg: 30 };
const CASES: Array<{ name: string; view: TestViewOptions; source?: ImagerySourceCapabilities; overrides?: Partial<ImagerySelectionInput> }> = [
  { name: "overhead", view: { latDeg: 44.97, lonDeg: -93.23, altitudeMeters: 3000 } },
  { name: "oblique", view: CANYON },
  { name: "near the horizon", view: { latDeg: 47.6, lonDeg: -122.3, altitudeMeters: 300, pitchDeg: 88, headingDeg: 90 } },
  { name: "antimeridian", view: { latDeg: -16.5, lonDeg: 179.97, altitudeMeters: 2500, pitchDeg: 60, headingDeg: 90 } },
  { name: "whole globe", view: { latDeg: 10, lonDeg: 179.999, altitudeMeters: 8_000_000 } },
  { name: "past the Mercator limit", view: { latDeg: 84.9, lonDeg: 20, altitudeMeters: 40_000, pitchDeg: 50, headingDeg: 10 } },
  { name: "cartographic", view: CANYON, source: CARTO },
  { name: "refine point", view: CANYON, overrides: { refineFrom: { position: at(36.12, -112.05, 900), minDistanceMeters: 2400, pixelAngle: 0.8 / 720 } } },
  { name: "focus, both", view: CANYON, overrides: { focus: { mode: "both", position: at(36.2, -112.2, 1200), radiusMeters: 20_000, minDistanceMeters: 5000, pixelAngle: 0.8 / 720, offset: 0, horizonCull: true } } },
  { name: "focus, around", view: CANYON, overrides: { focus: { mode: "around", position: at(36.0, -111.9, 800), radiusMeters: 8000, minDistanceMeters: 1500, pixelAngle: 0.8 / 720, offset: -1, horizonCull: false } } },
];

/** Uneven ground, unknown in patches when `unknown`, and uneven bounds per tile. */
function ground(unknown: boolean, shift = 0) {
  const heightAt = (lat: number, lon: number): number | null => unknown && Math.sin(lat * 3.1 + lon * 1.7) > 0.6 ? null
    : Math.sin(lat * 0.13 + shift) * 1200 + Math.cos(lon * 0.07) * 200 + Math.sin(lat * 40 + lon * 31) * 90 + lat * 0.000000123;
  const boundsFor = (tile: TileId) => {
    const seed = ((tile.z * 73856093) ^ (tile.x * 19349663) ^ (tile.y * 83492791)) >>> 0;
    return { min: -1600 + (seed % 300), max: 1500 + (seed >>> 9) % 400 };
  };
  return { heightAt, boundsFor };
}

/** The surface three ways: scalar heights, packed heights, and packed heights with a revision. */
function surfaces(unknown: boolean) {
  const { heightAt, boundsFor } = ground(unknown);
  const counts = { packed: 0, revised: 0 };
  const packed = (count: "packed" | "revised") => (coordinates: Float64Array): Float64Array => {
    counts[count] += coordinates.length / 2;
    const heights = new Float64Array(coordinates.length / 2);
    for (let i = 0; i < heights.length; i++) heights[i] = heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN;
    return heights;
  };
  const scalar: ImagerySurface = { heightAt, boundsFor };
  const batched: ImagerySurface = { heightAt, boundsFor, heightsAt: packed("packed") };
  const revised: ImagerySurface & { getRevision(): number } = { heightAt, boundsFor, heightsAt: packed("revised"), getRevision: () => 7 };
  return { scalar, batched, revised, counts };
}

function input(view: TestViewOptions, surface: ImagerySurface, source = PHOTO, overrides: Partial<ImagerySelectionInput> = {}): ImagerySelectionInput {
  return {
    view: createTestView({ renderWidth: 1280, renderHeight: 720, ...view }), source, offset: 0, surface,
    availability: { isResident: () => true, isMissing: () => false }, maxPages: 4096, maxNodes: 12_000,
    hysteresis: { refineAbove: 1.2, coarsenBelow: 0.8, coarsenAfterMs: 500, pinMs: 1000 }, now: 0, ...overrides,
  };
}

/** A plan, without its CPU time, and the view's measurement of its leaves and coverage. */
function outcome(value: ImagerySelectionInput) {
  const step = createImagerySelector(() => 0).step(value, Infinity);
  expect(step.completed).toBe(true);
  const plan: ImageryPlan = { ...step.plan!, cpuMs: 0 };
  const measured = measureImageryView(value, plan.leaves.map(leaf => leaf.tile), plan.coverage);
  const pages = measureImageryView(value, plan.leaves.map(leaf => leaf.tile));
  return { plan, measured, pages };
}

/** Every value, numbers by their bits (NaN as one value), keys sorted. */
function digestOf(value: unknown): string {
  const hash = createHash("sha256");
  const visit = (item: unknown): void => {
    if (typeof item === "number") {
      if (Number.isNaN(item)) hash.update("n:NaN;");
      else hash.update(new Uint8Array(Float64Array.of(item).buffer));
    } else if (Array.isArray(item)) { hash.update(`[${item.length}`); item.forEach(visit); hash.update("]"); }
    else if (item && typeof item === "object") {
      for (const key of Object.keys(item).sort()) { hash.update(`${key}:`); visit((item as Record<string, unknown>)[key]); }
      hash.update("}");
    } else hash.update(`${typeof item}:${String(item)};`);
  };
  visit(value);
  return hash.digest("hex");
}

/**
 * A random view, source, ground and focus from a seed: altitudes from half a
 * metre to ten thousand kilometres, grazing views, near planes far out, the
 * poles, the antimeridian, flat and unknown ground, and scalar, packed or
 * revised heights. Fixed cases miss tiles that only their nearest point keeps
 * above the horizon; these reach them.
 */
function randomCase(seed: number): ImagerySelectionInput {
  let state = seed >>> 0;
  const random = (): number => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
  const latDeg = random() < 0.2 ? pick([-89.9, -85.05, -84.9, 0, 84.9, 85.05, 89.9]) + (random() - 0.5) * 0.2 : (random() - 0.5) * 178;
  const lonDeg = random() < 0.2 ? pick([-180, 180, 0]) + (random() - 0.5) * 0.05 : (random() - 0.5) * 360;
  const view: TestViewOptions = {
    latDeg, lonDeg,
    altitudeMeters: random() < 0.1 ? pick([0.5, 2, -50]) : 10 ** (random() * 7),
    pitchDeg: random() < 0.4 ? 75 + random() * 15 : random() * 90,
    headingDeg: random() * 360,
    fovYDeg: 20 + random() * 80,
    renderWidth: pick([1280, 1080, 640, 333]), renderHeight: pick([720, 2400, 480, 1001]),
    near: random() < 0.3 ? 10 ** (random() * 3.5) : undefined,
    orthographicHalfHeight: random() < 0.05 ? 10 ** (2 + random() * 5) : undefined,
  };
  if (random() < 0.3) { view.logicalWidth = Math.round(view.renderWidth! / 2.625); view.logicalHeight = Math.round(view.renderHeight! / 2.625); }
  const side = pick([256, 512]);
  const source: ImagerySourceCapabilities = {
    id: "s", version: "1", kind: random() < 0.3 ? "cartographic" : "photographic", minLevel: 0, maxLevel: pick([19, 22, 12]),
    tileWidth: side, tileHeight: random() < 0.15 ? 768 - side : side,
    variants: random() < 0.3 ? [{ id: "2x", width: 512, height: 512 }] : [],
  };
  const flat = random() < 0.2, unknown = random() < 0.3, shift = random() * 3;
  const amplitude = flat ? 0 : 10 ** (random() * 3.5);
  const heightAt = (lat: number, lon: number): number | null => flat ? 0 : unknown && Math.sin(lat * 3.1 + lon * 1.7) > 0.6 ? null
    : Math.sin(lat * 0.13 + shift) * amplitude + Math.cos(lon * 0.07) * amplitude / 6 + Math.sin(lat * 40 + lon * 31) * 90 + lat * 0.000000123;
  const boundsFor = (tile: TileId) => {
    if (flat) return { min: 0, max: 0 };
    const s = ((tile.z * 73856093) ^ (tile.x * 19349663) ^ (tile.y * 83492791)) >>> 0;
    return { min: -amplitude * 1.3 - 100 + (s % 300), max: amplitude * 1.3 + 100 + (s >>> 9) % 400 };
  };
  const heightsAt = (coordinates: Float64Array): Float64Array => {
    const heights = new Float64Array(coordinates.length / 2);
    for (let i = 0; i < heights.length; i++) heights[i] = heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN;
    return heights;
  };
  const surface: ImagerySurface = pick([{ heightAt, boundsFor }, { heightAt, boundsFor, heightsAt }, { heightAt, boundsFor, heightsAt, getRevision: () => 3 }]);
  const near = at(latDeg + (random() - 0.5) * 0.2, lonDeg + (random() - 0.5) * 0.2, random() * 2000);
  const overrides: Partial<ImagerySelectionInput> = pick<Partial<ImagerySelectionInput>>([
    {}, {}, {},
    { refineFrom: { position: near, minDistanceMeters: 10 ** (random() * 4), pixelAngle: 0.8 / 720 } },
    { focus: { mode: "both", position: near, radiusMeters: 10 ** (2 + random() * 3), minDistanceMeters: 10 ** (random() * 4), pixelAngle: 0.8 / 720, offset: 0, horizonCull: random() < 0.5 } },
    { focus: { mode: "around", position: near, radiusMeters: 10 ** (2 + random() * 3), minDistanceMeters: 10 ** (random() * 4), pixelAngle: 0.8 / 720, offset: -1, horizonCull: random() < 0.5 } },
  ]);
  const offset = random() < 0.2 ? pick([-1, 1, 0.5]) : 0;
  return { ...input(view, surface, source, overrides), offset, maxPages: 2048, maxNodes: 3000 };
}

/** The digest of a random case's plan, its measurements, and its pages measured twice with a cache. */
function randomOutcome(value: ImagerySelectionInput): string {
  const step = createImagerySelector(() => 0).step(value, Infinity);
  const plan = step.plan ? { ...step.plan, cpuMs: 0 } : null;
  const tiles = plan?.leaves.map(leaf => leaf.tile) ?? [];
  const cache = createImageryMeasurementCache();
  return digestOf({
    completed: step.completed, plan, measured: measureImageryView(value, tiles, plan?.coverage ?? []),
    pages: measureImageryView(value, tiles, [], cache), again: measureImageryView(value, tiles, [], cache),
  });
}

describe("imagery selection identity", () => {
  it("gives the shipped plans and measurements whether heights come one at a time, packed, or reused within a revision", () => {
    const all: unknown[] = [];
    let asked = 0, reused = 0;
    for (const unknown of [false, true]) for (const { name, view, source, overrides } of CASES) {
      const { scalar, batched, revised, counts } = surfaces(unknown);
      const expected = outcome(input(view, scalar, source, overrides));
      expect(outcome(input(view, batched, source, overrides)), `${name}, packed`).toEqual(expected);
      expect(outcome(input(view, revised, source, overrides)), `${name}, reused`).toEqual(expected);
      expect(expected.plan.leaves.length, name).toBeGreaterThan(0);
      all.push(name, unknown, expected);
      asked += counts.packed; reused += counts.revised;
    }
    expect(digestOf(all)).toBe(SHIPPED_DIGEST);
    // Reuse has to save heights to be worth keeping: the lattice asks for about 40 % of them.
    expect(reused).toBeLessThan(asked * 0.45);
  });

  it("gives the shipped plans and measurements for random views, sources, grounds and focus", () => {
    const outcomes: string[] = [];
    for (let seed = 1; seed <= 400; seed++) outcomes.push(randomOutcome(randomCase(seed)));
    expect(digestOf(outcomes)).toBe(SHIPPED_RANDOM_DIGEST);
  }, 30000);

  it("asks for every height again once the surface's revision changes", () => {
    let shift = 0, revision = 0;
    const { boundsFor } = ground(false);
    const heightsAt = (coordinates: Float64Array): Float64Array => {
      const { heightAt } = ground(false, shift);
      const heights = new Float64Array(coordinates.length / 2);
      for (let i = 0; i < heights.length; i++) heights[i] = heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN;
      return heights;
    };
    const surface: ImagerySurface = { heightAt: (lat, lon) => ground(false, shift).heightAt(lat, lon), boundsFor, heightsAt, getRevision: () => revision };
    for (const { name, view, source, overrides } of CASES) {
      shift = 0;
      const before = outcome(input(view, surface, source, overrides));
      shift = 0.5; revision += 1;
      const after = outcome(input(view, surface, source, overrides));
      const expected = outcome(input(view, { heightAt: ground(false, 0.5).heightAt, boundsFor }, source, overrides));
      expect(after, name).toEqual(expected);
      expect(digestOf(after), name).not.toBe(digestOf(before));
      revision += 1;
    }
  });

  it("gives a view's kept measurements bit for bit, and measures again once anything they depend on changes", () => {
    /** The next double away from zero. */
    const nudge = (value: number): number => {
      const bits = new BigInt64Array(Float64Array.of(value).buffer);
      bits[0] += 1n;
      return new Float64Array(bits.buffer)[0];
    };
    /** Copies of the view with one number moved by one step each. */
    const nudged = (view: unknown): unknown[] => {
      if (typeof view === "number") return [Number.isInteger(view) ? view + 1 : nudge(view)];
      if (!view || typeof view !== "object") return [];
      return Object.entries(view).flatMap(([key, value]) => nudged(value).map(changed =>
        Array.isArray(view) ? Object.assign([...view], { [key]: changed }) : { ...view, [key]: changed }));
    };
    let checked = 0;
    for (const unknown of [false, true]) for (const { name, view, source, overrides } of CASES) {
      if (overrides) continue;
      const { scalar, revised } = surfaces(unknown);
      const plan = outcome(input(view, scalar, source)).plan;
      const leaves = plan.leaves.map(leaf => leaf.tile);
      const measure = (surface: ImagerySurface, tiles = leaves, coverage: readonly TileId[] = [], cache?: ReturnType<typeof createImageryMeasurementCache>, at = input(view, surface, source).view) =>
        measureImageryView({ view: at, source: source ?? PHOTO, surface }, tiles, coverage, cache);
      const cache = createImageryMeasurementCache();
      const regions = measure(revised, leaves, plan.coverage, cache);
      expect(digestOf(regions), name).toBe(digestOf(measure(scalar, leaves, plan.coverage)));
      expect(cache.reused, name).toBe(0);
      // The loaded pages, at an equal view built again: every one was a region.
      expect(digestOf(measure(revised, leaves, [], cache)), name).toBe(digestOf(measure(scalar)));
      expect(cache.reused, name).toBe(leaves.length);

      const base = input(view, revised, source).view;
      for (const changed of nudged(base) as Array<typeof base>) {
        measure(revised, leaves, [], cache);
        const before = cache.reused;
        expect(digestOf(measure(revised, leaves, [], cache, changed)), name).toBe(digestOf(measure(scalar, leaves, [], undefined, changed)));
        expect(cache.reused, `${name}: ${JSON.stringify(changed)}`).toBe(before);
        checked += 1;
      }
      // One surface whose revision, camera ground or bounds change in place.
      const state = { revision: 7, ground: 0, widened: null as TileId | null, raised: null as TileId | null };
      const changing: ImagerySurface = {
        heightsAt: revised.heightsAt, getRevision: () => state.revision,
        heightAt: (lat, lon) => { const height = revised.heightAt(lat, lon); return height === null ? state.ground || null : height + state.ground; },
        boundsFor: tile => {
          const bounds = revised.boundsFor(tile);
          return tile === state.widened ? { min: bounds.min - 1, max: bounds.max } : tile === state.raised ? { min: bounds.min, max: bounds.max + 1 } : bounds;
        },
      };
      /** How many regions a measurement after `change` gives without measuring them again. */
      const reusedAfter = (change: () => void, surface = changing, at = source ?? PHOTO): number => {
        measure(changing, leaves, [], cache);
        change();
        const before = cache.reused;
        measureImageryView({ view: base, source: at, surface }, leaves, [], cache);
        return cache.reused - before;
      };
      expect(reusedAfter(() => {}), name).toBe(leaves.length);
      expect(reusedAfter(() => { state.revision += 1; }), name).toBe(0);
      expect(reusedAfter(() => { state.ground += 1; }), name).toBe(0);
      state.ground = 0; state.revision += 1;
      expect(reusedAfter(() => {}, changing, { ...(source ?? PHOTO), tileWidth: 512 }), name).toBe(0);
      expect(reusedAfter(() => {}, { ...changing }), name).toBe(0);
      // A region whose bounds changed is measured again alone.
      const moved = leaves[Math.floor(leaves.length / 2)];
      expect(reusedAfter(() => { state.widened = moved; }), name).toBe(leaves.length - 1);
      expect(reusedAfter(() => { state.raised = leaves.find(leaf => leaf !== moved)!; }), name).toBe(leaves.length - 1);
      expect(digestOf(measure(changing, leaves, [], cache)), name).toBe(digestOf(measure({ heightAt: changing.heightAt, boundsFor: changing.boundsFor })));
      state.widened = null; state.raised = null;
      // Without revisions nothing is kept.
      const unrevised: ImagerySurface = { heightAt: revised.heightAt, boundsFor: revised.boundsFor, heightsAt: revised.heightsAt };
      expect(reusedAfter(() => measure(unrevised, leaves, [], cache), unrevised), name).toBe(0);
    }
    expect(checked).toBeGreaterThan(100);
  }, 15000);

  it("keeps the heights of tiles that touch no changed terrain into later revisions, with the same plans and measurements", () => {
    let seed = 5;
    const random = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    // Terrain tiles of any level raise the ground inside them; a revision raises a few more.
    const raised = new Map<string, number>();
    const levels = new Set<number>();
    const { boundsFor } = ground(true);
    const heightAt = (lat: number, lon: number): number | null => {
      const base = ground(true).heightAt(lat, lon);
      if (base === null) return null;
      let height = base;
      for (const z of levels) {
        const at = lonLatToTileXY(lon, lat, z);
        height += raised.get(`${z}/${Math.floor(at.x)}/${Math.floor(at.y)}`) ?? 0;
      }
      return height;
    };
    const asked = { kept: 0, full: 0 };
    const packed = (count: keyof typeof asked) => (coordinates: Float64Array): Float64Array => {
      asked[count] += coordinates.length / 2;
      const heights = new Float64Array(coordinates.length / 2);
      for (let i = 0; i < heights.length; i++) heights[i] = heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN;
      return heights;
    };
    let revision = 0;
    const changes: Array<{ revision: number; tiles: TileId[] }> = [];
    const kept: ImagerySurface = {
      heightAt, boundsFor, heightsAt: packed("kept"), getRevision: () => revision,
      changedSince: since => changes.filter(change => change.revision > since).flatMap(change => change.tiles),
    };
    const full: ImagerySurface = { heightAt, boundsFor, heightsAt: packed("full"), getRevision: () => revision };
    let changed = 0;
    for (const { name, view, source, overrides } of CASES) for (let step = 0; step < 4; step++) {
      const expected = digestOf(outcome(input(view, { heightAt, boundsFor }, source, overrides)));
      expect(digestOf(outcome(input(view, kept, source, overrides))), `${name}, step ${step}`).toBe(expected);
      expect(digestOf(outcome(input(view, full, source, overrides))), `${name}, step ${step}`).toBe(expected);
      // Raise terrain under a few leaves, a level or so either side of theirs, or across the world's edges.
      const { leaves } = outcome(input(view, full, source, overrides)).plan;
      const tiles: TileId[] = [];
      for (let k = 0; k < 3; k++) {
        const leaf = leaves[Math.floor(random() * leaves.length)].tile;
        const z = Math.max(0, leaf.z + Math.floor(random() * 5) - 2), n = 2 ** z;
        const at = lonLatToTileXY(tileLonDeg(leaf.z, leaf.x + random()), tileLatDeg(leaf.z, leaf.y + random()), z);
        const x = k === 2 && random() < 0.3 ? (random() < 0.5 ? 0 : n - 1) : Math.min(n - 1, Math.floor(at.x));
        const tile = { z, x, y: Math.min(n - 1, Math.floor(at.y)) };
        raised.set(`${tile.z}/${tile.x}/${tile.y}`, (raised.get(`${tile.z}/${tile.x}/${tile.y}`) ?? 0) + 40 + random() * 300);
        levels.add(z);
        tiles.push(tile);
      }
      revision += 1;
      changes.push({ revision, tiles });
      if (digestOf(outcome(input(view, { heightAt, boundsFor }, source, overrides))) !== expected) changed += 1;
    }
    // The changes move plans and measurements, and keeping heights saves asking for many.
    expect(changed).toBeGreaterThan(CASES.length);
    expect(asked.kept).toBeLessThan(asked.full * 0.75);
  }, 30000);

  it("follows bounds that change while the revision does not, at either end or both", () => {
    const { heightAt } = ground(true);
    let lower = 0, raise = 0;
    const boundsFor = (tile: TileId) => {
      const bounds = ground(true).boundsFor(tile);
      return { min: bounds.min - lower, max: bounds.max + raise };
    };
    const heightsAt = (coordinates: Float64Array): Float64Array => {
      const heights = new Float64Array(coordinates.length / 2);
      for (let i = 0; i < heights.length; i++) heights[i] = heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN;
      return heights;
    };
    const surface: ImagerySurface = { heightAt, boundsFor, heightsAt, getRevision: () => 0 };
    const moved = new Set<string>();
    for (const { name, view, source, overrides } of CASES) for (const [down, up] of [[3000, 3000], [0, 3000], [3000, 0]]) {
      lower = 0; raise = 0;
      const before = outcome(input(view, surface, source, overrides));
      lower = down; raise = up;
      const after = outcome(input(view, surface, source, overrides));
      expect(after, `${name}, ${down} down, ${up} up`).toEqual(outcome(input(view, { heightAt, boundsFor }, source, overrides)));
      if (digestOf(after) !== digestOf(before)) moved.add(`${down}/${up}`);
    }
    expect(moved.size).toBe(3);
    // The fixed views have no tile that the top of its hull alone shows; random ones do.
    let shown = 0;
    for (let seed = 1; seed <= 200; seed++) for (const [down, up] of [[0, 3000], [3000, 0]]) {
      const value = randomCase(seed), base = value.surface;
      const changing = { ...base, getRevision: () => 0, boundsFor: (tile: TileId) => { const bounds = base.boundsFor(tile); return { min: bounds.min - lower, max: bounds.max + raise }; } };
      lower = 0; raise = 0;
      const before = randomOutcome({ ...value, surface: changing });
      lower = down; raise = up;
      const after = randomOutcome({ ...value, surface: changing });
      expect(after, `seed ${seed}, ${down} down, ${up} up`).toBe(randomOutcome({ ...value, surface: { heightAt: base.heightAt, boundsFor: changing.boundsFor } }));
      if (after !== before) shown += 1;
    }
    expect(shown).toBeGreaterThan(100);
  }, 30000);

  it("measures a tile measured just before with its new heights once the revision changes, whether the change names it or not", () => {
    // Each measurement asks only for this one tile, so the entry the selector
    // gave last is the one it is asked for first after each change.
    let shift = 0, revision = 0, named = true;
    const { boundsFor } = ground(false);
    const heightAt = (lat: number, lon: number): number | null => ground(false, shift).heightAt(lat, lon);
    const heightsAt = (coordinates: Float64Array): Float64Array => {
      const heights = new Float64Array(coordinates.length / 2);
      for (let i = 0; i < heights.length; i++) heights[i] = heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN;
      return heights;
    };
    // The whole world changes: named, every kept tile touches the root and goes; unnamed, the revision's record goes.
    const surface: ImagerySurface = { heightAt, boundsFor, heightsAt, getRevision: () => revision, changedSince: () => named ? [{ z: 0, x: 0, y: 0 }] : null };
    let checked = 0;
    for (const { name, view, source, overrides } of CASES) {
      if (overrides) continue;
      shift = 0;
      for (const { tile } of outcome(input(view, { heightAt, boundsFor }, source)).plan.leaves.slice(0, 3)) {
        const measure = (at: ImagerySurface) => digestOf(measureImageryView({ view: input(view, at, source).view, source: source ?? PHOTO, surface: at }, [tile]));
        let before = measure(surface);
        for (const change of [true, false, true]) {
          named = change; shift += 0.5; revision += 1;
          const after = measure(surface);
          expect(after, `${name}, ${change ? "named" : "unnamed"}`).toBe(measure({ heightAt, boundsFor }));
          if (after !== before) checked += 1;
          before = after;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});
