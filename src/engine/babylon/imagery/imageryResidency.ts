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

import type { DetailLimit } from "../../../terrain/mapDetailPolicy";

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
}

/** One image's pages, each as its slot at every sampled level. */
export interface PreparedImage {
  width: number;
  height: number;
  /** Row-major pages; each is its levels, largest first. */
  pages: Uint8Array[][];
  /** Response bytes when observable. */
  compressedBytes: number | null;
}

/** The source does not have this image: record it as missing, not failed. */
export class ImageryMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageryMissingError";
  }
}

export interface ImageryLoader {
  /** Fetches, decodes and splits one image into prepared pages. */
  load(url: string, expected: { width: number; height: number }, signal: AbortSignal): Promise<PreparedImage>;
}

/** The GPU side: slots in an atlas. */
export interface ImageryPageStore {
  readonly capacity: number;
  allocate(): number | null;
  release(slot: number): void;
  upload(slot: number, levels: readonly Uint8Array[]): void;
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
  /** Demanded images left out of the bounded queue. */
  overflow: number;
  failed: number;
  missing: number;
  uploads: number;
  uploadBytes: number;
  evictions: number;
  aborted: number;
  compressedBytes: number;
  limits: DetailLimit[];
}

type EntryState = "queued" | "loading" | "staged" | "resident" | "failed";

interface Entry {
  request: ImageryRequest;
  state: EntryState;
  prepared: PreparedImage | null;
  slots: number[] | null;
  abort: AbortController | null;
  failures: number;
  retryAt: number;
  lastUsed: number;
  reservedBytes: number;
}

