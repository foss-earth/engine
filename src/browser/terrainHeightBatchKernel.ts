import { sampleTerrainGrid, type TerrainGrid } from "../terrain/terrainGrid.js";
import { sampleTerrainHeightPixels, unpackTerrainHeightPixels, type TerrainHeightPixels } from "./terrainHeightPixels.js";
import type { HeightBatchWorkerScope, WasmHeightCore, WasmHeightSampler } from "./terrainHeightBatchProtocol.js";

const MAX_SNAPSHOTS = 24 * 1024 ** 2;
const MAX_BATCH = 8192;
function gridBytes(grid: TerrainGrid): number { return [grid, ...(grid.neighbors ?? [])].reduce((sum, source) => sum + source.heights.byteLength, 0); }
function reference(grid: TerrainGrid, coordinates: Float64Array): Float64Array {
  const out = new Float64Array(coordinates.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = sampleTerrainGrid(grid, coordinates[i * 2], coordinates[i * 2 + 1]);
  return out;
}

/** One owning worker. Immutable source snapshots are retained with bounded LRU
 * storage; the complete JS and WASM arms use the identical protocol. */
export function installTerrainHeightBatchKernel(options: {
  scope: HeightBatchWorkerScope; kernel: "typescript" | "single" | "threaded";
  now(): number; loadWasm?(): Promise<WasmHeightCore>;
}): { dispose(): void } {
  const models = new Map<number, { grid: TerrainGrid; bytes: number; sourceIds: number[]; sampler: WasmHeightSampler | null }>();
  const sources = new Map<number, Float32Array>();
  // Sources required later in the current request remain alive even if their
  // model is evicted. Include those pins in the same JS/WASM memory budget.
  const jobSources = new Set<Float32Array>();
  const jobIndices = new Set<Uint32Array>();
  const sourceIdentities = new WeakMap<Float32Array, number>();
  let nextLegacySource = 0;
  function snapshotBytes(): number {
    const arrays = new Set(jobSources);
    for (const model of models.values()) for (const source of [model.grid, ...(model.grid.neighbors ?? [])]) arrays.add(source.heights);
    return [...arrays].reduce((sum, heights) => sum + heights.byteLength, 0)
      + [...jobIndices].reduce((sum, indices) => sum + indices.byteLength, 0);
  }
  function wasmBytes(): number { return [...models.values()].reduce((sum, model) => sum + (model.sampler?.bytes ?? 0), 0); }
  function evict(id: number): void {
    const model = models.get(id);
    model?.sampler?.dispose();
    if (model) model.sampler = null;
    models.delete(id);
  }
  let core: WasmHeightCore | null = null, started = false, disposed = false;
  let actual: "typescript" | "single" = "typescript";
  let parity: "not compared" | "same" | "different" | "unchecked" = options.kernel === "single" ? "unchecked" : "not compared";
  let fallbackReason: string | null = options.kernel === "threaded" ? "threaded-unavailable" : null;
  let serial = Promise.resolve();
  let sparseValidated = false;
  function retire(reason: string): void {
    fallbackReason = reason; actual = "typescript";
    for (const model of models.values()) { model.sampler?.dispose(); model.sampler = null; }
    core?.dispose(); core = null;
  }
  const receive: NonNullable<HeightBatchWorkerScope["onmessage"]> = event => {
    serial = serial.then(async () => {
      const request = event.data;
      if (disposed) return;
      if (request?.kind !== "terrain-heights" || request.version !== 1 || !Number.isSafeInteger(request.id) || request.id < 1
        || !Array.isArray(request.batches) || (request.packed !== undefined && request.batches.length)) throw new Error("Invalid height batch request");
      const requested = request.packed === undefined ? request.batches : unpackTerrainHeightPixels(request.packed);
      if (requested.length > 512) throw new Error("Invalid height batch request");
      if (!started) {
        started = true;
        if (options.kernel === "single") {
          try { core = await options.loadWasm?.() ?? null; if (!core) throw new Error("No WASM height core"); }
          catch { fallbackReason = "wasm-startup-failed"; }
        }
      }
      if (disposed) { core?.dispose(); core = null; return; }
      const start = options.now();
      const batches = [];
      let peakSnapshotBytes = 0, peakWasmBytes = 0;
      actual = "typescript";
      let samples = 0;
      // Keep the request's source catalogue through this job: an earlier new
      // model may evict a retained model that a later batch still references.
      const requestedModels = new Map(requested.map(batch => [batch.gridId, models.get(batch.gridId)]));
      const available = new Map<number, Float32Array>();
      jobSources.clear(); jobIndices.clear();
      for (const batch of requested) {
        const grid = batch.sparse ? batch.grid : requestedModels.get(batch.gridId)?.grid ?? batch.grid;
        if (grid) for (const source of [grid, ...(grid.neighbors ?? [])]) {
          jobSources.add(source.heights);
          if (batch.sparse) jobIndices.add((source as TerrainHeightPixels).indices);
        }
        for (const source of batch.sources ?? []) {
          const heights = source.heights ?? sources.get(source.sourceId);
          if (heights) { available.set(source.sourceId, heights); jobSources.add(heights); }
        }
      }
      if ([...jobSources].reduce((sum, heights) => sum + heights.byteLength, 0)
        + [...jobIndices].reduce((sum, indices) => sum + indices.byteLength, 0) > MAX_SNAPSHOTS) throw new Error("Height request exceeds 24 MiB");
      sources.clear();
      for (const batch of requested) for (const source of batch.sources ?? []) if (source.heights) {
        if (!Number.isSafeInteger(source.sourceId) || source.sourceId < 1 || !(source.heights instanceof Float32Array)) throw new Error("Invalid height source");
        available.set(source.sourceId, source.heights);
      }
      for (const batch of requested) {
        if (!Number.isSafeInteger(batch.gridId) || batch.gridId < 1 || !(batch.coordinates instanceof Float64Array)
          || batch.coordinates.length % 2 || !batch.coordinates.length || !batch.coordinates.every(Number.isFinite)) throw new Error("Invalid height coordinates");
        samples += batch.coordinates.length / 2;
        if (samples > MAX_BATCH) throw new Error("Height batch exceeds 8192 samples");
        if (batch.sparse) {
          const source = batch.grid as TerrainHeightPixels | undefined;
          if (!source || !Array.isArray(source.neighbors ?? []) || (source.neighbors?.length ?? 0) > 32) throw new Error("Sparse height snapshot missing");
          for (const grid of [source, ...(source.neighbors ?? [])]) {
            if (!Number.isInteger(grid.z) || grid.z < 0 || grid.z > 30 || !Number.isInteger(grid.x) || !Number.isInteger(grid.y)
              || grid.x < 0 || grid.y < 0 || grid.x >= 2 ** grid.z || grid.y >= 2 ** grid.z
              || !Number.isInteger(grid.size) || grid.size < 1 || grid.size > 4096
              || !(grid.heights instanceof Float32Array) || !(grid.indices instanceof Uint32Array) || grid.heights.length !== grid.indices.length
              || grid.indices.some((value, at) => value >= grid.size ** 2 || (at > 0 && value <= grid.indices[at - 1]))) throw new Error("Invalid sparse height snapshot");
          }
          const referencePixels = () => Float64Array.from({ length: batch.coordinates.length / 2 }, (_, i) => sampleTerrainHeightPixels(source, batch.coordinates[i * 2], batch.coordinates[i * 2 + 1]));
          let heights: Float64Array, batchActual: "typescript" | "single" = "typescript";
          // Sparse inputs are complete for this request only. Retaining them
          // across generations would add no pixels and recreate cache churn.
          for (const id of [...models.keys()]) evict(id);
          if (core) {
            let sampler: WasmHeightSampler | null = null;
            try {
              sampler = core.createHeightSampler(source);
              peakSnapshotBytes = Math.max(peakSnapshotBytes, snapshotBytes()); peakWasmBytes = Math.max(peakWasmBytes, sampler.bytes);
              if (!Number.isSafeInteger(sampler.bytes) || sampler.bytes < 0 || snapshotBytes() + sampler.bytes > MAX_SNAPSHOTS) throw new Error("Sparse WASM snapshot exceeds budget");
              heights = sampler.sample(batch.coordinates);
              if (!sparseValidated) {
                const expected = referencePixels();
                if (heights.length !== expected.length || !heights.every((value, i) => Object.is(value, expected[i]))) {
                  parity = "different"; retire("parity-mismatch"); heights = expected;
                } else { sparseValidated = true; parity = "same"; batchActual = "single"; actual = "single"; }
              } else { batchActual = "single"; actual = "single"; }
            } catch { retire("wasm-execution-failed"); heights = referencePixels(); }
            finally { sampler?.dispose(); }
          } else { peakSnapshotBytes = Math.max(peakSnapshotBytes, snapshotBytes()); heights = referencePixels(); }
          batches.push({ gridId: batch.gridId, heights, actual: batchActual });
          continue;
        }
        let model = models.get(batch.gridId) ?? requestedModels.get(batch.gridId);
        if (!model) {
          let source = batch.grid;
          let sourceIds: number[];
          if (batch.sources) {
            if (!Array.isArray(batch.sources) || !batch.sources.length || batch.sources.length > 33
              || (batch.sources.length > 1 && !batch.neighborsPresent)) throw new Error("Invalid height source descriptors");
            const grids = batch.sources.map(value => {
              if (!Number.isSafeInteger(value.sourceId) || value.sourceId < 1) throw new Error("Invalid height source id");
              const heights = available.get(value.sourceId);
              if (!heights) throw new Error("Missing retained height source");
              return { z: value.z, x: value.x, y: value.y, size: value.size, heights };
            });
            source = { ...grids[0], ...(batch.neighborsPresent ? { neighbors: grids.slice(1) } : {}) };
            sourceIds = batch.sources.map(value => value.sourceId);
          } else {
            if (!source) throw new Error("Height snapshot missing");
            sourceIds = [source, ...(source.neighbors ?? [])].map(value => {
              let id = sourceIdentities.get(value.heights);
              if (id === undefined) { id = --nextLegacySource; sourceIdentities.set(value.heights, id); }
              return id;
            });
          }
          if (!source || !Array.isArray(source.neighbors ?? []) || (source.neighbors?.length ?? 0) > 32) throw new Error("Height snapshot missing or invalid");
          const own = (grid: TerrainGrid): TerrainGrid => {
            if (!grid || !Number.isInteger(grid.z) || grid.z < 0 || grid.z > 30 || !Number.isInteger(grid.x) || !Number.isInteger(grid.y)
              || grid.x < 0 || grid.y < 0 || grid.x >= 2 ** grid.z || grid.y >= 2 ** grid.z
              || !Number.isInteger(grid.size) || grid.size < 1 || grid.size > 4096
              || !(grid.heights instanceof Float32Array) || !(grid.heights.buffer instanceof ArrayBuffer)
              || grid.heights.length !== grid.size ** 2) throw new Error("Height snapshot missing or invalid");
            return { z: grid.z, x: grid.x, y: grid.y, size: grid.size, heights: grid.heights };
          };
          const grid = { ...own(source), ...(source.neighbors ? { neighbors: source.neighbors.map(own) } : {}) };
          const size = gridBytes(grid);
          if (size > MAX_SNAPSHOTS) throw new Error("Height snapshot exceeds 24 MiB");
          model = { grid, bytes: size, sourceIds, sampler: null };
        }
        models.delete(batch.gridId); models.set(batch.gridId, model);
        // Include re-admitted models captured at request start: an earlier
        // batch can have evicted them even when this batch needs no payload.
        // Shared JavaScript sources count once; WASM samplers own copies.
        while (models.size > 16 || snapshotBytes() + wasmBytes() > MAX_SNAPSHOTS) {
          const disposable = [...models.values()].find(item => item !== model && item.sampler);
          if (disposable) { disposable.sampler!.dispose(); disposable.sampler = null; continue; }
          const oldest = [...models.entries()].find(([, item]) => item !== model);
          if (!oldest) break;
          evict(oldest[0]);
        }
        let heights: Float64Array;
        let batchActual: "typescript" | "single" = "typescript";
        if (core) {
          try {
            const first = !model.sampler;
            if (first) {
              const wasmSize = model.bytes + (3 + (1 + (model.grid.neighbors?.length ?? 0)) * 6) * 8;
              if (model.bytes + wasmSize > MAX_SNAPSHOTS) {
                retire("wasm-snapshot-budget-exceeded");
                heights = reference(model.grid, batch.coordinates);
                batches.push({ gridId: batch.gridId, heights });
                continue;
              }
              while (snapshotBytes() + wasmBytes() + wasmSize > MAX_SNAPSHOTS) {
                const disposable = [...models.values()].find(item => item !== model && item.sampler);
                if (disposable) { disposable.sampler!.dispose(); disposable.sampler = null; continue; }
                const oldest = [...models.entries()].find(([, item]) => item !== model);
                if (!oldest) break;
                evict(oldest[0]);
              }
              // Other batches can pin valid sources that cannot be freed yet.
              // Keep this batch exact in TS, and allow a later smaller request
              // to use the still-healthy WASM core.
              if (snapshotBytes() + wasmBytes() + wasmSize > MAX_SNAPSHOTS) {
                fallbackReason = "wasm-request-budget-exceeded";
                heights = reference(model.grid, batch.coordinates);
                batches.push({ gridId: batch.gridId, heights, actual: batchActual });
                continue;
              }
              model.sampler = core!.createHeightSampler(model.grid);
              if (!Number.isSafeInteger(model.sampler.bytes) || model.sampler.bytes < 0
                || snapshotBytes() + wasmBytes() > MAX_SNAPSHOTS) throw new Error("WASM height sampler exceeds budget");
            }
            const sampler = model.sampler;
            if (!sampler) throw new Error("WASM height sampler missing");
            heights = sampler.sample(batch.coordinates);
            batchActual = "single"; actual = "single";
            if (first) {
              const expected = reference(model.grid, batch.coordinates);
              if (heights.length !== expected.length || !heights.every((value, i) => Object.is(value, expected[i]))) {
                parity = "different"; retire("parity-mismatch"); heights = expected; batchActual = "typescript";
              } else { parity = "same"; actual = "single"; }
            }
          } catch { retire("wasm-execution-failed"); heights = reference(model.grid, batch.coordinates); batchActual = "typescript"; }
        } else heights = reference(model.grid, batch.coordinates);
        peakSnapshotBytes = Math.max(peakSnapshotBytes, snapshotBytes()); peakWasmBytes = Math.max(peakWasmBytes, wasmBytes());
        batches.push({ gridId: batch.gridId, heights, actual: batchActual });
      }
      if (disposed) return;
      jobSources.clear(); jobIndices.clear();
      // If admission failed later in this request, publish only reference
      // cache provenance. Earlier valid WASM values still have exact bits.
      if (!core) for (const batch of batches) batch.actual = "typescript";
      sources.clear();
      for (const model of models.values()) [model.grid, ...(model.grid.neighbors ?? [])].forEach((grid, index) => sources.set(model.sourceIds[index], grid.heights));
      options.scope.postMessage({ kind: "terrain-heights", version: 1, id: request.id, batches, retained: [...models.keys()], retainedSources: [...sources.keys()], actual, parity,
        fallbackReason, workMs: options.now() - start, snapshotBytes: snapshotBytes(), wasmBytes: wasmBytes(), peakSnapshotBytes, peakWasmBytes },
      batches.map(batch => batch.heights.buffer as ArrayBuffer));
    });
    // Throw on the worker's task queue so the owning page retires it. Never
    // leave a rejected request silently waiting without a response.
    void serial.catch(error => { setTimeout(() => { throw error; }, 0); });
  };
  options.scope.onmessage = receive;
  return { dispose() {
    if (disposed) return; disposed = true; options.scope.onmessage = null;
    for (const model of models.values()) model.sampler?.dispose();
    models.clear(); sources.clear(); jobSources.clear(); jobIndices.clear(); core?.dispose(); core = null;
  } };
}
