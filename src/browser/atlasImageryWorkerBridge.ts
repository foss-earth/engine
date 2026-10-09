import { ResourceCapacityError, type ImageKind, type ImageOperationScope, type ImageSessionBroker, type Reservation } from "@foss-earth/images";
import { createImageFileService, type HeldDecodedImage, type HeaderInferredImageFileService } from "@foss-earth/images/browser";
import { pageUploadBytes } from "../terrain/imagery/imageryAtlasLayout.js";
import { atlasWorkerError, type AtlasImageryWorkerPort, type AtlasImageryWorkerReply, type AtlasImageryWorkerRequest } from "./atlasImageryWorkerProtocol.js";

export interface AtlasWorkerPreparedPages { width: number; height: number; pages?: Uint8Array[][]; blank?: boolean }
export interface AtlasImageryWorkerBridge {
  readonly offThread: boolean;
  /** Actual shared service factory, bound to this broker and this native decoder. */
  createFileService(options: Omit<Parameters<typeof createImageFileService>[0], "broker" | "decode">): HeaderInferredImageFileService;
  uses(files: HeaderInferredImageFileService, broker: ImageSessionBroker): boolean;
  prepare(image: HeldDecodedImage, scope: ImageOperationScope, priority: number, outputBytes: number): Promise<AtlasWorkerPreparedPages>;
  /** Stop new work; active native replies/retirement drain before idle termination. */
  dispose(): void;
}
export interface AtlasImageryWorkerBridgeOptions {
  broker: ImageSessionBroker;
  /** Return null or throw when this host has no usable worker. */
  createWorker(): AtlasImageryWorkerPort | null;
  /** Main realm fallback, at most one encoded Blob copy. */
  decode(bytes: Uint8Array, mimeType: ImageKind): Promise<ImageBitmap>;
  onError?(error: unknown): void;
}
/** Original optional worker/fallback selection with retained same-broker
 * inputs. Only private admitted copies transfer; cache/body views never detach. */
