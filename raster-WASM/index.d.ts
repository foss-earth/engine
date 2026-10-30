export interface RasterCore {
  /** Returns an owned copy by default. reuseInput consumes aligned caller RGBA storage. Never borrows WASM memory. */
  decodeTerrarium(data: Uint8ClampedArray, size: number, reuseInput?: boolean): Float32Array;
}

/** Lazy, shared loading of this package's single-threaded WASM artifact. */
export function loadRasterCore(): Promise<RasterCore>;

/** Instantiate supplied artifact bytes, for offline callers and equivalent-output A/B tests. */
export function instantiateRasterCore(bytes: ArrayBuffer | ArrayBufferView): Promise<RasterCore>;
