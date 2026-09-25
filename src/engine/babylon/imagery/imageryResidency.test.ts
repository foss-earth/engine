import { describe, expect, it, vi } from "vitest";
import {
  createImageryResidency,
  ImageryMissingError,
  type ImageryLoader,
  type ImageryPageStore,
  type ImageryRequest,
  type ImageryResourceLimits,
  type PreparedImage,
} from "./imageryResidency";

interface Pending {
  url: string;
  signal: AbortSignal;
  resolve(image: PreparedImage): void;
  reject(error: Error): void;
}

function harness(limits: Partial<ImageryResourceLimits> = {}, capacity = 8) {
  const pending: Pending[] = [];
  const loader: ImageryLoader = {
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
  const residency = createImageryResidency({
    loader, store,
    limits: { gpuBytes: 1e9, stagingBytes: 1e9, concurrentRequests: 8, queuedRequests: 100, uploadBytesPerUpdate: 1e9, cpuMsPerUpdate: 2, ...limits },
    now: () => time,
    missingTtlMs: 1000,
  });
  const image = (pages = 1, width = 256): PreparedImage => ({
    width, height: width, compressedBytes: 100,
    pages: Array.from({ length: pages }, () => [new Uint8Array(1000)]),
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { residency, loader, store, pending, uploads, free, image, flush, advance: (ms: number) => { time += ms; } };
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
    expect(residency.stats().limits).toContain("memory");
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
    expect(residency.stats()).toMatchObject({ staged: 1 });
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
