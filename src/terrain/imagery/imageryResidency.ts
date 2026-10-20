import type { TextureTransferOutcome, TextureTransferRetirement } from "@foss-earth/renderer";
import type { NavigationAbortController, NavigationAbortSignal } from "../../navigation/navigationLease.js";
/**
 * Loading and residency for the paged imagery atlas: which images are
 * requested, decoded and staged, uploaded into slots, kept, and evicted.
 *
 * Admission is bounded everywhere: concurrent and queued requests, decoded
 * bytes waiting for upload, upload bytes per update, and atlas slots. Pages
 * the published display references are pinned; nothing a frame may sample is
 * ever freed or reused. Requests are deduplicated by image key, which names
 * source, version, variant and tile.
 */

import type { DetailLimit } from "../mapDetailPolicy.js";
import { retryDelayMs, type RetryDelay } from "../retryDelay.js";

export interface ImageryResourceLimits {
  /** Estimated GPU bytes for the atlas, mips, gutters and page table. */
  gpuBytes: number;
  /** Decoded bytes waiting for upload, in flight included. */
  stagingBytes: number;
  concurrentRequests: number;
  queuedRequests: number;
  /** Upload admitted per update; one larger page may pass when nothing else has. */
  uploadBytesPerUpdate: number;
  /** Selection and preparation CPU per update before yielding, in ms. */
  cpuMsPerUpdate: number;
  /** How long an image the server does not have stays missing before it is asked for again, ms. */
  missingRetryMs: number;
  /** How a failed download backs off, ms: the first wait, doubling with each failure in a row, up to the longest. */
  retryDelayMs: RetryDelay;
}

/** One image's pages, each as its slot at every sampled level. */
export interface PreparedImage {
  width: number;
  height: number;
  /** Row-major pages; each is its levels, largest first. */
  pages: Uint8Array[][];
  /** Response bytes when observable. */
  compressedBytes: number | null;
  /** Optional ownership for new bounded producers; absent on legacy records. */
  close?(): void;
  /** Acquire before native input use; requires close and isCurrent too. */
  retain?(): () => void;
  isCurrent?(): boolean;
}

/** Bound pages and their charge survive close requests while native use retains them. */
export interface RetainedPreparedImage extends PreparedImage {
  close(): void;
  retain(): () => void;
  isCurrent(): boolean;
}

/** Native store.upload:void gives no ownership/completion proof for held pages. */
export class ImageryOwnedUploadUnsupportedError extends Error {
  constructor() {
    super("Managed Atlas pages require a proven owned native upload store; legacy upload:void is unsupported.");
    this.name = "ImageryOwnedUploadUnsupportedError";
  }
}

/** The source does not have this image: record it as missing, not failed. */
export class ImageryMissingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageryMissingError";
  }
}

export interface ImageryLoader<TSignal extends NavigationAbortSignal = NavigationAbortSignal> {
  /** Fetches, decodes and splits one image into prepared pages. */
  load(url: string, expected: { width: number; height: number }, signal: TSignal, priority?: number): Promise<PreparedImage>;
}

/** Complete native ownership from the actual borrowed Renderer batch capability. */
export interface OwnedImageryNativeJob {
  readonly bytes: number;
  readonly settled: Promise<TextureTransferOutcome>;
  readonly retired: Promise<TextureTransferRetirement>;
  isCurrent(): boolean;
  submit(): void;
  cancel(reason?: unknown): void;
  /** Idempotent slot retirement request; actual reuse waits for native retirement. */
  release(): void;
}
export interface OwnedImageryUploadJob extends OwnedImageryNativeJob {
  readonly slots: readonly number[];
}

/** The GPU side: slots in an atlas. */
export interface ImageryPageStore {
  readonly capacity: number;
  allocate(): number | null;
  release(slot: number): void;
  upload(slot: number, levels: readonly Uint8Array[]): void;
  /** Optional real complete-batch capability. Null admits no native work. */
  prepareOwnedUpload?(image: RetainedPreparedImage): OwnedImageryUploadJob | null;
  /** Needed for original safe eviction policy before complete managed admission. */
  freeSlots?(): number;
}

