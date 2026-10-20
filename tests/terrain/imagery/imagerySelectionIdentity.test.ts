import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { geodeticToEcef } from "../../../src/camera/cameraMath.js";
import type { TileId } from "../../../src/terrain/imagery/imageryGeometry.js";
import {
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
    // Reuse has to save heights to be worth keeping.
    expect(reused).toBeLessThan(asked * 0.6);
  });

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

  it("follows bounds that change while the revision does not", () => {
    const { heightAt } = ground(true);
    let widen = 0;
    const boundsFor = (tile: TileId) => {
      const bounds = ground(true).boundsFor(tile);
      return { min: bounds.min - widen, max: bounds.max + widen };
    };
    const heightsAt = (coordinates: Float64Array): Float64Array => {
      const heights = new Float64Array(coordinates.length / 2);
      for (let i = 0; i < heights.length; i++) heights[i] = heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN;
      return heights;
    };
    const surface: ImagerySurface = { heightAt, boundsFor, heightsAt, getRevision: () => 0 };
    for (const { name, view, source, overrides } of CASES) {
      widen = 0;
      outcome(input(view, surface, source, overrides));
      widen = 3000;
      expect(outcome(input(view, surface, source, overrides)), name).toEqual(outcome(input(view, { heightAt, boundsFor }, source, overrides)));
    }
  });
});
