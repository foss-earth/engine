import type { ImageKind } from "@foss-earth/images";

export interface AtlasWorkerFailure { name: string; message: string; errors?: AtlasWorkerFailure[] }
export type AtlasImageryWorkerRequest =
  | { kind: "decode"; id: number; bytes: Uint8Array; mimeType: ImageKind }
  | { kind: "prepare"; id: number; bitmap: ImageBitmap; width: number; height: number; outputBytes: number };
export type AtlasImageryWorkerReply =
  | { kind: "decoded"; id: number; bitmap: ImageBitmap }
  | { kind: "prepared"; id: number; width: number; height: number; pages?: Uint8Array[][]; blank?: boolean; inputRetired: boolean; canvasRetired: boolean; error?: AtlasWorkerFailure }
  | { kind: "failed"; id: number; error: AtlasWorkerFailure; nativeRetired: boolean }
  | { kind: "canvas-retired"; id: number; error?: AtlasWorkerFailure };
export interface AtlasImageryWorkerPort {
  onmessage: ((event: MessageEvent<AtlasImageryWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: AtlasImageryWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
  /** Optional actual realm/input/queued-output retirement proof after fatal loss.
   * A throwing/void terminate or rejected promise is not proof. */
  readonly retired?: Promise<void>;
}
export interface AtlasImageryWorkerScope {
  onmessage: ((event: MessageEvent<AtlasImageryWorkerRequest>) => void) | null;
  postMessage(message: AtlasImageryWorkerReply, transfer?: Transferable[]): void;
}
export function atlasWorkerFailure(error: unknown): AtlasWorkerFailure {
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error),
    ...(error instanceof AggregateError ? { errors: error.errors.map(atlasWorkerFailure) } : {}) };
}
export function atlasWorkerError(error: AtlasWorkerFailure): Error {
  return error.errors ? new AggregateError(error.errors.map(atlasWorkerError), error.message) : new Error(error.message);
}