export interface ImageryRequest {
  imageKey: string;
  url: string;
  width: number;
  height: number;
  /** Higher loads first. */
  priority: number;
  /** Fallback coverage: loaded before everything else. */
  coverage: boolean;
  /** Keys sharing this prefix belong to one source version; others are obsolete when it changes. */
  sourceKey: string;
}

export interface ImageryResidencyStats {
  resident: number;
  residentPages: number;
  staged: number;
  stagedBytes: number;
  inFlight: number;
  inFlightReservedBytes: number;
  queued: number;
  demanded: number;
  /** Demanded images left out of the bounded queue; they are queued as it drains. */
  overflow: number;
  /**
   * Downloaded images the last upload found no slot for: every slot was
   * pinned by the display or held more important imagery.
   */
  unplaced: number;
  /** Slots the published display pins. */
  pinnedPages: number;
  failed: number;
  missing: number;
  uploads: number;
  uploadBytes: number;
  evictions: number;
  aborted: number;
  compressedBytes: number;
  limits: DetailLimit[];
  /** Additive managed-path diagnostics; legacy counts retain their meaning. */
  uploading?: number;
  quarantinedPages?: number;
  uploadRefusals?: number;
}

type EntryState = "queued" | "loading" | "staged" | "uploading" | "resident" | "failed";

interface Entry<TSignal extends NavigationAbortSignal> {
  request: ImageryRequest;
  state: EntryState;
  prepared: PreparedImage | null;
  slots: number[] | null;
  owned: OwnedImageryUploadJob | null;
  abort: NavigationAbortController<TSignal> | null;
  failures: number;
  retryAt: number;
  lastUsed: number;
  reservedBytes: number;
}

export interface ImageryResidencyOptions<TSignal extends NavigationAbortSignal = NavigationAbortSignal> {
  loader: ImageryLoader<TSignal>;
  store: ImageryPageStore;
  limits: ImageryResourceLimits;
  /** Endpoint cap from the source's request policy, when stricter than the profile. */
  maxConcurrentForSource?: (sourceKey: string) => number | undefined;
  now: () => number;
  createAbortController(): NavigationAbortController<TSignal>;
  /** Called when residency changes in a way the display or selection should see. */
  onChange?: () => void;
  onError?: (error: Error, url: string) => void;
}

export interface ImageryResidency {
  /** Replaces the demand: the images the current plan wants, in any order. */
  setDemand(requests: readonly ImageryRequest[]): void;
  /** Slots the published display references; never freed while pinned. */
  setPinned(slots: ReadonlySet<number>): void;
  /** Starts requests the limits admit. */
  pump(): void;
  /** Uploads staged images until the byte budget or deadline is used; returns bytes uploaded. */
  upload(deadline: number, clock?: () => number): number;
  slotsFor(imageKey: string): readonly number[] | null;
  isResident(imageKey: string): boolean;
  isMissing(imageKey: string): boolean;
  /** Changes whenever residency or missing records change. */
  getRevision(): number;
  /** Changes when a missing record is added or expires, which can change selection. */
  getMissingRevision(): number;
  /** True while demanded work is queued, loading, staged or waiting for a retry. */
  isBusy(): boolean;
  /** The earliest time a failed request may be retried or a missing record expires. */
  nextWakeAt(): number | null;
  stats(): ImageryResidencyStats;
  /** Frees every slot and cancels every request, e.g. after the GPU context was lost. */
  reset(): void;
  /** New admission limits; lower ones stop admitting work beyond them from the next pump. */
  setLimits(limits: ImageryResourceLimits): void;
  dispose(): void;
}

function decodedBytes(width: number, height: number): number {
  return width * height * 4;
}

function preparedBytes(image: PreparedImage): number {
  let total = 0;
  for (const page of image.pages) for (const level of page) total += level.byteLength;
  return total;
}

