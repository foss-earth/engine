import { describe, expect, it } from "vitest";
import { collectTerrainHeightPixels, sampleTerrainHeightPixels } from "../src/browser/terrainHeightPixels.js";
import { sampleTerrainGrid, type TerrainGrid } from "../src/terrain/terrainGrid.js";

const grid = (z: number, x: number, y: number, size: number, seed = 0): TerrainGrid => ({ z, x, y, size,
  heights: Float32Array.from({ length: size ** 2 }, (_, i) => ((i * 13 + seed * 17) % 65521 - 32760) / 256) });
describe("exact sparse terrain height inputs", () => {
  it("retains reference bits across tile edges, mixed zooms, neighbour ties and special values", () => {
    for (const tile of [{ z: 0, x: 0, y: 0 }, { z: 1, x: 1, y: 0 }, { z: 4, x: 5, y: 7 }, { z: 30, x: 1073741823, y: 1073741823 }]) {
      for (const size of [1, 2, 3, 17, 256]) for (const neighbors of [undefined, [], [grid(0, 0, 0, 3, 3)], [grid(tile.z, (tile.x + 1) % 2 ** tile.z, tile.y, 7, 1), grid(0, 0, 0, 2, 7)]]) {
        const source = { ...grid(tile.z, tile.x, tile.y, size), ...(neighbors ? { neighbors } : {}) };
        const values = [-0, 0, Number.EPSILON, 0.5 / size, 0.5, 1 - 0.5 / size, 1, 1 + Number.EPSILON, -1, 2];
        const coordinates = Float64Array.from(values.flatMap(x => values.flatMap(y => [tile.x + x, tile.y + y])));
        const compact = collectTerrainHeightPixels(source, coordinates);
        for (let at = 0; at < coordinates.length; at += 2) expect(Object.is(sampleTerrainHeightPixels(compact, coordinates[at], coordinates[at + 1]), sampleTerrainGrid(source, coordinates[at], coordinates[at + 1]))).toBe(true);
      }
    }
    for (const special of [-0, 0, NaN, Infinity, -Infinity, 1.401298464324817e-45]) {
      const source = grid(0, 0, 0, 2); source.heights.fill(special);
      const coordinates = new Float64Array([-0, -0, 0.5, 0.5, 1, 1]);
      const compact = collectTerrainHeightPixels(source, coordinates);
      for (let at = 0; at < coordinates.length; at += 2) expect(Object.is(sampleTerrainHeightPixels(compact, coordinates[at], coordinates[at + 1]), sampleTerrainGrid(source, coordinates[at], coordinates[at + 1]))).toBe(true);
    }
  });
  it("copies at most sixteen original leaf pixels per coordinate without retaining source buffers", () => {
    const source = grid(3, 2, 3, 512);
    source.neighbors = [grid(2, 0, 1, 257), grid(4, 6, 6, 128)];
    const coordinates = Float64Array.from({ length: 8192 * 2 }, (_, i) => (i % 2 ? source.y : source.x) + ((i * 101) % 65521) / 65521);
    const compact = collectTerrainHeightPixels(source, coordinates);
    const sources = [compact, ...(compact.neighbors ?? [])];
    expect(sources.reduce((sum, value) => sum + value.heights.length, 0)).toBeLessThanOrEqual(8192 * 16);
    expect(sources.reduce((sum, value) => sum + value.heights.byteLength + value.indices.byteLength, 0)).toBeLessThanOrEqual(1024 ** 2);
    for (const value of sources) expect([source, ...source.neighbors].some(original => original.heights.buffer === value.heights.buffer)).toBe(false);
    for (let at = 0; at < coordinates.length; at += 2) expect(Object.is(sampleTerrainHeightPixels(compact, coordinates[at], coordinates[at + 1]), sampleTerrainGrid(source, coordinates[at], coordinates[at + 1]))).toBe(true);
    source.heights.fill(99999);
    expect(compact.heights.includes(99999)).toBe(false);
    const broken = { ...compact, indices: new Uint32Array(), heights: new Float32Array() };
    expect(() => sampleTerrainHeightPixels(broken, source.x + 0.5, source.y + 0.5)).toThrow("missing a required pixel");
  });
  it("keeps repeated neighbour objects in tie order without duplicating their unused pixels", () => {
    const source = grid(1, 0, 0, 512), neighbor = grid(0, 0, 0, 257, 3);
    source.neighbors = [source, ...Array<TerrainGrid>(31).fill(neighbor)];
    const coordinates = new Float64Array([0.9999, 0.9999]);
    const compact = collectTerrainHeightPixels(source, coordinates);
    expect([compact, ...(compact.neighbors ?? [])].reduce((sum, value) => sum + value.heights.length, 0)).toBeLessThanOrEqual(16);
    expect(sampleTerrainHeightPixels(compact, coordinates[0], coordinates[1])).toBe(sampleTerrainGrid(source, coordinates[0], coordinates[1]));
  });
});
