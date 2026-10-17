import type { TerrainNumericGeometry, TerrainNumericRequest } from "../terrain/terrainNumericGeometry.js";
import type { PoolWorkerPort } from "./workerPool.js";

export const TERRAIN_MESH_PROTOCOL = 1;
export type TerrainMeshRequestedBackend = "typescript" | "wasm";
export type TerrainMeshActualBackend = "typescript" | "wasm-single";
export type TerrainMeshValidation = "reference" | "unvalidated";
export type TerrainMeshNumericInput = Omit<TerrainNumericRequest, "getSurfaceHeightMeters">;
export interface TerrainMeshWorkerRequest {
  kind: "prepare-terrain-mesh";
  protocol: 1;
  id: number;
  generation: number;
  requestedBackend: TerrainMeshRequestedBackend;
  input: TerrainMeshNumericInput;
}
interface ReplyIdentity {
  protocol: 1;
  id: number;
  generation: number;
  requestedBackend: TerrainMeshRequestedBackend;
  actualBackend: TerrainMeshActualBackend | null;
  validationStatus: TerrainMeshValidation;
}
export type TerrainMeshWorkerReply =
  | (ReplyIdentity & { kind: "prepared-terrain-mesh"; geometry: TerrainNumericGeometry; actualBackend: TerrainMeshActualBackend })
  | (ReplyIdentity & { kind: "terrain-mesh-failed"; error: { name: string; message: string } });
export type TerrainMeshWorkerPort = PoolWorkerPort<TerrainMeshWorkerRequest, TerrainMeshWorkerReply>;
export interface TerrainMeshWorkerScope {
  onmessage: ((event: MessageEvent<TerrainMeshWorkerRequest>) => void) | null;
  postMessage(message: TerrainMeshWorkerReply, transfer?: Transferable[]): void;
}
/** This optional library port is the only native dependency; no native package is imported by engine. */
export interface NativeTerrainGeometryPort {
  readonly actualTier: "single";
  buildSurface(request: TerrainMeshNumericInput): TerrainNumericGeometry | Promise<TerrainNumericGeometry>;
  dispose?(): void;
}
