export interface TerrainTile { z: number; x: number; y: number }
export interface TerrainGrid extends TerrainTile {
  size: number; heights: Float32Array;
  /** Optional sorted original pixel indices for compact height batches. Every
   * direct neighbour then uses matching indices/heights; size stays original. */
  indices?: Uint32Array;
  neighbors?: TerrainGrid[];
}
export interface TerrainRequest {
  tile: TerrainTile;
  grid?: TerrainGrid;
  segments?: number;
  withUvs?: boolean;
  /** Unsupported without a prepared grid; the caller keeps that case in TypeScript. */
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
}
export interface TerrainSurface {
  positions: Float64Array;
  targetPositions: Float32Array;
  uvs: Float64Array | null;
  indices: Uint32Array;
  center: { x: number; y: number; z: number };
  segments: number;
  heightBounds: { min: number; max: number };
  terrainZoom: number;
  actualTier: "single";
  validationStatus: "unvalidated";
}
export interface TerrainCore {
  readonly actualTier: "single";
  readonly validationStatus: "unvalidated";
  buildSurface(request: TerrainRequest): TerrainSurface;
  /** Retained immutable grid; coordinates are x/y pairs at grid.z. Results
   * stay Float64 to preserve the reference's interpolated heights/slopes. */
  createHeightSampler(grid: TerrainGrid): TerrainHeightSampler;
  dispose(): void;
}
export interface TerrainHeightSampler {
  readonly bytes: number;
  sample(coordinates: Float64Array): Float64Array;
  dispose(): void;
}
export interface TerrainCoreOptions {
  /** Explicit assertion for worker hosts without browser WorkerGlobalScope, e.g. Node workers. */
  workerRealm?: boolean;
  wasmUrl?: URL | string;
  fetch?: typeof fetch;
  /** Trusted non-throwing builtins from this worker's executing Math realm. */
  math?: Pick<Math, "sin" | "cos" | "atan" | "sinh" | "sqrt" | "pow" | "floor" | "round" | "min" | "max">;
}
export function loadTerrainCore(options?: TerrainCoreOptions): Promise<TerrainCore>;
export function instantiateTerrainCore(source: BufferSource | WebAssembly.Module, options?: TerrainCoreOptions): Promise<TerrainCore>;
export function createTerrainCore(exports: WebAssembly.Exports, options?: TerrainCoreOptions): TerrainCore;
export function assertTerrainWorker(options?: TerrainCoreOptions): void;
