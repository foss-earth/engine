import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTerrainTileLoader, DEFAULT_TERRAIN_LOADER_LIMITS, neighborBand, type TerrainLoaderLimits } from "../src/terrain/terrainLoader.js";
import { sampleTerrainGrid, sampleTerrainGridRow, terrainGridColumns, type TerrainGrid, type TerrainTile } from "../src/terrain/terrainGrid.js";
import { terrainMeshTarget } from "../src/babylon/terrainMesh.js";
import { collectTerrainHeightPixels, sampleTerrainHeightPixels } from "../src/browser/terrainHeightPixels.js";
import { prepareTerrainNumericGeometry } from "../terrain-TS/terrainNumericGeometry.js";
import { instantiateTerrainCore } from "../terrain-WASM/index.js";

// Audit L6. A patch keeps only the band of each same-zoom neighbour it reads:
// every reader must get the same bits from it as from whole neighbours. And the
// loader's cache is bounded by bytes of heights as well as by tiles.

/** Heights from the tile's address, with sharp steps, so a pixel read from the wrong place shows. */
function heightsOf(tile: TerrainTile, size: number): Float32Array {
  let state = (tile.z * 7919 + tile.x * 104729 + tile.y * 1299709) >>> 0;
  const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  return Float32Array.from({ length: size * size }, () => Math.round(random() * 2_000_000) / 256 - 3000);
}

/** A loader over an archive of `size`-pixel tiles, where the tiles in `missing` answer 404. */
function loaderFor(size: number | ((tile: TerrainTile) => number), bandLevels: number | undefined, missing: ReadonlySet<string> = new Set(),
  more: Partial<TerrainLoaderLimits> = {}, asked: string[] = []) {
  const ports = {
    createAbortController: () => new AbortController(),
    requestSignal: (signal: AbortSignal) => signal,
    fetchTile: async (url: string) => {
      const at = /\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(url)!.slice(1).join("/");
      asked.push(at);
      return new Response(at, { status: missing.has(at) ? 404 : 200 });
    },
    byteLength: (blob: Blob) => blob.size,
  };
  return createTerrainTileLoader<Blob, AbortSignal>({
    ports, limits: () => ({ ...DEFAULT_TERRAIN_LOADER_LIMITS, ...(bandLevels === undefined ? {} : { neighborBandLevels: bandLevels }), ...more }),
    decode: async blob => {
      const [z, x, y] = (await blob.text()).split("/").map(Number);
      const tile = { z: z!, x: x!, y: y! }, side = typeof size === "number" ? size : size(tile);
      return { size: side, heights: heightsOf(tile, side) };
    },
  });
}

async function patches(size: number | ((tile: TerrainTile) => number), tile: TerrainTile, missing?: ReadonlySet<string>, levels = 2) {
  const whole = loaderFor(size, 0, missing), banded = loaderFor(size, levels, missing);
  try {
    return { whole: await whole.loadPatch(tile), banded: await banded.loadPatch(tile) };
  } finally { whole.dispose(); banded.dispose(); }
}

/** Points of the grid's tile, in its own tile coordinates: every pixel centre and edge of the outer three pixels, the corners, and random ones inside. */
function pointsIn(grid: TerrainGrid, tile: TerrainTile = grid): Array<[number, number]> {
  const scale = 2 ** (grid.z - tile.z), x0 = tile.x * scale, y0 = tile.y * scale, span = scale, steps = grid.size / scale;
  const along: number[] = [];
  for (let i = 0; i <= 6; i++) along.push(i / 2, steps - i / 2);
  for (const extra of [1e-9, 0.25, 0.49999, 0.5, 0.50001]) along.push(extra, steps - extra);
  let state = 99;
  const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let i = 0; i < 24; i++) along.push(random() * steps);
  const points: Array<[number, number]> = [];
  for (const a of along) for (const b of along) points.push([x0 + (a / steps) * span, y0 + (b / steps) * span]);
  return points;
}

