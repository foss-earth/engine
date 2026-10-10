import { NullEngine, Scene, Texture, StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HeaderImageRequest } from "@foss-earth/images/browser";
import { createRasterTilesRuntime, type AsyncRasterMapTextures, type RasterTilesRuntimeOptions } from "../src/babylon/createRasterTilesRuntime.js";
import type { BoundedMapTextureRequest, LoadedMapTexture } from "../src/babylon/imagery/boundedMapTextureLoader.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import { createEngineSettings, testAtlasDevice } from "../fixtures/composition/runtimeHost.js";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
interface ReadyMap { handle: LoadedMapTexture; texture: Texture; events: string[]; dispose: Mock<() => void>; settleReplacement: Mock<() => void>; invalidate(): void }
interface PendingMap { file: HeaderImageRequest; request: BoundedMapTextureRequest; resolve(handle: LoadedMapTexture): void; reject(error: Error): void }
/** Only transport/ready handles are supplied doubles. All tile selection,
 * terrain fallback, generations, materials, publication and disposal are real. */
function fixture(change: Partial<RasterTilesRuntimeOptions> = {}) {
  const engine = new NullEngine(), scene = new Scene(engine), settings = createEngineSettings();
  const pending: PendingMap[] = [], timers = new Set<() => void>(); let now = 0;
  const terrainLoads = vi.fn(() => new Promise<never>(() => {})), terrainDispose = vi.fn();
  const legacy = vi.fn(() => { throw new Error("The async path must not invoke legacy updateURL."); });
  const resolve = vi.fn<AsyncRasterMapTextures["resolve"]>((_source, _tile, url) => ({ file: { url, mimeType: "image/png", width: 256, height: 256 }, declaredBytes: 65536, priority: 7 }));
  const acquire = vi.fn<AsyncRasterMapTextures["acquire"]>((file, request) => new Promise((resolve, reject) => pending.push({ file, request, resolve, reject })));
  const requestRender = vi.fn(), onLoadError = vi.fn(), warn = vi.fn();
  const source = { ...RASTER_BASE_MAP_SOURCES[0], protocol: "xyz" as const, urlTemplate: "https://fixture.invalid/original/{z}/{x}/{y}" };
  const runtime = createRasterTilesRuntime({ scene, settings, source, nowMs: () => now,
    after(callback) { timers.add(callback); return () => { timers.delete(callback); }; },
    asyncMapTextures: { resolve, acquire, createAbortController: () => new AbortController() },
    attachTerrainLighting: () => ({}) as ReturnType<RasterTilesRuntimeOptions["attachTerrainLighting"]>,
    createTerrainLoader: () => ({ dispose: terrainDispose, getMetrics: () => ({ active: 0, queued: 0, decodedBytes: 0 }),
      setPaused() {}, load: terrainLoads, loadPatch: terrainLoads }),
    imageryPorts: { device: testAtlasDevice(scene), capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
      loader: { load() { throw new Error("This fixture uses per-mesh imagery."); } }, createAbortController: () => new AbortController() },
    meshRebuildCpuMs: () => 2, anisotropy: () => 4, requestRender, onLoadError, log: { warn }, ...change,
  });
  const handles: ReadyMap[] = [];
  function ready(label: string, target = scene): ReadyMap {
    const texture = new Texture(null, target), events: string[] = []; let live = true;
    const dispose = vi.fn(() => { if (!live) return; live = false; events.push(`release:${label}`); texture.dispose(); });
    const settleReplacement = vi.fn(() => { events.push(`settle:${label}`); });
    const handle: LoadedMapTexture = { texture, uploaded: { texture, dispose, kind: "2d", width: 256, height: 256, levels: 9, gpuBytes: 349524, complete: true } as LoadedMapTexture["uploaded"],
      sourceGpuBytes: 349524, isCurrent: () => live, dispose, settleReplacement };
    const value = { handle, texture, events, dispose, settleReplacement, invalidate: () => { live = false; } }; handles.push(value); return value;
  }
  const nextSource = (id: string) => ({ ...source, id, urlTemplate: `https://fixture.invalid/${id}/{z}/{x}/{y}` });
  const materials = () => scene.meshes.filter(mesh => mesh.metadata?.mapSurface).map(mesh => mesh.material as StandardMaterial);
  const complete = async (jobs: PendingMap[], label: string) => { const held = jobs.map((job, index) => { const item = ready(`${label}-${index}`); job.resolve(item.handle); return item; }); await flush(); return held; };
  return { engine, scene, runtime, settings, pending, resolve, acquire, legacy, requestRender, onLoadError, warn, terrainLoads, terrainDispose, timers,
    ready, complete, nextSource, materials, setTime: (value: number) => { now = value; },
    disposeHost() { runtime.dispose(); scene.dispose(); engine.dispose(); } };
}
afterEach(() => vi.restoreAllMocks());

