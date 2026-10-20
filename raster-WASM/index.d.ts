export interface RasterCore {
  /** Returns an owned copy; malformed input and WASM failures throw. No JavaScript fallback. */
  decodeTerrarium(data: Uint8ClampedArray, size: number): Float32Array;
}

/** Lazy, shared loading of this package's single-threaded WASM artifact. */
export function loadRasterCore(): Promise<RasterCore>;

/** Instantiate supplied artifact bytes, for offline callers and equivalent-output A/B tests. */
export function instantiateRasterCore(bytes: ArrayBuffer | ArrayBufferView): Promise<RasterCore>;