function expectSameHeights(whole: TerrainGrid, banded: TerrainGrid, tile?: TerrainTile): number {
  let count = 0;
  for (const [x, y] of pointsIn(whole, tile)) {
    const a = sampleTerrainGrid(whole, x, y), b = sampleTerrainGrid(banded, x, y);
    if (!Object.is(a, b)) expect.fail(`${whole.z}/${whole.x}/${whole.y} at ${x}, ${y}: ${b} is not ${a}`);
    count++;
  }
  return count;
}

const neighbourKeys = (grid: TerrainGrid) => grid.neighbors!.map(n => `${n.z}/${n.x}/${n.y}/${n.size}`);

describe("neighbour bands (L6)", () => {
  it("keeps a quarter of each edge neighbour and 2 × 2 pixels of each corner, as sub-tiles of the same pixels", async () => {
    const { whole, banded } = await patches(16, { z: 6, x: 20, y: 30 });
    expect(whole.neighbors).toHaveLength(8);
    // NW, N, NE, W, E, SW, S, SE, each in its neighbour's place.
    expect(neighbourKeys(banded)).toEqual([
      "9/159/239/2",
      "8/80/119/4", "8/81/119/4", "8/82/119/4", "8/83/119/4",
      "9/168/239/2",
      "8/79/120/4", "8/79/121/4", "8/79/122/4", "8/79/123/4",
      "8/84/120/4", "8/84/121/4", "8/84/122/4", "8/84/123/4",
      "9/159/248/2",
      "8/80/124/4", "8/81/124/4", "8/82/124/4", "8/83/124/4",
      "9/168/248/2",
    ]);
    // The east neighbour's band is its first four columns.
    const east = whole.neighbors![4]!, band = banded.neighbors!.slice(10, 14);
    for (let row = 0; row < 16; row++) for (let col = 0; col < 4; col++) {
      expect(band[row >> 2]!.heights[(row & 3) * 4 + col]).toBe(east.heights[row * 16 + col]);
    }
    const bytes = (grid: TerrainGrid) => grid.neighbors!.reduce((sum, n) => sum + n.heights.byteLength, 0);
    expect(bytes(whole)).toBe(8 * 16 * 16 * 4);
    expect(bytes(banded)).toBe(4 * 16 * 4 * 4 + 4 * 2 * 2 * 4);
    expect([...banded.heights]).toEqual([...whole.heights]);
  });

  for (const levels of [2, 4]) describe(`with bands 1/${2 ** levels} of a tile wide`, () => {
    it("reads the same heights everywhere in the tile, its edges and corners, for every grid size", async () => {
      let samples = 0;
      for (const size of [8, 16, 64, 512]) {
        const { whole, banded } = await patches(size, { z: 9, x: 300, y: 200 }, undefined, levels);
        expect(banded.neighbors!.length).toBe(size >= 2 ** (levels + 1) ? 4 * 2 ** levels + 4 : 8);
        samples += expectSameHeights(whole, banded);
      }
      expect(samples).toBeGreaterThan(9_000);
    });

    it("reads the same heights where the patch wraps the antimeridian, at the poles' rows, and at zooms 0 and 1", async () => {
      for (const tile of [{ z: 0, x: 0, y: 0 }, { z: 1, x: 0, y: 1 }, { z: 1, x: 1, y: 0 }, { z: 5, x: 0, y: 0 }, { z: 5, x: 31, y: 31 }, { z: 5, x: 31, y: 7 }]) {
        const { whole, banded } = await patches(16, tile, undefined, levels);
        expectSameHeights(whole, banded);
      }
    });

    it("keeps a coarser neighbour whole, in its place, ahead of the bands after it", async () => {
      // 7/40/60 is missing, so the patch's north neighbour is its parent, which also covers the north-east corner.
      const { whole, banded } = await patches(32, { z: 7, x: 40, y: 61 }, new Set(["7/40/60"]), levels);
      expect(neighbourKeys(whole)[1]).toBe("6/20/30/32");
      expect(neighbourKeys(banded).filter(key => key.startsWith("6/"))).toEqual(["6/20/30/32"]);
      expect(neighbourKeys(banded).indexOf("6/20/30/32")).toBe(1);
      expectSameHeights(whole, banded);
    });

    it("reads the same heights for a finer tile drawn from the patch, as a parent's grid stands in for a child", async () => {
      const { whole, banded } = await patches(64, { z: 9, x: 300, y: 200 }, undefined, levels);
      for (const child of [{ z: 10, x: 600, y: 400 }, { z: 10, x: 601, y: 401 }, { z: 11, x: 1203, y: 800 }]) expectSameHeights(whole, banded, child);
    });

    it("keeps whole a neighbour of another size than the patch's, whose pixels a read can reach past a band", async () => {
      const { whole, banded } = await patches(tile => tile.x === 20 && tile.y === 30 ? 2 : 32, { z: 6, x: 20, y: 30 }, undefined, levels);
      expect(banded.neighbors!.map(n => n.size)).toEqual(Array(8).fill(32));
      expectSameHeights(whole, banded);
    });

    it("samples rows with the same bits", async () => {
      const { whole, banded } = await patches(64, { z: 9, x: 300, y: 200 }, undefined, levels);
      const xs = Float64Array.from({ length: 65 }, (_, i) => 300 + i / 64);
      const a = new Float64Array(65), b = new Float64Array(65);
      for (const y of [200, 200 + 0.5 / 64, 200.3, 201 - 0.25 / 64, 201]) {
        sampleTerrainGridRow(whole, terrainGridColumns(whole, xs), y, a);
        sampleTerrainGridRow(banded, terrainGridColumns(banded, xs), y, b);
        expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer))).toBe(true);
      }
    });

    it("builds the same meshes in the renderer, the TypeScript core and the WebAssembly core", async () => {
      const core = await instantiateTerrainCore(readFileSync(new URL("../terrain-WASM/single/terrain.wasm", import.meta.url)), { workerRealm: true });
      try {
        for (const [size, tile] of [[32, { z: 6, x: 20, y: 30 }], [64, { z: 9, x: 300, y: 200 }], [512, { z: 12, x: 1045, y: 1478 }]] as const) {
          const { whole, banded } = await patches(size, tile, undefined, levels);
          for (const target of [tile, { z: tile.z + 1, x: tile.x * 2 + 1, y: tile.y * 2 }]) for (const segments of [1, 3, 16, 64]) {
            const a = terrainMeshTarget({ segments }, target, whole), b = terrainMeshTarget({ segments }, target, banded);
            expect(Buffer.from(b.positions.buffer).equals(Buffer.from(a.positions.buffer))).toBe(true);
            expect(b.heightBounds).toEqual(a.heightBounds);
            const ta = prepareTerrainNumericGeometry({ tile: target, grid: whole, segments }), tb = prepareTerrainNumericGeometry({ tile: target, grid: banded, segments });
            expect(Buffer.from(tb.positions.buffer).equals(Buffer.from(ta.positions.buffer))).toBe(true);
            expect(Buffer.from(tb.targetPositions.buffer).equals(Buffer.from(ta.targetPositions.buffer))).toBe(true);
            const wa = core.buildSurface({ tile: target, grid: whole, segments, withUvs: false });
            const wb = core.buildSurface({ tile: target, grid: banded, segments, withUvs: false });
            expect(Buffer.from(wb.positions.buffer).equals(Buffer.from(wa.positions.buffer))).toBe(true);
            expect(Buffer.from(wb.targetPositions.buffer).equals(Buffer.from(ta.targetPositions.buffer))).toBe(true);
          }
          // The WebAssembly height sampler, over the whole patch.
          const points = pointsIn(whole), sampler = core.createHeightSampler(banded);
          try {
            const heights = sampler.sample(Float64Array.from(points.flat()));
            points.forEach(([x, y], i) => { if (!Object.is(heights[i], sampleTerrainGrid(whole, x, y))) expect.fail(`WASM height at ${x}, ${y}`); });
          } finally { sampler.dispose(); }
        }
      } finally { core.dispose(); }
    });

    it("samples the same heights from the pixels a height batch keeps", async () => {
      const { whole, banded } = await patches(64, { z: 9, x: 300, y: 200 }, undefined, levels);
      const points = pointsIn(whole), coordinates = Float64Array.from(points.flat());
      const sparse = collectTerrainHeightPixels(banded, coordinates);
      for (const [x, y] of points) expect(sampleTerrainHeightPixels(sparse, x, y)).toBe(sampleTerrainGrid(whole, x, y));
    });
  });

  it("makes each band once per neighbour grid and side, keeps shared heights shared, and leaves grids it cannot split whole", () => {
    const grid = { z: 3, x: 2, y: 2, size: 8, heights: heightsOf({ z: 3, x: 2, y: 2 }, 8) };
    expect(neighborBand(grid, 1, 0, 2)).toBe(neighborBand(grid, 1, 0, 2));
    expect(neighborBand(grid, 1, 0, 2)).not.toBe(neighborBand(grid, -1, 0, 2));
    expect(neighborBand(grid, 1, 0, 2)).not.toBe(neighborBand(grid, 1, 0, 1));
    // Levels 1 to 4 only, and only where each band keeps 2 pixels.
    for (const levels of [0, -1, 1.5, 5, Number.NaN]) expect(neighborBand(grid, 1, 0, levels)).toBeNull();
    expect(neighborBand(grid, 1, 0, 1)!.map(band => band.size)).toEqual([4, 4]);
    expect(neighborBand(grid, 1, 0, 3)).toBeNull();
    const big = { ...grid, size: 32, heights: new Float32Array(1024) };
    expect(neighborBand(big, 0, 1, 4)!.map(band => [band.z, band.size])).toEqual(Array(16).fill([7, 2]));
    expect(neighborBand(big, 1, 1, 4)!.map(band => [band.z, band.x, band.y, band.size])).toEqual([[7, 32, 32, 2]]);
    expect(neighborBand(grid, 0, 0, 2)).toBeNull();
    expect(neighborBand({ ...grid, size: 4, heights: new Float32Array(16) }, 1, 0, 2)).toBeNull();
    expect(neighborBand({ ...grid, size: 12, heights: new Float32Array(144) }, 1, 0, 2)).toBeNull();
    expect(neighborBand({ ...grid, heights: new Float32Array(63) }, 1, 0, 2)).toBeNull();
    const shared = new Float32Array(new SharedArrayBuffer(256));
    shared.set(grid.heights);
    expect(neighborBand({ ...grid, heights: shared }, 0, -1, 2)!.every(band => band.heights.buffer instanceof SharedArrayBuffer)).toBe(true);
  });

  it("keeps whole neighbours while the limit is off or absent", async () => {
    for (const levels of [0, undefined]) {
      const loader = loaderFor(16, levels);
      const patch = await loader.loadPatch({ z: 6, x: 20, y: 30 });
      expect(patch.neighbors!.map(n => n.size)).toEqual(Array(8).fill(16));
      loader.dispose();
    }
  });
});

