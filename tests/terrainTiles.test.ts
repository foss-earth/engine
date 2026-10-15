import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerrainInterest, createTerrainTileLoader, DEFAULT_TERRAIN_LOADER_LIMITS, isTerrainWithdrawn } from "../src/terrain/terrainLoader.js";
import { decodeTerrarium, MAPTERHORN, sampleTerrainGrid, sampleTerrainGridRow, terrainGridColumns, type TerrainGrid } from "../src/terrain/terrainGrid.js";

afterEach(() => vi.unstubAllGlobals());
const ports = { createAbortController: () => new AbortController(), requestSignal: (signal: AbortSignal, timeoutMs: number) => AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  fetchTile: (url: string, signal: AbortSignal) => fetch(url, { signal }), byteLength: (blob: Blob) => blob.size };
const options = { ports, limits: () => DEFAULT_TERRAIN_LOADER_LIMITS, decode: async () => ({ size: 1, heights: new Float32Array([250]) }) };

describe("streamed terrain", () => {
  it("decodes negative and fractional elevations without color normalization", () => {
    expect([...decodeTerrarium(new Uint8ClampedArray([127, 255, 128, 255]), 1)]).toEqual([-0.5]);
    expect([...decodeTerrarium(new Uint8ClampedArray([129, 0, 64, 255]), 1)]).toEqual([256.25]);
    expect(() => decodeTerrarium(new Uint8ClampedArray([0, 0, 0, 0]), 1)).toThrow("missing");
    expect(() => decodeTerrarium(new Uint8ClampedArray([129, 0, 64, 255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3, 0]), 2)).toThrow("missing");
    const aligned = new Uint8ClampedArray(8);
    aligned.set([129, 0, 64, 255], 4);
    expect([...decodeTerrarium(new Uint8ClampedArray(aligned.buffer, 4, 4), 1)]).toEqual([256.25]);
    const unaligned = new Uint8ClampedArray(8);
    unaligned.set([129, 0, 64, 255], 1);
    expect([...decodeTerrarium(new Uint8ClampedArray(unaligned.buffer, 1, 4), 1)]).toEqual([256.25]);
  });
  it("stores the same float32 height as the byte formula for every colour", () => {
    const shipped = new Float32Array(1), fast = new Float32Array(1);
    for (let red = 0; red < 256; red++) for (let green = 0; green < 256; green++) for (let blue = 0; blue < 256; blue++) {
      shipped[0] = red * 256 + green + blue / 256 - 32768;
      const word = (red | (green << 8) | (blue << 16)) + 0xff000000;
      fast[0] = ((((word & 0xff) << 16) | (word & 0xff00) | ((word >>> 16) & 0xff)) - 8388608) / 256;
      if (!Object.is(shipped[0], fast[0])) expect.fail(`rgb ${red},${green},${blue}: ${fast[0]} is not ${shipped[0]}`);
    }
    const size = 32, data = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = (i * 3) & 255; data[i + 1] = (i * 7) & 255; data[i + 2] = (i * 11) & 255; data[i + 3] = 255; }
    const heights = decodeTerrarium(data, size), one = new Float32Array(1);
    for (let i = 0; i < heights.length; i++) {
      const offset = i * 4;
      one[0] = data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32768;
      if (!Object.is(heights[i], one[0])) expect.fail(`pixel ${i}: ${heights[i]} is not ${one[0]}`);
    }
  });
  it("samples pixel centers and interpolates a parent tile for a missing child", () => {
    const grid = { z: 0, x: 0, y: 0, size: 2, heights: new Float32Array([0, 10, 20, 30]) };
    expect(sampleTerrainGrid(grid, 0.25, 0.25)).toBe(0);
    expect(sampleTerrainGrid(grid, 0.5, 0.5)).toBe(15);
    expect(sampleTerrainGrid(grid, 1, 1)).toBe(30);
  });
  it("deduplicates requests and falls back on 404 without deadlocking all six slots", async () => {
    const fetcher = vi.fn(async (url: string) => new Response("tile", { status: url.includes("/0/0/0") ? 200 : 404 }));
    vi.stubGlobal("fetch", fetcher);
    const loader = createTerrainTileLoader({ ...options, trackMemory: true });
    const tile = { z: 2, x: 0, y: 0 };
    expect(loader.load(tile)).toBe(loader.load(tile));
    const grids = await Promise.all(Array.from({ length: 8 }, (_, i) => loader.load({ z: 2, x: i % 4, y: Math.floor(i / 4) })));
    expect(grids.every(grid => grid.z === 0 && grid.heights[0] === 250)).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("/0/0/0"))).toHaveLength(1);
    expect(loader.getMetrics().decodedBytes).toBe(4); // shared parent array is counted once
    loader.dispose();
    expect(loader.getMetrics().decodedBytes).toBe(0);
  });
  it("samples a row of shared columns with sampleTerrainGrid's bits, inside the grid, at its edges and beyond", () => {
    let state = 7;
    const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const grid = (z: number, x: number, y: number, size: number): TerrainGrid => ({ z, x, y, size,
      heights: Float32Array.from({ length: size * size }, () => Math.round(random() * 2_000_000) / 256 - 3000) });
    let edgeSamples = 0, ownSamples = 0;
    for (const size of [1, 2, 3, 16, 512]) for (const neighbors of [undefined, [] as TerrainGrid[], "around"] as const) {
      const center = grid(12, 985, 1471, size);
      if (neighbors === "around") center.neighbors = [grid(12, 984, 1471, size), grid(12, 985, 1470, size), grid(11, 492, 736, size), grid(12, 986, 1472, size)];
      else if (neighbors) center.neighbors = neighbors;
      // In the grid's own tile coordinates: the columns of its own tile's mesh, a
      // child tile's, a parent tile's, and columns overhanging both edges.
      for (const [from, to, count] of [[985, 986, 65], [985.5, 986, 65], [984, 986, 33], [984.9, 986.1, 50]] as const) {
        const xs = Float64Array.from({ length: count }, (_, col) => from + (col / (count - 1)) * (to - from));
        const columns = terrainGridColumns(center, xs), out = new Float64Array(count);
        for (const y of [1471, 1471 + 0.5 / size, 1471 + 1e-9, 1471.37, 1472 - 0.5 / size, 1472, 1470.9, 1472.2, 1471 + random()]) {
          out.fill(Number.NaN);
          sampleTerrainGridRow(center, columns, y, out);
          for (let col = 0; col < count; col++) {
            const expected = sampleTerrainGrid(center, xs[col], y);
            if (!Object.is(out[col], expected)) expect.fail(`size ${size} ${String(neighbors)} x ${xs[col]} y ${y}: ${out[col]} is not ${expected}`);
            if (center.neighbors && (columns.edge[col] || y - center.y < 0.5 / size || y - center.y > 1 - 0.5 / size)) edgeSamples++; else ownSamples++;
          }
        }
      }
    }
    expect(edgeSamples).toBeGreaterThan(1000);
    expect(ownSamples).toBeGreaterThan(1000);
  });
  it("uses both tiles at a shared edge instead of producing a half-pixel height step", () => {
    const left = { z: 1, x: 0, y: 0, size: 2, heights: new Float32Array([0, 10, 0, 10]) };
    const right = { z: 1, x: 1, y: 0, size: 2, heights: new Float32Array([20, 30, 20, 30]) };
    expect(sampleTerrainGrid({ ...left, neighbors: [right] }, 1, 0.5)).toBe(15);
    expect(sampleTerrainGrid({ ...right, neighbors: [left] }, 1, 0.5)).toBe(15);
  });
  it("does not turn server errors into fabricated ground", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const loader = createTerrainTileLoader(options);
    await expect(loader.load({ z: 1, x: 0, y: 0 })).rejects.toThrow("503");
    loader.dispose();
  });
  it("rejects paused queued loads on disposal without starting their transport", async () => {
    const fetchTile = vi.fn(async () => new Response("tile"));
    const loader = createTerrainTileLoader({ ...options, ports: { ...ports, fetchTile } });
    loader.setPaused(true);
    const pending = loader.load({ z: 1, x: 0, y: 0 });
    expect(loader.getMetrics().queued).toBe(1);
    loader.dispose(); loader.setPaused(false);
    await expect(pending).rejects.toThrow("disposed");
    expect(fetchTile).not.toHaveBeenCalled();
    expect(loader.getMetrics()).toMatchObject({ queued: 0, active: 0 });
  });
  it("rejects late decode results after disposal and leaves no decoded cache bytes", async () => {
    let finish!: (decoded: { size: number; heights: Float32Array }) => void;
    const decode = vi.fn(() => new Promise<{ size: number; heights: Float32Array }>(resolve => { finish = resolve; }));
    const loader = createTerrainTileLoader({ ...options, trackMemory: true, decode, ports: { ...ports, fetchTile: async () => new Response("tile") } });
    const pending = loader.load({ z: 0, x: 0, y: 0 });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    loader.dispose(); finish({ size: 1, heights: new Float32Array([42]) });
    await expect(pending).rejects.toThrow("disposed");
    expect(loader.getMetrics()).toMatchObject({ queued: 0, active: 0, decodedBytes: 0 });
  });
  it("tells the decoder which tiles were moved ahead and aborts its signal on disposal", async () => {
    const decode = vi.fn<(blob: Blob, request: { prioritize: boolean; signal: AbortSignal }) => Promise<{ size: number; heights: Float32Array }>>(async () => ({ size: 1, heights: new Float32Array([1]) }));
    const loader = createTerrainTileLoader({ ...options, decode, ports: { ...ports, fetchTile: async () => new Response("tile") } });
    await loader.loadPatch({ z: 2, x: 1, y: 1 });
    // The centre waits its turn; its eight neighbours are moved ahead of other centres.
    expect(decode.mock.calls.map(([, request]) => request.prioritize)).toEqual([false, ...Array(8).fill(true)]);
    const { signal } = decode.mock.calls[0][1];
    expect(signal.aborted).toBe(false); loader.dispose(); expect(signal.aborted).toBe(true);
  });

  describe("withdrawn claims", () => {
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    function harness() {
      const fetchTile = vi.fn<(url: string) => Promise<Response>>(async () => new Response("tile"));
      const loader = createTerrainTileLoader({ ...options, ports: { ...ports, fetchTile } });
      const fetched = () => fetchTile.mock.calls.map(([url]) => String(url).match(/\/(\d+\/\d+\/\d+)\.webp/)![1]);
      return { loader, fetchTile, fetched };
    }
    it("takes a waiting tile out of the queue when its only claim is released, and asks for it again later", async () => {
      const { loader, fetched } = harness();
      loader.setPaused(true);
      const interest = createTerrainInterest();
      const withdrawn = loader.load({ z: 3, x: 1, y: 1 }, false, interest);
      const kept = loader.load({ z: 3, x: 2, y: 1 });
      expect(loader.getMetrics().queued).toBe(2);
      interest.release();
      await expect(withdrawn).rejects.toSatisfy(isTerrainWithdrawn);
      expect(loader.getMetrics().queued).toBe(1);
      loader.setPaused(false);
      await kept;
      expect(fetched()).toEqual(["3/2/1"]);
      // Asked for again, it is a new request.
      await expect(loader.load({ z: 3, x: 1, y: 1 })).resolves.toMatchObject({ z: 3, x: 1, y: 1 });
      expect(fetched()).toEqual(["3/2/1", "3/1/1"]);
    });
    it("shares the request for a tile asked for again as it is withdrawn", async () => {
      const { loader, fetched } = harness();
      loader.setPaused(true);
      const interest = createTerrainInterest();
      const withdrawn = loader.load({ z: 3, x: 1, y: 1 }, false, interest);
      interest.release();
      const again = loader.load({ z: 3, x: 1, y: 1 });
      loader.setPaused(false);
      await expect(withdrawn).rejects.toSatisfy(isTerrainWithdrawn);
      await again;
      expect(loader.load({ z: 3, x: 1, y: 1 })).toBe(again);
      expect(fetched()).toEqual(["3/1/1"]);
    });
    it("keeps a waiting tile another claim or a plain request still wants", async () => {
      const { loader, fetched } = harness();
      loader.setPaused(true);
      const first = createTerrainInterest(), second = createTerrainInterest(), third = createTerrainInterest();
      const shared = [loader.load({ z: 3, x: 1, y: 1 }, false, first), loader.load({ z: 3, x: 1, y: 1 }, false, second)];
      const plain = [loader.load({ z: 3, x: 2, y: 1 }, false, third), loader.load({ z: 3, x: 2, y: 1 })];
      first.release(); third.release();
      loader.setPaused(false);
      await expect(Promise.all([...shared, ...plain])).resolves.toHaveLength(4);
      expect(fetched()).toEqual(["3/1/1", "3/2/1"]);
    });
    it("lets a downloading tile finish into the cache when its claim is released", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const { loader, fetchTile, fetched } = harness();
      fetchTile.mockImplementationOnce(async () => { await gate; return new Response("tile"); });
      const interest = createTerrainInterest();
      const downloading = loader.load({ z: 3, x: 1, y: 1 }, false, interest);
      await flush();
      interest.release();
      release();
      await expect(downloading).resolves.toMatchObject({ z: 3, x: 1, y: 1 });
      await loader.load({ z: 3, x: 1, y: 1 });
      expect(fetched()).toEqual(["3/1/1"]);
    });
    it("asks for none of a patch's neighbours once its claim is released", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const { loader, fetchTile, fetched } = harness();
      fetchTile.mockImplementationOnce(async () => { await gate; return new Response("tile"); });
      const interest = createTerrainInterest();
      const patch = loader.loadPatch({ z: 3, x: 1, y: 1 }, interest);
      await flush();
      interest.release();
      release();
      await expect(patch).rejects.toSatisfy(isTerrainWithdrawn);
      await flush();
      expect(fetched()).toEqual(["3/1/1"]);
      expect(loader.getMetrics()).toMatchObject({ active: 0, queued: 0 });
    });
    it("withdraws a patch's waiting neighbours with its claim, keeping those another patch wants", async () => {
      const { loader, fetched } = harness();
      const first = createTerrainInterest(), second = createTerrainInterest();
      await loader.load({ z: 3, x: 1, y: 1 });
      await loader.load({ z: 3, x: 2, y: 1 });
      loader.setPaused(true);
      const patches = [loader.loadPatch({ z: 3, x: 1, y: 1 }, first), loader.loadPatch({ z: 3, x: 2, y: 1 }, second)];
      await flush();
      // 3/1/1's neighbours from x 0 to 2 and 3/2/1's from 1 to 3; both centres are already loaded.
      expect(loader.getMetrics().queued).toBe(10);
      first.release();
      await expect(patches[0]).rejects.toSatisfy(isTerrainWithdrawn);
      // Only those 3/1/1 alone asked for leave: x 0 in rows 0 to 2.
      expect(loader.getMetrics().queued).toBe(7);
      loader.setPaused(false);
      await expect(patches[1]).resolves.toMatchObject({ z: 3, x: 2, y: 1 });
      expect(fetched().filter(key => key.startsWith("3/0/"))).toEqual([]);
      expect(fetched()).toHaveLength(2 + 7);
    });
    it("starts tiles moved ahead in the order they were moved, before the rest", async () => {
      const { loader, fetched } = harness();
      loader.setPaused(true);
      const plain = [loader.load({ z: 4, x: 5, y: 0 }), loader.load({ z: 4, x: 6, y: 0 })];
      const moved = [loader.load({ z: 4, x: 1, y: 0 }, true), loader.load({ z: 4, x: 2, y: 0 }, true), loader.load({ z: 4, x: 6, y: 0 }, true)];
      loader.setPaused(false);
      await Promise.all([...plain, ...moved]);
      expect(fetched()).toEqual(["4/1/0", "4/2/0", "4/6/0", "4/5/0"]);
    });
    it("keeps a waiting tile's place for a patch that holds it before asking", async () => {
      const { loader, fetched } = harness();
      loader.setPaused(true);
      const first = createTerrainInterest(), second = createTerrainInterest();
      const kept = loader.load({ z: 3, x: 2, y: 1 }, false, first);
      const withdrawn = loader.load({ z: 3, x: 6, y: 6 }, false, first);
      // 3/2/1 is held as a neighbour of 3/1/1, 3/6/6 by nothing else; a hold asks for nothing.
      loader.holdPatch({ z: 3, x: 1, y: 1 }, second);
      expect(loader.getMetrics().queued).toBe(2);
      first.release();
      await expect(withdrawn).rejects.toSatisfy(isTerrainWithdrawn);
      expect(loader.getMetrics().queued).toBe(1);
      loader.setPaused(false);
      await expect(kept).resolves.toMatchObject({ z: 3, x: 2, y: 1 });
      await loader.loadPatch({ z: 3, x: 1, y: 1 }, second);
      // 3/2/1 kept its place ahead of the patch's centre.
      expect(fetched().slice(0, 2)).toEqual(["3/2/1", "3/1/1"]);
      expect(fetched()).toHaveLength(9);
    });
    it("asks for a held patch's neighbours when the tile that asked for its centre no longer wants it", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const { loader, fetchTile, fetched } = harness();
      fetchTile.mockImplementationOnce(async () => { await gate; return new Response("tile"); });
      const first = createTerrainInterest(), gone = createTerrainInterest(), second = createTerrainInterest(), third = createTerrainInterest();
      const patch = loader.loadPatch({ z: 3, x: 1, y: 1 }, first);
      await flush();
      loader.setPaused(true);
      for (const hold of [gone, second, third]) loader.holdPatch({ z: 3, x: 1, y: 1 }, hold);
      gone.release(); first.release();
      release();
      await expect(patch).rejects.toSatisfy(isTerrainWithdrawn);
      expect(loader.getMetrics().queued).toBe(8);
      // Asked for the second and claimed for the third: either one keeps them.
      second.release();
      expect(loader.getMetrics().queued).toBe(8);
      loader.setPaused(false);
      await expect(loader.loadPatch({ z: 3, x: 1, y: 1 }, third)).resolves.toMatchObject({ z: 3, x: 1, y: 1 });
      expect(fetched()).toHaveLength(9);
      expect(fetched().slice(1).every(key => key.startsWith("3/"))).toBe(true);
    });
    it("asks for none of a patch's neighbours when every claim holding it is released", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const { loader, fetchTile, fetched } = harness();
      fetchTile.mockImplementationOnce(async () => { await gate; return new Response("tile"); });
      const first = createTerrainInterest(), second = createTerrainInterest();
      const patch = loader.loadPatch({ z: 3, x: 1, y: 1 }, first);
      await flush();
      loader.holdPatch({ z: 3, x: 1, y: 1 }, second);
      second.release(); first.release();
      release();
      await expect(patch).rejects.toSatisfy(isTerrainWithdrawn);
      await flush();
      expect(fetched()).toEqual(["3/1/1"]);
      expect(loader.getMetrics()).toMatchObject({ active: 0, queued: 0 });
    });
    it("asks for a neighbour another patch holds when the tile that asked for the centre no longer wants it", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const { loader, fetchTile, fetched } = harness();
      fetchTile.mockImplementationOnce(async () => { await gate; return new Response("tile"); });
      const first = createTerrainInterest(), second = createTerrainInterest();
      const patch = loader.loadPatch({ z: 3, x: 1, y: 1 }, first);
      await flush();
      loader.setPaused(true);
      // 3/2/1's patch takes in five of 3/1/1's neighbours, those from x 1 to 2.
      loader.holdPatch({ z: 3, x: 2, y: 1 }, second);
      first.release();
      release();
      await expect(patch).rejects.toSatisfy(isTerrainWithdrawn);
      expect(loader.getMetrics().queued).toBe(5);
      loader.setPaused(false);
      await expect(loader.loadPatch({ z: 3, x: 2, y: 1 }, second)).resolves.toMatchObject({ z: 3, x: 2, y: 1 });
      expect(fetched().filter(key => key.startsWith("3/0/"))).toEqual([]);
      expect(fetched()).toHaveLength(1 + 5 + 3);
    });
    it("claims a held tile for its holder as it is asked for", async () => {
      const { loader, fetched } = harness();
      loader.setPaused(true);
      const first = createTerrainInterest(), second = createTerrainInterest();
      loader.holdPatch({ z: 3, x: 1, y: 1 }, second);
      expect(loader.getMetrics().queued).toBe(0);
      const asked = loader.load({ z: 3, x: 2, y: 1 }, false, first);
      first.release();
      expect(loader.getMetrics().queued).toBe(1);
      second.release();
      await expect(asked).rejects.toSatisfy(isTerrainWithdrawn);
      loader.setPaused(false);
      await flush();
      expect(fetched()).toEqual([]);
    });
    it("tells when a tile arrives, however it was asked for, asking for nothing", async () => {
      const { loader, fetched } = harness();
      loader.setPaused(true);
      const interest = createTerrainInterest(), gone = createTerrainInterest();
      const arrived = vi.fn(), early = vi.fn();
      void loader.whenLoaded({ z: MAPTERHORN.maxZoom + 1, x: 0, y: 0 }, interest).then(arrived);
      void loader.whenLoaded({ z: MAPTERHORN.maxZoom, x: 0, y: 0 }, gone).then(early);
      gone.release();
      await flush();
      expect([arrived.mock.calls.length, loader.getMetrics().queued]).toEqual([0, 0]);
      const tile = loader.load({ z: MAPTERHORN.maxZoom, x: 0, y: 0 });
      loader.setPaused(false);
      await tile; await flush();
      expect([arrived.mock.calls.length, early.mock.calls.length]).toEqual([1, 0]);
      await expect(loader.whenLoaded({ z: MAPTERHORN.maxZoom, x: 0, y: 0 }, createTerrainInterest())).resolves.toBeUndefined();
      expect(fetched()).toEqual([`${MAPTERHORN.maxZoom}/0/0`]);
    });
    it("holds the tile a patch beyond the source's levels is taken from", async () => {
      const { loader } = harness();
      loader.setPaused(true);
      const first = createTerrainInterest(), second = createTerrainInterest();
      const kept = loader.load({ z: MAPTERHORN.maxZoom, x: 0, y: 0 }, false, first);
      loader.holdPatch({ z: MAPTERHORN.maxZoom + 2, x: 1, y: 1 }, second);
      first.release();
      loader.setPaused(false);
      await expect(kept).resolves.toMatchObject({ z: MAPTERHORN.maxZoom, x: 0, y: 0 });
    });
  });

  describe("decode slots", () => {
    const decoded = { size: 1, heights: new Float32Array([7]) };
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    function harness(limits: { maxConcurrent: number }, decodeSlots?: () => number) {
      const decodes: { resolve(value: typeof decoded): void; reject(error: Error): void }[] = [];
      const decode = vi.fn(() => new Promise<typeof decoded>((resolve, reject) => { decodes.push({ resolve, reject }); }));
      const fetchTile = vi.fn(async () => new Response("tile"));
      const loader = createTerrainTileLoader({ ...options, decode, limits: () => ({ ...DEFAULT_TERRAIN_LOADER_LIMITS, ...limits }),
        ...(decodeSlots ? { decodeSlots } : {}), ports: { ...ports, fetchTile } });
      const load = (x: number) => loader.load({ z: 4, x, y: 0 });
      return { loader, decode, decodes, fetchTile, load };
    }
    it("keeps a tile in its download slot until it is decoded when there are none", async () => {
      const { loader, decode, decodes, fetchTile, load } = harness({ maxConcurrent: 2 });
      const tiles = [load(0), load(1), load(2)];
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2)); await flush();
      expect(fetchTile).toHaveBeenCalledTimes(2);
      expect(loader.getMetrics()).toMatchObject({ active: 2, decoding: 2, queued: 1 });
      decodes[0].resolve(decoded);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3));
      decodes[1].resolve(decoded); decodes[2].resolve(decoded);
      expect((await Promise.all(tiles)).map(grid => grid.x)).toEqual([0, 1, 2]);
      expect(loader.getMetrics()).toMatchObject({ active: 0, decoding: 0, queued: 0 });
    });
    it("downloads more tiles while downloaded ones wait to decode, up to the decode slots", async () => {
      const { loader, decode, decodes, fetchTile, load } = harness({ maxConcurrent: 2 }, () => 1);
      const tiles = [0, 1, 2, 3].map(load);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3)); await flush();
      // Two download slots and one decode slot: three tiles download or decode, the fourth waits.
      expect(fetchTile).toHaveBeenCalledTimes(3);
      expect(loader.getMetrics()).toMatchObject({ active: 3, decoding: 3, queued: 1 });
      decodes[1].resolve(decoded);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(4));
      for (const index of [0, 2, 3]) decodes[index].resolve(decoded);
      expect((await Promise.all(tiles)).map(grid => grid.x)).toEqual([0, 1, 2, 3]);
      expect(loader.getMetrics()).toMatchObject({ active: 0, decoding: 0, queued: 0 });
    });
    it("never runs more downloads than the download slots, whatever the decode slots", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const { loader, fetchTile, load } = harness({ maxConcurrent: 2 }, () => 8);
      fetchTile.mockImplementation(async () => { await gate; return new Response("tile"); });
      void [0, 1, 2, 3].map(load);
      await flush();
      expect(fetchTile).toHaveBeenCalledTimes(2);
      expect(loader.getMetrics()).toMatchObject({ active: 2, decoding: 0, queued: 2 });
      release(); loader.dispose();
    });
    it("reads the decode slots at each start, so fewer stop downloads until decodes finish", async () => {
      let slots = 2;
      const { decode, decodes, fetchTile, load } = harness({ maxConcurrent: 1 }, () => slots);
      void [0, 1, 2, 3, 4].map(load);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3)); await flush();
      slots = 0;
      decodes[0].resolve(decoded); decodes[1].resolve(decoded); await flush();
      // One tile still decodes and one download slot is all there is: nothing starts.
      expect(fetchTile).toHaveBeenCalledTimes(3);
      decodes[2].resolve(decoded);
      await vi.waitFor(() => expect(fetchTile).toHaveBeenCalledTimes(4));
    });
    it("frees a decode slot when its decode fails, and forgets the tile", async () => {
      const { decode, decodes, fetchTile, load } = harness({ maxConcurrent: 1 }, () => 1);
      const first = load(0), second = load(1), third = load(2);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2)); await flush();
      expect(fetchTile).toHaveBeenCalledTimes(2);
      decodes[0].reject(new Error("bad tile"));
      await expect(first).rejects.toThrow("bad tile");
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3));
      decodes[1].resolve(decoded); decodes[2].resolve(decoded);
      await expect(Promise.all([second, third])).resolves.toHaveLength(2);
      // A failed tile is asked for again.
      void load(0);
      await vi.waitFor(() => expect(fetchTile).toHaveBeenCalledTimes(4));
    });
    it("decodes downloaded tiles while paused and starts none", async () => {
      const { loader, decode, decodes, fetchTile, load } = harness({ maxConcurrent: 1 }, () => 2);
      const first = load(0);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
      loader.setPaused(true);
      const later = [load(1), load(2)];
      decodes[0].resolve(decoded);
      await expect(first).resolves.toMatchObject({ x: 0 });
      await flush();
      expect(fetchTile).toHaveBeenCalledTimes(1);
      expect(loader.getMetrics()).toMatchObject({ active: 0, decoding: 0, queued: 2 });
      loader.setPaused(false);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3));
      decodes[1].resolve(decoded); decodes[2].resolve(decoded);
      await expect(Promise.all(later)).resolves.toHaveLength(2);
    });
    it("rejects tiles waiting to decode on disposal and leaves nothing counted", async () => {
      const { loader, decode, decodes, load } = harness({ maxConcurrent: 1 }, () => 2);
      const tiles = [0, 1, 2, 3].map(load);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3));
      loader.dispose();
      for (const pending of decodes) pending.resolve(decoded);
      for (const tile of tiles) await expect(tile).rejects.toThrow("disposed");
      expect(loader.getMetrics()).toMatchObject({ active: 0, decoding: 0, queued: 0 });
    });
    it("falls back on 404 without deadlocking when every slot holds a decode", async () => {
      const fetcher = vi.fn(async (url: string) => new Response("tile", { status: url.includes("/0/0/0") ? 200 : 404 }));
      vi.stubGlobal("fetch", fetcher);
      const loader = createTerrainTileLoader({ ...options, decodeSlots: () => 2, limits: () => ({ ...DEFAULT_TERRAIN_LOADER_LIMITS, maxConcurrent: 1 }) });
      const grids = await Promise.all(Array.from({ length: 8 }, (_, i) => loader.load({ z: 2, x: i % 4, y: Math.floor(i / 4) })));
      expect(grids.every(grid => grid.z === 0 && grid.heights[0] === 250)).toBe(true);
      expect(fetcher.mock.calls.filter(([url]) => url.includes("/0/0/0"))).toHaveLength(1);
      expect(loader.getMetrics()).toMatchObject({ active: 0, decoding: 0, queued: 0 });
    });
  });
});
