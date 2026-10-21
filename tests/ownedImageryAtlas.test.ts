import { describe, expect, it, vi } from "vitest";
import { createImageryAtlas } from "../src/babylon/imagery/imageryAtlas.js";
import { createImageryResidency, type ImageryRequest } from "../src/terrain/imagery/imageryResidency.js";
import { prepareManagedPatchTable } from "../src/terrain/imagery/managedPatchTable.js";
import { buildPatchTable, samePatchTableCells } from "../src/terrain/imagery/imageryBinding.js";
import { pageUploadBytes } from "../src/terrain/imagery/imageryAtlasLayout.js";
import { ownedAtlasHost, flushOwnedAtlas } from "../fixtures/composition/ownedAtlasHost.js";
const request: ImageryRequest = { imageKey: "page", sourceKey: "source@1", width: 256, height: 256, url: "https://fixture.invalid/page", priority: 8, coverage: true };
const limits = { gpuBytes: 1e9, stagingBytes: 1e9, concurrentRequests: 1, queuedRequests: 8, uploadBytesPerUpdate: 1e9, cpuMsPerUpdate: 2, missingRetryMs: 1000, retryDelayMs: { min: 2000, max: 30000 } };

describe("actual Renderer whole-batch Atlas ownership", () => {
  it("reserves all pages and copies before native calls and publishes residency only after completion", async () => {
    const h = ownedAtlasHost(), image = h.image(), onError = vi.fn();
    const residency = createImageryResidency({ loader: { load: async () => image }, store: h.atlas, limits, now: () => 0, createAbortController: () => new AbortController(), onError });
    try {
      residency.setDemand([request]); residency.pump(); await flushOwnedAtlas();
      expect(residency.upload(Infinity)).toBe(pageUploadBytes()); expect(h.writes.map(write => write.lod)).toEqual([0,1,2,3,4]);
      expect(residency.stats()).toMatchObject({ resident: 0, uploading: 1, uploads: 0 }); expect(residency.slotsFor("page")).toBeNull();
      expect(h.broker.pools.stats().decoded.reserved).toBe(2 * pageUploadBytes()); expect(h.broker.pools.stats().uploadOutstanding.reserved).toBe(pageUploadBytes());
      h.native[0].resolve(); await flushOwnedAtlas();
      expect(residency.stats()).toMatchObject({ resident: 1, uploading: 0, uploads: 1, uploadBytes: pageUploadBytes() }); expect(residency.slotsFor("page")).toHaveLength(1);
      expect(h.broker.pools.stats().decoded.reserved).toBe(0); expect(h.broker.pools.stats().uploadOutstanding.reserved).toBe(0); expect(onError).not.toHaveBeenCalled();
    } finally { residency.dispose(); h.dispose(); }
  });
  it("admits two pages as one job with all ten existing mip regions", async () => {
    const h = ownedAtlasHost(), image = h.image(512), job = h.atlas.prepareOwnedUpload!(image)!;
    try {
      expect(job.slots).toHaveLength(2); expect(h.writes).toEqual([]); expect(h.broker.pools.stats().uploadOutstanding.reserved).toBe(2 * pageUploadBytes());
      job.submit(); image.close(); expect(h.writes.map(write => write.lod)).toEqual([0,1,2,3,4,0,1,2,3,4]);
      h.native[0].resolve(); expect((await job.settled).status).toBe("uploaded"); await job.retired; job.release(); expect(h.atlas.freeSlots()).toBe(h.layout.capacity);
    } finally { image.close(); job.release(); h.dispose(); }
  });
  for (const failureAt of [1,3,5]) it(`quarantines a partial native throw at mip call ${failureAt} until actual retirement`, async () => {
    const h = ownedAtlasHost(), image = h.image(), reason = new Error("partial mip failure"); h.onWrite(index => { if (index === failureAt) throw reason; });
    const job = h.atlas.prepareOwnedUpload!(image)!;
    try {
      job.submit(); expect(await job.settled).toEqual({ status: "failed", error: reason }); job.release(); image.close();
      expect(h.writes).toHaveLength(failureAt); expect(h.atlas.freeSlots()).toBe(h.layout.capacity - 1);
      expect(h.broker.pools.stats().decoded.reserved).toBe(2 * pageUploadBytes());
      h.native[0].resolve(); await job.retired; expect(h.atlas.freeSlots()).toBe(h.layout.capacity); expect(h.broker.pools.stats().decoded.reserved).toBe(0);
    } finally { job.release(); image.close(); h.dispose(); }
  });
  for (const end of ["reset", "source", "dispose"] as const) it(`${end} cannot publish or reuse an old native slot before proof`, async () => {
    const h = ownedAtlasHost(), image = h.image();
    const residency = createImageryResidency({ loader: { load: async () => image }, store: h.atlas, limits, now: () => 0, createAbortController: () => new AbortController() });
    try {
      residency.setDemand([request]); residency.pump(); await flushOwnedAtlas(); residency.upload(Infinity);
      if (end === "reset") { residency.reset(); h.atlas.clear(); } else if (end === "source") residency.setDemand([{ ...request, imageKey: "new", sourceKey: "source@2" }]); else { residency.dispose(); h.atlas.dispose(); }
      expect(h.atlas.freeSlots()).toBe(h.layout.capacity - 1); expect(h.broker.pools.stats().decoded.reserved).toBe(2 * pageUploadBytes());
      h.native[0].resolve(); await flushOwnedAtlas(); expect(residency.stats().resident).toBe(0); expect(h.broker.pools.stats().decoded.reserved).toBe(0);
      if (end !== "dispose") expect(h.atlas.freeSlots()).toBe(h.layout.capacity);
    } finally { residency.dispose(); h.dispose(); }
  });
  it("keeps slots, input and GPU quarantined after rejected completion until observed device loss", async () => {
    const h = ownedAtlasHost(), image = h.image(), job = h.atlas.prepareOwnedUpload!(image)!; job.submit(); image.close(); job.release();
    const reason = new Error("completion unknown"); h.native[0].reject(reason); expect(await job.settled).toEqual({ status: "failed", error: reason });
    h.atlas.dispose(); h.tracker.dispose(); await flushOwnedAtlas(); expect(h.disposals).toEqual([]); expect(h.broker.pools.stats().sourceGpu.reserved).toBe(Math.ceil(h.layout.estimatedBytes));
    expect(h.broker.pools.stats().decoded.reserved).toBe(2 * pageUploadBytes()); h.tracker.deviceLost(); await job.retired; await h.atlas.whenDisposed;
    expect(h.broker.pools.live()).toEqual([]); expect(h.disposals).toEqual(["imagery-atlas", "imagery-page-table"]); h.dispose();
  });
  it("refuses capacity before slot/native changes and keeps the prepared owner for a later host wake", async () => {
    const h = ownedAtlasHost(), image = h.image(), full = h.broker.pools.reserve("uploadOutstanding", 16 * 2 ** 20, "other submitted work"); expect(full.ok).toBe(true); if (!full.ok) throw new Error(full.reason);
    const wake = vi.fn(), stop = h.resources.subscribeAvailable(wake);
    try { expect(h.atlas.prepareOwnedUpload!(image)).toBeNull(); expect(h.atlas.freeSlots()).toBe(h.layout.capacity); expect(h.writes).toEqual([]); expect(image.isCurrent()).toBe(true);
      full.reservation.release(); await flushOwnedAtlas(); expect(wake).toHaveBeenCalledOnce(); const job = h.atlas.prepareOwnedUpload!(image)!; expect(job).not.toBeNull(); job.cancel(); job.release(); await job.retired;
    } finally { stop(); image.close(); full.reservation.release(); h.dispose(); }
  });
  it("rejects failed copy admission before native work and releases the whole provisional slot set", async () => {
    const h = ownedAtlasHost(), image = h.image(); h.onCopy(() => { throw new Error("copy reservation refused"); });
    try { expect(h.atlas.prepareOwnedUpload!(image)).toBeNull(); await flushOwnedAtlas(); expect(h.writes).toEqual([]); expect(h.atlas.freeSlots()).toBe(h.layout.capacity); expect(h.broker.pools.stats().decoded.reserved).toBe(pageUploadBytes()); }
    finally { image.close(); h.dispose(); }
  });
  it("requires actual completion capability and GPU admission before any native texture allocation", () => {
    const h = ownedAtlasHost(), create = vi.fn(h.device.createRawTexture);
    try { expect(() => createImageryAtlas({} as never, h.layout, 1, { ...h.device, createRawTexture: create, prepareRawTextureBatch: undefined }, { ...h.resources, overlap: false, requestRender() {}, onError() {} })).toThrow("whole-batch"); expect(create).not.toHaveBeenCalled();
      expect(() => createImageryAtlas({} as never, h.layout, 1, { ...h.device, createRawTexture: create }, { ...h.resources, reserveGpu: () => null, overlap: false, requestRender() {}, onError() {} })).toThrow("GPU admission"); expect(create).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });
  it("retains a fresh table block and candidate charge through failed native work without changing the outgoing table", async () => {
    const h = ownedAtlasHost(), display = { pages: new Map([["2/0/0", { slot: 0, z: 2 }]]), ancestors: new Set(["1/0/0", "0/0/0"]), slots: new Set([0]), fallbackLeaves: 0, slotImages: new Map([[0, "s/std/2/0/0"]]), ambiguousSlots: new Set<number>() };
    const candidate = prepareManagedPatchTable(display, { z: 2, x: 0, y: 0 }, { reserve: h.resources.reserveTable })!;
    const old = h.atlas.allocateBlock()!, incoming = h.atlas.allocateBlock()!, job = h.atlas.prepareOwnedTable!(incoming, candidate.data, () => candidate.retain())!;
    const reason = new Error("table copy failed"); h.onWrite(() => { throw reason; }); job.submit();
    expect(await job.settled).toEqual({ status: "failed", error: reason }); candidate.close(); job.release(); expect(h.atlas.prepareOwnedTable!.bind(null, old, new Uint8Array(4), () => () => {})).toThrow();
    expect(h.broker.pools.stats().decoded.reserved).toBe(2 * 16384); h.native[0].resolve(); await job.retired; expect(h.broker.pools.stats().decoded.reserved).toBe(0);
    h.atlas.releaseBlock(old); h.dispose();
  });
  it("builds a managed table aside under the same admission, and allocates it only when it differs from the bound one", () => {
    const display = (slot: number) => ({ pages: new Map([["2/0/0", { slot, z: 2 }], ["1/0/0", { slot: 1, z: 1 }]]), ancestors: new Set(["1/0/0", "0/0/0"]), slots: new Set([slot, 1]), fallbackLeaves: 0, slotImages: new Map([[slot, "s/std/2/0/0"]]), ambiguousSlots: new Set<number>() });
    const patch = { z: 1, x: 0, y: 0 }, labels: string[] = [];
    let live = 0, refuse = false;
    const ports = { reserve: (bytes: number, label: string) => { expect(bytes).toBe(16384); labels.push(label); if (refuse) return null; live += 1; return { release() { live -= 1; } }; } };
    const scratch = new Uint8Array(16384).fill(7), fresh = buildPatchTable(display(5), patch);
    const isBound = vi.fn((built: { cellsLog2: number; data: Uint8Array }) => bound !== null && samePatchTableCells(bound.data, built.data, built.cellsLog2));
    let bound: { cellsLog2: number; data: Uint8Array } | null = null;
    // Nothing bound: a held table of its own, equal to a new build, under one admission.
    const first = prepareManagedPatchTable(display(5), patch, ports, { scratch, isBound });
    if (!first || first.unchanged) throw new Error("expected a held table");
    expect(first.data).not.toBe(scratch); expect(Array.from(first.data)).toEqual(Array.from(fresh.data)); expect(first.cellsLog2).toBe(1); expect(live).toBe(1);
    bound = { cellsLog2: first.cellsLog2, data: first.data };
    // The same table again: unchanged, admitted and then released by its close, with no data.
    const again = prepareManagedPatchTable(display(5), patch, ports, { scratch, isBound });
    expect(again).toMatchObject({ unchanged: true, cellsLog2: 1, capped: false, emptyCells: 0 }); expect(again).not.toHaveProperty("data"); expect(live).toBe(2);
    again!.close(); again!.close(); expect(live).toBe(1);
    // A changed page: a new held table.
    const changed = prepareManagedPatchTable(display(6), patch, ports, { scratch, isBound });
    if (!changed || changed.unchanged) throw new Error("expected a held table");
    expect(Array.from(changed.data)).toEqual(Array.from(buildPatchTable(display(6), patch).data)); expect(live).toBe(2);
    // Admission comes first: a refusal builds and compares nothing.
    isBound.mockClear(); refuse = true;
    expect(prepareManagedPatchTable(display(5), patch, ports, { scratch, isBound })).toBeNull(); expect(isBound).not.toHaveBeenCalled(); refuse = false;
    // A throwing comparison releases its admission.
    expect(() => prepareManagedPatchTable(display(5), patch, ports, { scratch, isBound: () => { throw new Error("compare"); } })).toThrow("compare"); expect(live).toBe(2);
    expect(new Set(labels)).toEqual(new Set(["imagery patch 1/0/0 table"]));
    first.close(); changed.close(); expect(live).toBe(0);
  });
  it("attempts every Renderer release after a throwing input cleanup and never acknowledges it resident", async () => {
    const h = ownedAtlasHost(), image = h.image(), original = image.close; image.close = () => { original(); throw new Error("input cleanup"); };
    const errors = vi.fn(), residency = createImageryResidency({ loader: { load: async () => image }, store: h.atlas, limits, now: () => 0, createAbortController: () => new AbortController(), onError: errors });
    try { residency.setDemand([request]); residency.pump(); await flushOwnedAtlas(); residency.upload(Infinity); h.native[0].resolve(); await flushOwnedAtlas();
      expect(residency.stats()).toMatchObject({ resident: 0, failed: 1 }); expect(h.broker.pools.stats().decoded.reserved).toBe(0); expect(h.broker.pools.stats().uploadOutstanding.reserved).toBe(0); expect(h.atlas.freeSlots()).toBe(h.layout.capacity); expect(errors).toHaveBeenCalled();
    } finally { residency.dispose(); h.dispose(); }
  });
  it("attempts both native texture disposals but quarantines GPU storage when one cleanup throws", async () => {
    const h = ownedAtlasHost(), dispose = h.atlas.texture.dispose; h.atlas.texture.dispose = () => { throw new Error("native texture retirement unknown"); };
    try { expect(() => h.atlas.dispose()).toThrow("retirement unknown"); expect((await h.atlas.whenDisposed!).cleanupError).toBeInstanceOf(Error); expect(h.disposals).toEqual(["imagery-page-table"]); expect(h.broker.pools.stats().sourceGpu.reserved).toBe(Math.ceil(h.layout.estimatedBytes)); }
    finally { h.atlas.texture.dispose = dispose; dispose.call(h.atlas.texture); h.dispose(); }
  });
});
