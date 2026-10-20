import { describe, expect, it } from "vitest";
import { collectTerrainHeightPixels, packTerrainHeightPixels, sampleTerrainHeightPixels, unpackTerrainHeightPixels, type TerrainHeightPixels } from "../src/browser/terrainHeightPixels.js";
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
  it("copies each source's pixels in ascending index order with their original heights", () => {
    const source = grid(5, 9, 12, 256, 4);
    source.neighbors = [grid(5, 10, 12, 256, 1), grid(4, 4, 6, 129, 2), grid(6, 18, 23, 64, 3)];
    for (const spread of [1e-3, 0.02, 0.5, 1]) {
      const coordinates = Float64Array.from({ length: 4096 }, (_, i) => (i % 2 ? source.y : source.x) + 0.5 + (((i * 7919) % 4093) / 4093 - 0.5) * spread * 1.2);
      const compact = collectTerrainHeightPixels(source, coordinates);
      const pairs: Array<[TerrainHeightPixels, TerrainGrid]> = [[compact, source], ...(compact.neighbors ?? []).map((value, i): [TerrainHeightPixels, TerrainGrid] => [value, source.neighbors![i]])];
      expect(pairs.some(([value]) => value !== compact && value.indices.length > 0)).toBe(spread === 1);
      for (const [value, original] of pairs) {
        expect(value.heights.length).toBe(value.indices.length);
        for (let i = 0; i < value.indices.length; i++) {
          if (i > 0) expect(value.indices[i]).toBeGreaterThan(value.indices[i - 1]);
          expect(Object.is(value.heights[i], original.heights[value.indices[i]])).toBe(true);
        }
      }
      for (let at = 0; at < coordinates.length; at += 2) expect(Object.is(sampleTerrainHeightPixels(compact, coordinates[at], coordinates[at + 1]), sampleTerrainGrid(source, coordinates[at], coordinates[at + 1]))).toBe(true);
    }
  });
  it("keeps repeated neighbour objects in tie order without duplicating their unused pixels", () => {
    const source = grid(1, 0, 0, 512), neighbor = grid(0, 0, 0, 257, 3);
    source.neighbors = [source, ...Array<TerrainGrid>(31).fill(neighbor)];
    const coordinates = new Float64Array([0.9999, 0.9999]);
    const compact = collectTerrainHeightPixels(source, coordinates);
    expect([compact, ...(compact.neighbors ?? [])].reduce((sum, value) => sum + value.heights.length, 0)).toBeLessThanOrEqual(16);
    expect(sampleTerrainHeightPixels(compact, coordinates[0], coordinates[1])).toBe(sampleTerrainGrid(source, coordinates[0], coordinates[1]));
  });
  it("packs the pixels each batch collects, without unread neighbours, into views that keep reference bits", () => {
    const cases: Array<[TerrainGrid, Float64Array]> = [];
    for (const tile of [{ z: 0, x: 0, y: 0 }, { z: 1, x: 1, y: 0 }, { z: 4, x: 5, y: 7 }, { z: 30, x: 1073741823, y: 1073741823 }]) {
      for (const size of [1, 2, 3, 17, 256]) for (const neighbors of [undefined, [], [grid(0, 0, 0, 3, 3)], [grid(tile.z, (tile.x + 1) % 2 ** tile.z, tile.y, 7, 1), grid(0, 0, 0, 2, 7)]]) {
        const values = [-0, 0, Number.EPSILON, 0.5 / size, 0.5, 1 - 0.5 / size, 1, 1 + Number.EPSILON, -1, 2];
        cases.push([{ ...grid(tile.z, tile.x, tile.y, size), ...(neighbors ? { neighbors } : {}) }, Float64Array.from(values.flatMap(x => values.flatMap(y => [tile.x + x, tile.y + y])))]);
      }
    }
    const repeated = grid(1, 0, 0, 512), neighbor = grid(0, 0, 0, 257, 3);
    repeated.neighbors = [repeated, ...Array<TerrainGrid>(31).fill(neighbor)];
    cases.push([repeated, new Float64Array([0.9999, 0.9999, 0.5, 0.5, 0.0001, 0.9999])]);
    const mixed = grid(5, 9, 12, 256, 4);
    mixed.neighbors = [grid(5, 10, 12, 256, 1), grid(4, 4, 6, 129, 2), grid(6, 18, 23, 64, 3)];
    cases.push([mixed, Float64Array.from({ length: 4096 }, (_, i) => (i % 2 ? mixed.y : mixed.x) + 0.5 + (((i * 7919) % 4093) / 4093 - 0.5) * 1.2)]);
    const pack = packTerrainHeightPixels();
    let bytes = 0;
    cases.forEach(([source, coordinates], i) => { bytes += pack.add(i + 1, source, Array.from(coordinates), coordinates.length / 2, Infinity)!; });
    const packed = pack.finish(), batches = unpackTerrainHeightPixels(packed);
    expect(packed.heights.byteLength + packed.indices.byteLength).toBe(bytes);
    expect(batches).toHaveLength(cases.length);
    let dropped = 0;
    batches.forEach((batch, i) => {
      const [source, coordinates] = cases[i], collected = collectTerrainHeightPixels(source, coordinates), sent = batch.grid as TerrainHeightPixels;
      expect(batch).toMatchObject({ gridId: i + 1, sparse: true });
      expect(batch.coordinates).toEqual(coordinates);
      const read = collected.neighbors?.filter(value => value.indices.length);
      dropped += (collected.neighbors?.length ?? 0) - (read?.length ?? 0);
      expect(sent).toEqual({ ...collected, ...(read ? { neighbors: read } : {}) });
      for (let at = 0; at < coordinates.length; at += 2) expect(Object.is(sampleTerrainHeightPixels(sent, coordinates[at], coordinates[at + 1]), sampleTerrainGrid(source, coordinates[at], coordinates[at + 1]))).toBe(true);
    });
    expect(dropped).toBeGreaterThan(30);
  });
  it("appends nothing for a batch over its byte budget", () => {
    const pack = packTerrainHeightPixels(), source = grid(2, 1, 1, 64);
    expect(pack.add(1, source, [1.5, 1.5], 1, 31)).toBeNull();
    expect(pack.add(2, source, [1.5, 1.5, 1.25, 1.25], 1, 32)).toBe(32);
    const packed = pack.finish();
    expect([...packed.table]).toEqual([2, 1, 1, 0, 2, 1, 1, 64, 4]);
    expect([...packed.coordinates]).toEqual([1.5, 1.5]);
    expect(unpackTerrainHeightPixels(packed)).toHaveLength(1);
  });
  it("rejects packed tables that do not describe their arrays exactly", () => {
    const pack = packTerrainHeightPixels(), source = { ...grid(2, 1, 1, 4), neighbors: [grid(2, 2, 1, 4, 1)] };
    pack.add(1, source, [1.99, 1.5], 1, Infinity);
    const valid = pack.finish();
    expect(unpackTerrainHeightPixels(valid)[0].grid?.neighbors).toHaveLength(1);
    const edit = (change: (table: number[]) => void, arrays: Partial<typeof valid> = {}) => {
      const table = [...valid.table]; change(table);
      return () => unpackTerrainHeightPixels({ ...valid, table: new Float64Array(table), ...arrays });
    };
    for (const [change, message] of [
      [(table: number[]) => { table[1] = 0; }, "batch"], [(table: number[]) => { table[1] = 2; }, "batch"],
      [(table: number[]) => { table[2] = 0; }, "batch"], [(table: number[]) => { table[2] = 34; }, "batch"],
      [(table: number[]) => { table[3] = 0; }, "batch"], [(table: number[]) => { table[3] = 2; }, "batch"],
      [(table: number[]) => { table.pop(); }, "batch"], [(table: number[]) => { table[8] = 1e9; }, "source"],
      [(table: number[]) => { table[8] = -1; }, "source"], [(table: number[]) => { table[8] -= 1; }, "request"],
      [(table: number[]) => { table.push(1); }, "batch"],
    ] as const) expect(edit(change)).toThrow(`Invalid packed height ${message}`);
    expect(edit(() => {}, { indices: valid.indices.slice(1) })).toThrow("Invalid packed height request");
    expect(edit(() => {}, { coordinates: new Float64Array([1.99, 1.5, 1, 1]) })).toThrow("Invalid packed height request");
    expect(edit(() => {}, { heights: Float64Array.from(valid.heights) as unknown as Float32Array })).toThrow("Invalid packed height request");
  });
});
