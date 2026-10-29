import type { TerrainGrid } from "../terrain/terrainGrid.js";
import type { ComputeWorker } from "./computeAdmission.js";

export interface HeightSource { sourceId: number; z: number; x: number; y: number; size: number; heights?: Float32Array }
export interface HeightBatch { gridId: number; grid?: TerrainGrid; sources?: HeightSource[]; sparse?: boolean; neighborsPresent?: boolean; coordinates: Float64Array }
/** A request's sparse batches in four arrays, so posting it clones a few
 * buffers rather than two typed arrays per grid and neighbour. Per batch the
 * table holds [gridId, coordinate pairs, sources, neighbours present], then
 * [z, x, y, size, pixels] per source; each source's pixels follow the
 * previous source's in `heights` and `indices`. */
export interface PackedHeightBatches { table: Float64Array; coordinates: Float64Array; heights: Float32Array; indices: Uint32Array }
/** `packed`, when present, replaces `batches`, which must then be empty. */
export interface HeightBatchRequest { kind: "terrain-heights"; version: 1; id: number; batches: HeightBatch[]; packed?: PackedHeightBatches }
export interface HeightBatchReply {
  kind: "terrain-heights"; version: 1; id: number;
  batches: Array<{ gridId: number; heights: Float64Array; actual?: "typescript" | "single" }>;
  retained: number[];
  retainedSources?: number[];
  actual: "typescript" | "single";
  parity: "not compared" | "same" | "different" | "unchecked";
  fallbackReason: string | null;
  workMs: number; snapshotBytes: number; wasmBytes: number;
  peakSnapshotBytes?: number; peakWasmBytes?: number;
}
export interface HeightBatchWorkerPort extends ComputeWorker {
  onmessage: ((event: MessageEvent<HeightBatchReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: HeightBatchRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface HeightBatchWorkerScope {
  onmessage: ((event: MessageEvent<HeightBatchRequest>) => void) | null;
  postMessage(reply: HeightBatchReply, transfer?: Transferable[]): void;
}
export interface WasmHeightSampler { bytes: number; sample(coordinates: Float64Array): Float64Array; dispose(): void }
export interface WasmHeightCore { createHeightSampler(grid: TerrainGrid): WasmHeightSampler; dispose(): void }
