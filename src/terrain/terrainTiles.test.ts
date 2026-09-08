import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerrainTileLoader, decodeTerrarium, sampleTerrainGrid } from "./terrainTiles";

afterEach(() => vi.unstubAllGlobals());
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
    const loader = createTerrainTileLoader(undefined, undefined, async () => ({ size: 1, heights: new Float32Array([250]) }));
    const tile = { z: 2, x: 0, y: 0 };
    expect(loader.load(tile)).toBe(loader.load(tile));
    const grids = await Promise.all(Array.from({ length: 8 }, (_, i) => loader.load({ z: 2, x: i % 4, y: Math.floor(i / 4) })));
    expect(grids.every(grid => grid.z === 0 && grid.heights[0] === 250)).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("/0/0/0"))).toHaveLength(1);
    loader.dispose();
  });
  it("uses both tiles at a shared edge instead of producing a half-pixel height step", () => {
    const left = { z: 1, x: 0, y: 0, size: 2, heights: new Float32Array([0, 10, 0, 10]) };
    const right = { z: 1, x: 1, y: 0, size: 2, heights: new Float32Array([20, 30, 20, 30]) };
    expect(sampleTerrainGrid({ ...left, neighbors: [right] }, 1, 0.5)).toBe(15);
    expect(sampleTerrainGrid({ ...right, neighbors: [left] }, 1, 0.5)).toBe(15);
  });
  it("does not turn server errors into fabricated ground", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const loader = createTerrainTileLoader();
    await expect(loader.load({ z: 1, x: 0, y: 0 })).rejects.toThrow("503");
    loader.dispose();
  });
});
