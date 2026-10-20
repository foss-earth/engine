import { describe, expect, it } from "vitest";
import { createPointHeights, keepPoint, pointSlot } from "../src/browser/pointHeights.js";

describe("heights kept by exact point", () => {
  it("finds what a Map keyed by x, then y, finds, through growth and lattice-like keys", () => {
    const table = createPointHeights(), reference = new Map<number, Map<number, { height: number; origin: number }>>();
    let seed = 7;
    const random = () => (seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0) / 2 ** 32;
    const xs = [-0, 0, 5e-324, -5e-324, 1, 1 + Number.EPSILON, 2 ** 30 - 1 / 64, 16383.015625, 16383.0156250001, 1e300];
    for (let i = 0; i < 40000; i++) {
      // Lattice coordinates repeat rows and columns, as imagery probes do.
      const x = random() < 0.2 ? xs[Math.floor(random() * xs.length)] : 8191 + Math.floor(random() * 200) / 64;
      const y = random() < 0.2 ? xs[Math.floor(random() * xs.length)] : 4095 + Math.floor(random() * 200) / 64 + (random() < 0.3 ? 1e-9 : 0);
      const slot = pointSlot(table, x, y), kept = reference.get(x)?.get(y);
      expect(table.origins[slot] ? { height: table.heights[slot], origin: table.origins[slot] } : undefined).toEqual(kept);
      if (kept) { if (random() < 0.1) { table.origins[slot] = kept.origin = 2; } continue; }
      const height = random() < 0.01 ? -0 : random() * 1e4 - 500, origin = 1 + Math.floor(random() * 3);
      keepPoint(table, slot, x, y, height, origin);
      if (!reference.has(x)) reference.set(x, new Map());
      reference.get(x)!.set(y, { height, origin });
      expect(table.size * 2).toBeLessThanOrEqual(table.origins.length);
    }
    const all = [...reference].flatMap(([x, row]) => [...row].map(([y, value]) => ({ x, y, ...value })));
    expect(table.size).toBe(all.length);
    for (const { x, y, height, origin } of all) {
      const slot = pointSlot(table, x, y);
      expect(Object.is(table.heights[slot], height)).toBe(true); expect(table.origins[slot]).toBe(origin);
    }
  });
  it("keeps -0 and 0 as one key and finds no NaN", () => {
    const table = createPointHeights();
    keepPoint(table, pointSlot(table, -0, 0), -0, 0, 12, 1);
    for (const [x, y] of [[0, 0], [-0, -0], [0, -0], [-0, 0]]) expect(table.origins[pointSlot(table, x, y)]).toBe(1);
    keepPoint(table, pointSlot(table, 3, 4), 3, 4, 5, 1);
    for (const [x, y] of [[NaN, 4], [3, NaN], [NaN, NaN]]) expect(table.origins[pointSlot(table, x, y)]).toBe(0);
    expect(table.size).toBe(2);
  });
});
