import { createTerrainImageDecoder, type TerrainImageDecoderPorts } from "./terrainImageDecoder.js";
import { terrainDecodeFailure, type TerrainDecodeWorkerRequest, type TerrainDecodeWorkerScope } from "./terrainDecodeWorkerProtocol.js";
import type { TerrainNativeDecoderStatus } from "./terrainNativeDecoder.js";

export interface TerrainDecodeWorkerKernelPorts {
  scope: TerrainDecodeWorkerScope;
  /** This worker realm's createImageBitmap; null when it has none. */
  createImageBitmap: ((blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>) | null;
  /** A canvas in this worker realm; null when it has no OffscreenCanvas. */
  createCanvas(width: number, height: number): OffscreenCanvas | null;
  decodeTerrarium?: TerrainImageDecoderPorts["decodeTerrarium"];
  decodeBackendStatus?(): TerrainNativeDecoderStatus;
  onError(error: unknown): void;
}
class UnsupportedRealm extends Error {}
/**
 * The page's own Terrarium decoder, run in a worker with one canvas reused for
 * every tile. Heights go back as a transferred buffer. No fetch or cache here.
 */
export function installTerrainDecodeWorkerKernel(ports: TerrainDecodeWorkerKernelPorts): { dispose(): void } {
  const { scope } = ports;
  let disposed = false, canvas: OffscreenCanvas | null = null;
  const report = (error: unknown): void => { try { ports.onError(error); } catch { /* Host error port attempted. */ } };
  const backend = (): { backend?: TerrainNativeDecoderStatus } => {
    try { return ports.decodeBackendStatus ? { backend: ports.decodeBackendStatus() } : {}; }
    catch (error) { report(error); return {}; }
  };
  const reuseCanvas = (width: number, height: number): OffscreenCanvas => {
    canvas ??= ports.createCanvas(width, height);
    if (!canvas) throw new UnsupportedRealm("This worker has no OffscreenCanvas.");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new UnsupportedRealm("This worker has no 2D canvas.");
    // The decoder's size assignment resets the canvas; clearing as well keeps a
    // tile with missing samples from showing the last tile's pixels through.
    canvas.width = width; canvas.height = height;
    context.clearRect(0, 0, width, height);
    return canvas;
  };
  async function run(request: TerrainDecodeWorkerRequest): Promise<void> {
    const { id, blob, maxTileSide } = request;
    try {
      if (disposed) throw new Error("Terrain decode worker kernel disposed.");
      const createImageBitmap = ports.createImageBitmap;
      if (!createImageBitmap) throw new UnsupportedRealm("This worker has no createImageBitmap.");
      const { size, heights } = await createTerrainImageDecoder({ createImageBitmap, createCanvas: reuseCanvas,
        nowMs: () => 0, limits: () => ({ maxTileSide }), decodeTerrarium: ports.decodeTerrarium })(blob);
      scope.postMessage({ kind: "decoded-terrain", id, size, heights, ...backend() }, [heights.buffer as ArrayBuffer]);
    } catch (error) {
      scope.postMessage({ kind: "failed", id, error: terrainDecodeFailure(error), unsupported: error instanceof UnsupportedRealm, ...backend() });
    }
  }
  const receive = (event: MessageEvent<TerrainDecodeWorkerRequest>): void => { void run(event.data).catch(report); };
  scope.onmessage = receive;
  return { dispose() { disposed = true; canvas = null; if (scope.onmessage === receive) scope.onmessage = null; } };
}
