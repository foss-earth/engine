import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { instantiateTerrainCore, type TerrainGrid } from "../terrain-WASM/index.js";
import { prepareTerrainNumericGeometry } from "../terrain-TS/terrainNumericGeometry.js";
import { sampleTerrainGrid } from "../src/terrain/terrainGrid.js";

const binary = readFileSync(new URL("../terrain-WASM/single/terrain.wasm", import.meta.url));
const grid = (z: number, x: number, y: number, size: number, seed: number): TerrainGrid => ({
  z, x, y, size,
  heights: Float32Array.from({ length: size * size }, (_, i) => ((i * 7919 + seed * 101) % 65521 - 32760) / 256),
});
const bytes = (values: ArrayBufferView): Buffer => Buffer.from(values.buffer, values.byteOffset, values.byteLength);

it("computes terrain grid powers once per batch, using the executing realm's Math.pow", async () => {
  const pow = vi.fn(Math.pow);
  const core = await instantiateTerrainCore(binary, { workerRealm: true, math: { sin: Math.sin, cos: Math.cos, atan: Math.atan, sinh: Math.sinh, pow } });
  const source = { ...grid(4, 5, 7, 17, 0), neighbors: [grid(5, 12, 14, 7, 1), grid(3, 2, 3, 3, 2)] };
  const sampler = core.createHeightSampler(source);
  try {
    const coordinates = new Float64Array([5, 7, 6, 8, 4.999, 7.5, 6.001, 7.5, 5.5, 6.999, 5.5, 8.001]);
    const expected = Float64Array.from({ length: coordinates.length / 2 }, (_, i) => sampleTerrainGrid(source, coordinates[i * 2], coordinates[i * 2 + 1]));
    pow.mockClear();
    expect(bytes(sampler.sample(coordinates))).toEqual(bytes(expected));
    const calls = pow.mock.calls.slice();
    expect(calls.length).toBeLessThan(12);
    // The zoom differences keep both signs, rather than being derived from
    // some replacement for the executing realm's own power function.
    expect(calls).toEqual(expect.arrayContaining([[2, 0], [2, 1], [2, -1], [2, 4]]));
    const many = new Float64Array(coordinates.length * 256);
    for (let i = 0; i < many.length; i += coordinates.length) many.set(coordinates, i);
    pow.mockClear();
    const result = sampler.sample(many);
    expect(pow.mock.calls).toEqual(calls);
    for (let i = 0; i < result.length; i += expected.length) expect(bytes(result.subarray(i, i + expected.length))).toEqual(bytes(expected));
  } finally { sampler.dispose(); core.dispose(); }
});

it("keeps mixed-zoom, ordered overlapping neighbours exact in meshes and alternating height samplers", async () => {
  const core = await instantiateTerrainCore(binary, { workerRealm: true });
  try {
    for (const z of [1, 4, 14, 30]) {
      const n = 2 ** z;
      for (const [x, y] of [[0, 0], [n - 1, n - 1]]) {
        const parent = grid(z - 1, x >> 1, y >> 1, 7, 3);
        const sibling = grid(z, (x + 1) % n, y, 3, 7);
        const root = grid(0, 0, 0, 2, 11);
        for (const neighbors of [undefined, [], [sibling, parent, root], [root, parent, sibling]]) {
          const source = { ...grid(z, x, y, 17, 5), ...(neighbors ? { neighbors } : {}) };
          const coordinates = Float64Array.from([-0.05, 0, 0.5 / 17, 0.5, 1 - 0.5 / 17, 1, 1.05]
            .flatMap(dx => [-0.05, 0, 0.5, 1, 1.05].flatMap(dy => [x + dx, y + dy])));
          const a = core.createHeightSampler(source), b = core.createHeightSampler(parent);
          try {
            const expected = Float64Array.from({ length: coordinates.length / 2 }, (_, i) => sampleTerrainGrid(source, coordinates[i * 2], coordinates[i * 2 + 1]));
            for (let repeat = 0; repeat < 2; repeat++) {
              expect(bytes(a.sample(coordinates))).toEqual(bytes(expected));
              expect(bytes(b.sample(new Float64Array([parent.x, parent.y])))).toEqual(bytes(new Float64Array([sampleTerrainGrid(parent, parent.x, parent.y)])));
            }
          } finally { a.dispose(); b.dispose(); }
          // The mesh's target zoom differs from its grid in the second arm.
          for (const tile of [{ z, x, y }, parent]) {
            const request = { tile, grid: source, segments: 8, withUvs: true };
            const actual = core.buildSurface(request), expected = prepareTerrainNumericGeometry(request);
            for (const field of ["positions", "targetPositions", "uvs", "indices"] as const) expect(bytes(actual[field]!)).toEqual(bytes(expected[field]!));
            expect(actual.center).toEqual(expected.center);
            expect(actual.heightBounds).toEqual(expected.heightBounds);
          }
        }
      }
    }
  } finally { core.dispose(); }
});