describe("neighbour lookup (L6)", () => {
  // Each point sampled with a new neighbour list, so nothing is remembered: the plain ordered scan.
  const fresh = (grid: TerrainGrid, x: number, y: number) => sampleTerrainGrid({ ...grid, neighbors: [...grid.neighbors!] }, x, y);
  const grid = (z: number, x: number, y: number, size = 8): TerrainGrid => ({ z, x, y, size, heights: heightsOf({ z, x, y }, size) });
  // Down the east edge, then back up, then across the corners: the bands' pixels in turn, and each again.
  const edgePoints = (tile: TerrainTile, size: number): Array<[number, number]> => {
    const points: Array<[number, number]> = [];
    for (const x of [tile.x + 1 - 0.2 / size, tile.x + 0.1 / size]) {
      for (let i = 0; i <= 4 * size; i++) points.push([x, tile.y + 1 - i / (4 * size)]);
      for (let i = 0; i <= 4 * size; i++) points.push([x, tile.y + i / (4 * size)]);
    }
    for (let i = 0; i <= 4 * size; i++) points.push([tile.x + i / (4 * size), tile.y + 0.3 / size], [tile.x + 1 - i / (4 * size), tile.y + 1 - 0.3 / size]);
    return points;
  };

  it("reads the first neighbour that covers a pixel where neighbours overlap, after a later one covered the pixels before", async () => {
    const core = await instantiateTerrainCore(readFileSync(new URL("../terrain-WASM/single/terrain.wasm", import.meta.url)), { workerRealm: true });
    try {
      // The east neighbour's top-left quarter comes first, then the whole east neighbour, then the rest.
      const centre = grid(4, 5, 5), quarterEast = grid(5, 12, 10), east = grid(4, 6, 5), others = [grid(4, 4, 5), grid(4, 5, 4), grid(4, 5, 6)];
      for (const neighbors of [[quarterEast, east, ...others], [quarterEast, ...others, east], [quarterEast, east, ...others, grid(3, 3, 2)]]) {
        const patch: TerrainGrid = { ...centre, neighbors };
        const points = edgePoints(centre, 8);
        let quarter = 0;
        for (const [x, y] of points) {
          const want = fresh(patch, x, y);
          if (!Object.is(sampleTerrainGrid(patch, x, y), want)) expect.fail(`TypeScript height at ${x}, ${y}`);
          if (x > 5.9 && y < 5.5) quarter++;
        }
        expect(quarter).toBeGreaterThan(10);
        const sampler = core.createHeightSampler(patch);
        try {
          const heights = sampler.sample(Float64Array.from(points.flat()));
          points.forEach(([x, y], i) => { if (!Object.is(heights[i], fresh(patch, x, y))) expect.fail(`WASM height at ${x}, ${y}`); });
        } finally { sampler.dispose(); }
        const mesh = (p: TerrainGrid) => core.buildSurface({ tile: centre, grid: p, segments: 16, withUvs: false }).positions;
        const plain = prepareTerrainNumericGeometry({ tile: centre, grid: patch, segments: 16 }).positions;
        expect(Buffer.from(mesh(patch).buffer).equals(Buffer.from(plain.buffer))).toBe(true);
      }
    } finally { core.dispose(); }
  });

  it("reads the same heights as the ordered scan from a patch of bands, with bands of 2 to 4 levels and a corner neighbour missing", async () => {
    for (const levels of [2, 3, 4]) for (const missing of [new Set<string>(), new Set(["9/301/201"])]) {
      const { banded } = await patches(64, { z: 9, x: 300, y: 200 }, missing, levels);
      for (const [x, y] of edgePoints(banded, 64)) if (!Object.is(sampleTerrainGrid(banded, x, y), fresh(banded, x, y))) expect.fail(`height at ${x}, ${y}, ${levels} levels`);
    }
  });
});

