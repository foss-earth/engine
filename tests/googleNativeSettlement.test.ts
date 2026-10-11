import { Matrix, type Scene } from "@babylonjs/core";
import type { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import { describe, expect, it, vi } from "vitest";
import { createEngineSettings } from "../fixtures/composition/runtimeHost.js";
import { createGoogleTilesRuntime, type GoogleTilesRenderer, type GoogleTilesRuntimeOptions } from "../src/babylon/createTilesRuntime.js";
import { NativeMapStartupError } from "../src/babylon/nativeMapSettlement.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** Outer queue removal is deliberately independent of its actual native callback. */
function nativeQueue() {
  const cancel = new Set<() => void>();
  return { maxJobs: 1, currJobs: 0, items: [] as unknown[],
    add<T>(item: unknown, callback: (item: unknown) => T | Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const stop = () => reject(new Error("Outer queue cancelled")); cancel.add(stop);
        let inner: T | Promise<T>;
        try { inner = callback(item); } catch (error) { cancel.delete(stop); reject(error); return; }
        void Promise.resolve(inner).then(resolve, reject).finally(() => { cancel.delete(stop); });
      });
    },
    removeByFilter() { for (const stop of cancel) stop(); cancel.clear(); },
  };
}
function fixture() {
  const parser = deferred<void>(), root = deferred<void>(), response = deferred<Response>();
  const modelDisposed = vi.fn(), tile = { engineData: { scene: null } };
  let parserSignal: AbortSignal | undefined;
  const tiles = {
    fetchOptions: {}, errorTarget: 20, group: { getWorldMatrix: () => Matrix.Identity() },
    visibleTiles: new Set(), activeTiles: new Set(), stats: { queued: 0 },
    lruCache: { minSize: 0, maxSize: 0, minBytesSize: 0, maxBytesSize: 0, itemSet: new Set(), cachedBytes: 0 },
    downloadQueue: nativeQueue(), parseQueue: nativeQueue(), processNodeQueue: nativeQueue(),
    calculateTileViewError() {}, update() {}, registerPlugin: vi.fn(),
    addEventListener() {}, removeEventListener() {}, dispose: vi.fn(),
    async parseTile(_bytes: ArrayBuffer, _tile: typeof tile, _extension: string, _uri: string, signal: AbortSignal) {
      parserSignal = signal; await parser.promise;
      if (signal.aborted) modelDisposed();
    },
    async loadRootTileset() { await root.promise; return {}; },
  };
  const auth = { fetchData: vi.fn<(uri: string, options: RequestInit) => Promise<Response>>(() => response.promise) };
  const options: GoogleTilesRuntimeOptions = {
    scene: {} as Scene, apiKey: "fixture", settings: createEngineSettings(),
    createTilesRenderer: () => tiles as unknown as GoogleTilesRenderer,
    createAuthPlugin: () => auth as unknown as GoogleCloudAuthPlugin,
    createAbortController: () => new AbortController(), combineSignals: signals => AbortSignal.any([...signals]),
    whenMeshesReady: async () => {}, lighting: { followTerrainLight: () => false }, responseRealm: { Response, TransformStream },
    recordMapRequest() {}, resourceTiming: () => null, online: () => undefined, origin: () => undefined, log: { info() {}, error() {} },
  };
  return { parser, root, response, modelDisposed, tiles, tile, auth, options, get parserSignal() { return parserSignal; } };
}
describe("Google actual native task retirement", () => {
  it("waits a parser after its queue result was already cancelled, and never adopts the late model", async () => {
    const f = fixture(), runtime = createGoogleTilesRuntime(f.options);
    const queued = f.tiles.parseQueue.add(f.tile, () => f.tiles.parseTile(new ArrayBuffer(0), f.tile, "glb", "fixture.glb", new AbortController().signal));
    const outerFailure = expect(queued).rejects.toThrow("Outer queue cancelled");
    runtime.dispose(); await outerFailure; expect(f.parserSignal?.aborted).toBe(true);
    let finished = false; const proof = runtime.whenSettled().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false); expect(f.modelDisposed).not.toHaveBeenCalled();
    f.parser.resolve(); await proof; expect(f.modelDisposed).toHaveBeenCalledOnce(); expect(f.tiles.dispose).toHaveBeenCalledOnce();
  });
  it("keeps root-body and authenticated fetch work observable after cancellation", async () => {
    const f = fixture(), runtime = createGoogleTilesRuntime(f.options);
    const body = f.tiles.loadRootTileset(), fetch = f.auth.fetchData("https://fixture.invalid/root", {});
    runtime.dispose(); let finished = false; const proof = runtime.whenSettled().then(() => { finished = true; });
    f.root.resolve(); await body; await Promise.resolve(); expect(finished).toBe(false);
    f.response.resolve(new Response("{}")); await fetch; await proof; expect(finished).toBe(true);
  });
  it("returns a real partial-startup drain even when allocation cleanup fails", async () => {
    const f = fixture();
    f.tiles.registerPlugin.mockImplementation(() => {
      void f.tiles.parseQueue.add(f.tile, () => f.tiles.parseTile(new ArrayBuffer(0), f.tile, "glb", "partial.glb", new AbortController().signal)).catch(() => {});
      throw new Error("Plugin startup failed");
    });
    f.tiles.dispose.mockImplementation(() => { throw new Error("Tile cleanup failed"); });
    let failure: unknown; try { createGoogleTilesRuntime(f.options); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(NativeMapStartupError);
    let finished = false;
    const proof = (failure as NativeMapStartupError).whenSettled().finally(() => { finished = true; });
    const rejected = expect(proof).rejects.toThrow("cleanup"); await Promise.resolve(); expect(finished).toBe(false);
    f.parser.resolve(); await rejected; expect(f.modelDisposed).toHaveBeenCalledOnce();
  });
});
