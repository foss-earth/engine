import type { ImageKind } from "@foss-earth/images";
import { RgbaSurfaceCreationError, type RgbaReadbackSurface } from "@foss-earth/images/browser";
import { isBlankImage, preparePages } from "../terrain/imagery/imageryPagePreparation.js";
import { pageUploadBytes } from "../terrain/imagery/imageryAtlasLayout.js";
import { atlasWorkerFailure, type AtlasImageryWorkerScope, type AtlasImageryWorkerRequest } from "./atlasImageryWorkerProtocol.js";

export interface AtlasImageryWorkerKernelPorts {
  scope: AtlasImageryWorkerScope;
  /** Native worker realm; encoded Blob copy and prospective pixels were
   * admitted in the host before this message. No fetch/header/cache here. */
  decode(bytes: Uint8Array, mimeType: ImageKind): Promise<ImageBitmap>;
  /** Supply public Images.createCanvasRgbaSurface with this worker's canvas realm. */
  createSurface(width: number, height: number): RgbaReadbackSurface;
  onError(error: unknown): void;
}
/** Original decode/check-transparent/prepare/transfer behavior, with explicit
 * host admission and retirement messages. No broker or global self is created. */
export function installAtlasImageryWorkerKernel(ports: AtlasImageryWorkerKernelPorts): { dispose(): void } {
  const { scope } = ports;
  let disposed = false;
  const report = (error: unknown): void => { try { ports.onError(error); } catch { /* Host error port attempted. */ } };
  const send = (message: Parameters<typeof scope.postMessage>[0], transfer?: Transferable[]): void => { scope.postMessage(message, transfer); };
  async function run(request: AtlasImageryWorkerRequest): Promise<void> {
    if (request.kind === "decode") {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await ports.decode(request.bytes, request.mimeType); request.bytes = new Uint8Array(0);
        if (disposed) throw new Error("Imagery worker kernel disposed.");
        send({ kind: "decoded", id: request.id, bitmap }, [bitmap]); bitmap = null; // Actual transfer moves ownership to the host common decoder.
      } catch (error) {
        request.bytes = new Uint8Array(0);
        const errors = [error]; let nativeRetired = bitmap === null; if (bitmap) try { bitmap.close(); nativeRetired = true; } catch (cleanup) { errors.push(cleanup); }
        send({ kind: "failed", id: request.id, nativeRetired, error: atlasWorkerFailure(errors.length === 1 ? errors[0] : new AggregateError(errors, "Worker decode cleanup failed.")) });
      }
      return;
    }
    const { id, bitmap, width, height } = request;
    let surface: RgbaReadbackSurface | null = null, canvasRetirement: Promise<void> | undefined;
    let pages: Uint8Array[][] | undefined, blank = false, inputRetired = false, canvasRetired = true, uncertainCanvas = false;
    const failures: unknown[] = [];
    try {
      if (disposed) throw new Error("Imagery worker kernel disposed.");
      if (width !== bitmap.width || height !== bitmap.height || width % 256 || height % 256 || width < 256 || height < 256 || request.outputBytes !== width / 256 * (height / 256) * pageUploadBytes()) throw new Error("Worker page dimensions/admission disagree.");
      surface = ports.createSurface(width, height); canvasRetired = false;
      const rgba = await surface.read(bitmap);
      if (disposed) throw new Error("Imagery worker kernel disposed.");
      if (!ArrayBuffer.isView(rgba) || Object.prototype.toString.call(rgba) !== "[object Uint8ClampedArray]" || rgba.byteLength !== width * height * 4 || rgba.byteOffset !== 0 || rgba.buffer.byteLength !== rgba.byteLength) throw new Error("Worker RGBA output exceeded its exact independent admission.");
      blank = isBlankImage(rgba); if (!blank) pages = preparePages(rgba, width, height);
    } catch (error) { failures.push(error); if (error instanceof RgbaSurfaceCreationError) { canvasRetirement = error.retired; canvasRetired = false; } }
    finally {
      if (surface) {
        try { canvasRetirement = surface.retired; } catch (error) { failures.push(error); uncertainCanvas = true; }
        try { surface.dispose(); if (!canvasRetirement && !uncertainCanvas) canvasRetired = true; } catch (error) { failures.push(error); }
      }
      try { bitmap.close(); inputRetired = true; } catch (error) { failures.push(error); }
    }
    if (canvasRetirement) void canvasRetirement.then(() => {
      try { send({ kind: "canvas-retired", id }); } catch (error) { report(error); }
    }, error => { try { send({ kind: "canvas-retired", id, error: atlasWorkerFailure(error) }); } catch (cleanup) { report(cleanup); } });
    const failure = failures.length ? atlasWorkerFailure(failures.length === 1 ? failures[0] : new AggregateError(failures, "Worker page preparation and cleanup failed.")) : undefined;
    const transfer = !failure && pages ? pages.flatMap(levels => levels.map(level => level.buffer as ArrayBuffer)) : [];
    send({ kind: "prepared", id, width, height, inputRetired, canvasRetired, ...(failure ? { error: failure } : blank ? { blank: true } : { pages }) }, transfer);
  }
  const receive = (event: MessageEvent<AtlasImageryWorkerRequest>): void => { void run(event.data).catch(report); };
  scope.onmessage = receive;
  return { dispose() { disposed = true; if (scope.onmessage === receive) scope.onmessage = null; } };
}
