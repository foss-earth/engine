import { describe, expect, it, vi } from "vitest";
import { createTerrainHeightBatches } from "../src/browser/terrainHeightBatches.js";
import { installTerrainHeightBatchKernel } from "../src/browser/terrainHeightBatchKernel.js";
import type { HeightBatchReply, HeightBatchRequest, HeightBatchWorkerPort, HeightBatchWorkerScope } from "../src/browser/terrainHeightBatchProtocol.js";
import { sampleTerrainHeightPixels, type TerrainHeightPixels } from "../src/browser/terrainHeightPixels.js";
import { sampleTerrainGrid, type TerrainGrid } from "../src/terrain/terrainGrid.js";
const turn = () => new Promise(resolve => setImmediate(resolve));
const grid = (size = 1, height = 3): TerrainGrid => ({ z: 0, x: 0, y: 0, size, heights: new Float32Array(size * size).fill(height) });
const xy = new Float64Array([0.5, 0.5]);
function page() {
  const scheduled: Array<() => void> = [], requests: HeightBatchRequest[] = [];
  const worker: HeightBatchWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, terminate: vi.fn(), postMessage: request => { requests.push(request); } };
  const batches = createTerrainHeightBatches({ kernel: "typescript", createWorker: () => worker, now: () => 0,
    schedule: callback => { scheduled.push(callback); }, after: () => () => {} });
  return { batches, worker, requests, flush() { while (scheduled.length) scheduled.shift()!(); }, reply(request = requests.at(-1)!, value = 3) {
    worker.onmessage?.({ data: { kind: "terrain-heights", version: 1, id: request.id, batches: request.batches.map(batch => ({ gridId: batch.gridId, heights: new Float64Array(batch.coordinates.length / 2).fill(value) })), retained: [], actual: "typescript", parity: "not compared", fallbackReason: null, workMs: 0, snapshotBytes: 0, nativeBytes: 0 } } as unknown as MessageEvent<HeightBatchReply>);
  } };
}
describe("height snapshot lifecycle and bounded admission", () => {
  it("bounds pending grids and snapshot bytes before any worker reply", () => {
    const test = page();
    try {
      for (let i = 0; i < 600; i++) test.batches.sample(grid(), xy);
      expect(test.batches.stats().retainedGrids).toBe(512);
      test.flush(); expect(test.requests[0].batches).toHaveLength(512);
      for (let i = 0; i < 7; i++) test.batches.sample(grid(1024), xy);
      expect(test.batches.stats().pageSnapshotBytes).toBeLessThanOrEqual(24 * 1024 ** 2);
      expect(test.batches.stats().retainedGrids).toBeLessThanOrEqual(512);
      expect(test.batches.stats().pageSnapshotBytes).toBe(0);
    } finally { test.batches.dispose(); }
  });
  it("sends only direct numeric grid records and excludes nested neighbour graphs", () => {
    const test = page();
    try {
      const source = { ...grid(), extra: new Float32Array(1024) };
      const neighbor = { ...grid(), neighbors: [grid(1024)], extra: "not part of the kernel" };
      source.neighbors = [neighbor];
      test.batches.sample(source, xy); test.flush();
      const sentGrid = test.requests[0].batches[0].grid as TerrainHeightPixels;
      const sent = [sentGrid, ...(sentGrid.neighbors ?? [])];
      expect(sent).toHaveLength(2);
      expect(Object.keys(sent[0]).filter(key => key !== "neighbors").sort()).toEqual(["heights", "indices", "size", "x", "y", "z"]);
      expect(Object.keys(sent[1]).sort()).toEqual(["heights", "indices", "size", "x", "y", "z"]);
    } finally { test.batches.dispose(); }
  });
  it("ignores an evicted in-flight generation and releases every page state on retirement", () => {
    const test = page();
    try {
      const source = grid(1024, 17);
      test.batches.sample(source, xy); test.flush();
      const old = test.requests[0];
      for (let i = 0; i < 512; i++) test.batches.sample(grid(), xy);
      test.reply(old, 999);
      expect(test.batches.sample(source, xy)[0]).toBe(17);
      expect(test.batches.stats().cacheHits).toBe(0);
      test.worker.onerror?.({} as ErrorEvent);
      for (let i = 0; i < 600; i++) test.batches.sample(grid(), xy);
      expect(test.batches.stats()).toMatchObject({ retainedGrids: 0, pageSnapshotBytes: 0, cachedSamples: 0, state: "retired" });
      expect(test.worker.terminate).toHaveBeenCalledOnce();
    } finally { test.batches.dispose(); }
    expect(test.batches.stats().retainedGrids).toBe(0);
    expect(test.batches.sample(grid(), xy)[0]).toBe(3);
    expect(test.batches.stats().retainedGrids).toBe(0);
  });
  it("bounds JS plus native worker snapshots together and disposes evicted models", async () => {
    let reply: HeightBatchReply | undefined;
    const scope: HeightBatchWorkerScope = { onmessage: null, postMessage(value) { reply = value; } };
    const disposed = vi.fn();
    const installed = installTerrainHeightBatchKernel({ scope, kernel: "single", now: () => 0, loadNative: async () => ({
      createHeightSampler(source) { return { bytes: source.heights.byteLength + 72, sample(coordinates) { return Float64Array.from({ length: coordinates.length / 2 }, (_, i) => sampleTerrainGrid(source, coordinates[i * 2], coordinates[i * 2 + 1])); }, dispose: disposed }; }, dispose() {} }) });
    try {
      scope.onmessage?.({ data: { kind: "terrain-heights", version: 1, id: 1, batches: Array.from({ length: 13 }, (_, i) => ({ gridId: i + 1, grid: grid(512), coordinates: xy })) } } as MessageEvent<HeightBatchRequest>);
      await turn();
      expect(reply?.batches).toHaveLength(13);
      expect(reply!.snapshotBytes + reply!.nativeBytes).toBeLessThanOrEqual(24 * 1024 ** 2);
      expect(reply?.actual).toBe("single"); expect(disposed.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally { installed.dispose(); }
  });
  it("keeps an individually oversized native snapshot on the complete worker reference", async () => {
    let reply: HeightBatchReply | undefined;
    const scope: HeightBatchWorkerScope = { onmessage: null, postMessage(value) { reply = value; } };
    const createHeightSampler = vi.fn();
    const installed = installTerrainHeightBatchKernel({ scope, kernel: "single", now: () => 0, loadNative: async () => ({ createHeightSampler, dispose() {} }) });
    try {
      scope.onmessage?.({ data: { kind: "terrain-heights", version: 1, id: 1, batches: [{ gridId: 1, grid: grid(2048, 7), coordinates: xy }] } } as MessageEvent<HeightBatchRequest>);
      await turn();
      expect(reply).toMatchObject({ actual: "typescript", fallbackReason: "native-snapshot-budget-exceeded", nativeBytes: 0 });
      expect(reply?.batches[0].heights[0]).toBe(7); expect(createHeightSampler).not.toHaveBeenCalled();
    } finally { installed.dispose(); }
  });
  it("deduplicates overlapping 512-square nine-source patches across wrapper replacement and churn", async () => {
    const scheduled: Array<() => void> = [], requests: HeightBatchRequest[] = [];
    let reply: HeightBatchReply | undefined;
    const worker: HeightBatchWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, terminate: vi.fn(), postMessage(request) {
      requests.push(request);
      scope.onmessage?.({ data: structuredClone(request) } as MessageEvent<HeightBatchRequest>);
    } };
    const scope: HeightBatchWorkerScope = { onmessage: null, postMessage(value) {
      reply = value; worker.onmessage?.({ data: structuredClone(value) } as MessageEvent<HeightBatchReply>);
    } };
    const installed = installTerrainHeightBatchKernel({ scope, kernel: "single", now: () => 0, loadNative: async () => ({ createHeightSampler(source) {
      return { bytes: [source, ...(source.neighbors ?? [])].reduce((sum, value) => sum + value.heights.byteLength, 456),
        sample(coordinates) { return Float64Array.from({ length: coordinates.length / 2 }, (_, i) => ("indices" in source ? sampleTerrainHeightPixels(source as TerrainHeightPixels, coordinates[i * 2], coordinates[i * 2 + 1]) : sampleTerrainGrid(source, coordinates[i * 2], coordinates[i * 2 + 1]))); }, dispose() {} };
    }, dispose() {} }) });
    const batches = createTerrainHeightBatches({ kernel: "single", createWorker: () => worker, now: () => 0,
      schedule: callback => { scheduled.push(callback); }, after: () => () => {} });
    const tiles = Array.from({ length: 9 }, (_, i) => ({ ...grid(512, i), z: 3, x: i % 3, y: Math.floor(i / 3) }));
    const sample = () => {
      for (const tile of tiles) {
        const source = { ...tile, neighbors: tiles.filter(value => value !== tile).map(value => ({ ...value })) };
        const coordinates = new Float64Array([source.x + 0.0001, source.y + 0.0001, source.x + 0.5, source.y + 0.5]);
        expect(batches.sample(source, coordinates)).toEqual(Float64Array.from([sampleTerrainGrid(source, coordinates[0], coordinates[1]), sampleTerrainGrid(source, coordinates[2], coordinates[3])]));
      }
    };
    const flush = async () => { while (scheduled.length) scheduled.shift()!(); await turn(); };
    try {
      sample(); await flush();
      expect(requests).toHaveLength(1);
      expect(requests[0].batches).toHaveLength(9);
      expect(requests[0].batches.every(batch => batch.sparse)).toBe(true);
      for (let repeat = 0; repeat < 10; repeat++) sample();
      await flush(); expect(requests).toHaveLength(1);
      expect(batches.stats()).toMatchObject({ retainedGrids: 9, pageSamples: 18, workerCacheHits: 180, nativeCacheHits: 180, pageSnapshotBytes: 0 });
      for (let iteration = 0; iteration < 20; iteration++) {
        const index = iteration % tiles.length;
        tiles[index] = { ...tiles[index], heights: new Float32Array(512 ** 2).fill(100 + iteration) };
        sample(); await flush();
        expect(requests.at(-1)!.batches.every(batch => batch.sparse)).toBe(true);
        expect(reply!.snapshotBytes + reply!.nativeBytes).toBeLessThanOrEqual(24 * 1024 ** 2);
      }
      expect(batches.stats().inputBytes).toBeLessThan(64 * 1024);
      expect(batches.stats().peakSnapshotBytes + batches.stats().peakNativeBytes).toBeLessThan(24 * 1024 ** 2);
      expect(batches.stats()).toMatchObject({ actual: "single", parity: "same", fallbackReason: null });
    } finally { batches.dispose(); installed.dispose(); }
  });
  it("bounds numeric memoisation and pending samples independently of source lifetime", () => {
    const test = page();
    try {
      const source = grid();
      for (let batch = 0; batch < 18; batch++) {
        const coordinates = Float64Array.from({ length: 8192 * 2 }, (_, i) => i % 2 ? 0.5 : batch * 8192 + i / 2);
        expect(test.batches.sample(source, coordinates).every(value => value === 3)).toBe(true);
        expect(test.batches.stats().cachedSamples).toBeLessThanOrEqual(131072);
      }
      expect(test.batches.stats().dropped).toBeGreaterThan(0);
      test.flush(); expect(test.requests[0].batches.reduce((sum, batch) => sum + batch.coordinates.length / 2, 0)).toBeLessThanOrEqual(8192);
      expect(test.batches.stats().pageSnapshotBytes).toBe(0);
    } finally { test.batches.dispose(); }
  });
  it("recovers retained models after an earlier batch evicts them during the same job", async () => {
    let reply: HeightBatchReply | undefined;
    const scope: HeightBatchWorkerScope = { onmessage: null, postMessage(value) { reply = value; } };
    const installed = installTerrainHeightBatchKernel({ scope, kernel: "typescript", now: () => 0 });
    const source = (id: number) => ({ sourceId: id, ...grid(512, id) });
    try {
      scope.onmessage?.({ data: { kind: "terrain-heights", version: 1, id: 1, batches: Array.from({ length: 16 }, (_, i) => ({ gridId: i + 1, sources: [source(i + 1)], coordinates: xy })) } } as MessageEvent<HeightBatchRequest>);
      await turn(); expect(reply?.retained).toHaveLength(16);
      scope.onmessage?.({ data: { kind: "terrain-heights", version: 1, id: 2, batches: [{ gridId: 17, sources: [source(17)], coordinates: xy }, { gridId: 1, coordinates: xy }] } } as MessageEvent<HeightBatchRequest>);
      await turn();
      expect(reply?.id).toBe(2); expect(reply?.batches.map(batch => batch.heights[0])).toEqual([17, 1]);
      expect(reply!.snapshotBytes + reply!.nativeBytes).toBeLessThanOrEqual(24 * 1024 ** 2);
    } finally { installed.dispose(); }
  });
  it("drops queued source generations collected before dispatch without retiring the worker", () => {
    vi.stubGlobal("WeakRef", class { deref() { return undefined; } });
    const test = page();
    try {
      test.batches.sample(grid(), xy); test.flush();
      expect(test.requests).toHaveLength(0);
      expect(test.batches.stats()).toMatchObject({ state: "idle", pageSnapshotBytes: 0, cachedSamples: 1, actual: "not started" });
    } finally { test.batches.dispose(); vi.unstubAllGlobals(); }
  });
  it("does not clone unrelated backing storage when a grid uses a typed-array view", () => {
    const test = page();
    try {
      const backing = new Float32Array(1024 * 1024).fill(4);
      const source = { ...grid(), heights: backing.subarray(50, 51) };
      expect(test.batches.sample(source, xy)[0]).toBe(4); test.flush();
      expect(test.requests[0].batches[0].grid!.heights.buffer.byteLength).toBe(4);
      expect(source.heights.buffer).toBe(backing.buffer);
    } finally { test.batches.dispose(); }
  });
  it("rejects a sparse worker mismatch before replacing exact page results", () => {
    const test = page(), source = grid(512, 17);
    try {
      expect(test.batches.sample(source, xy)[0]).toBe(17); test.flush();
      test.reply(test.requests[0], 999);
      expect(test.batches.stats()).toMatchObject({ state: "retired", parity: "different", fallbackReason: "worker-reference-mismatch" });
      expect(test.batches.sample(source, xy)[0]).toBe(17);
      expect(test.worker.terminate).toHaveBeenCalledOnce();
    } finally { test.batches.dispose(); }
  });
});
