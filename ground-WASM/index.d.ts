/** World ray `[origin xyz, direction xyz, length, epsilon]` and hit row `[mesh, distance, face, bu, bv, point xyz, normal xyz]`. */
export const WORLD: Readonly<{ rayStride: 8; rowStride: 11; maxRays: 65536 }>;

/**
 * Babylon `Matrix.m` values in its row-vector order, Float32Array or Float64Array as the scene stores them.
 * `normalToWorld` is the matrix `PickingInfo.getNormal(true, false)` transforms by: the world matrix, or for
 * non-uniform scaling its translation-free inverse transpose. It defaults to `localToWorld`.
 */
export interface GroundTransform {
  worldToLocal: ArrayLike<number>;
  localToWorld: ArrayLike<number>;
  normalToWorld?: ArrayLike<number>;
}

export interface GroundMesh {
  readonly generation: number;
  /** The mesh field of world hit rows. */
  readonly handle: number;
  /** Owned compact traversal data: [node count, face count], ten f64 values
   * per node [low xyz, high xyz,left,right,start,count], original face IDs. */
  snapshot(): Float64Array;
  /** Rows: origin xyz, finite positive length, direction xyz, epsilon >=0.
   * Directions are already in mesh-local ray space; they are not normalised.
   * Returns rows: hit(0/1), ray parameter, original face, bu,bv, raw normal xyz.
   * Miss: [0,-1,-1,0,0,0,0,0]. All returned storage is caller-owned. */
  query(rays: Float64Array): Float64Array;
  /** The mesh-space `getBoundingInfo()` world queries test first: [minimum xyz, maximum xyz, sphere center xyz,
   * sphere radius]. Until set, the root box and the sphere `new BoundingInfo` gives it. */
  setBounds(bounds: ArrayLike<number>): void;
  /** `scene.pickWithRay` restricted to this mesh, with `getNormal(true, false)`, for each world ray (WORLD.rayStride
   * values). Rows (WORLD.rowStride values) start empty, [0,-1,-1,0,0,0,0,0,0,0,0], or as `previous` holds them; a row
   * takes this mesh's hit unless it is no nearer than the one it holds. Copies in and out. */
  queryWorld(rays: Float64Array, transform: GroundTransform, previous?: Float64Array): Float64Array;
  dispose(): void;
}

/**
 * Rays and hit rows in WASM memory, allocated once. Fill `rays`, `reset()` the rows, then `run()` each mesh in the
 * scene's order: the rows end as the scene's pick. Views are replaced only when memory grows; re-read the getters
 * after building or importing a mesh. Little-endian hosts only.
 */
export interface GroundWorldBatch {
  readonly capacity: number;
  readonly rays: Float64Array;
  readonly output: Float64Array;
  reset(count?: number): void;
  run(mesh: GroundMesh, transform: GroundTransform, count?: number): void;
  dispose(): void;
}

export interface GroundCore {
  readonly backend: "single";
  readonly actualTier: "single";
  readonly validationStatus: "unvalidated";
  /** Whether this core was allowed onto the page main thread. */
  readonly page: boolean;
  buildBvh(positions: Float32Array, indices: Uint32Array, options?: { generation?: number }): GroundMesh;
  /** Adopts `snapshot()`'s index of this geometry without rebuilding; throws with `status` 6 if it is not a valid
   * index of it, or is deeper than 48 levels. */
  importSnapshot(snapshot: Float64Array, positions: Float32Array, indices: Uint32Array, options?: { generation?: number }): GroundMesh;
  createWorldBatch(capacity: number): GroundWorldBatch;
  dispose(): void;
}

/** Refuses the page main thread (a global `document`) unless `page` is true. */
export interface GroundCoreOptions { page?: boolean }
export function loadGroundCore(options?: { wasmUrl?: URL | string; fetch?: typeof fetch } & GroundCoreOptions): Promise<GroundCore>;
export function instantiateGroundCore(bytes: BufferSource | WebAssembly.Module, options?: GroundCoreOptions): Promise<GroundCore>;
export function createGroundCore(exports: WebAssembly.Exports, options?: GroundCoreOptions): GroundCore;
