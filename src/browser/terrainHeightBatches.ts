import { sampleTerrainGrid, type TerrainGrid } from "../terrain/terrainGrid.js";
import { collectTerrainHeightPixels, type TerrainHeightPixels } from "./terrainHeightPixels.js";
import type { HeightBatchReply, HeightBatchWorkerPort } from "./terrainHeightBatchProtocol.js";

export interface TerrainHeightBatchStats {
  actual: "not started" | "typescript" | "single";
  state: "idle" | "busy" | "retired";
  parity: HeightBatchReply["parity"];
  fallbackReason: string | null;
  jobs: number; samples: number; cacheHits: number; referenceCacheHits: number; workerCacheHits: number; nativeCacheHits: number; pageSamples: number; dropped: number;
  workMs: number; roundTripMs: number; inputBytes: number; outputBytes: number;
  snapshotBytes: number; nativeBytes: number; cachedSamples: number; pageSnapshotBytes: number; retainedGrids: number;
  peakSnapshotBytes: number; peakNativeBytes: number;
}
interface GridState {
  id: number; key: string; grid: WeakRef<TerrainGrid>;
  values: Map<number, Map<number, { height: number; origin: "page" | "typescript" | "single" }>>;
  queued: Map<number, Set<number>>;
  pending: number[];
  count: number;
}
interface Flight { id: number; start: number; batches: Array<{ state: GridState; coordinates: Float64Array; pixels: TerrainHeightPixels }> }
interface GridStamp { z: number; x: number; y: number; size: number; heightsId: number }
interface GridGeneration { own: GridStamp; neighbors: GridStamp[] | null; key: string }
const MAX_CACHE = 131072, MAX_PENDING = 16384, MAX_BATCH = 8192, MAX_TRANSFER = 24 * 1024 ** 2;

/** Exact asynchronous memoisation over immutable adopted grids. A cache miss
 * always evaluates the reference immediately, so neither terrain arrival nor
 * worker latency can change the selector's height, slope or plan. */
