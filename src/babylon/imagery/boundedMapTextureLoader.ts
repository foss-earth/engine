import type { BaseTexture } from "@babylonjs/core";
import { rgba8Bytes, type ImageFile, type ImageSessionBroker } from "@foss-earth/images";
import type { EncodedImageFile, HeldDecodedImage, ImageFileService } from "@foss-earth/images/browser";
import type { ImageTextureUploader, UploadedImageTexture } from "@foss-earth/renderer/babylon";
import { finishOwnedCleanup } from "../ownedCleanup.js";

export interface BoundedMapTexturePorts {
  broker: ImageSessionBroker;
  /** The host's one cache/transfer/header/decode service, including actual map transport. */
  files: ImageFileService;
  uploader: ImageTextureUploader;
  maxTextureSide(): number;
  whenReady(texture: BaseTexture, signal: AbortSignal): Promise<void>;
}
export interface BoundedMapTextureRequest {
  /** Initial encoded reservation; the shared file service enforces response and pool limits. */
  declaredBytes: number;
  priority: number;
  overlap?: boolean;
  signal?: AbortSignal;
  onBytes?(bytes: number): void;
}
export interface LoadedMapTexture {
  readonly texture: BaseTexture;
  readonly uploaded: UploadedImageTexture;
  readonly sourceGpuBytes: number;
  isCurrent(): boolean;
  /** Host calls only after atomic publication and outgoing source disposal. */
  settleReplacement(): void;
  dispose(): void;
}
/**
 * Explicit async map path. It never creates a decoder, cache, uploader, device
 * or frame loop. Legacy synchronous Texture/updateURL remains a separate API.
 * File MIME/dimensions must be the actual provider tile metadata, not guessed.
 */
export function createBoundedMapTextureLoader(ports: BoundedMapTexturePorts): (file: ImageFile, request: BoundedMapTextureRequest) => Promise<LoadedMapTexture> {
  return async (input, request) => {
    request.signal?.throwIfAborted();
    const file = Object.freeze({ url: input.url, mimeType: input.mimeType, width: input.width, height: input.height });
    const maximum = ports.maxTextureSide();
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("The host did not supply a valid renderer texture-size limit.");
    if (![file.width,file.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= maximum)) throw new Error("Map tile dimensions exceed the borrowed renderer's limits.");
    if (!Number.isSafeInteger(request.declaredBytes) || request.declaredBytes < 0 || !Number.isFinite(request.priority)) throw new Error("Map acquisition needs nonnegative encoded bytes and a finite priority.");
    const scope = ports.broker.scope();
    let disposed = false, encoded: EncodedImageFile | undefined, decoded: HeldDecodedImage | undefined;
    let releaseDecodedInput: (() => void) | undefined;
    const ended = (): void => { disposed = true; request.signal?.removeEventListener("abort", abort); };
    const dispose = (): void => {
      if (disposed) return; disposed = true;
      finishOwnedCleanup([() => request.signal?.removeEventListener("abort", abort),
        () => scope.signal.removeEventListener("abort", ended), () => scope.dispose()], "Map retained handle cleanup failed.");
    };
    const abort = (): void => dispose();
    scope.signal.addEventListener("abort", ended, { once: true });
    request.signal?.addEventListener("abort", abort, { once: true });
    const failures: unknown[] = [];
    let loaded: LoadedMapTexture | undefined;
    try {
      if (request.signal?.aborted) dispose(); scope.signal.throwIfAborted();
      // Full RGBA8 mip chain is a conservative pre-allocation bound. NPOT GL1
      // omits illegal mips, then resizes this reservation to the actual result.
      const gpu = scope.reserve("sourceGpu", rgba8Bytes(file.width,file.height), file.url, { overlap: request.overlap });
      encoded = await ports.files.obtain(file,request.declaredBytes,scope,request.onBytes,request.priority); scope.signal.throwIfAborted();
      decoded = await ports.files.decode(encoded,file,scope,request.priority); scope.signal.throwIfAborted();
      encoded.release(); encoded = undefined;
      // The queued uploader can read this bitmap on a later host pump. Scope
      // cancellation must defer both native close and the existing pixel charge.
      if (!decoded.retain) throw new Error("Bounded map uploads require a decoded-image input retain port.");
      releaseDecodedInput = decoded.retain();
      const uploaded = await ports.uploader.upload({ kind: "2d", images: [decoded.image], label: file.url, signal: scope.signal,
        // Original map: encoded sRGB storage, shader gamma decode, invertY=false,
        // trilinear/mips where legal. Renderer owns the actual backend behavior.
        textureColor: { useSRGBBuffer: false, gammaSpace: true },
        reserveUpload(bytes,label) { const grant=ports.broker.pools.reserve("uploadOutstanding",bytes,label); if (!grant.ok) throw new Error(grant.reason); return grant.reservation; },
        reserveDecodedStaging(bytes,label) { const grant=ports.broker.pools.reserve("decoded",bytes,label); if (!grant.ok) throw new Error(grant.reason); return grant.reservation; },
      });
      if (!scope.adopt(uploaded)) { scope.signal.throwIfAborted(); throw new Error("Stale map upload."); }
      if (uploaded.gpuBytes > gpu.bytes) throw new Error("Map uploader exceeded its pre-admitted RGBA8 source bound.");
      gpu.resize(uploaded.gpuBytes);
      await ports.whenReady(uploaded.texture,scope.signal); scope.signal.throwIfAborted();
      loaded = { texture: uploaded.texture, uploaded, sourceGpuBytes: uploaded.gpuBytes, isCurrent: () => !disposed && scope.isCurrent(), settleReplacement() { if (!disposed && scope.isCurrent()) gpu.settle(); }, dispose };
    } catch (error) { failures.push(error); }
    try { encoded?.release(); } catch (error) { failures.push(error); }
    try { decoded?.close(); } catch (error) { failures.push(error); }
    try { releaseDecodedInput?.(); } catch (error) { failures.push(error); }
    if (failures.length) { try { dispose(); } catch (error) { failures.push(error); } throw failures.length === 1 ? failures[0] : new AggregateError(failures,"Map acquisition and cleanup failed."); }
    return loaded!;
  };
}