describe("elevation cache bytes (L6)", () => {
  const tile = (x: number) => ({ z: 6, x, y: 30 });
  it("lets the oldest used tiles go past the byte bound, counting each tile's heights", async () => {
    const asked: string[] = [];
    const loader = loaderFor(16, 2, new Set(), { cacheBytes: 3 * 1024 }, asked);
    for (const x of [1, 2, 3]) await loader.load(tile(x));
    expect(loader.getMetrics().cachedBytes).toBe(3 * 1024);
    await loader.load(tile(1));
    await loader.load(tile(4));
    // 2 was used longest ago.
    expect(loader.getMetrics().cachedBytes).toBe(3 * 1024);
    asked.length = 0;
    for (const x of [1, 3, 4]) await loader.load(tile(x));
    expect(asked).toEqual([]);
    await loader.load(tile(2));
    expect(asked).toEqual(["6/2/30"]);
    loader.dispose();
    expect(loader.getMetrics().cachedBytes).toBe(0);
  });

  it("does not count a tile under a missing one, which holds its ancestor's heights", async () => {
    const loader = loaderFor(16, 2, new Set(["7/40/60"]), { cacheBytes: 2 * 1024 });
    const grid = await loader.load({ z: 7, x: 40, y: 60 });
    expect(grid.z).toBe(6);
    expect(loader.getMetrics().cachedBytes).toBe(1024);
    loader.dispose();
  });

  it("keeps the count as the only bound without one", async () => {
    const asked: string[] = [];
    const loader = loaderFor(16, 2, new Set(), { cacheEntries: 2 }, asked);
    for (const x of [1, 2, 3]) await loader.load(tile(x));
    expect(loader.getMetrics().cachedBytes).toBe(2 * 1024);
    asked.length = 0;
    await loader.load(tile(2)); await loader.load(tile(3));
    expect(asked).toEqual([]);
    loader.dispose();
  });

  it("forgets the bytes of a tile that failed", async () => {
    const loader = createTerrainTileLoader<Blob, AbortSignal>({
      ports: { createAbortController: () => new AbortController(), requestSignal: signal => signal,
        fetchTile: async () => new Response("x"), byteLength: blob => blob.size },
      limits: () => ({ ...DEFAULT_TERRAIN_LOADER_LIMITS, cacheBytes: 4096 }),
      decode: async () => { throw new Error("bad tile"); },
    });
    await expect(loader.load(tile(1))).rejects.toThrow("bad tile");
    expect(loader.getMetrics().cachedBytes).toBe(0);
    loader.dispose();
  });

  it("decodes a kept download again without asking the transport, and keeps the most recently decoded within its bound", async () => {
    const asked: string[] = [];
    // Each download is 6 bytes ("6/x/30"); 13 bytes keep two.
    const loader = loaderFor(16, 2, new Set(), { cacheEntries: 1, encodedBytes: 13 }, asked);
    for (const x of [1, 2, 3]) await loader.load(tile(x));
    expect(loader.getMetrics()).toMatchObject({ cachedBytes: 1024, encodedBytes: 12 });
    asked.length = 0;
    const again = await loader.load(tile(2));
    expect(asked).toEqual([]);
    expect([...again.heights]).toEqual([...heightsOf(tile(2), 16)]);
    await loader.load(tile(1));
    expect(asked).toEqual(["6/1/30"]);
    // 1 was decoded last, so 3 went.
    asked.length = 0;
    await loader.load(tile(2)); await loader.load(tile(1));
    expect(asked).toEqual([]);
    await loader.load(tile(3));
    expect(asked).toEqual(["6/3/30"]);
    loader.dispose();
    expect(loader.getMetrics().encodedBytes).toBe(0);
  });

  it("keeps no downloads without the bound, and asks again for one that would not decode", async () => {
    const asked: string[] = [];
    const none = loaderFor(16, 2, new Set(), { cacheEntries: 1 }, asked);
    await none.load(tile(1)); await none.load(tile(2)); await none.load(tile(1));
    expect(asked).toEqual(["6/1/30", "6/2/30", "6/1/30"]);
    expect(none.getMetrics().encodedBytes).toBe(0);
    none.dispose();
    let fail = false, fetches = 0;
    const loader = createTerrainTileLoader<Blob, AbortSignal>({
      ports: { createAbortController: () => new AbortController(), requestSignal: signal => signal,
        fetchTile: async () => { fetches++; return new Response("6/1/30"); }, byteLength: blob => blob.size },
      limits: () => ({ ...DEFAULT_TERRAIN_LOADER_LIMITS, cacheEntries: 1, encodedBytes: 1000 }),
      decode: async () => { if (fail) throw new Error("bad tile"); return { size: 1, heights: new Float32Array([1]) }; },
    });
    await loader.load(tile(1)); await loader.load(tile(2));
    fail = true;
    await expect(loader.load(tile(1))).rejects.toThrow("bad tile");
    fail = false;
    expect(fetches).toBe(2);
    await loader.load(tile(1));
    expect(fetches).toBe(3);
    loader.dispose();
  });

  it("does not let kept downloads go for one larger than the whole bound", async () => {
    const asked: string[] = [];
    const loader = loaderFor(16, 2, new Set(), { cacheEntries: 1, encodedBytes: 7 }, asked);
    await loader.load(tile(1));
    await loader.load(tile(10));
    // "6/100/30" is 8 bytes.
    await loader.load({ z: 6, x: 100, y: 30 });
    expect(loader.getMetrics().encodedBytes).toBe(7);
    asked.length = 0;
    await loader.load(tile(10));
    expect(asked).toEqual([]);
    loader.dispose();
  });
});
