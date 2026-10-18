import type { TerrainGrid } from "../terrain/terrainGrid.js";

export interface HeightSource { sourceId: number; z: number; x: number; y: number; size: number; heights?: Float32Array }
export interface HeightBatch { gridId: number; grid?: TerrainGrid; sources?: HeightSource[]; sparse?: boolean; neighborsPresent?: boolean; coordinates: Float64Array }
export interface HeightBatchRequest { kind: "terrain-heights"; version: 1; id: number; batches: HeightBatch[] }
export interface HeightBatchReply {
  kind: "terrain-heights"; version: 1; id: number;
  batches: Array<{ gridId: number; heights: Float64Array; actual?: "typescript" | "single" }>;
  retained: number[];
  retainedSources?: number[];
  actual: "typescript" | "single";
  parity: "not compared" | "same" | "different" | "unchecked";
  fallbackReason: string | null;
  workMs: number; snapshotBytes: number; nativeBytes: number;
  peakSnapshotBytes?: number; peakNativeBytes?: number;
}
export interface HeightBatchWorkerPort {
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
export interface NativeHeightSampler { bytes: number; sample(coordinates: Float64Array): Float64Array; dispose(): void }
export interface NativeHeightCore { createHeightSampler(grid: TerrainGrid): NativeHeightSampler; dispose(): void }
