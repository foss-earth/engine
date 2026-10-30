import { decodeTerrarium } from "../../raster-TS/terrarium.js";

export interface TerrainImageDecodeLimits { /** Maximum square tile side, pixels. Original bound: 1024. */ maxTileSide: number }
export const DEFAULT_TERRAIN_IMAGE_DECODE_LIMITS: Readonly<TerrainImageDecodeLimits> = Object.freeze({ maxTileSide: 1024 });
export interface TerrainImageDecoderPorts {
  createImageBitmap(blob: Blob, options: ImageBitmapOptions): Promise<ImageBitmap>;
  /** Fresh host Document/canvas realm; no ambient factory. */
  createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
  nowMs(): number;
  limits(): TerrainImageDecodeLimits;
  /** Optional worker-only numeric decoder; it owns WASM parity and JS fallback. */
  decodeTerrarium?(data: Uint8ClampedArray, size: number): Promise<Float32Array>;
  onDecodeCpu?(milliseconds: number): void;
}
/** Original native WebP/PNG Terrarium path: raw RGB, square bound, close finally. */
export function createTerrainImageDecoder(ports: TerrainImageDecoderPorts): (blob: Blob) => Promise<{ size: number; heights: Float32Array }> {
  // Page fallback can decode hundreds of tiles. Keep one cleared surface,
  // rather than leaving hundreds of native 2D contexts for a later GC.
  let idleCanvas: HTMLCanvasElement | OffscreenCanvas | undefined;
  return async blob => {
    const maximum = ports.limits().maxTileSide;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_TERRAIN_IMAGE_DECODE_LIMITS.maxTileSide) throw new RangeError("Terrain maxTileSide must be 1–1024 whole pixels.");
    const bitmap = await ports.createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    let started = 0, result: { size: number; heights: Float32Array } | undefined;
    let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
    const failures: unknown[] = [];
    try {
      if (ports.onDecodeCpu) started = ports.nowMs();
      if (bitmap.width !== bitmap.height || bitmap.width > maximum) throw new Error("Invalid terrain tile size");
      canvas = idleCanvas ?? ports.createCanvas(bitmap.width, bitmap.height);
      idleCanvas = undefined;
      canvas.width = canvas.height = bitmap.width;
      const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!context) throw new Error("Terrain image decoder unavailable");
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      result = { size: bitmap.width, heights: ports.decodeTerrarium
        ? await ports.decodeTerrarium(data, bitmap.width) : decodeTerrarium(data, bitmap.width, true) };
    } catch (error) { failures.push(error); }
    finally {
      try { bitmap.close(); } catch (error) { failures.push(error); }
      // Detached page canvases can keep native pixel storage until GC, even
      // after their ImageBitmap is closed. Release it before the next tile.
      // Worker hosts may reuse the canvas; the next decode restores its size.
      if (canvas) try {
        canvas.width = canvas.height = 0;
        idleCanvas ??= canvas;
      } catch (error) { failures.push(error); }
      if (ports.onDecodeCpu) try { ports.onDecodeCpu(ports.nowMs() - started); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Terrain decode and cleanup failed.");
    return result!;
  };
}
