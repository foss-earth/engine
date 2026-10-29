import { describe, expect, it, vi } from "vitest";
import {
  createImageryResidency,
  ImageryMissingError,
  type ImageryLoader,
  type ImageryPageStore,
  type ImageryRequest,
  type ImageryResourceLimits,
  type PreparedImage,
} from "../src/terrain/imagery/imageryResidency.js";

interface Pending {
  url: string;
  signal: AbortSignal;
  resolve(image: PreparedImage): void;
  reject(error: Error): void;
}

function harness(limits: Partial<ImageryResourceLimits> = {}, capacity = 8) {
  const pending: Pending[] = [];
  const loader: ImageryLoader<AbortSignal> = {
    load: vi.fn((url, _expected, signal) => new Promise<PreparedImage>((resolve, reject) => pending.push({ url, signal, resolve, reject }))),
  };
  const free = Array.from({ length: capacity }, (_, index) => index);
  const uploads: number[] = [];
  const store: ImageryPageStore = {
    capacity,
    allocate: () => free.shift() ?? null,
    release: slot => { free.push(slot); free.sort((a, b) => a - b); },
    upload: slot => { uploads.push(slot); },
  };
  let time = 0;
  const onChange = vi.fn();
  const residency = createImageryResidency({ createAbortController: () => new AbortController(),
    loader, store,
    limits: { gpuBytes: 1e9, stagingBytes: 1e9, concurrentRequests: 8, queuedRequests: 100, uploadBytesPerUpdate: 1e9, cpuMsPerUpdate: 2,
      missingRetryMs: 1000, retryDelayMs: { min: 2000, max: 30_000 }, ...limits },
    now: () => time,
    onChange,
  });
  const image = (pages = 1, width = 256): PreparedImage => ({
    width, height: width, compressedBytes: 100,
    pages: Array.from({ length: pages }, () => [new Uint8Array(1000)]),
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { residency, loader, store, pending, uploads, free, image, flush, onChange, advance: (ms: number) => { time += ms; } };
}

const request = (key: string, priority = 1, extra: Partial<ImageryRequest> = {}): ImageryRequest => ({
  imageKey: key, url: `https://tiles/${key}`, width: 256, height: 256, priority, coverage: false, sourceKey: "s@1", ...extra,
});

describe("imagery residency", () => {
  it("deduplicates, and loads coverage then the most important demand first within the concurrency limit", () => {
    const { residency, pending } = harness({ concurrentRequests: 2 });
    residency.setDemand([request("a", 1), request("b", 5), request("b", 3), request("root", 0, { coverage: true })]);
    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/root", "https://tiles/b"]);
  });

  it("keeps the queue bounded and reports what it left out", () => {
    const { residency } = harness({ queuedRequests: 3, concurrentRequests: 1 });
    residency.setDemand(Array.from({ length: 10 }, (_, index) => request(`t${index}`, index)));
    expect(residency.stats()).toMatchObject({ queued: 3, overflow: 7 });
    // What the queue left out waits its turn: loading, not a lack of GPU memory.
    expect(residency.stats().limits).toContain("loading");
    expect(residency.stats().limits).not.toContain("memory");
  });

  it("queues demand left out earlier as soon as the queue has room", async () => {
    const { residency, pending, image, flush } = harness({ queuedRequests: 2, concurrentRequests: 2 });
    residency.setDemand(["a", "b", "c", "d"].map((key, index) => request(key, 10 - index)));
    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/a", "https://tiles/b"]);
    pending[0].resolve(image());
    pending[1].resolve(image());
    await flush();
    residency.upload(Infinity);
    // No new demand: pumping alone picks up what did not fit before.
    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/a", "https://tiles/b", "https://tiles/c", "https://tiles/d"]);
    expect(residency.stats().overflow).toBe(0);
  });

  it("orders a demand once, not again on every pump", () => {
    const { residency, pending } = harness();
    let reads = 0;
    const counted = (key: string, priority: number): ImageryRequest =>
      Object.defineProperty(request(key), "priority", { get: () => { reads += 1; return priority; }, enumerable: true });
    residency.setDemand(["a", "b", "c", "d"].map((key, index) => counted(key, index)));
    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/d", "https://tiles/c", "https://tiles/b", "https://tiles/a"]);
    // Everything demanded is loading: pumping again has nothing to order.
    reads = 0;
    for (let i = 0; i < 5; i++) residency.pump();
    expect(reads).toBe(0);
    // A new demand is ordered by its own priorities.
    residency.setDemand(["e", "f", "g"].map((key, index) => counted(key, index)));
    residency.pump();
    expect(pending.slice(4).map(item => item.url)).toEqual(["https://tiles/g", "https://tiles/f", "https://tiles/e"]);
  });

  it("does not start work the staging budget cannot hold", () => {
    const { residency, pending } = harness({ stagingBytes: 256 * 256 * 4 * 2 * 2 });
    residency.setDemand([request("a"), request("b"), request("c")]);
    residency.pump();
    expect(pending).toHaveLength(2);
  });

  it("uploads within the per-update byte budget, letting one larger image through", async () => {
    const { residency, pending, uploads, image, flush } = harness({ uploadBytesPerUpdate: 1500 });
    residency.setDemand([request("a", 2), request("b", 1)]);
    residency.pump();
    pending[0].resolve(image());
    pending[1].resolve(image());
    await flush();
    expect(residency.upload(Infinity)).toBe(1000);
    expect(uploads).toHaveLength(1);
    expect(residency.isResident("a")).toBe(true);
    expect(residency.upload(Infinity)).toBe(1000);
    expect(residency.isResident("b")).toBe(true);
    // A four-page variant alone exceeds the budget but still passes when nothing else has.
    residency.setDemand([request("a", 2), request("b", 1), request("v", 3, { width: 512, height: 512 })]);
    residency.pump();
    pending[2].resolve(image(4, 512));
    await flush();
    expect(residency.upload(Infinity)).toBe(4000);
    expect(residency.slotsFor("v")).toHaveLength(4);
  });

  it("never frees a pinned slot, evicts old undemanded images first, and reports the memory limit", async () => {
    const { residency, pending, image, flush } = harness({}, 2);
    residency.setDemand([request("a"), request("b")]);
    residency.pump();
    pending.forEach(item => item.resolve(image()));
    await flush();
    residency.upload(Infinity);
    const aSlot = residency.slotsFor("a")![0];
    residency.setPinned(new Set([aSlot]));
    residency.setDemand([request("c")]);
    residency.pump();
    pending[2].resolve(image());
    await flush();
    residency.upload(Infinity);
    expect(residency.isResident("a")).toBe(true);
    expect(residency.isResident("b")).toBe(false);
    expect(residency.isResident("c")).toBe(true);
    // With every slot pinned, new work waits staged instead of taking a pinned slot.
    residency.setPinned(new Set([0, 1]));
    residency.setDemand([request("d")]);
    residency.pump();
    pending[3].resolve(image());
    await flush();
    expect(residency.upload(Infinity)).toBe(0);
    expect(residency.stats()).toMatchObject({ staged: 1, unplaced: 1, pinnedPages: 2 });
    expect(residency.stats().limits).toContain("memory");
  });

  it("records missing tiles with an expiry instead of banning the level", async () => {
    const { residency, pending, flush, advance, loader } = harness();
    residency.setDemand([request("gone")]);
    residency.pump();
    pending[0].reject(new ImageryMissingError("404"));
    await flush();
    expect(residency.isMissing("gone")).toBe(true);
    residency.setDemand([request("gone")]);
    residency.pump();
    expect(loader.load).toHaveBeenCalledTimes(1);
    advance(1001);
    expect(residency.isMissing("gone")).toBe(false);
    residency.setDemand([request("gone")]);
    residency.pump();
    expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it("keeps bounded admission and coverage order across an empty, live, and expired missing set", async () => {
    const { residency, pending, image, flush, advance } = harness({ queuedRequests: 1, concurrentRequests: 2 });
    const wanted = [request("detail", 10), request("other", 5), request("root", 0, { coverage: true })];
    residency.setDemand(wanted);
    expect(residency.stats()).toMatchObject({ queued: 1, overflow: 2, missing: 0 });
    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/root"]);
    pending[0].resolve(image());
    await flush();
    residency.upload(Infinity);

    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/root", "https://tiles/detail"]);
    pending[1].reject(new ImageryMissingError("404"));
    await flush();
    residency.setDemand(wanted);
    expect(residency.stats()).toMatchObject({ queued: 1, overflow: 0, missing: 1 });
    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/root", "https://tiles/detail", "https://tiles/other"]);
    pending[2].resolve(image());
    await flush();
    residency.upload(Infinity);

    // Expiry removes the final missing record, and the same demand admits it again.
    advance(1000);
    residency.pump();
    expect(pending.map(item => item.url)).toEqual([
      "https://tiles/root", "https://tiles/detail", "https://tiles/other", "https://tiles/detail",
    ]);
    expect(residency.stats()).toMatchObject({ resident: 2, inFlight: 1, queued: 0, overflow: 0, missing: 0 });
    pending[3].resolve(image());
    await flush();
    residency.upload(Infinity);
    residency.pump();
    expect(pending).toHaveLength(4);
    expect(residency.stats()).toMatchObject({ resident: 3, inFlight: 0, queued: 0, overflow: 0, missing: 0 });
  });

  it("wakes selection when missing imagery expires even after the coarse plan stops demanding it", async () => {
    const { residency, pending, flush, advance, onChange } = harness();
    residency.setDemand([request("detail")]);
    residency.pump();
    pending[0].reject(new ImageryMissingError("404"));
    await flush();
    // A missing node makes the selector keep its parent; the missing image
    // is consequently absent from demand until availability changes.
    residency.setDemand([request("parent")]);
    const missingRevision = residency.getMissingRevision();
    expect(residency.nextWakeAt()).toBe(1000);
    advance(1000);
    onChange.mockClear();
    residency.pump();
    expect(residency.getMissingRevision()).toBeGreaterThan(missingRevision);
    expect(onChange).toHaveBeenCalledOnce();
    expect(residency.isMissing("detail")).toBe(false);
    expect(residency.nextWakeAt()).toBeNull();
  });

  it("invalidates missing availability when selection observes an expired record first", async () => {
    const { residency, pending, flush, advance } = harness();
    residency.setDemand([request("detail")]);
    residency.pump();
    pending[0].reject(new ImageryMissingError("404"));
    await flush();
    const missingRevision = residency.getMissingRevision();
    advance(1000);
    expect(residency.isMissing("detail")).toBe(false);
    expect(residency.getMissingRevision()).toBeGreaterThan(missingRevision);
  });

  it("backs off after failures without marking the tile missing", async () => {
    const { residency, pending, flush, advance, loader } = harness();
    residency.setDemand([request("flaky")]);
    residency.pump();
    pending[0].reject(new Error("429"));
    await flush();
    expect(residency.isMissing("flaky")).toBe(false);
    expect(residency.nextWakeAt()).toBe(2000);
    residency.setDemand([request("flaky")]);
    residency.pump();
    expect(loader.load).toHaveBeenCalledTimes(1);
    advance(2000);
    residency.setDemand([request("flaky")]);
    residency.pump();
    expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it("rejects an image of the wrong size as that variant", async () => {
    const { residency, pending, image, flush } = harness();
    residency.setDemand([request("v", 1, { width: 512, height: 512 })]);
    residency.pump();
    pending[0].resolve(image(1, 256));
    await flush();
    expect(residency.isMissing("v")).toBe(true);
    expect(residency.isResident("v")).toBe(false);
  });

  it("drops stale completions, and aborts in-flight work when the source changes", async () => {
    const { residency, pending, image, flush } = harness();
    residency.setDemand([request("a"), request("b")]);
    residency.pump();
    // Same source: in-flight work may finish, but it is not staged once undemanded.
    residency.setDemand([request("b")]);
    pending[0].resolve(image());
    await flush();
    expect(residency.stats().staged).toBe(0);
    // Another source: the old source's in-flight request is cancelled.
    residency.setDemand([request("x", 1, { sourceKey: "t@1" })]);
    expect(pending[1].signal.aborted).toBe(true);
  });

  it("wakes queued work after the last request from the old view completes", async () => {
    const { residency, pending, image, flush, onChange } = harness({ concurrentRequests: 1 });
    residency.setDemand([request("old-view")]);
    residency.pump();
    residency.setDemand([request("current-view")]);
    residency.pump();
    expect(pending).toHaveLength(1);
    onChange.mockClear();
    pending[0].resolve(image());
    await flush();
    expect(onChange).toHaveBeenCalledOnce();
    residency.pump();
    expect(pending.map(item => item.url)).toEqual(["https://tiles/old-view", "https://tiles/current-view"]);
    expect(residency.stats().staged).toBe(0);
  });

  it("disposal cancels requests and frees every slot", async () => {
    const { residency, pending, image, flush, free } = harness({}, 4);
    residency.setDemand([request("a"), request("b")]);
    residency.pump();
    pending[0].resolve(image());
    await flush();
    residency.upload(Infinity);
    residency.dispose();
    expect(pending[1].signal.aborted).toBe(true);
    expect(free).toEqual([0, 1, 2, 3]);
  });
});


describe("imagery residency disposal failures", () => {
  it("releases every occupied slot even when one supplied release throws and retires state before callbacks", async () => {
    const f = harness(), error = new Error("slot release failed"), release = f.store.release;
    f.residency.setDemand([request("a"), request("b")]); f.residency.pump();
    f.pending.forEach(job => job.resolve(f.image())); await f.flush(); f.residency.upload(Infinity);
    let first = true; const calls: number[] = [];
    f.store.release = slot => { calls.push(slot); release(slot); if (first) { first = false; expect(f.residency.stats().resident).toBe(0); throw error; } };
    expect(() => f.residency.dispose()).toThrow(error); expect(calls).toHaveLength(2); expect(f.free).toHaveLength(8); expect(f.residency.stats().resident).toBe(0);
    f.residency.dispose(); expect(calls).toHaveLength(2);
  });

  it("counts every state, page and reserved byte in its stats", async () => {
    const { residency, pending, image, flush } = harness({ concurrentRequests: 2 });
    residency.setDemand(["a", "b", "c", "d", "e"].map((key, index) => request(key, 5 - index)));
    residency.pump();
    pending[0].resolve(image());
    pending[1].reject(new Error("network"));
    await flush();
    residency.pump();
    residency.upload(Infinity);
    pending[2].resolve(image());
    pending[3].reject(new ImageryMissingError("absent"));
    await flush();
    expect(residency.stats()).toMatchObject({
      resident: 1, residentPages: 1, staged: 1, stagedBytes: 1000, inFlight: 0, inFlightReservedBytes: 0,
      queued: 1, demanded: 5, failed: 1, missing: 1, limits: ["loading"],
    });
    residency.pump();
    expect(residency.stats()).toMatchObject({ staged: 1, inFlight: 1, inFlightReservedBytes: 256 * 256 * 4 * 2, queued: 0 });
  });
});

describe("imagery residency stats cache", () => {
  it("returns equal snapshots until something changes, each in its own object", () => {
    const { residency } = harness({ queuedRequests: 2, concurrentRequests: 1 });
    residency.setDemand([request("a", 2), request("b", 1), request("c", 0)]);
    const first = residency.stats();
    const second = residency.stats();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.limits).not.toBe(first.limits);
    expect(first).toMatchObject({ queued: 2, overflow: 1, resident: 0, demanded: 3 });
    first.resident = 50;
    first.uploads = 50;
    first.limits.push("backend");
    const third = residency.stats();
    expect(third.resident).toBe(0);
    expect(third.uploads).toBe(0);
    expect(third.limits).not.toContain("backend");
    expect(third).toEqual(second);
    const pinned = residency.stats();
    residency.setPinned(new Set([4, 9]));
    expect(residency.stats().pinnedPages).toBe(2);
    expect(pinned.pinnedPages).toBe(0);
    expect(residency.stats()).toEqual(residency.stats());
  });

  it("shows an upload, an eviction, and an image left unplaced on the following stats call", async () => {
    const { residency, pending, image, flush, onChange } = harness({}, 1);
    residency.setDemand([request("a")]);
    residency.pump();
    pending[0].resolve(image());
    await flush();
    const beforeUpload = residency.stats();
    expect(beforeUpload).toMatchObject({ staged: 1, resident: 0, uploads: 0, evictions: 0, unplaced: 0 });
    expect(residency.stats()).toEqual(beforeUpload);
    let uploadedDuringNotify: { resident: number; staged: number; uploads: number } | null = null;
    onChange.mockImplementation(() => {
      const stats = residency.stats();
      uploadedDuringNotify = { resident: stats.resident, staged: stats.staged, uploads: stats.uploads };
    });
    residency.upload(Infinity);
    expect(uploadedDuringNotify).toEqual({ resident: 1, staged: 0, uploads: 1 });
    const uploaded = residency.stats();
    expect(uploaded).toMatchObject({ resident: 1, residentPages: 1, staged: 0, uploads: 1, evictions: 0 });
    expect(beforeUpload.resident).toBe(0);
    expect(beforeUpload.uploads).toBe(0);
    onChange.mockReset();
    residency.pump();
    expect(residency.upload(Infinity)).toBe(0);
    expect(residency.stats()).toEqual(uploaded);

    residency.setDemand([request("b")]);
    residency.pump();
    pending[1].resolve(image());
    await flush();
    const beforeEvict = residency.stats();
    expect(beforeEvict).toMatchObject({ resident: 1, staged: 1, evictions: 0 });
    residency.upload(Infinity);
    const afterEvict = residency.stats();
    expect(afterEvict.evictions).toBe(1);
    expect(afterEvict.resident).toBe(1);
    expect(residency.isResident("a")).toBe(false);
    expect(residency.isResident("b")).toBe(true);
    expect(beforeEvict.evictions).toBe(0);
    expect(residency.stats()).toEqual(afterEvict);

    const slot = residency.slotsFor("b")![0];
    residency.setPinned(new Set([slot]));
    residency.setDemand([request("b"), request("c")]);
    residency.pump();
    pending[2].resolve(image());
    await flush();
    const beforeUnplaced = residency.stats();
    expect(beforeUnplaced).toMatchObject({ unplaced: 0, staged: 1, resident: 1, evictions: 1 });
    expect(beforeUnplaced.limits).not.toContain("memory");
    expect(residency.upload(Infinity)).toBe(0);
    const unplaced = residency.stats();
    expect(unplaced).toMatchObject({ unplaced: 1, staged: 1, resident: 1, evictions: 1 });
    expect(unplaced.limits).toContain("memory");
    expect(beforeUnplaced.unplaced).toBe(0);
    expect(beforeUnplaced.limits).not.toContain("memory");
  });

  it("shows a newly missing image, and drops it after the record expires", async () => {
    const { residency, pending, flush, advance, onChange } = harness();
    residency.setDemand([request("gone")]);
    residency.pump();
    const before = residency.stats();
    expect(before.missing).toBe(0);
    expect(residency.stats()).toEqual(before);
    let missingDuringNotify: number | null = null;
    onChange.mockImplementation(() => { missingDuringNotify = residency.stats().missing; });
    pending[0].reject(new ImageryMissingError("404"));
    await flush();
    expect(missingDuringNotify).toBe(1);
    const missing = residency.stats();
    expect(missing.missing).toBe(1);
    expect(before.missing).toBe(0);
    expect(residency.stats()).toEqual(missing);
    onChange.mockReset();
    advance(1001);
    expect(residency.stats().missing).toBe(0);
    expect(missing.missing).toBe(1);
    expect(residency.isMissing("gone")).toBe(false);
    expect(residency.stats().missing).toBe(0);
  });

  it("shows a retried failure as in flight on the next stats call", async () => {
    const { residency, pending, flush, advance } = harness({ concurrentRequests: 1 });
    residency.setDemand([request("flaky")]);
    residency.pump();
    pending[0].reject(new Error("429"));
    await flush();
    const failed = residency.stats();
    expect(failed).toMatchObject({ failed: 1, inFlight: 0 });
    expect(residency.stats()).toEqual(failed);
    advance(2000);
    residency.pump();
    const retried = residency.stats();
    expect(retried.failed).toBe(0);
    expect(retried.inFlight).toBe(1);
    expect(failed.failed).toBe(1);
    expect(residency.stats()).toEqual(retried);
  });
});