export function createAtlasImageryWorkerBridge(options: AtlasImageryWorkerBridgeOptions): AtlasImageryWorkerBridge {
  let worker: AtlasImageryWorkerPort | null = null, closing = false, failed = false, nextId = 1;
  const services = new WeakSet<HeaderInferredImageFileService>();
  type Pending = { kind: "decode" | "prepare"; settled: boolean; canvasPending: boolean; canvasProven: boolean;
    resolve(reply: AtlasImageryWorkerReply): void; reject(error: unknown): void;
    finishInput(): void; finishCanvas(): void; failure?: unknown };
  const waiting = new Map<number, Pending>();
  const report = (error: unknown): void => { try { options.onError?.(error); } catch { /* Existing host error port attempted. */ } };
  const cleanup = (actions: (() => void)[], prior: unknown[] = []): unknown[] => { for (const action of actions) try { action(); } catch (error) { prior.push(error); } return prior; };
  const errorFrom = (errors: unknown[], message: string): unknown => errors.length === 1 ? errors[0] : new AggregateError(errors, message);
  const stopIdle = (): void => { if ((!closing && !failed) || waiting.size || !worker) return; const retiring = worker; worker = null; try { retiring.terminate(); } catch (error) { report(error); } };
  const retirePending = (id: number, pending: Pending): void => { if (pending.settled && !pending.canvasPending) { waiting.delete(id); stopIdle(); } };
  const loseWorker = (error: unknown): void => {
    failed = true; report(error); const retiring = worker;
    // A fatal worker event is not native/queued-output retirement. Keep active
    // charged inputs until final replies or an explicitly supplied proof.
    let retirement: Promise<void> | undefined;
    try { retirement = retiring?.retired; } catch (cleanupError) { report(cleanupError); }
    if (retirement) void retirement.then(() => {
      const entries = [...waiting]; waiting.clear();
      for (const [, pending] of entries) {
        const errors = cleanup([pending.finishInput, pending.finishCanvas], [error]);
        if (!pending.settled) pending.reject(errorFrom(errors, "Imagery worker loss and cleanup failed.")); else if (errors.length > 1) report(errorFrom(errors, "Late worker retirement cleanup failed."));
      }
      stopIdle();
    }, report);
    stopIdle();
  };
  try { worker = options.createWorker(); } catch (error) { report(error); }
  if (worker) {
    const selected = worker;
    selected.onerror = () => loseWorker(new Error("The imagery decoder stopped."));
    selected.onmessage = event => {
      const reply = event.data, pending = waiting.get(reply.id);
      if (!pending) { if (reply.kind === "decoded") try { reply.bitmap.close(); } catch (error) { report(error); } return; }
      if (reply.kind === "canvas-retired") {
        if (reply.error) { report(atlasWorkerError(reply.error)); return; }
        pending.canvasPending = false; pending.canvasProven = true; const errors = cleanup([pending.finishCanvas]); if (errors.length) report(errorFrom(errors, "Worker canvas retirement cleanup failed.")); retirePending(reply.id, pending); return;
      }
      if (pending.settled) { if (reply.kind === "decoded") try { reply.bitmap.close(); } catch (error) { report(error); } return; }
      if ((pending.kind === "decode" && reply.kind === "prepared") || (pending.kind === "prepare" && (reply.kind === "decoded" || reply.kind === "failed")) || (reply.kind === "failed" && !reply.nativeRetired)) { const errors = [new Error("Worker reply does not prove the expected native input retired.")]; if (reply.kind === "decoded") cleanup([() => reply.bitmap.close()], errors); loseWorker(errorFrom(errors, "Unexpected worker output cleanup failed.")); return; }
      const errors: unknown[] = [];
      if (reply.kind === "prepared") {
        pending.canvasPending = !reply.canvasRetired && !pending.canvasProven;
        if (reply.inputRetired) cleanup([pending.finishInput], errors); else { loseWorker(new Error("Worker input close did not prove retirement.")); return; }
        if (reply.canvasRetired) cleanup([pending.finishCanvas], errors);
      } else cleanup([pending.finishInput, pending.finishCanvas], errors);
      pending.settled = true;
      if (reply.kind === "failed") errors.unshift(atlasWorkerError(reply.error));
      if (reply.kind === "prepared" && reply.error) errors.unshift(atlasWorkerError(reply.error));
      if (errors.length) { if (reply.kind === "decoded") cleanup([() => reply.bitmap.close()], errors); pending.reject(errorFrom(errors, "Worker reply and ownership cleanup failed.")); }
      else pending.resolve(reply);
      retirePending(reply.id, pending);
    };
  }
  const reserve = (pool: "encoded" | "decoded", bytes: number, label: string): Reservation => {
    const grant = options.broker.pools.reserve(pool, bytes, label); if (!grant.ok) throw new ResourceCapacityError(grant.pool, grant.reason); return grant.reservation;
  };
  const request = (message: AtlasImageryWorkerRequest, transfer: Transferable[], input: () => void, canvas: () => void): Promise<AtlasImageryWorkerReply> => {
    return new Promise((resolve, reject) => {
      if (!worker || closing || failed) { const errors = cleanup([input, canvas], [new Error("The imagery worker is unavailable.")]); reject(errorFrom(errors, "Worker admission cleanup failed.")); return; }
      const pending: Pending = { kind: message.kind, settled: false, canvasPending: false, canvasProven: false, resolve, reject, finishInput: input, finishCanvas: canvas };
      waiting.set(message.id, pending);
      try { worker.postMessage(message, transfer); }
      catch (error) {
        // postMessage throwing does not prove whether an injected transport
        // transferred/started work. Keep all holds unless an actual reply or
        // native realm retirement proves the input stopped.
        pending.failure = error; loseWorker(error);
      }
    });
  };
  const decode = async (bytes: Uint8Array, mimeType: ImageKind): Promise<ImageBitmap> => {
    if (closing) throw new Error("The imagery worker bridge is disposed.");
    if (!worker || failed) {
      const blob = reserve("encoded", bytes.byteLength, "native imagery Blob copy");
      let bitmap: ImageBitmap | null = null; const errors: unknown[] = [];
      try { bitmap = await options.decode(bytes, mimeType); } catch (error) { errors.push(error); }
      cleanup([() => blob.release()], errors);
      if (errors.length) { if (bitmap) cleanup([() => bitmap!.close()], errors); throw errorFrom(errors, "Native fallback decode and cleanup failed."); }
      return bitmap!;
    }
    // A private message body and native worker Blob coexist with the retained
    // source/cache input. Admit both before slice/structured transfer.
    const copies = reserve("encoded", bytes.byteLength * 2, "worker encoded message and native Blob copies");
    let snapshot: Uint8Array;
    try { snapshot = bytes.slice(); } catch (error) { const errors = cleanup([() => copies.release()], [error]); throw errorFrom(errors, "Worker snapshot allocation cleanup failed."); }
    const reply = await request({ kind: "decode", id: nextId++, bytes: snapshot, mimeType }, [snapshot.buffer as ArrayBuffer], () => copies.release(), () => {});
    if (reply.kind !== "decoded") throw new Error("The worker did not return a decoded bitmap.");
    return reply.bitmap;
  };
  return {
    get offThread() { return worker !== null && !closing && !failed; },
    createFileService(ports) { const files = createImageFileService({ ...ports, broker: options.broker, decode }); services.add(files); return files; },
    uses: (files, broker) => broker === options.broker && services.has(files),
    async prepare(image, scope, priority, outputBytes) {
      scope.signal.throwIfAborted(); if (!scope.isCurrent()) throw new Error("Stale worker imagery preparation.");
      if (!image.retain) throw new Error("Worker preparation requires held decoded input.");
      const { width, height } = image.image, expectedOutput = width / 256 * (height / 256) * pageUploadBytes();
      if (outputBytes !== expectedOutput) throw new Error("Worker prepared output admission does not match its pages.");
      let endInput: (() => void) | null = null, canvas: Reservation | null = null, rgba: Reservation | null = null, holdCanvas: (() => void) | null = null, holdRgba: (() => void) | null = null;
      const finishInput = (): void => { const input = endInput, pixels = rgba, hold = holdRgba; endInput = null; rgba = null; holdRgba = null; const errors = cleanup([() => hold?.(), () => pixels?.release(), () => input?.()]); if (errors.length) throw errorFrom(errors, "Worker bitmap/RGBA retirement failed."); };
      const finishCanvas = (): void => { const owned = canvas, hold = holdCanvas; canvas = null; holdCanvas = null; const errors = cleanup([() => hold?.(), () => owned?.release()]); if (errors.length) throw errorFrom(errors, "Worker canvas retirement failed."); };
      let posted = false;
      try {
        canvas = scope.reserve("decoded", width * height * 4, "worker RGBA canvas"); holdCanvas = canvas.retain();
        rgba = scope.reserve("decoded", width * height * 4, "worker RGBA pixels"); holdRgba = rgba.retain(); endInput = image.retain();
        const reply = await options.broker.decodes.run(priority, scope.signal, async () => {
          scope.signal.throwIfAborted(); if (!scope.isCurrent()) throw new Error("Stale worker imagery preparation.");
          posted = true;
          return request({ kind: "prepare", id: nextId++, bitmap: image.image, width, height, outputBytes }, [image.image], finishInput, finishCanvas);
        });
        if (reply.kind !== "prepared") throw new Error("The worker did not return prepared imagery.");
        if (reply.width !== width || reply.height !== height) throw new Error("Worker returned invalid preparation dimensions.");
        if (!reply.blank) {
          if (!reply.pages || reply.pages.length !== width / 256 * (height / 256)) throw new Error("Worker returned invalid prepared page dimensions.");
          for (const levels of reply.pages) for (let level = 0; level < 5; level++) if (levels.length !== 5 || !(levels[level] instanceof Uint8Array) || levels[level].byteLength !== (288 >> level) ** 2 * 4 || levels[level].byteOffset !== 0 || levels[level].buffer.byteLength !== levels[level].byteLength) throw new Error("Worker returned invalid complete RGBA mip storage.");
        }
        return { width: reply.width, height: reply.height, pages: reply.pages, blank: reply.blank };
      } catch (error) {
        if (posted) throw error;
        const errors = cleanup([finishInput, finishCanvas], [error]); throw errorFrom(errors, "Worker preparation admission failed.");
      }
    },
    dispose() { if (closing) return; closing = true; stopIdle(); },
  };
}
