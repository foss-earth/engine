import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerrainTileLoader, DEFAULT_TERRAIN_LOADER_LIMITS } from "../src/terrain/terrainLoader.js";
import { decodeTerrarium, sampleTerrainGrid } from "../src/terrain/terrainGrid.js";

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
});