describe("retained async raster map composition", () => {
  it("uses actual host metadata and keeps outgoing imagery through readiness without elevation or surface churn", async () => {
    const f = fixture();
    try {
      f.runtime.update(); await flush(); expect(f.pending.length).toBeGreaterThan(0);
      const first = await f.complete([...f.pending], "first"); f.runtime.update();
      const old = f.materials().map(material => material.diffuseTexture), revision = f.runtime.getRevision(), terrainCalls = f.terrainLoads.mock.calls.length;
      const start = f.pending.length; f.runtime.setSource(f.nextSource("replacement")); await flush();
      const jobs = f.pending.slice(start); expect(jobs.length).toBeGreaterThan(0);
      expect(f.materials().map(material => material.diffuseTexture)).toEqual(old);
      expect(first.every(item => item.dispose.mock.calls.length === 0)).toBe(true);
      expect(jobs.every(job => job.request.overlap === true && job.request.priority === 7 && job.request.declaredBytes === 65536)).toBe(true);
      const incoming = jobs.map((job, index) => {
        const item = f.ready(`incoming-${index}`), outgoing = first[index];
        outgoing.dispose.mockImplementationOnce(() => { expect(f.materials().some(material => material.diffuseTexture === item.texture)).toBe(true); outgoing.texture.dispose(); outgoing.events.push("released before settle"); });
        item.settleReplacement.mockImplementationOnce(() => { expect(outgoing.dispose).toHaveBeenCalledOnce(); });
        job.resolve(item.handle); return item;
      });
      await flush(); f.runtime.update();
      expect(f.legacy).not.toHaveBeenCalled(); expect(f.terrainLoads).toHaveBeenCalledTimes(terrainCalls); expect(f.runtime.getRevision()).toBe(revision);
      expect(incoming.every(item => item.texture.wrapU === Texture.CLAMP_ADDRESSMODE && item.texture.wrapV === Texture.CLAMP_ADDRESSMODE && item.texture.anisotropicFilteringLevel === 4)).toBe(true);
      expect(incoming.every(item => item.settleReplacement.mock.calls.length === 1)).toBe(true);
      expect(f.resolve.mock.calls.every(([source, tile, url]) => url.includes(`/${tile.z}/${tile.x}/${tile.y}`) && source.urlTemplate.includes("{z}"))).toBe(true);
    } finally { f.disposeHost(); }
  });
  it("cancels pending replacements and closes late results before another source can publish", async () => {
    const f = fixture();
    try {
      f.runtime.update(); await flush(); const oldJobs = [...f.pending];
      f.runtime.setSource(f.nextSource("latest")); await flush(); const latest = f.pending.slice(oldJobs.length);
      expect(oldJobs.every(job => job.request.signal?.aborted)).toBe(true);
      const stale = await f.complete(oldJobs, "stale");
      expect(stale.every(item => item.dispose.mock.calls.length === 1 && item.settleReplacement.mock.calls.length === 0)).toBe(true);
      expect(f.materials().every(material => material.diffuseTexture === null)).toBe(true);
      const current = await f.complete(latest, "current"); f.runtime.update();
      expect(current.every(item => item.dispose.mock.calls.length === 0)).toBe(true);
      expect(f.runtime.getMetrics().visibleTiles).toBeGreaterThan(0);
    } finally { f.disposeHost(); }
  });
  it("cancels every pending map despite an earlier terrain disposer throwing and discards late readiness after disposal", async () => {
    const f = fixture(), failure = new Error("terrain cleanup failed");
    try {
      f.runtime.update(); await flush(); f.terrainDispose.mockImplementationOnce(() => { throw failure; });
      expect(() => f.runtime.dispose()).toThrow(failure);
      expect(f.pending.every(job => job.request.signal?.aborted)).toBe(true);
      expect(f.scene.meshes).toHaveLength(0); const requests = f.requestRender.mock.calls.length;
      const late = await f.complete([...f.pending], "late");
      expect(late.every(item => item.dispose.mock.calls.length === 1 && item.settleReplacement.mock.calls.length === 0)).toBe(true);
      expect(f.requestRender).toHaveBeenCalledTimes(requests); f.runtime.dispose(); expect(f.terrainDispose).toHaveBeenCalledOnce();
      expect(f.engine.isDisposed).toBe(false);
    } finally { f.disposeHost(); }
  });
  it.each(["stale", "foreign-scene"] as const)("rejects %s incoming handles while preserving visible outgoing content", async kind => {
    const f = fixture(), other = new Scene(f.engine);
    try {
      f.runtime.update(); await flush(); await f.complete([...f.pending], "old"); f.runtime.update();
      const old = f.materials().map(material => material.diffuseTexture), start = f.pending.length;
      f.runtime.setSource(f.nextSource(kind)); await flush();
      const incoming = f.pending.slice(start).map((job, index) => { const value = f.ready(`${kind}-${index}`, kind === "foreign-scene" ? other : f.scene);
        if (kind === "stale") value.handle.isCurrent = () => false; job.resolve(value.handle); return value; });
      await flush(); expect(f.materials().map(material => material.diffuseTexture)).toEqual(old);
      expect(incoming.every(value => value.dispose.mock.calls.length === 1 && value.settleReplacement.mock.calls.length === 0)).toBe(true);
      expect(f.onLoadError).toHaveBeenCalled();
    } finally { f.disposeHost(); other.dispose(); }
  });
  it("settles a synchronous metadata failure after insertion and retries through the existing host wake authority", async () => {
    const f = fixture();
    try {
      f.resolve.mockImplementationOnce(() => { throw new Error("Actual provider MIME unavailable."); });
      f.runtime.update(); await flush(); expect(f.onLoadError).toHaveBeenCalledWith(expect.objectContaining({ message: "Actual provider MIME unavailable." }), expect.any(String));
      const calls = f.resolve.mock.calls.length; f.setTime(60000); for (const callback of [...f.timers]) callback(); f.runtime.update(); await flush();
      expect(f.resolve.mock.calls.length).toBeGreaterThan(calls); expect(f.legacy).not.toHaveBeenCalled();
    } finally { f.disposeHost(); }
  });
  it("keeps incoming pixels after outgoing cleanup failure and conservatively retains overlap without skipping the render request", async () => {
    const f = fixture(), failure = new Error("outgoing cleanup failed");
    try {
      f.runtime.update(); await flush(); const first = await f.complete([...f.pending], "first"); f.runtime.update();
      const start = f.pending.length; f.runtime.setSource(f.nextSource("next")); await flush();
      first[0].dispose.mockImplementationOnce(() => { throw failure; }); const requests = f.requestRender.mock.calls.length;
      const next = await f.complete(f.pending.slice(start), "next");
      expect(f.materials().some(material => material.diffuseTexture === next[0].texture)).toBe(true);
      expect(next[0].dispose).not.toHaveBeenCalled(); expect(next[0].settleReplacement).not.toHaveBeenCalled();
      expect(f.onLoadError).toHaveBeenCalledWith(failure, expect.any(String)); expect(f.requestRender.mock.calls.length).toBeGreaterThan(requests);
      first[0].dispose();
    } finally { f.disposeHost(); }
  });
});
