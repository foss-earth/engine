import type { PoolWorkerPort } from "./workerPool.js";
import type { TerrainNativeDecoderStatus } from "./terrainNativeDecoder.js";

export interface TerrainDecodeFailure { name: string; message: string; errors?: TerrainDecodeFailure[] }
/** The Blob is copied by structured clone; its bytes are not read on the page. */
export interface TerrainDecodeWorkerRequest { kind: "decode-terrain"; id: number; blob: Blob; maxTileSide: number }
export type TerrainDecodeWorkerReply =
  | { kind: "decoded-terrain"; id: number; size: number; heights: Float32Array; backend?: TerrainNativeDecoderStatus }
  /** `unsupported`: this worker realm cannot decode at all (no OffscreenCanvas 2D or
   * createImageBitmap); the page decodes instead. Otherwise the tile itself failed. */
  | { kind: "failed"; id: number; error: TerrainDecodeFailure; unsupported: boolean; backend?: TerrainNativeDecoderStatus };
export type TerrainDecodeWorkerPort = PoolWorkerPort<TerrainDecodeWorkerRequest, TerrainDecodeWorkerReply>;
export interface TerrainDecodeWorkerScope {
  onmessage: ((event: MessageEvent<TerrainDecodeWorkerRequest>) => void) | null;
  postMessage(message: TerrainDecodeWorkerReply, transfer?: Transferable[]): void;
}
export function terrainDecodeFailure(error: unknown): TerrainDecodeFailure {
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error),
    ...(error instanceof AggregateError ? { errors: error.errors.map(terrainDecodeFailure) } : {}) };
}
/** The page-side error for a worker failure: same class for the decoder's own errors, same name and message otherwise. */
export function terrainDecodeError(failure: TerrainDecodeFailure): Error {
  const error = failure.errors ? new AggregateError(failure.errors.map(terrainDecodeError), failure.message)
    : failure.name === "RangeError" ? new RangeError(failure.message)
    : failure.name === "TypeError" ? new TypeError(failure.message) : new Error(failure.message);
  if (error.name !== failure.name) error.name = failure.name;
  return error;
}