export function createTerrainHeightBatches(options: {
  kernel: "typescript" | "single" | "threaded";
  createWorker(): HeightBatchWorkerPort | null;
  now(): number;
  schedule(callback: () => void): void;
  after(callback: () => void, ms: number): () => void;
}) {
  let worker: HeightBatchWorkerPort | null = null, flight: Flight | null = null, cancelTimeout: (() => void) | null = null;
  let nextGrid = 0, nextJob = 0, queued = 0, cached = 0, scheduled = false, disposed = false, retired = false;
  const states = new Map<number, GridState>();
  const generations = new Map<string, GridState>(), arrayIds = new WeakMap<Float32Array, number>();
  let nextArray = 0;
  const arrayId = (heights: Float32Array): number => {
    let id = arrayIds.get(heights); if (id === undefined) { id = ++nextArray; arrayIds.set(heights, id); } return id;
  };
  const ownKey = (grid: TerrainGrid): string => `${grid.z}/${grid.x}/${grid.y}/${grid.size}/${arrayId(grid.heights)}`;
  let wrapperGenerations = new WeakMap<TerrainGrid, GridGeneration>();
  const unchanged = (stamp: GridStamp, grid: TerrainGrid): boolean => stamp.z === grid.z && stamp.x === grid.x
    && stamp.y === grid.y && stamp.size === grid.size && stamp.heightsId === arrayId(grid.heights);
  const stamp = (grid: TerrainGrid): GridStamp => ({ z: grid.z, x: grid.x, y: grid.y, size: grid.size, heightsId: arrayId(grid.heights) });
  const generation = (grid: TerrainGrid): string => {
    const previous = wrapperGenerations.get(grid), neighbors = grid.neighbors;
    let same = previous !== undefined && unchanged(previous.own, grid)
      && (previous.neighbors === null ? neighbors === undefined : neighbors !== undefined && previous.neighbors.length === neighbors.length);
    if (same && neighbors) for (let i = 0; i < neighbors.length; i++) {
      if (!unchanged(previous!.neighbors![i], neighbors[i])) { same = false; break; }
    }
    if (same) return previous!.key;
    const key = `${ownKey(grid)}:${neighbors ? neighbors.map(ownKey).join(",") : "none"}`;
    wrapperGenerations.set(grid, { own: stamp(grid), neighbors: neighbors ? neighbors.map(stamp) : null, key });
    return key;
  };
  const status: TerrainHeightBatchStats = { actual: "not started", state: "idle", parity: options.kernel === "single" ? "unchecked" : "not compared",
    fallbackReason: null, jobs: 0, samples: 0, cacheHits: 0, referenceCacheHits: 0, workerCacheHits: 0, nativeCacheHits: 0, pageSamples: 0, dropped: 0,
    workMs: 0, roundTripMs: 0, inputBytes: 0, outputBytes: 0, snapshotBytes: 0, nativeBytes: 0, cachedSamples: 0, pageSnapshotBytes: 0, retainedGrids: 0, peakSnapshotBytes: 0, peakNativeBytes: 0 };
  function removeState(state: GridState): void {
    if (states.get(state.id) !== state) return;
    states.delete(state.id); generations.delete(state.key);
    queued -= state.pending.length / 2;
    state.pending.length = 0; state.queued.clear();
    cached -= state.count; state.values.clear(); state.count = 0;
  }
  function cacheValue(state: GridState, x: number, y: number, value: number, origin: "page" | "typescript" | "single"): void {
    let row = state.values.get(x);
    if (!row) { row = new Map(); state.values.set(x, row); }
    if (!row.has(y)) { state.count++; cached++; }
    row.set(y, { height: value, origin });
  }
  function trim(): void {
    while (cached > MAX_CACHE || states.size > 512) removeState(states.values().next().value!);
  }
  function retire(reason: string): void {
    retired = true; status.state = "retired"; status.actual = "typescript"; status.fallbackReason = reason;
    cancelTimeout?.(); cancelTimeout = null;
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = null; }
    flight = null; queued = 0;
    wrapperGenerations = new WeakMap();
    for (const state of [...states.values()]) removeState(state);
    queued = 0;
    status.snapshotBytes = 0; status.nativeBytes = 0;
  }
  function schedule(): void {
    if (scheduled || flight || retired || disposed || !queued) return;
    scheduled = true;
    options.schedule(() => { scheduled = false; flush(); });
  }
  function receive(reply: HeightBatchReply): void {
    if (disposed || retired || !flight || reply?.id !== flight.id) return;
    const current = flight;
    if (reply.kind !== "terrain-heights" || reply.version !== 1 || !Array.isArray(reply.batches)
      || reply.batches.length !== current.batches.length || !Array.isArray(reply.retained)
      || !["typescript", "single"].includes(reply.actual) || (reply.actual === "single" && reply.parity !== "same")) {
      retire("invalid-worker-reply"); return;
    }
    for (let i = 0; i < reply.batches.length; i++) {
      const batch = reply.batches[i], requested = current.batches[i];
      if (batch.gridId !== requested.state.id || !(batch.heights instanceof Float64Array) || batch.heights.length * 2 !== requested.coordinates.length
        || (batch.actual !== undefined && !["typescript", "single"].includes(batch.actual)) || (batch.actual === "single" && reply.parity !== "same")) {
        retire("invalid-worker-result"); return;
      }
      if (states.get(requested.state.id) === requested.state) for (let j = 0; j < batch.heights.length; j++) {
        const expected = requested.state.values.get(requested.coordinates[j * 2])?.get(requested.coordinates[j * 2 + 1]);
        if (expected && !Object.is(expected.height, batch.heights[j])) {
          status.parity = "different"; retire("worker-reference-mismatch"); return;
        }
      }
    }
    cancelTimeout?.(); cancelTimeout = null; flight = null;
    for (let i = 0; i < reply.batches.length; i++) {
      const { state, coordinates } = current.batches[i];
      for (let j = 0; j < reply.batches[i].heights.length; j++) {
        const x = coordinates[j * 2], y = coordinates[j * 2 + 1];
        const waiting = state.queued.get(x);
        waiting?.delete(y); if (waiting?.size === 0) state.queued.delete(x);
        queued--;
        if (states.get(state.id) !== state) continue;
        cacheValue(state, x, y, reply.batches[i].heights[j], reply.batches[i].actual ?? reply.actual);
      }
    }
    trim();
    status.actual = reply.actual; status.state = "idle"; status.parity = reply.parity; status.fallbackReason = reply.fallbackReason;
    status.jobs++; status.workMs += reply.workMs; status.roundTripMs += options.now() - current.start;
    status.outputBytes += reply.batches.reduce((sum, batch) => sum + batch.heights.byteLength, 0);
    status.snapshotBytes = reply.snapshotBytes; status.nativeBytes = reply.nativeBytes;
    status.peakSnapshotBytes = Math.max(status.peakSnapshotBytes, reply.peakSnapshotBytes ?? reply.snapshotBytes);
    status.peakNativeBytes = Math.max(status.peakNativeBytes, reply.peakNativeBytes ?? reply.nativeBytes);
    schedule();
  }
  function flush(): void {
    if (disposed || retired || flight || !queued) return;
    try {
      if (!worker) {
        worker = options.createWorker();
        if (!worker) { retire("worker-unavailable"); return; }
        worker.onmessage = event => receive(event.data);
        worker.onerror = () => retire("worker-error");
        worker.onmessageerror = () => retire("worker-message-error");
      }
      let samples = 0, snapshotBytes = 0;
      const batches: Flight["batches"] = [];
      for (const state of states.values()) {
        if (!state.pending.length) continue;
        const grid = state.grid.deref();
        if (!grid) { queued -= state.pending.length / 2; state.pending.length = 0; state.queued.clear(); continue; }
        const count = Math.min(state.pending.length / 2, MAX_BATCH - samples);
        if (!count) break;
        const coordinates = new Float64Array(state.pending.slice(0, count * 2));
        const pixels = collectTerrainHeightPixels(grid, coordinates);
        const bytes = [pixels, ...(pixels.neighbors ?? [])].reduce((sum, source) => sum + source.heights.byteLength + source.indices.byteLength, 0);
        if (snapshotBytes + bytes > MAX_TRANSFER) continue;
        state.pending.splice(0, count * 2);
        batches.push({ state, coordinates, pixels }); samples += count; snapshotBytes += bytes;
      }
      if (!batches.length) { if (queued) retire("snapshot-budget-exceeded"); return; }
      const id = ++nextJob;
      flight = { id, start: options.now(), batches };
      const request = { kind: "terrain-heights" as const, version: 1 as const, id,
        batches: batches.map(({ state, coordinates, pixels }) => ({ gridId: state.id, coordinates, grid: pixels, sparse: true })) };
      status.inputBytes += snapshotBytes + batches.reduce((sum, batch) => sum + batch.coordinates.byteLength, 0);
      status.state = "busy";
      cancelTimeout = options.after(() => retire(status.jobs === 0 ? "worker-startup-timeout" : "worker-timeout"), status.jobs === 0 ? 15000 : 5000);
      // Keep coordinates for admission/caching. Transfer only the owned compact
      // pixel buffers; original height arrays are never detached or cloned.
      const transfer: Transferable[] = [];
      for (const { pixels } of batches) for (const source of [pixels, ...(pixels.neighbors ?? [])]) {
        if (source.heights.byteLength) transfer.push(source.heights.buffer as ArrayBuffer, source.indices.buffer as ArrayBuffer);
      }
      worker.postMessage(request, transfer);
    } catch { retire("worker-dispatch-failed"); }
  }
  return {
    sample(grid: TerrainGrid, coordinates: Float64Array): Float64Array {
      if (coordinates.length % 2 || coordinates.length / 2 > MAX_BATCH) throw new Error("Invalid height batch dimensions");
      // Retired/disposed instances retain no grids. All heights still use the
      // complete immediate reference path.
      if (disposed || retired) {
        const result = new Float64Array(coordinates.length / 2);
        for (let i = 0; i < result.length; i++) result[i] = sampleTerrainGrid(grid, coordinates[i * 2], coordinates[i * 2 + 1]);
        status.samples += result.length; status.pageSamples += result.length;
        return result;
      }
      // Wrappers are replaced frequently as adopted neighbour patches change.
      // Only the immutable array identities, tile metadata and ordered direct
      // neighbours define a generation; neither wrapper identity nor nested
      // neighbour graphs affect sampleTerrainGrid's result.
      const key = generation(grid);
      let state = generations.get(key);
      if (!state) {
        state = { id: ++nextGrid, key, grid: new WeakRef(grid), values: new Map(), queued: new Map(), pending: [], count: 0 };
        generations.set(key, state); states.set(state.id, state);
      }
      if (state.grid.deref() !== grid) state.grid = new WeakRef(grid);
      states.delete(state.id); states.set(state.id, state);
      const result = new Float64Array(coordinates.length / 2);
      for (let i = 0; i < result.length; i++) {
        const x = coordinates[i * 2], y = coordinates[i * 2 + 1];
        status.samples++;
        const row = state.values.get(x);
        const hit = row?.get(y);
        if (hit) {
          result[i] = hit.height; status.cacheHits++;
          if (hit.origin === "page") status.referenceCacheHits++;
          else { status.workerCacheHits++; if (hit.origin === "single") status.nativeCacheHits++; }
          continue;
        }
        result[i] = sampleTerrainGrid(grid, x, y); status.pageSamples++;
        // The exact reference result is already available. Memoise immediately
        // so a slow worker never repeats page work; both worker arms share this.
        if (Number.isFinite(x) && Number.isFinite(y)) cacheValue(state, x, y, result[i], "page");
        if (disposed || retired || !Number.isFinite(x) || !Number.isFinite(y) || state.queued.get(x)?.has(y)) continue;
        if (queued >= MAX_PENDING) { status.dropped++; continue; }
        let waiting = state.queued.get(x);
        if (!waiting) { waiting = new Set(); state.queued.set(x, waiting); }
        waiting.add(y); state.pending.push(x, y); queued++;
      }
      trim(); schedule(); return result;
    },
    stats(): TerrainHeightBatchStats { return { ...status, cachedSamples: cached, pageSnapshotBytes: 0, retainedGrids: states.size }; },
    dispose() {
      if (disposed) return; disposed = true;
      cancelTimeout?.(); cancelTimeout = null;
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
      worker = null; flight = null;
      wrapperGenerations = new WeakMap();
      for (const state of [...states.values()]) removeState(state);
      queued = 0; status.snapshotBytes = 0; status.nativeBytes = 0;
    },
  };
}
