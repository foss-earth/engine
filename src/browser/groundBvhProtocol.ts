import type { GroundBvhSnapshot } from "./groundBvh.js";

export type GroundBuildKernel = "typescript" | "single" | "threaded";
export interface GroundBvhBuild { positions: Float32Array; indices: Uint32Array; generation: number }
export interface GroundBvhPreparation {
  generation: number;
  snapshot: GroundBvhSnapshot;
  actual: "typescript" | "single";
  parity: "same" | "not-run" | "different";
  fallbackReason: string | null;
  workMs: number;
}
export interface GroundBvhPreparerStatus {
  kernel: GroundBuildKernel;
  state: "idle" | "busy" | "failed" | "disposed";
  actual: "typescript" | "single" | null;
  parity: GroundBvhPreparation["parity"];
  failure: string | null;
  jobs: number;
  lastJob: { workMs: number; roundTripMs: number; inputBytes: number; outputBytes: number } | null;
}
export interface GroundBvhPreparer {
  /** Own copies may be transferred; the displayed buffers must never be detached. */
  prepare(request: GroundBvhBuild): Promise<GroundBvhPreparation>;
  status(): GroundBvhPreparerStatus;
  dispose(): void;
}
export type GroundBvhWorkerRequest = { type: "build"; id: number; request: GroundBvhBuild };
export type GroundBvhWorkerReply = { type: "built"; id: number; result: GroundBvhPreparation }
  | { type: "failed"; id: number; message: string };
export interface GroundBvhWorkerPort {
  postMessage(message: GroundBvhWorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: { data?: unknown; message?: string }) => void): void;
  terminate(): void;
}
export interface GroundBvhWorkerScope {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: GroundBvhWorkerReply, transfer: Transferable[]): void;
}
export interface GroundNumericCore {
  buildBvh(positions: Float32Array, indices: Uint32Array, options?: { generation?: number }): {
    snapshot(): Float64Array;
    query(rays: Float64Array): Float64Array;
    dispose(): void;
  };
  dispose(): void;
}
export interface GroundWorkerTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
