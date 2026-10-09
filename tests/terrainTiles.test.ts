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
});
