import { describe, expect, it, vi } from "vitest";
import { createTerrainHeightBatches } from "../src/browser/terrainHeightBatches.js";
import { installTerrainHeightBatchKernel } from "../src/browser/terrainHeightBatchKernel.js";
import type { HeightBatchReply, HeightBatchRequest, HeightBatchWorkerPort, HeightBatchWorkerScope } from "../src/browser/terrainHeightBatchProtocol.js";
import { sampleTerrainHeightPixels, type TerrainHeightPixels } from "../src/browser/terrainHeightPixels.js";
import { sampleTerrainGrid, type TerrainGrid } from "../src/terrain/terrainGrid.js";

const turn = () => new Promise(resolve => setImmediate(resolve));
function setup(kernel: "single" | "typescript" | "threaded" = "single", mismatch = false) {
  const timers: Array<() => void> = [], scheduled: Array<() => void> = [];
  const worker: HeightBatchWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: (request, transfer) => scope.onmessage?.({ data: structuredClone(request, { transfer: transfer as ArrayBuffer[] }) } as MessageEvent<HeightBatchRequest>), terminate: vi.fn() };
  const scope: HeightBatchWorkerScope = { onmessage: null,
    postMessage: reply => worker.onmessage?.({ data: structuredClone(reply) } as MessageEvent<HeightBatchReply>) };
  const loadNative = vi.fn(async () => ({ createHeightSampler: (grid: TerrainGrid) => ({ bytes: grid.heights.byteLength,
    sample(xy: Float64Array) { return Float64Array.from({ length: xy.length / 2 }, (_, i) => ("indices" in grid ? sampleTerrainHeightPixels(grid as TerrainHeightPixels, xy[i * 2], xy[i * 2 + 1]) : sampleTerrainGrid(grid, xy[i * 2], xy[i * 2 + 1])) + (mismatch ? 1 : 0)); }, dispose() {} }), dispose() {} }));
  const installed = installTerrainHeightBatchKernel({ scope, kernel, now: () => performance.now(), loadNative });
  const batches = createTerrainHeightBatches({ kernel, createWorker: () => worker, now: () => performance.now(),
    schedule: callback => { scheduled.push(callback); }, after: callback => { timers.push(callback); return () => { timers.splice(timers.indexOf(callback), 1); }; } });
  return { batches, worker, loadNative, timers, async flush() { while (scheduled.length) scheduled.shift()!(); await turn(); }, dispose() { batches.dispose(); installed.dispose(); } };
}
const grid: TerrainGrid = { z: 1, x: 0, y: 0, size: 2, heights: new Float32Array([0.1, 10, -9, 1234.1234]) };
const xy = new Float64Array([0.1, 0.2, 0.9, 0.7, 0.5, 0.5, 0, 0, 1, 1]);
const reference = (source = grid) => Float64Array.from({ length: xy.length / 2 }, (_, i) => sampleTerrainGrid(source, xy[i * 2], xy[i * 2 + 1]));

describe("immutable batched imagery heights", () => {
  it.each(["single", "typescript", "threaded"] as const)("keeps exact immediate heights, then admits matching cached results (%s)", async kernel => {
    const test = setup(kernel);
    try {
      expect(test.batches.sample(grid, xy)).toEqual(reference());
      expect(test.batches.stats()).toMatchObject({ actual: "not started", cacheHits: 0, pageSamples: 5 });
      await test.flush();
      expect(test.batches.sample(grid, xy)).toEqual(reference());
      expect(test.batches.stats()).toMatchObject({ jobs: 1, cacheHits: 5, pageSamples: 5,
        actual: kernel === "single" ? "single" : "typescript", parity: kernel === "single" ? "same" : "not compared",
        fallbackReason: kernel === "threaded" ? "threaded-unavailable" : null });
      expect(test.loadNative).toHaveBeenCalledTimes(kernel === "single" ? 1 : 0);
      const replacement = { ...grid, heights: new Float32Array([90, 10, 0, 30]) };
      expect(test.batches.sample(replacement, xy)).toEqual(reference(replacement));
      expect(test.batches.stats().pageSamples).toBe(10);
      await test.flush();
      expect(test.batches.sample(replacement, xy)).toEqual(reference(replacement));
    } finally { test.dispose(); }
  });
  it("retires mismatched native output to the full worker reference before caching", async () => {
    const test = setup("single", true);
    try {
      test.batches.sample(grid, xy); await test.flush();
      expect(test.batches.sample(grid, xy)).toEqual(reference());
      expect(test.batches.stats()).toMatchObject({ actual: "typescript", parity: "different", fallbackReason: "parity-mismatch" });
    } finally { test.dispose(); }
  });
  it("memoises immediate reference results separately from admitted native results", async () => {
    const test = setup();
    try {
      test.batches.sample(grid, xy);
      expect(test.batches.sample({ ...grid }, xy)).toEqual(reference());
      expect(test.batches.stats()).toMatchObject({ referenceCacheHits: 5, workerCacheHits: 0, nativeCacheHits: 0, pageSamples: 5, retainedGrids: 1 });
      await test.flush();
      expect(test.batches.sample({ ...grid }, xy)).toEqual(reference());
      expect(test.batches.stats()).toMatchObject({ referenceCacheHits: 5, workerCacheHits: 5, nativeCacheHits: 5, pageSamples: 5, retainedGrids: 1 });
    } finally { test.dispose(); }
  });
  it("invalidates changed ordered neighbours even when the centre wrapper is reused", async () => {
    const test = setup();
    const a = { z: 1, x: 1, y: 0, size: 2, heights: new Float32Array(4).fill(20) };
    const b = { ...a, heights: new Float32Array(4).fill(90) };
    const source = { ...grid, neighbors: [a, b] };
    const edge = new Float64Array([0.99, 0.5]);
    try {
      const initial = sampleTerrainGrid(source, edge[0], edge[1]);
      expect(test.batches.sample(source, edge)[0]).toBe(initial);
      await test.flush();
      source.neighbors = [b, a];
      const changed = sampleTerrainGrid(source, edge[0], edge[1]);
      expect(changed).not.toBe(initial);
      expect(test.batches.sample(source, edge)[0]).toBe(changed);
      expect(test.batches.stats()).toMatchObject({ cacheHits: 0, pageSamples: 2, retainedGrids: 2 });
      await test.flush();
      expect(test.batches.sample({ ...source, neighbors: source.neighbors.map(value => ({ ...value })) }, edge)[0]).toBe(changed);
      expect(test.batches.stats()).toMatchObject({ cacheHits: 1, pageSamples: 2, retainedGrids: 2 });
    } finally { test.dispose(); }
  });
  it("retires a timed-out worker and uses current page grids without retry", async () => {
    const test = setup();
    try {
      test.worker.postMessage = vi.fn();
      test.batches.sample(grid, xy); await test.flush(); test.timers[0]();
      expect(test.worker.terminate).toHaveBeenCalledOnce();
      expect(test.batches.sample(grid, xy)).toEqual(reference());
      expect(test.batches.stats()).toMatchObject({ actual: "typescript", state: "retired", fallbackReason: "worker-startup-timeout", jobs: 0 });
    } finally { test.dispose(); }
  });
});
