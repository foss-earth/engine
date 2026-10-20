export interface GroundMesh {
  readonly generation: number;
  /** Owned compact traversal data: [node count, face count], ten f64 values
   * per node [low xyz, high xyz,left,right,start,count], original face IDs. */
  snapshot(): Float64Array;
  /** Rows: origin xyz, finite positive length, direction xyz, epsilon >=0.
   * Directions are already in mesh-local ray space; they are not normalised.
   * Returns rows: hit(0/1), ray parameter, original face, bu,bv, raw normal xyz.
   * Miss: [0,-1,-1,0,0,0,0,0]. All returned storage is caller-owned. */
  query(rays: Float64Array): Float64Array;
  dispose(): void;
}
export interface GroundCore {
  readonly backend: "single";
  readonly actualTier: "single";
  readonly validationStatus: "unvalidated";
  buildBvh(positions: Float32Array, indices: Uint32Array, options?: { generation?: number }): GroundMesh;
  dispose(): void;
}
export function loadGroundCore(options?: { wasmUrl?: URL | string; fetch?: typeof fetch }): Promise<GroundCore>;
export function instantiateGroundCore(bytes: BufferSource | WebAssembly.Module): Promise<GroundCore>;
export function createGroundCore(exports: WebAssembly.Exports): GroundCore;
