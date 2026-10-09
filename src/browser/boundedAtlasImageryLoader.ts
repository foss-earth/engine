import type { AtlasImageryWorkerBridge } from "./atlasImageryWorkerBridge.js";
import { imageDimensionMismatch, type ImageKind, type ImageOperationScope, type ImageSessionBroker, type Reservation } from "@foss-earth/images";
import { ImageHttpStatusError, readbackDecodedImage, type CachedEncodedImageFile, type HeaderInferredImageFileService,
  type HeldDecodedImage, type HeldRgbaImage, type RgbaReadbackSurface } from "@foss-earth/images/browser";
import { IMAGERY_PAGE_SIZE, pageUploadBytes } from "../terrain/imagery/imageryAtlasLayout.js";
import { isBlankImage, preparePages } from "../terrain/imagery/imageryPagePreparation.js";
import { ImageryMissingError, type ImageryLoader, type RetainedPreparedImage } from "../terrain/imagery/imageryResidency.js";

export interface BoundedAtlasImageryLoaderOptions {
  /** Borrowed. The supplied file service must use this exact session broker. */
  broker: ImageSessionBroker;
  files: HeaderInferredImageFileService;
  /** Reviewed transfer estimate; absent MIME is inferred from JPEG/PNG bytes. */
  describe(url: string, expected: Readonly<{ width: number; height: number }>): { declaredBytes: number; mimeType?: ImageKind };
  /** Default for direct legacy three-argument calls. Residency supplies priority. */
  priority(): number;
  /** The host's supplied Document/OffscreenCanvas realm, never a global factory. */
  createSurface(width: number, height: number): RgbaReadbackSurface;
  /** Borrowed; its createFileService must have constructed these exact files. */
  worker?: AtlasImageryWorkerBridge;
  onBytes?(bytes: number): void;
  /** Late native surface cleanup errors use the host's existing error channel. */
  onCleanupFailure?(error: unknown): void;
}
export interface BrowserImageryLoader extends ImageryLoader<AbortSignal> {
  /** This producer always supplies the complete managed lifetime contract. */
  load(url: string, expected: { width: number; height: number }, signal: AbortSignal, priority?: number): Promise<RetainedPreparedImage>;
  /** True only while a supplied worker performs native decode/preparation. */
  readonly offThread: boolean;
  /** Owns operation scopes only; the broker, files, cache and realm are borrowed. */
  dispose(): void;
}

function attempt(action: () => void, failures: unknown[]): void {
  try { action(); } catch (error) { failures.push(error); }
}
function failure(errors: unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, "Atlas imagery operation and cleanup failed.");
}
function typedCause<T extends Error>(error: unknown, type: new (...args: never[]) => T): T | null {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof type) return current;
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return null;
}
function classify(error: unknown): unknown {
  const blank = typedCause(error, ImageryMissingError);
  const dimension = imageDimensionMismatch(error);
  const status = typedCause(error, ImageHttpStatusError);
  if (blank || dimension || status?.status === 404 || status?.status === 204) {
    if (error instanceof ImageryMissingError) return error;
    return new ImageryMissingError(blank?.message ?? (dimension ? "Map image dimensions do not match this variant." : `Map tile not available (${status!.status})`), { cause: error });
  }
  return error;
}

/**
 * Shared bounded acquisition and native readback, followed by the original pure
 * page/gutter/mip preparation. Optional explicit worker bridge preserves actual
 * off-thread decode/preparation; no renderer or clock is created.
 * Returned held pages require a proven owned-upload store; legacy void uploads
 * cannot establish native input retirement and are explicitly refused.
 */