function managed(image: PreparedImage): boolean {
  return image.close !== undefined || image.retain !== undefined || image.isCurrent !== undefined;
}

function validateManaged(image: PreparedImage): void {
  if (managed(image) && (typeof image.close !== "function" || typeof image.retain !== "function" || typeof image.isCurrent !== "function")) throw new Error("Managed Atlas pages require close, retain and isCurrent together.");
}

function cleanupFailure(failures: unknown[]): unknown {
  return failures.length === 1 ? failures[0] : new AggregateError(failures, "Imagery operation and prepared-page cleanup failed.");
}

export function createImageryResidency<TSignal extends NavigationAbortSignal>(options: ImageryResidencyOptions<TSignal>): ImageryResidency {
  const now = options.now;
  let limits = options.limits;
  const entries = new Map<string, Entry<TSignal>>();
  const missing = new Map<string, number>();
  let demand = new Map<string, ImageryRequest>();
  let pinned: ReadonlySet<number> = new Set();
  let revision = 0;
  let missingRevision = 0;
  let missingWakeAt = Infinity;
  let tick = 0;
  let overflow = 0;
  let unplaced = 0;
  let disposed = false;
  let uploadRefusals = 0;
  type PendingUpload = {
    entry: Entry<TSignal>; request: ImageryRequest; image: RetainedPreparedImage; job: OwnedImageryUploadJob;
    outcome: TextureTransferOutcome | null; retirement: TextureTransferRetirement | null;
    failed: boolean; ownerClosed: boolean;
  };
  const pendingUploads = new Set<PendingUpload>();
  const counters = { uploads: 0, uploadBytes: 0, evictions: 0, aborted: 0, compressedBytes: 0 };

  const changed = (): void => {
    revision += 1;
    options.onChange?.();
  };

  function recordMissing(key: string): void {
    const until = now() + limits.missingRetryMs;
    missing.set(key, until);
    missingWakeAt = Math.min(missingWakeAt, until);
    missingRevision += 1;
  }

  function expireMissing(): void {
    const time = now();
    if (time < missingWakeAt) return;
    missingWakeAt = Infinity;
    let expired = false;
    for (const [key, until] of missing) {
      if (time >= until) {
        missing.delete(key);
        expired = true;
      } else missingWakeAt = Math.min(missingWakeAt, until);
    }
    if (expired) {
      missingRevision += 1;
      changed();
    }
  }

  const isMissing = (key: string): boolean => {
    const until = missing.get(key);
    if (until === undefined) return false;
    if (now() < until) return true;
    expireMissing();
    return false;
  };

  function freeSlots(entry: Entry<TSignal>): void {
    if (entry.owned) {
      const owned = entry.owned; entry.owned = null; entry.slots = null;
      owned.release(); return;
    }
    if (!entry.slots) return;
    const slots = entry.slots;
    entry.slots = null;
    const failures: unknown[] = [];
    for (const slot of slots) try { options.store.release(slot); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Imagery slot cleanup failed.");
  }

  function drop(key: string, entry: Entry<TSignal>): void {
    const abort = entry.abort, prepared = entry.prepared, owned = entry.owned; entry.abort = null; entry.prepared = null; entry.reservedBytes = 0;
    const pending = [...pendingUploads].find(value => value.entry === entry && value.job === owned);
    if (pending && prepared === pending.image) pending.ownerClosed = true;
    if (entries.get(key) === entry) entries.delete(key);
    const failures: unknown[] = [];
    if (abort) { counters.aborted += 1; try { abort.abort(); } catch (error) { failures.push(error); } }
    try { owned?.cancel(new Error("Atlas imagery entry retired.")); } catch (error) { failures.push(error); }
    try { prepared?.close?.(); } catch (error) { failures.push(error); }
    try { freeSlots(entry); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Imagery entry cleanup failed.");
  }

  function dropAll(): void {
    const retiring = [...entries]; entries.clear();
    const failures: unknown[] = [];
    for (const [key, entry] of retiring) try { drop(key, entry); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Imagery residency cleanup failed.");
  }

  function inFlight(): Entry<TSignal>[] {
    return [...entries.values()].filter(entry => entry.state === "loading");
  }

  function reservedBytes(): number {
    let total = 0;
    for (const entry of entries.values()) if (entry.state === "loading" || entry.state === "staged") total += entry.reservedBytes;
    for (const pending of pendingUploads) total += pending.job.bytes;
    return total;
  }

  function start(entry: Entry<TSignal>): void {
    const { request } = entry;
    const controller = options.createAbortController();
    entry.state = "loading";
    entry.abort = controller;
    entry.reservedBytes = decodedBytes(request.width, request.height) * 2;
    const reportDetached = (error: unknown): void => {
      // Late cleanup must never recreate a retired entry or strand other work.
      options.onError?.(error instanceof Error ? error : new Error(String(error)), request.url);
    };
    void options.loader.load(request.url, { width: request.width, height: request.height }, controller.signal, request.priority).then(image => {
      if (disposed || entries.get(request.imageKey) !== entry || controller.signal.aborted) {
        try { image.close?.(); } catch (error) { reportDetached(error); }
        return;
      }
      entry.abort = null;
      // Assign before validation so a rejected record is still retired by catch.
      entry.prepared = image;
      validateManaged(image);
      if (image.isCurrent && !image.isCurrent()) throw new Error("Stale prepared Atlas imagery.");
      if (image.compressedBytes) counters.compressedBytes += image.compressedBytes;
      if (image.width !== request.width || image.height !== request.height) {
        // A variant that is not the size it was declared is not that variant.
        entries.delete(request.imageKey);
        entry.prepared = null; entry.reservedBytes = 0;
        const failures: unknown[] = [];
        try { image.close?.(); } catch (error) { failures.push(error); }
        recordMissing(request.imageKey);
        failures.unshift(new Error(`Map image was ${image.width}×${image.height}, expected ${request.width}×${request.height}.`));
        try { options.onError?.(cleanupFailure(failures) as Error, request.url); } finally { changed(); }
        return;
      }
      if (!demand.has(request.imageKey)) {
        // Stale work is not kept outside the bounded cache.
        entries.delete(request.imageKey);
        entry.prepared = null; entry.reservedBytes = 0;
        const failures: unknown[] = [];
        try { image.close?.(); } catch (error) { failures.push(error); }
        // Its concurrency/staging reservation may have been the only thing
        // holding up the current view. Wake admission without invalidating
        // the display, whose pages did not change.
        try { if (failures.length) reportDetached(cleanupFailure(failures)); }
        finally { if (overflow > 0 || [...entries.values()].some(candidate => candidate.state === "queued")) options.onChange?.(); }
        return;
      }
      entry.state = "staged";
      entry.prepared = image;
      entry.reservedBytes = preparedBytes(image);
      changed();
    }).catch((error: unknown) => {
      if (disposed || entries.get(request.imageKey) !== entry) return;
      entry.abort = null;
      const prepared = entry.prepared; entry.prepared = null; entry.reservedBytes = 0;
      const failures: unknown[] = [error];
      try { prepared?.close?.(); } catch (cleanup) { failures.push(cleanup); }
      const reported = cleanupFailure(failures);
      if (controller.signal.aborted) {
        entries.delete(request.imageKey);
        return;
      }
      if (error instanceof ImageryMissingError && failures.length === 1) {
        entries.delete(request.imageKey);
        recordMissing(request.imageKey);
        changed();
        return;
      }
      // Rate limits, timeouts and network errors back off; they never mark a level missing.
      entry.state = "failed";
      entry.failures += 1;
      entry.retryAt = now() + retryDelayMs(entry.failures, limits.retryDelayMs);
      entry.reservedBytes = 0;
      try { options.onError?.(reported instanceof Error ? reported : new Error(String(reported)), request.url); }
      finally { changed(); }
    }).catch((error: unknown) => {
      // Supplied reporting/refresh callbacks are not allowed to leave an
      // unhandled detached promise. State and ownership were retired first.
      // If reporting itself throws there is no second safe host error channel.
      try { reportDetached(error); } catch { /* Already attempted the supplied error port. */ }
    });
  }

  const reportOwned = (error: unknown, url: string): void => {
    try { options.onError?.(error instanceof Error ? error : new Error(String(error)), url); }
    catch { /* The sole supplied error channel was attempted; no detached rejection. */ }
  };
  const wakeOwned = (): void => { if (!disposed) try { changed(); } catch (error) { reportOwned(error, "Atlas native completion"); } };
  const closeOwnedInput = (pending: PendingUpload, errors: unknown[]): void => {
    if (pending.ownerClosed) return;
    pending.ownerClosed = true;
    if (pending.entry.prepared === pending.image) { pending.entry.prepared = null; pending.entry.reservedBytes = 0; }
    try { pending.image.close(); } catch (error) { errors.push(error); }
  };
  const ownsEntry = (pending: PendingUpload): boolean => !disposed && entries.get(pending.request.imageKey) === pending.entry
    && pending.entry.owned === pending.job && pending.entry.request.sourceKey === pending.request.sourceKey;
  const failOwned = (pending: PendingUpload, error: unknown): void => {
    if (pending.failed) { reportOwned(error, pending.request.url); return; }
    pending.failed = true;
    const errors: unknown[] = [error];
    if (ownsEntry(pending)) {
      pending.entry.state = "failed"; pending.entry.failures += 1;
      pending.entry.retryAt = now() + retryDelayMs(pending.entry.failures, limits.retryDelayMs);
    }
    closeOwnedInput(pending, errors);
    try { pending.job.cancel(error); } catch (cleanup) { errors.push(cleanup); }
    try { pending.job.release(); } catch (cleanup) { errors.push(cleanup); }
    reportOwned(cleanupFailure(errors), pending.request.url); wakeOwned();
  };
  const finishOwned = (pending: PendingUpload): void => {
    if (!pending.outcome || !pending.retirement) return;
    pendingUploads.delete(pending);
    const errors: unknown[] = [];
    if (pending.retirement.cleanupError !== undefined) errors.push(pending.retirement.cleanupError);
    const demanded = demand.get(pending.request.imageKey);
    const publishable = !pending.failed && pending.outcome.status === "uploaded" && pending.retirement.status === "completed" && ownsEntry(pending)
      && demanded?.sourceKey === pending.request.sourceKey && pending.job.isCurrent() && pending.image.isCurrent();
    closeOwnedInput(pending, errors);
    if (!publishable || errors.length || !ownsEntry(pending) || !pending.job.isCurrent()) {
      if (!pending.failed && errors.length) failOwned(pending, cleanupFailure(errors));
      else if (!pending.failed && ownsEntry(pending) && demanded) failOwned(pending, new Error("Atlas native upload completed for a stale generation."));
      try { pending.job.release(); } catch (error) { reportOwned(error, pending.request.url); }
      if (pending.entry.owned === pending.job) { pending.entry.owned = null; pending.entry.slots = null; pending.entry.reservedBytes = 0; }
      if (errors.length && pending.failed) reportOwned(cleanupFailure(errors), pending.request.url);
      wakeOwned(); return;
    }
    pending.entry.slots = [...pending.job.slots]; pending.entry.prepared = null; pending.entry.reservedBytes = 0;
    pending.entry.state = "resident"; pending.entry.lastUsed = tick;
    counters.uploads += 1; counters.uploadBytes += pending.job.bytes;
    wakeOwned();
  };
  const beginOwned = (entry: Entry<TSignal>, image: RetainedPreparedImage, job: OwnedImageryUploadJob): void => {
    const pending: PendingUpload = { entry, request: { ...entry.request }, image, job, outcome: null, retirement: null, failed: false, ownerClosed: false };
    entry.owned = job; entry.state = "uploading"; pendingUploads.add(pending);
    // Both observers and ownership are registered before any native callback.
    void job.settled.then(outcome => {
      pending.outcome = outcome;
      if (outcome?.status === "failed") failOwned(pending, outcome.error);
      else if (outcome?.status === "device-lost") failOwned(pending, new Error("Atlas native device was lost."));
      else if (outcome?.status !== "uploaded") failOwned(pending, new Error("Atlas native outcome is malformed."));
      finishOwned(pending);
    }, error => { pending.outcome = { status: "failed", error }; failOwned(pending, error); finishOwned(pending); });
    void job.retired.then(retirement => {
      if (retirement?.status !== "completed" && retirement?.status !== "device-lost") { failOwned(pending, new Error("Atlas native retirement proof is malformed.")); return; }
      pending.retirement = retirement; finishOwned(pending);
    }, error => { failOwned(pending, error); /* Unknown native lifetime stays quarantined. */ });
    try { job.submit(); } catch (error) { failOwned(pending, error); }
  };

  /**
   * Frees one unpinned image for work of `priority`: undemanded images first,
   * oldest first, then demanded ones less important than the new work. Demanded
   * coverage and pinned slots are never freed.
   */
  function evictOne(priority: number): boolean {
    let best: Entry<TSignal> | null = null;
    let bestScore = Infinity;
    for (const entry of entries.values()) {
      if (entry.state !== "resident" || !entry.slots) continue;
      if (entry.slots.some(slot => pinned.has(slot))) continue;
      const demanded = demand.get(entry.request.imageKey);
      if (demanded && (demanded.coverage || demanded.priority >= priority)) continue;
      const score = demanded ? 1e12 + demanded.priority : entry.lastUsed;
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (!best) return false;
    freeSlots(best);
    entries.delete(best.request.imageKey);
    counters.evictions += 1;
    return true;
  }

  function allocate(count: number, priority: number): number[] | null {
    const slots: number[] = [];
    while (slots.length < count) {
      const slot = options.store.allocate();
      if (slot !== null) {
        slots.push(slot);
        continue;
      }
      if (!evictOne(priority)) {
        for (const allocated of slots) options.store.release(allocated);
        return null;
      }
    }
    return slots;
  }

  /** Queues the most important demand not yet loading or resident, within the queue bound. */
  function fillQueue(): void {
    const ordered = [...demand.values()]
      .filter(request => !isMissing(request.imageKey))
      .sort((a, b) => Number(b.coverage) - Number(a.coverage) || b.priority - a.priority || (a.imageKey < b.imageKey ? -1 : 1));
    let queued = 0;
    for (const entry of entries.values()) if (entry.state === "queued") queued += 1;
    overflow = 0;
    for (const request of ordered) {
      const entry = entries.get(request.imageKey);
      if (entry) {
        if (entry.state === "failed" && !entry.owned && now() >= entry.retryAt) {
          entry.state = "queued";
          queued += 1;
        }
        continue;
      }
      if (queued >= limits.queuedRequests && !request.coverage) {
        overflow += 1;
        continue;
      }
      entries.set(request.imageKey, {
        request, state: "queued", prepared: null, slots: null, owned: null, abort: null,
        failures: 0, retryAt: 0, lastUsed: tick, reservedBytes: 0,
      });
      queued += 1;
    }
  }

  return {
    setDemand(requests) {
      if (disposed) return;
      tick += 1;
      const next = new Map<string, ImageryRequest>();
      for (const request of requests) {
        const existing = next.get(request.imageKey);
        if (!existing || existing.priority < request.priority) next.set(request.imageKey, request);
      }
      demand = next;
      const sources = new Set([...next.values()].map(request => request.sourceKey));
      const retiring: [string, Entry<TSignal>][] = [];
      for (const [key, entry] of [...entries]) {
        const wanted = next.get(key);
        if (wanted) {
          entry.request = wanted;
          entry.lastUsed = tick;
          continue;
        }
        if (entry.state === "queued" || entry.state === "staged" || entry.state === "uploading" || entry.state === "failed") {
          retiring.push([key, entry]);
        } else if (entry.state === "loading" && !sources.has(entry.request.sourceKey)) {
          // A switched source makes its in-flight work obsolete; otherwise
          // let it finish rather than thrash while the camera moves.
          retiring.push([key, entry]);
        }
      }
      // Retire identities before supplied abort/close callbacks can reenter;
      // one failing disposer must not strand the rest of the obsolete demand.
      for (const [key, entry] of retiring) if (entries.get(key) === entry) entries.delete(key);
      const failures: unknown[] = [];
      for (const [key, entry] of retiring) try { drop(key, entry); } catch (error) { failures.push(error); }
      try { if (!disposed) fillQueue(); } catch (error) { failures.push(error); }
      if (failures.length) throw cleanupFailure(failures);
    },
    setPinned(slots) {
      pinned = new Set(slots);
    },
    pump() {
      if (disposed) return;
      // Missing images disappear from demand when selection falls back to
      // their parents. Expire those records too, so a still view can refine
      // again without waiting for camera movement or a reload.
      expireMissing();
      fillQueue();
      const loading = inFlight();
      let active = loading.length;
      const perSource = new Map<string, number>();
      for (const entry of loading) perSource.set(entry.request.sourceKey, (perSource.get(entry.request.sourceKey) ?? 0) + 1);
      let reserved = reservedBytes();
      const queued = [...entries.values()]
        .filter(entry => entry.state === "queued")
        .sort((a, b) => Number(b.request.coverage) - Number(a.request.coverage) || b.request.priority - a.request.priority || (a.request.imageKey < b.request.imageKey ? -1 : 1));
      for (const entry of queued) {
        if (active >= limits.concurrentRequests) break;
        const sourceCap = options.maxConcurrentForSource?.(entry.request.sourceKey);
        if (sourceCap !== undefined && (perSource.get(entry.request.sourceKey) ?? 0) >= sourceCap) continue;
        const need = decodedBytes(entry.request.width, entry.request.height) * 2;
        // Coverage may always start one request so the globe is never left bare.
        if (reserved + need > limits.stagingBytes && !(entry.request.coverage && active === 0)) break;
        start(entry);
        active += 1;
        reserved += need;
        perSource.set(entry.request.sourceKey, (perSource.get(entry.request.sourceKey) ?? 0) + 1);
      }
    },
    upload(deadline, clock = now) {
      if (disposed) return 0;
      unplaced = 0;
      let bytes = 0, legacyBytes = 0;
      const staged = [...entries.values()]
        .filter(entry => entry.state === "staged" && entry.prepared)
        .sort((a, b) => Number(b.request.coverage) - Number(a.request.coverage) || b.request.priority - a.request.priority);
      for (const entry of staged) {
        const image = entry.prepared!;
        if (managed(image)) {
          const failures: unknown[] = [];
          try {
            validateManaged(image);
            if (!image.isCurrent!()) throw new Error("Stale prepared Atlas imagery.");
            if (!options.store.prepareOwnedUpload) throw new ImageryOwnedUploadUnsupportedError();
            const cost = preparedBytes(image);
            if (bytes > 0 && (bytes + cost > limits.uploadBytesPerUpdate || clock() >= deadline)) break;
            while (options.store.freeSlots && options.store.freeSlots() < image.pages.length && evictOne(entry.request.coverage ? Infinity : entry.request.priority)) { /* Original unpinned safe eviction policy. */ }
            const job = options.store.prepareOwnedUpload(image as RetainedPreparedImage);
            if (!job) { uploadRefusals += 1; unplaced += 1; continue; }
            if (disposed || entries.get(entry.request.imageKey) !== entry || !image.isCurrent!() || !job.isCurrent()) {
              const errors: unknown[] = [];
              try { job.cancel(new Error("Atlas entry changed during native admission.")); } catch (error) { errors.push(error); }
              try { job.release(); } catch (error) { errors.push(error); }
              if (errors.length) throw cleanupFailure(errors);
              continue;
            }
            beginOwned(entry, image as RetainedPreparedImage, job); bytes += job.bytes;
            continue;
          } catch (error) { failures.push(error); }
          entry.prepared = null; entry.reservedBytes = 0;
          entry.state = "failed"; entry.failures += 1;
          entry.retryAt = now() + retryDelayMs(entry.failures, limits.retryDelayMs);
          try { image.close?.(); } catch (error) { failures.push(error); }
          const reported = cleanupFailure(failures);
          try { options.onError?.(reported instanceof Error ? reported : new Error(String(reported)), entry.request.url); }
          finally { changed(); }
          continue;
        }
        const cost = preparedBytes(image);
        if (bytes > 0 && (bytes + cost > limits.uploadBytesPerUpdate || clock() >= deadline)) break;
        const slots = allocate(image.pages.length, entry.request.coverage ? Infinity : entry.request.priority);
        if (!slots) {
          unplaced += 1;
          continue;
        }
        image.pages.forEach((levels, index) => options.store.upload(slots[index], levels));
        entry.slots = slots;
        entry.prepared = null;
        entry.reservedBytes = 0;
        entry.state = "resident";
        entry.lastUsed = tick;
        bytes += cost; legacyBytes += cost;
        counters.uploads += 1;
        counters.uploadBytes += cost;
      }
      if (legacyBytes > 0) changed();
      return bytes;
    },
    slotsFor(key) {
      const entry = entries.get(key);
      return entry?.state === "resident" ? entry.slots : null;
    },
    isResident: key => entries.get(key)?.state === "resident",
    isMissing,
    getRevision: () => revision,
    getMissingRevision: () => missingRevision,
    isBusy() {
      for (const [key, entry] of entries) if (entry.state !== "resident" && demand.has(key)) return true;
      return overflow > 0;
    },
    nextWakeAt() {
      let earliest = Infinity;
      for (const [key, entry] of entries) if (entry.state === "failed" && !entry.owned && demand.has(key)) earliest = Math.min(earliest, entry.retryAt);
      earliest = Math.min(earliest, missingWakeAt);
      return earliest === Infinity ? null : earliest;
    },
    stats() {
      // One pass over the entries, in their order: the update asks for these several times a frame.
      const count: Record<EntryState, number> = { queued: 0, loading: 0, staged: 0, uploading: 0, resident: 0, failed: 0 };
      let residentPages = 0, stagedBytes = 0, inFlightReservedBytes = 0, loadingDemanded = false;
      for (const entry of entries.values()) {
        count[entry.state] += 1;
        residentPages += entry.slots?.length ?? 0;
        if (entry.state === "staged") stagedBytes += entry.reservedBytes;
        else if (entry.state === "loading") inFlightReservedBytes += entry.reservedBytes;
        if (!loadingDemanded && entry.state !== "resident" && demand.has(entry.request.imageKey)) loadingDemanded = true;
      }
      const limits: DetailLimit[] = [];
      // Only a full atlas is a memory limit. A long queue is loading: what
      // it left out is queued as it drains.
      if (unplaced > 0) limits.push("memory");
      if (loadingDemanded || overflow > 0) limits.push("loading");
      return {
        resident: count.resident,
        residentPages,
        staged: count.staged,
        stagedBytes,
        inFlight: count.loading,
        inFlightReservedBytes,
        queued: count.queued,
        demanded: demand.size,
        overflow,
        unplaced,
        pinnedPages: pinned.size,
        failed: count.failed,
        missing: [...missing.keys()].filter(isMissing).length,
        ...counters,
        limits,
        uploading: count.uploading,
        quarantinedPages: [...pendingUploads].filter(pending => pending.failed || !ownsEntry(pending)).reduce((sum, pending) => sum + pending.job.slots.length, 0),
        uploadRefusals,
      };
    },
    setLimits(next) {
      limits = next;
    },
    reset() {
      const failures: unknown[] = [];
      try { dropAll(); } catch (error) { failures.push(error); }
      try { changed(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Imagery reset and notification failed.");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      missing.clear();
      dropAll();
    },
  };
}