export interface ImageryResidencyOptions {
  loader: ImageryLoader;
  store: ImageryPageStore;
  limits: ImageryResourceLimits;
  /** Endpoint cap from the source's request policy, when stricter than the profile. */
  maxConcurrentForSource?: (sourceKey: string) => number | undefined;
  now?: () => number;
  /** Called when residency changes in a way the display or selection should see. */
  onChange?: () => void;
  onError?: (error: Error, url: string) => void;
  /** How long a missing tile stays missing before it may be asked for again. */
  missingTtlMs?: number;
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
  /** Changes when a tile is newly recorded as missing, which can change selection. */
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

function retryDelayMs(failures: number): number {
  return Math.min(30_000, 2000 * 2 ** Math.max(0, failures - 1));
}

function decodedBytes(width: number, height: number): number {
  return width * height * 4;
}

function preparedBytes(image: PreparedImage): number {
  let total = 0;
  for (const page of image.pages) for (const level of page) total += level.byteLength;
  return total;
}

export function createImageryResidency(options: ImageryResidencyOptions): ImageryResidency {
  const now = options.now ?? (() => performance.now());
  let limits = options.limits;
  const missingTtlMs = options.missingTtlMs ?? 10 * 60_000;
  const entries = new Map<string, Entry>();
  const missing = new Map<string, number>();
  let demand = new Map<string, ImageryRequest>();
  let pinned: ReadonlySet<number> = new Set();
  let revision = 0;
  let missingRevision = 0;
  let tick = 0;
  let overflow = 0;
  let memoryLimited = false;
  let disposed = false;
  const counters = { uploads: 0, uploadBytes: 0, evictions: 0, aborted: 0, compressedBytes: 0 };

  const changed = (): void => {
    revision += 1;
    options.onChange?.();
  };

  const isMissing = (key: string): boolean => {
    const until = missing.get(key);
    if (until === undefined) return false;
    if (now() < until) return true;
    missing.delete(key);
    return false;
  };

  function freeSlots(entry: Entry): void {
    if (!entry.slots) return;
    for (const slot of entry.slots) options.store.release(slot);
    entry.slots = null;
  }

  function drop(key: string, entry: Entry): void {
    if (entry.abort) {
      entry.abort.abort();
      counters.aborted += 1;
    }
    freeSlots(entry);
    entries.delete(key);
  }

  function inFlight(): Entry[] {
    return [...entries.values()].filter(entry => entry.state === "loading");
  }

  function reservedBytes(): number {
    let total = 0;
    for (const entry of entries.values()) if (entry.state === "loading" || entry.state === "staged") total += entry.reservedBytes;
    return total;
  }

  function start(entry: Entry): void {
    const { request } = entry;
    const controller = new AbortController();
    entry.state = "loading";
    entry.abort = controller;
    entry.reservedBytes = decodedBytes(request.width, request.height) * 2;
    void options.loader.load(request.url, { width: request.width, height: request.height }, controller.signal).then(image => {
      if (disposed || entries.get(request.imageKey) !== entry || controller.signal.aborted) return;
      entry.abort = null;
      if (image.compressedBytes) counters.compressedBytes += image.compressedBytes;
      if (image.width !== request.width || image.height !== request.height) {
        // A variant that is not the size it was declared is not that variant.
        entries.delete(request.imageKey);
        missing.set(request.imageKey, now() + missingTtlMs);
        missingRevision += 1;
        options.onError?.(new Error(`Map image was ${image.width}×${image.height}, expected ${request.width}×${request.height}.`), request.url);
        changed();
        return;
      }
      if (!demand.has(request.imageKey)) {
        // Stale work is not kept outside the bounded cache.
        entries.delete(request.imageKey);
        return;
      }
      entry.state = "staged";
      entry.prepared = image;
      entry.reservedBytes = preparedBytes(image);
      changed();
    }).catch((error: unknown) => {
      if (disposed || entries.get(request.imageKey) !== entry) return;
      entry.abort = null;
      if (controller.signal.aborted) {
        entries.delete(request.imageKey);
        return;
      }
      if (error instanceof ImageryMissingError) {
        entries.delete(request.imageKey);
        missing.set(request.imageKey, now() + missingTtlMs);
        missingRevision += 1;
        changed();
        return;
      }
      // Rate limits, timeouts and network errors back off; they never mark a level missing.
      entry.state = "failed";
      entry.failures += 1;
      entry.retryAt = now() + retryDelayMs(entry.failures);
      entry.reservedBytes = 0;
      options.onError?.(error instanceof Error ? error : new Error(String(error)), request.url);
      changed();
    });
  }

  /**
   * Frees one unpinned image for work of `priority`: undemanded images first,
   * oldest first, then demanded ones less important than the new work. Demanded
   * coverage and pinned slots are never freed.
   */
  function evictOne(priority: number): boolean {
    let best: Entry | null = null;
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
        if (entry.state === "failed" && now() >= entry.retryAt) {
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
        request, state: "queued", prepared: null, slots: null, abort: null,
        failures: 0, retryAt: 0, lastUsed: tick, reservedBytes: 0,
      });
      queued += 1;
    }
  }

  return {
    setDemand(requests) {
      tick += 1;
      const next = new Map<string, ImageryRequest>();
      for (const request of requests) {
        const existing = next.get(request.imageKey);
        if (!existing || existing.priority < request.priority) next.set(request.imageKey, request);
      }
      demand = next;
      const sources = new Set([...next.values()].map(request => request.sourceKey));
      for (const [key, entry] of entries) {
        const wanted = next.get(key);
        if (wanted) {
          entry.request = wanted;
          entry.lastUsed = tick;
          continue;
        }
        if (entry.state === "queued" || entry.state === "staged" || entry.state === "failed") {
          drop(key, entry);
        } else if (entry.state === "loading" && !sources.has(entry.request.sourceKey)) {
          // A switched source makes its in-flight work obsolete; otherwise
          // let it finish rather than thrash while the camera moves.
          drop(key, entry);
        }
      }
      fillQueue();
    },
    setPinned(slots) {
      pinned = new Set(slots);
    },
    pump() {
      if (disposed) return;
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
      memoryLimited = false;
      let bytes = 0;
      const staged = [...entries.values()]
        .filter(entry => entry.state === "staged" && entry.prepared)
        .sort((a, b) => Number(b.request.coverage) - Number(a.request.coverage) || b.request.priority - a.request.priority);
      for (const entry of staged) {
        const image = entry.prepared!;
        const cost = preparedBytes(image);
        if (bytes > 0 && (bytes + cost > limits.uploadBytesPerUpdate || clock() >= deadline)) break;
        const slots = allocate(image.pages.length, entry.request.coverage ? Infinity : entry.request.priority);
        if (!slots) {
          memoryLimited = true;
          continue;
        }
        image.pages.forEach((levels, index) => options.store.upload(slots[index], levels));
        entry.slots = slots;
        entry.prepared = null;
        entry.reservedBytes = 0;
        entry.state = "resident";
        entry.lastUsed = tick;
        bytes += cost;
        counters.uploads += 1;
        counters.uploadBytes += cost;
      }
      if (bytes > 0) changed();
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
      for (const [key, entry] of entries) if (entry.state === "failed" && demand.has(key)) earliest = Math.min(earliest, entry.retryAt);
      return earliest === Infinity ? null : earliest;
    },
    stats() {
      const values = [...entries.values()];
      const count = (state: EntryState) => values.filter(entry => entry.state === state).length;
      const loadingDemanded = values.some(entry => entry.state !== "resident" && demand.has(entry.request.imageKey));
      const limits: DetailLimit[] = [];
      if (memoryLimited || overflow > 0) limits.push("memory");
      if (loadingDemanded) limits.push("loading");
      return {
        resident: count("resident"),
        residentPages: values.reduce((sum, entry) => sum + (entry.slots?.length ?? 0), 0),
        staged: count("staged"),
        stagedBytes: values.filter(entry => entry.state === "staged").reduce((sum, entry) => sum + entry.reservedBytes, 0),
        inFlight: count("loading"),
        inFlightReservedBytes: values.filter(entry => entry.state === "loading").reduce((sum, entry) => sum + entry.reservedBytes, 0),
        queued: count("queued"),
        demanded: demand.size,
        overflow,
        failed: count("failed"),
        missing: [...missing.keys()].filter(isMissing).length,
        ...counters,
        limits,
      };
    },
    setLimits(next) {
      limits = next;
    },
    reset() {
      for (const [key, entry] of entries) drop(key, entry);
      entries.clear();
      changed();
    },
    dispose() {
      disposed = true;
      for (const [key, entry] of entries) drop(key, entry);
      entries.clear();
      missing.clear();
    },
  };
}