export function createBoundedAtlasImageryLoader(options: BoundedAtlasImageryLoaderOptions): BrowserImageryLoader {
  if (typeof options.files.obtainInferred !== "function") throw new Error("Bounded Atlas imagery requires header-inferred common acquisition.");
  if (options.worker && !options.worker.uses(options.files, options.broker)) throw new Error("Worker imagery must use that bridge's exact common file service.");
  let disposed = false;
  const scopes = new Set<ImageOperationScope>();
  return {
    get offThread() { return options.worker?.offThread ?? false; },
    async load(url, expected, signal, suppliedPriority): Promise<RetainedPreparedImage> {
      if (disposed) throw new Error("The bounded Atlas imagery loader is disposed.");
      signal.throwIfAborted();
      const { width, height } = expected;
      const pageCount = (width / IMAGERY_PAGE_SIZE) * (height / IMAGERY_PAGE_SIZE);
      const outputBytes = pageCount * pageUploadBytes();
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < IMAGERY_PAGE_SIZE || height < IMAGERY_PAGE_SIZE || width % IMAGERY_PAGE_SIZE || height % IMAGERY_PAGE_SIZE || !Number.isSafeInteger(outputBytes)) throw new RangeError("Atlas imagery requires reviewed whole 256-pixel page dimensions.");
      const priority = suppliedPriority ?? options.priority();
      if (!Number.isFinite(priority)) throw new RangeError("Atlas imagery priority must be finite.");
      const description = options.describe(url, Object.freeze({ width, height }));
      if (!Number.isSafeInteger(description.declaredBytes) || description.declaredBytes < 0) throw new RangeError("Atlas declared bytes must be a nonnegative whole byte count.");
      const scope = options.broker.scope(); scopes.add(scope);
      let body: CachedEncodedImageFile | null = null, decoded: HeldDecodedImage | null = null, rgba: HeldRgbaImage | null = null;
      let endRgba: (() => void) | null = null, output: Reservation | null = null, endOutput: (() => void) | null = null;
      let pages: Uint8Array[][] | null = null, closing = false, closed = false, users = 0, attached = false;
      const deferredFailures: unknown[] = [];
      const requireCurrent = (): void => {
        signal.throwIfAborted(); scope.signal.throwIfAborted();
        if (disposed || !scope.isCurrent()) throw new Error("Stale bounded Atlas imagery.");
      };
      const detach = (): void => { if (attached) { attached = false; signal.removeEventListener("abort", onAbort); } };
      const close = (): void => {
        closing = true;
        if (!closed && users === 0) {
          closed = true; pages = null; scopes.delete(scope);
          const grant = output; output = null;
          const end = endOutput; endOutput = null;
          if (grant) attempt(() => grant.release(), deferredFailures);
          if (end) attempt(end, deferredFailures);
          attempt(detach, deferredFailures);
          attempt(() => scope.dispose(), deferredFailures);
        }
        if (deferredFailures.length) throw failure(deferredFailures.splice(0));
      };
      const onAbort = (): void => {
        // EventTarget must not turn a disposer failure into an uncaught task.
        // Preserve it for the load rejection or the owner's explicit close.
        try { scope.dispose(); } catch (error) { deferredFailures.push(error); }
      };
      const cleanupInputs = (errors: unknown[]): void => {
        const readback = rgba; rgba = null; if (readback) attempt(() => readback.close(), errors);
        const end = endRgba; endRgba = null; if (end) attempt(end, errors);
        const bitmap = decoded; decoded = null; if (bitmap) attempt(() => bitmap.close(), errors);
        const encoded = body; body = null; if (encoded) attempt(() => encoded.release(), errors);
      };
      try {
        attached = true; signal.addEventListener("abort", onAbort, { once: true });
        if (!scope.adopt({ dispose: detach })) requireCurrent();
        requireCurrent();
        const inferred = await options.files.obtainInferred({ url, width, height, mimeType: description.mimeType }, description.declaredBytes, scope,
          options.onBytes ? bytes => options.onBytes?.(bytes) : undefined, priority);
        body = inferred.body; requireCurrent();
        const compressedBytes = body.bytes.byteLength;
        decoded = await options.files.decode(body, inferred.file, scope, priority); requireCurrent();
        if (options.worker?.offThread) {
          // Output is admitted before the worker can allocate or transfer it.
          // The bridge separately holds decoded bitmap, canvas and RGBA input.
          output = scope.reserve("decoded", outputBytes, `${url} prepared Atlas pages`); endOutput = output.retain();
          const prepared = await options.worker.prepare(decoded, scope, priority, outputBytes); requireCurrent();
          if (prepared.blank) throw new ImageryMissingError("Map tile has no data");
          if (!prepared.pages) throw new Error("Worker imagery has no prepared pages.");
          pages = prepared.pages;
        } else {
          rgba = await readbackDecodedImage({ broker: options.broker, scope, image: decoded, priority, label: url,
            createSurface: (w, h) => options.createSurface(w, h),
            onCleanupFailure: options.onCleanupFailure ? error => options.onCleanupFailure?.(error) : undefined });
          requireCurrent(); endRgba = rgba.retain();
          if (isBlankImage(rgba.data)) throw new ImageryMissingError("Map tile has no data");
          output = scope.reserve("decoded", outputBytes, `${url} prepared Atlas pages`); endOutput = output.retain();
          requireCurrent(); pages = preparePages(rgba.data, width, height); requireCurrent();
        }
        const errors: unknown[] = []; cleanupInputs(errors);
        if (errors.length) throw failure(errors);
        requireCurrent();
        const held: RetainedPreparedImage = {
          width, height, compressedBytes,
          get pages() { if (!pages || closed) throw new Error("Prepared Atlas pages are closed."); return pages; },
          isCurrent: () => !closing && !closed && !disposed && scope.isCurrent() && !signal.aborted,
          retain() {
            requireCurrent(); if (closing || closed) throw new Error("Cannot retain closing Atlas pages.");
            users += 1; let released = false;
            return () => { if (released) return; released = true; users -= 1; if (closing) close(); };
          },
          close,
        };
        if (!scope.adopt({ dispose: close })) { requireCurrent(); throw new Error("Stale bounded Atlas imagery."); }
        requireCurrent(); return held;
      } catch (error) {
        const cancelled = signal.aborted || disposed || !scope.isCurrent();
        const errors: unknown[] = [error]; cleanupInputs(errors); attempt(close, errors);
        // Cleanup may itself invalidate the shared generation. The scope is
        // disposed by close on every error, so compare its captured generation
        // rather than treating that ordinary final close as cancellation.
        const generationChanged = options.broker.generation() !== scope.generation;
        // Cancellation takes precedence over a late typed missing observation.
        if (cancelled || signal.aborted || disposed || generationChanged) {
          const cause = failure(errors);
          // A transparent observation already uses this Engine error class.
          // Keep its evidence as cause, but cancellation must not expose a
          // missing marker that residency would otherwise cache.
          if (typedCause(cause, ImageryMissingError)) throw new Error("Atlas imagery was cancelled or became stale.", { cause });
          throw cause;
        }
        throw classify(failure(errors));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      for (const scope of [...scopes]) attempt(() => scope.dispose(), failures);
      if (failures.length) throw failure(failures);
    },
  };
}
