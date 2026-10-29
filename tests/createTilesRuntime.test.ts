import { Matrix, Vector3, Viewport, type Scene } from "@babylonjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("3d-tiles-renderer/babylonjs", () => ({
  TilesRenderer: class {
    fetchOptions = {};
    errorTarget = 20;
    group = { getWorldMatrix: () => Matrix.Identity() };
    visibleTiles = new Set();
    activeTiles = new Set();
    lruCache = { minSize: 0, maxSize: 0, minBytesSize: 0, maxBytesSize: 0, itemSet: new Set(), cachedBytes: 0 };
    downloadQueue = { maxJobs: 0, currJobs: 0, items: [] as unknown[] };
    parseQueue = { maxJobs: 0, currJobs: 0, items: [] as unknown[] };
    processNodeQueue = { maxJobs: 25, currJobs: 0, items: [] as unknown[] };
    stats = { queued: 0 };
    listeners = new Map<string, Set<(event: unknown) => void>>();
    registerPlugin() {}
    calculateTileViewError(tile: { nativeInView?: boolean; nativeError?: number }, target: { inView: boolean; error: number; distanceFromCamera: number }) {
      target.inView = tile?.nativeInView ?? false;
      target.error = tile?.nativeError ?? 1;
      target.distanceFromCamera = 999;
    }
    update() {}
    async parseTile() {}
    dispose() {}
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }
    removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(event: { type: string }) { this.listeners.get(event.type)?.forEach(listener => listener(event)); }
  },
}));
vi.mock("3d-tiles-renderer/core/plugins", () => ({
  GoogleCloudAuthPlugin: class { fetchData = vi.fn(); },
}));

import { createGoogleTilesRuntime as createCoreGoogle, type GoogleTilesRuntimeOptions } from "../src/babylon/createTilesRuntime.js";
import { TilesRenderer } from "3d-tiles-renderer/babylonjs";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import { whenMeshesReady } from "@foss-earth/renderer/babylon";
import { createEngineSettings } from "../fixtures/composition/runtimeHost.js";
let settings = createEngineSettings();
beforeEach(() => { settings = createEngineSettings(); });
function createGoogleTilesRuntime(options: Partial<GoogleTilesRuntimeOptions> & Pick<GoogleTilesRuntimeOptions, "scene" | "apiKey">) {
  return createCoreGoogle({
    settings, createTilesRenderer: (url, scene) => new TilesRenderer(url, scene),
    createAuthPlugin: options => new GoogleCloudAuthPlugin(options), createAbortController: () => new AbortController(),
    combineSignals: signals => AbortSignal.any([...signals]),
    whenMeshesReady: (meshes, options) => whenMeshesReady(meshes, { ...options, timers: { setTimeout, clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) } }),
    lighting: { followTerrainLight: () => false }, responseRealm: { Response, TransformStream },
    recordMapRequest: () => {}, resourceTiming: () => null, online: () => undefined, origin: () => undefined,
    log: { info: () => {}, error: () => {} }, ...options,
  });
}

describe("Google drawable tile publication", () => {
  const setup = () => {
    const ready = [false, false];
    const meshes = ready.map((_value, index) => ({ isDisposed: () => false, isReady: () => ready[index], subMeshes: [] }));
    const model = { getChildMeshes: () => meshes, setEnabled: vi.fn() };
    const tile = { engineData: { scene: model } };
    const runtime = createGoogleTilesRuntime({ scene: {} as Scene, apiKey: "test" });
    const renderer = runtime.tiles as unknown as {
      parseTile(buffer: ArrayBuffer, parsedTile: typeof tile, extension: string, uri: string, signal: AbortSignal): Promise<void>;
    };
    return { runtime, renderer, tile, model, ready: (index: number) => { ready[index] = true; } };
  };

  it("reuses cached models after a reload, revalidates the root, and renews an expired session from the network", async () => {
    const fetchData = vi.fn<(uri: string, init: RequestInit) => Promise<Response>>(async () => new Response("{}"));
    const refreshToken = vi.fn<(init: RequestInit) => Promise<unknown>>(async () => ({}));
    const plugin = { fetchData, auth: { refreshToken } };
    const runtime = createGoogleTilesRuntime({ scene: {} as Scene, apiKey: "test", createAuthPlugin: () => plugin as unknown as GoogleCloudAuthPlugin });
    try {
      expect(runtime.tiles.optimizedLoadStrategy).toBe(true);
      const options = runtime.tiles.fetchOptions;
      expect(options.cache).toBe("force-cache");
      await plugin.fetchData("https://tile.googleapis.com/v1/3dtiles/root.json", options);
      await plugin.fetchData("https://tile.googleapis.com/v1/3dtiles/datasets/a/files/b.glb?session=s", options);
      expect(fetchData.mock.calls.map(([, init]) => init.cache)).toEqual(["no-cache", "force-cache"]);
      await plugin.auth.refreshToken(options);
      expect(refreshToken).toHaveBeenCalledWith(expect.objectContaining({ cache: "reload", mode: "cors" }));
      expect(options.cache).toBe("force-cache");
    } finally { runtime.dispose(); }
  });

  it("keeps parsing pending until hidden tile meshes can draw, so traversal retains the previous LOD", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    try {
      const done = vi.fn();
      const parsing = fixture.renderer.parseTile(new ArrayBuffer(0), fixture.tile, "glb", "test.glb", new AbortController().signal).then(done);
      await vi.advanceTimersByTimeAsync(0);
      expect(done).not.toHaveBeenCalled();
      fixture.ready(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(done).not.toHaveBeenCalled();
      fixture.ready(1);
      await vi.advanceTimersByTimeAsync(300);
      await parsing;
      expect(done).toHaveBeenCalledOnce();
      expect(fixture.model.setEnabled).not.toHaveBeenCalledWith(true);
    } finally {
      fixture.runtime.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["eviction", "runtime disposal"])("cancels a pending drawable wait on %s", async (cause) => {
    vi.useFakeTimers();
    const fixture = setup();
    const abort = new AbortController();
    try {
      const parsing = fixture.renderer.parseTile(new ArrayBuffer(0), fixture.tile, "glb", "test.glb", abort.signal).catch(error => error);
      await vi.advanceTimersByTimeAsync(0);
      if (cause === "eviction") abort.abort();
      else fixture.runtime.dispose();
      expect(await parsing).toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.runtime.dispose();
      vi.useRealTimers();
    }
  });
});

describe("Google loading budgets", () => {
  it("sizes the renderer's cache and queues from map.google.*, and follows changes", async () => {
    const currentSettings = settings;
    const scene = { activeCamera: null, getEngine: () => ({}) } as unknown as Scene;
    const runtime = createGoogleTilesRuntime({ scene, apiKey: "test" });
    const tiles = runtime.tiles as unknown as {
      lruCache: { minSize: number; maxSize: number; minBytesSize: number; maxBytesSize: number };
      downloadQueue: { maxJobs: number };
      parseQueue: { maxJobs: number };
    };
    expect(tiles.lruCache).toMatchObject({ minSize: 6000, maxSize: 8000, minBytesSize: 0.3 * 2 ** 30, maxBytesSize: 0.4 * 2 ** 30 });
    expect(tiles.downloadQueue.maxJobs).toBe(25);
    expect(tiles.parseQueue.maxJobs).toBe(5);
    currentSettings.set("map.google.cacheBytes", { min: 64, max: 128 });
    currentSettings.set("map.google.downloads", 4);
    expect(tiles.lruCache).toMatchObject({ minBytesSize: 64 * 2 ** 20, maxBytesSize: 128 * 2 ** 20 });
    expect(tiles.downloadQueue.maxJobs).toBe(4);
    runtime.dispose();
    currentSettings.set("map.google.downloads", 9);
    expect(tiles.downloadQueue.maxJobs).toBe(4);
  });
});

describe("Google terrain detail anchors", () => {
  it("keeps the active-camera frustum while measuring detail from the supplied anchor", () => {
    const anchor = new Vector3(12, 0, 0);
    const scene = {
      activeCamera: { viewport: new Viewport(0, 0, 1, 1), getProjectionMatrix: () => Matrix.Identity() },
      getEngine: () => ({
        getHardwareScalingLevel: () => 1,
        getRenderWidth: () => 100,
        getRenderHeight: () => 100,
      }),
    } as Scene;
    const runtime = createGoogleTilesRuntime({ scene, apiKey: "test", getTerrainDetailAnchor: () => anchor });
    const renderer = runtime.tiles as unknown as {
      calculateTileViewError(
        tile: { geometricError: number; engineData: { boundingVolume: { distanceToPoint(point: Vector3): number } } },
        target: { inView: boolean; error: number; distanceFromCamera: number },
      ): void;
    };
    const target = { inView: true, error: 0, distanceFromCamera: 0 };

    runtime.update();
    renderer.calculateTileViewError({
      geometricError: 2,
      engineData: { boundingVolume: { distanceToPoint: (point) => point.x } },
    }, target);

    expect(target.inView).toBe(false);
    expect(target.distanceFromCamera).toBe(12);
    expect(target.error).toBe(100);
  });

  it("reports loaded camera detail independently of a focus anchor's requested refinement", () => {
    const onDetailFeedback = vi.fn();
    const scene = {
      activeCamera: { viewport: new Viewport(0, 0, 1, 1), getProjectionMatrix: () => Matrix.Identity() },
      getEngine: () => ({ getHardwareScalingLevel: () => 1, getRenderWidth: () => 100, getRenderHeight: () => 100 }),
    } as Scene;
    const runtime = createGoogleTilesRuntime({ scene, apiKey: "test", onDetailFeedback, getTerrainDetailAnchor: () => new Vector3(12, 0, 0) });
    const tile = { geometricError: 2, engineData: { boundingVolume: { distanceToPoint: () => 12 } } };
    const renderer = runtime.tiles as unknown as {
      calculateTileViewError(measuredTile: typeof tile, target: { inView: boolean; error: number; distanceFromCamera: number }): void;
    };
    runtime.tiles.visibleTiles.add(tile as never);
    runtime.update();
    const target = { inView: false, error: 0, distanceFromCamera: 0 };
    renderer.calculateTileViewError(tile, target);
    // The native measurement is camera-invisible in this mock. Anchor-only
    // selection must not invent delivered camera coverage. The first update
    // only records that nothing drawable is in the camera view.
    runtime.update();
    expect(runtime.getTerrainDetailState().loadedErrorTarget).toBeNull();
    expect(runtime.getTerrainDetailState().loadedDistribution.status).toBe("empty");
    expect(target.error).toBe(100);
    expect(onDetailFeedback).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("counts each drawable in-view tile, including when the maximum error stays the same", () => {
    const onDetailFeedback = vi.fn();
    const scene = { activeCamera: null, getEngine: () => ({}) } as unknown as Scene;
    const runtime = createGoogleTilesRuntime({ scene, apiKey: "test", onDetailFeedback });
    const renderer = runtime.tiles as unknown as {
      calculateTileViewError(tile: object, target: { inView: boolean; error: number; distanceFromCamera: number }): void;
    };
    const measure = (nativeError: number, extra: object = {}) => {
      const tile = { nativeInView: true, nativeError, geometricError: 2, engineData: { boundingVolume: { distanceToPoint: () => 1 } }, ...extra };
      runtime.tiles.visibleTiles.add(tile as never);
      renderer.calculateTileViewError(tile, { inView: false, error: 0, distanceFromCamera: 0 });
      return tile;
    };
    const parent = measure(8);
    const child = measure(4);
    runtime.update();
    const first = runtime.getTerrainDetailState();
    expect(first.loadedErrorTarget).toBe(8);
    expect(first.loadedDistribution).toMatchObject({
      status: "measured", sourceKey: "google", tileCount: 2,
      samples: [{ value: 4, count: 1 }, { value: 8, count: 1 }],
    });
    onDetailFeedback.mockClear();
    runtime.tiles.visibleTiles.delete(child as never);
    runtime.update();
    expect(runtime.getTerrainDetailState().loadedErrorTarget).toBe(8);
    expect(runtime.getTerrainDetailState().loadedDistribution.samples).toEqual([{ value: 8, count: 1 }]);
    expect(runtime.getTerrainDetailState().loadedDistribution.revision).not.toBe(first.loadedDistribution.revision);
    expect(onDetailFeedback).toHaveBeenCalledTimes(1);
    expect(runtime.tiles.visibleTiles.has(parent as never)).toBe(true);
    runtime.dispose();
  });

  it("keeps raw zero, subpixel and infinite camera errors, and skips unfinished or focus-only tiles", () => {
    const scene = {
      activeCamera: { viewport: new Viewport(0, 0, 1, 1), getProjectionMatrix: () => Matrix.Identity(), globalPosition: new Vector3(0, 0, 0) },
      getEngine: () => ({ getHardwareScalingLevel: () => 1, getRenderWidth: () => 100, getRenderHeight: () => 100 }),
    } as Scene;
    const runtime = createGoogleTilesRuntime({
      scene, apiKey: "test",
      getFocus: () => ({ mode: "around", position: new Vector3(0, 0, 0), radiusMeters: 1_000_000, finestErrorPx: null, horizonCull: false }),
    });
    const renderer = runtime.tiles as unknown as {
      calculateTileViewError(tile: object, target: { inView: boolean; error: number; distanceFromCamera: number }): void;
    };
    const measure = (fields: object) => {
      const tile = { geometricError: 2, engineData: { boundingVolume: { distanceToPoint: () => 1 } }, ...fields };
      runtime.tiles.visibleTiles.add(tile as never);
      const target = { inView: false, error: 0, distanceFromCamera: 0 };
      renderer.calculateTileViewError(tile, target);
      return target;
    };
    runtime.update();
    measure({ nativeInView: true, nativeError: 0 });
    measure({ nativeInView: true, nativeError: 0.25 });
    measure({ nativeInView: true, nativeError: Infinity });
    measure({ nativeInView: true, nativeError: Number.NaN });
    measure({ nativeInView: true, nativeError: 64, internal: { loadingState: 2, hasRenderableContent: true } });
    const focusOnly = measure({ nativeInView: false, nativeError: 2 });
    runtime.update();
    const distribution = runtime.getTerrainDetailState().loadedDistribution;
    expect(focusOnly.inView).toBe(true);
    expect(runtime.getTerrainDetailState().loadedErrorTarget).toBe(Infinity);
    expect(distribution.samples.map(sample => sample.value).sort((a, b) => a - b)).toEqual([0, 0.25, Infinity]);
    expect(distribution.unknownCount).toBe(1);
    expect(distribution.tileCount).toBe(4);
    expect(distribution.samples.some(sample => sample.value === 64 || sample.value === 2)).toBe(false);
    runtime.dispose();
  });
});

describe("Google coarse stand-ins", () => {
  // Over the campus while it loads: a tile thousands of kilometres across contains the eye.
  const setup = () => {
    const camera = { globalPosition: new Vector3(6378137 + 300, 0, 0), viewport: new Viewport(0, 0, 1, 1), getProjectionMatrix: () => Matrix.Identity() };
    const scene = {
      activeCamera: camera,
      getEngine: () => ({ getHardwareScalingLevel: () => 1, getRenderWidth: () => 100, getRenderHeight: () => 100 }),
    } as unknown as Scene;
    const onSurfaceChange = vi.fn();
    const runtime = createGoogleTilesRuntime({ scene, apiKey: "test", onSurfaceChange });
    const tile = (geometricError: number, distance: number, children = 4) => ({ geometricError, children: Array.from({ length: children }, () => ({})),
      engineData: { scene: { setEnabled: vi.fn() }, boundingVolume: { distanceToPoint: () => distance } } });
    const standIn = tile(262979, 0);
    // A nearer stand-in at the ground's own scale, a leaf and a tile far beyond the horizon all stay.
    const others = [tile(2054, 0), tile(262979, 0, 0), tile(131489, 5e6)];
    for (const t of [standIn, ...others]) runtime.tiles.visibleTiles.add(t as never);
    return { camera, runtime, standIn, others, onSurfaceChange };
  };

  it("hides a stand-in whose error exceeds its distance and 16 times the eye's height, and shows it again", () => {
    const { camera, runtime, standIn, others, onSurfaceChange } = setup();
    runtime.update();
    expect(standIn.engineData.scene.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    for (const other of others) expect(other.engineData.scene.setEnabled).not.toHaveBeenCalled();
    // What the ground is changed: queries read the surface again.
    const revision = runtime.getRevision();
    expect(revision).toBeGreaterThan(0);
    expect(onSurfaceChange).toHaveBeenCalledWith("geometry");
    runtime.update();
    expect(runtime.getRevision()).toBe(revision);
    expect(standIn.engineData.scene.setEnabled).toHaveBeenCalledOnce();
    // From 20 km up, the same tile is coarse at the eye's scale only by its own measure.
    camera.globalPosition = new Vector3(6378137 + 20000, 0, 0);
    runtime.update();
    expect(standIn.engineData.scene.setEnabled).toHaveBeenLastCalledWith(true);
    expect(runtime.getRevision()).toBeGreaterThan(revision);
    camera.globalPosition = new Vector3(6378137 + 300, 0, 0);
    runtime.update();
    expect(standIn.engineData.scene.setEnabled).toHaveBeenLastCalledWith(false);
    settings.set("map.terrain.hideCoarseStandIns", false);
    runtime.update();
    expect(standIn.engineData.scene.setEnabled).toHaveBeenLastCalledWith(true);
    expect(standIn.engineData.scene.setEnabled).toHaveBeenCalledTimes(4);
    runtime.dispose();
  });

  it("leaves a stand-in the renderer has hidden itself for the renderer to show", () => {
    const { runtime, standIn } = setup();
    runtime.update();
    expect(standIn.engineData.scene.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    // Its finer tiles are ready: the renderer hides it, and later may show it again.
    runtime.tiles.visibleTiles.delete(standIn as never);
    runtime.update();
    expect(standIn.engineData.scene.setEnabled).toHaveBeenCalledOnce();
    runtime.tiles.visibleTiles.add(standIn as never);
    runtime.update();
    expect(standIn.engineData.scene.setEnabled).toHaveBeenLastCalledWith(false);
    expect(standIn.engineData.scene.setEnabled).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });
});

describe("Google collision surface revisions", () => {
  it("reports visibility/replacement changes without changing on ordinary flight ticks", () => {
    const runtime = createGoogleTilesRuntime({ scene: {} as Scene, apiKey: "test" });
    const mesh = { metadata: {} };
    const event = { scene: { getChildMeshes: () => [mesh] }, tile: { geometricError: 4 } };
    const dispatch = (type: string, extra = {}) => runtime.tiles.dispatchEvent({ type, ...event, ...extra } as never);
    expect(runtime.getRevision()).toBe(0);
    dispatch("load-model");
    expect(mesh.metadata).toEqual({ googleGeometricErrorMeters: 4 });
    expect(runtime.getRevision()).toBe(0); // Loading hidden content does not move the ground.
    dispatch("tile-visibility-change", { visible: true });
    const initial = runtime.getRevision();
    expect(initial).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) runtime.update();
    expect(runtime.getRevision()).toBe(initial);
    dispatch("tile-visibility-change", { visible: false });
    expect(runtime.getRevision()).toBeGreaterThan(initial);
    const hidden = runtime.getRevision();
    dispatch("dispose-model");
    expect(runtime.getRevision()).toBeGreaterThan(hidden);
    const disposed = runtime.getRevision();
    runtime.dispose();
    const terminal = runtime.getRevision();
    expect(terminal).toBeGreaterThan(disposed);
    dispatch("tile-visibility-change", { visible: true });
    dispatch("dispose-model");
    expect(runtime.getRevision()).toBe(terminal);
  });
  it("notifies asynchronous owner state, suspension and disposal and detaches those event hooks", () => {
    const onSurfaceChange = vi.fn(), runtime = createGoogleTilesRuntime({ scene: {} as Scene, apiKey: "test", onSurfaceChange });
    const dispatch = (type: string) => runtime.tiles.dispatchEvent({ type } as never);
    for (const type of ["tile-download-start", "load-content", "load-tileset"]) dispatch(type);
    expect(onSurfaceChange.mock.calls.map(call => call[0])).toEqual(["loading", "loading", "loading"]);
    runtime.setSuspended(true); expect(onSurfaceChange).toHaveBeenLastCalledWith("status");
    runtime.dispose(); expect(onSurfaceChange).toHaveBeenLastCalledWith("disposed"); onSurfaceChange.mockClear();
    for (const type of ["tile-download-start", "load-content", "load-tileset"]) dispatch(type);
    expect(onSurfaceChange).not.toHaveBeenCalled();
  });
  it("attempts terminal notification and every event detach even when traversal disposal fails", () => {
    const onSurfaceChange = vi.fn(), runtime = createGoogleTilesRuntime({ scene: {} as Scene, apiKey: "test", onSurfaceChange });
    vi.spyOn(runtime.tiles, "dispose").mockImplementation(() => { throw new Error("Synthetic traversal cleanup failed"); });
    expect(() => runtime.dispose()).toThrow("Synthetic traversal cleanup failed"); expect(onSurfaceChange).toHaveBeenLastCalledWith("disposed");
    onSurfaceChange.mockClear();
    for (const type of ["tile-visibility-change", "dispose-model", "load-content", "tiles-load-end"]) runtime.tiles.dispatchEvent({ type } as never);
    expect(onSurfaceChange).not.toHaveBeenCalled(); runtime.dispose();
  });
});

describe("Google loading state", () => {
  it("counts tiles waiting to parse and tiles whose children are being prepared, as the renderer's idle test does", () => {
    const scene = { activeCamera: null, getEngine: () => ({}) } as unknown as Scene;
    const runtime = createGoogleTilesRuntime({ scene, apiKey: "test" });
    const tiles = runtime.tiles as unknown as {
      stats: { queued: number };
      downloadQueue: { currJobs: number };
      parseQueue: { currJobs: number; items: unknown[] };
      processNodeQueue: { currJobs: number; items: unknown[] };
    };
    Object.assign(tiles.stats, { queued: 1 });
    Object.assign(tiles.downloadQueue, { currJobs: 2 });
    Object.assign(tiles.parseQueue, { currJobs: 3, items: [{}, {}] });
    Object.assign(tiles.processNodeQueue, { currJobs: 1, items: [{}, {}, {}] });
    expect(runtime.getLoadingState()).toMatchObject({ queued: 1, downloading: 2, parsing: 3, waitingToParse: 2, preparingChildren: 4 });
    runtime.dispose();
  });
});

describe("Google focus region", () => {
  const EARTH = 6_378_137;
  // Tiles as spheres in tileset space (ECEF), measured the way the renderer measures its volumes.
  const tile = (center: Vector3, radius: number, geometricError = 20) => ({
    geometricError,
    engineData: {
      boundingVolume: {
        distanceToPoint: (point: Vector3) => Math.max(0, Vector3.Distance(center, point) - radius),
        sphere: { centerWorld: center, radiusWorld: radius },
      },
    },
  });
  const setup = (focus: { mode: "around" | "both"; finestErrorPx?: number | null }) => {
    const scene = {
      activeCamera: {
        viewport: new Viewport(0, 0, 1, 1),
        getProjectionMatrix: () => Matrix.PerspectiveFovLH(Math.PI / 2, 1, 1, 1e7),
        // 1 km above the focus point, which is on the ground at 0° N 0° E.
        globalPosition: new Vector3(EARTH + 1000, 0, 0),
      },
      getEngine: () => ({ getHardwareScalingLevel: () => 1, getRenderWidth: () => 100, getRenderHeight: () => 100 }),
    } as unknown as Scene;
    const runtime = createGoogleTilesRuntime({
      scene, apiKey: "test",
      getFocus: () => ({ mode: focus.mode, position: { x: EARTH, y: 0, z: 0 }, radiusMeters: 10_000, finestErrorPx: focus.finestErrorPx ?? null, horizonCull: true }),
    });
    const renderer = runtime.tiles as unknown as {
      errorTarget: number;
      calculateTileViewError(value: ReturnType<typeof tile>, target: { inView: boolean; error: number; distanceFromCamera: number }): void;
    };
    runtime.update();
    const measure = (value: ReturnType<typeof tile>) => {
      const target = { inView: true, error: 0, distanceFromCamera: 0 };
      renderer.calculateTileViewError(value, target);
      return target;
    };
    return { runtime, renderer, measure };
  };

  it("around the point, loads every direction within the radius by distance from the point, and nothing it cannot see", () => {
    const { runtime, measure } = setup({ mode: "around" });
    // Behind the camera for the frustum (the mock says out of view), 500 m from the point:
    // measured from the camera's 1 km distance, the floor. 20 m / (1000 m × 2/100 px⁻¹) = 1 px.
    expect(measure(tile(new Vector3(EARTH, 500, 0), 0))).toEqual({ inView: true, error: 1, distanceFromCamera: 500 });
    // Outside the radius: kept for coverage, never refined.
    expect(measure(tile(new Vector3(EARTH, 20_000, 0), 0))).toMatchObject({ inView: true, error: 0 });
    // The far side of the Earth is below the point's horizon.
    expect(measure(tile(new Vector3(-EARTH, 0, 0), 1000)).inView).toBe(false);
    runtime.dispose();
  });

  it("with the view, adds the region to what the camera sees and keeps the camera's measure elsewhere", () => {
    const { runtime, measure } = setup({ mode: "both" });
    expect(measure(tile(new Vector3(EARTH, 500, 0), 0))).toEqual({ inView: true, error: 1, distanceFromCamera: 500 });
    // Outside the radius the renderer's own frustum result stands.
    expect(measure(tile(new Vector3(EARTH, 20_000, 0), 0))).toEqual({ inView: false, error: 1, distanceFromCamera: 999 });
    runtime.dispose();
  });

  it("asks the region for no finer than its own error target", () => {
    const { runtime, renderer, measure } = setup({ mode: "around", finestErrorPx: 80 });
    const scale = renderer.errorTarget / Math.max(renderer.errorTarget, 80);
    expect(scale).toBeLessThan(1);
    expect(measure(tile(new Vector3(EARTH, 500, 0), 0)).error).toBeCloseTo(scale);
    runtime.dispose();
  });
});

describe("Google proximity detail", () => {
  const EARTH = 6_378_137;
  const sphereTile = (center: Vector3, geometricError = 20, nativeInView = false, nativeError = 1) => ({
    geometricError, nativeInView, nativeError,
    engineData: {
      boundingVolume: {
        distanceToPoint: (point: Vector3) => Vector3.Distance(center, point),
        sphere: { centerWorld: center, radiusWorld: 0 },
      },
    },
  });
  const setup = (extra: Partial<GoogleTilesRuntimeOptions> = {}) => {
    const eye = new Vector3(EARTH + 20, 0, 0);
    const scene = {
      activeCamera: {
        viewport: new Viewport(0, 0, 1, 1),
        getProjectionMatrix: () => Matrix.PerspectiveFovLH(Math.PI / 2, 1, 1, 1e7),
        getViewMatrix: () => Matrix.Identity(),
        globalPosition: eye,
      },
      getEngine: () => ({ getHardwareScalingLevel: () => 1, getRenderWidth: () => 100, getRenderHeight: () => 100 }),
    } as unknown as Scene;
    let at = 0;
    const runtime = createGoogleTilesRuntime({ scene, apiKey: "test", nowMs: () => at, ...extra });
    const renderer = runtime.tiles as unknown as {
      calculateTileViewError(tile: object, target: { inView: boolean; error: number; distanceFromCamera: number }): void;
    };
    const measure = (tile: object) => {
      const target = { inView: false, error: 0, distanceFromCamera: 0 };
      renderer.calculateTileViewError(tile, target);
      return target;
    };
    return { runtime, eye, scene, measure, advance: (ms: number) => { at += ms; runtime.update(); } };
  };

  it("refines off-frustum ground from the real eye distance even with a 10 km focus-distance clamp", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    const focus = new Vector3(EARTH, 10_000, 0);
    const f = setup({
      getTerrainDetailAnchor: () => focus,
      getFocus: () => ({ mode: "both", position: focus, radiusMeters: 20_000, finestErrorPx: null, horizonCull: false }),
    });
    try {
      f.runtime.update();
      const tile = sphereTile(new Vector3(EARTH, 0, 0));
      const target = f.measure(tile);
      expect(target.inView).toBe(true);
      expect(target.distanceFromCamera).toBeCloseTo(20);
      expect(target.error).toBeCloseTo(50);
      // Focus-only and proximity-only selection never count as visible loaded detail.
      f.runtime.tiles.visibleTiles.add(tile as never);
      f.runtime.update();
      expect(f.runtime.getTerrainDetailState().loadedErrorTarget).toBeNull();
    } finally { f.runtime.dispose(); }
  });

  it("preserves native measurements by default and restores them when switched off live", () => {
    const f = setup();
    try {
      const tile = sphereTile(new Vector3(EARTH, 0, 0));
      f.runtime.update();
      expect(f.measure(tile)).toEqual({ inView: false, error: 1, distanceFromCamera: 999 });
      settings.set("map.terrain.robustOrbitLOD", true);
      f.runtime.update();
      expect(f.measure(tile).inView).toBe(true);
      settings.set("map.terrain.robustOrbitLOD", false);
      f.runtime.update();
      expect(f.measure(tile)).toEqual({ inView: false, error: 1, distanceFromCamera: 999 });
    } finally { f.runtime.dispose(); }
  });

  it.each(["max", "power-norm", "weighted-sum"] as const)("combines weighted gaze and proximity errors with %s", mode => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    settings.set("map.terrain.proximityCoreMeters", 15);
    settings.set("map.terrain.proximityRadiusMeters", 1000);
    settings.set("map.terrain.losWeight", 2);
    settings.set("map.terrain.losGazeExponent", 2);
    settings.set("map.terrain.losPeripheralFloor", 0.25);
    settings.set("map.terrain.proximityWeight", 0.5);
    settings.set("map.terrain.proximityBlendMode", mode);
    settings.set("map.terrain.proximityBlendPower", 2);
    const f = setup();
    try {
      f.runtime.update();
      const target = f.measure(sphereTile(new Vector3(EARTH + 20, 100, 0), 20, true, 12));
      const los = 12 * 2 * 0.25;
      const proximity = 0.5 * (1 - (100 - 15) / (1000 - 15)) * 20 / (100 * 0.02);
      const expected = mode === "max" ? Math.max(los, proximity) : mode === "weighted-sum" ? los + proximity : Math.hypot(los, proximity);
      expect(target.error).toBeCloseTo(expected);
      expect(f.measure(sphereTile(new Vector3(EARTH + 20, 0, 100), 20, true, 12)).error).toBeGreaterThan(target.error);
    } finally { f.runtime.dispose(); }
  });

  it("keeps the safety error floor independent of the global detail target and metric weights", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.losWeight", 0);
    settings.set("map.terrain.proximityWeight", 0);
    const f = setup();
    try {
      const tile = sphereTile(new Vector3(EARTH, 0, 0));
      for (const target of [20, 524_288]) {
        f.runtime.setTerrainDetailTarget(target);
        f.runtime.update();
        expect(f.measure(tile).error).toBe(target * 20 / 8);
      }
    } finally { f.runtime.dispose(); }
  });

  it("extracts the active camera gaze from its view orientation", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.losGazeExponent", 2);
    settings.set("map.terrain.proximityWeight", 0);
    settings.set("map.terrain.proximityCoreMeters", 15);
    const f = setup();
    try {
      vi.spyOn(f.scene.activeCamera!, "getViewMatrix").mockReturnValue(Matrix.LookAtLH(Vector3.Zero(), new Vector3(0, 1, 0), new Vector3(0, 0, 1)));
      f.runtime.update();
      expect(f.measure(sphereTile(new Vector3(EARTH + 20, 100, 0), 20, true, 12)).error).toBeCloseTo(12);
      expect(f.measure(sphereTile(new Vector3(EARTH + 20, 0, 100), 20, true, 12)).error).toBeCloseTo(3);
    } finally { f.runtime.dispose(); }
  });

  it("preserves an infinite native camera error through the power-norm blend", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityBlendMode", "power-norm");
    const f = setup();
    try {
      f.runtime.update();
      expect(f.measure(sphereTile(new Vector3(EARTH, 0, 0), 20, true, Infinity)).error).toBe(Infinity);
    } finally { f.runtime.dispose(); }
  });

  it("predicts rear tiles along the whole capsule before the eye crosses the boundary", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    settings.set("map.terrain.proximityRadiusMeters", 50);
    const f = setup();
    try {
      const rear = sphereTile(new Vector3(EARTH + 20, -220, 0));
      f.runtime.update();
      expect(f.measure(rear).inView).toBe(false);
      f.eye.y = -100;
      f.advance(1000);
      expect(f.measure(rear)).toMatchObject({ inView: true, distanceFromCamera: 0 });
      settings.set("map.terrain.proximityLookaheadSeconds", 0);
      f.runtime.update();
      expect(f.measure(rear).inView).toBe(false);
    } finally { f.runtime.dispose(); }
  });

  it("clamps anchor speed and resets prediction after teleports", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    settings.set("map.terrain.proximityRadiusMeters", 50);
    const f = setup();
    try {
      f.runtime.update();
      f.eye.y = -1000;
      f.advance(10);
      expect(f.measure(sphereTile(new Vector3(EARTH + 20, -2400, 0))).inView).toBe(true);
      expect(f.measure(sphereTile(new Vector3(EARTH + 20, -3000, 0))).inView).toBe(false);
      f.eye.y = -4000;
      f.advance(1000);
      expect(f.measure(sphereTile(new Vector3(EARTH + 20, -4500, 0))).inView).toBe(false);
    } finally { f.runtime.dispose(); }
  });

  it("uses the selected focus anchor without enabling a focus loading region", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const focus = new Vector3(EARTH + 20, 10_000, 0);
    const f = setup({ getProximityFocus: () => focus });
    try {
      const tile = sphereTile(new Vector3(EARTH + 20, 10_100, 0));
      for (const [anchor, inView] of [["eye", false], ["focus", true], ["both", true]] as const) {
        settings.set("map.terrain.proximityAnchor", anchor);
        f.runtime.update();
        expect(f.measure(tile).inView).toBe(inView);
      }
    } finally { f.runtime.dispose(); }
  });

  it("measures the actual box along the capsule rather than its enclosing sphere", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    settings.set("map.terrain.proximityRadiusMeters", 50);
    const f = setup();
    try {
      f.runtime.update();
      f.eye.y = -100;
      f.advance(1000);
      const tile = {
        geometricError: 20,
        engineData: { boundingVolume: {
          sphere: { centerWorld: new Vector3(EARTH + 20, -200, 0), radiusWorld: 1000 },
          obb: {},
          distanceToPoint: (point: Vector3) => Math.hypot(point.x - (EARTH + 20), Math.max(-205 - point.y, 0, point.y + 195), point.z - 900),
        } },
      };
      expect(f.measure(tile).inView).toBe(false);
      tile.engineData.boundingVolume.distanceToPoint = point => Math.hypot(point.x - (EARTH + 20), Math.max(-205 - point.y, 0, point.y + 195), point.z);
      expect(f.measure(tile)).toMatchObject({ inView: true, distanceFromCamera: 0 });
    } finally { f.runtime.dispose(); }
  });

  it("transforms the camera eye through the floating origin before measuring proximity", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const f = setup();
    try {
      f.eye.x = 20;
      vi.spyOn(f.runtime.tiles.group, "getWorldMatrix").mockReturnValue(Matrix.Translation(-EARTH, 0, 0));
      f.runtime.update();
      expect(f.measure(sphereTile(new Vector3(EARTH, 0, 0)))).toMatchObject({ inView: true, distanceFromCamera: 20 });
    } finally { f.runtime.dispose(); }
  });

  it("does not admit bounds on the far side of the globe", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const f = setup();
    try {
      f.runtime.update();
      expect(f.measure(sphereTile(new Vector3(-EARTH, 0, 0))).inView).toBe(false);
    } finally { f.runtime.dispose(); }
  });

  const boxTile = (transform: Matrix, min = new Vector3(-10, -20, -30), max = new Vector3(10, 20, 30)) => {
    const inverseTransform = transform.clone().invert();
    const nearest = Vector3.Zero();
    const points: Vector3[] = [];
    for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) {
      points.push(Vector3.TransformCoordinates(new Vector3(x ? max.x : min.x, y ? max.y : min.y, z ? max.z : min.z), transform));
    }
    const clampPoint = (point: Vector3, target: Vector3): Vector3 => {
      Vector3.TransformCoordinatesToRef(point, inverseTransform, target);
      target.set(Math.max(min.x, Math.min(max.x, target.x)), Math.max(min.y, Math.min(max.y, target.y)), Math.max(min.z, Math.min(max.z, target.z)));
      return Vector3.TransformCoordinatesToRef(target, transform, target);
    };
    return { geometricError: 2, engineData: { boundingVolume: {
      obb: { min, max, transform, inverseTransform, points, clampPoint },
      distanceToPoint: vi.fn((point: Vector3) => { clampPoint(point, nearest); return Vector3.Distance(point, nearest); }),
    } } };
  };

  it.each([
    { start: [-100, 40, 50], end: [100, 40, 50], distance: Math.sqrt(800) },
    { start: [-100, 40, 0], end: [100, 40, 0], distance: 20 },
    { start: [-100, 0, 0], end: [100, 0, 0], distance: 0 },
    { start: [-100, 20, 30], end: [100, 20, 30], distance: 0 },
    { start: [100, 100, 100], end: [150, 160, 170], distance: Math.sqrt(19400) },
  ])("solves box capsule face/edge/corner minima without iterative point queries: %j", test => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    settings.set("map.terrain.proximityLookaheadSeconds", 1);
    const f = setup();
    try {
      const start = new Vector3(EARTH + 20 + test.start[0], test.start[1], test.start[2]);
      const end = new Vector3(EARTH + 20 + test.end[0], test.end[1], test.end[2]);
      f.eye.copyFrom(start.scale(2).subtract(end)); f.runtime.update();
      f.eye.copyFrom(start); f.advance(1000);
      const tile = boxTile(Matrix.Translation(EARTH + 20, 0, 0));
      expect(f.measure(tile).distanceFromCamera).toBeCloseTo(test.distance, 7);
      expect(tile.engineData.boundingVolume.distanceToPoint).toHaveBeenCalledOnce();
    } finally { f.runtime.dispose(); }
  });

  it("matches an independent dense-search oracle for rotated, scaled, sheared and degenerate boxes", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    settings.set("map.terrain.proximityLookaheadSeconds", 1);
    const f = setup();
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const point = Vector3.Zero();
    try {
      for (let test = 0; test < 32; test++) {
        const transform = Matrix.Scaling(0.5 + random() * 2, 0.5 + random() * 2, 0.5 + random() * 2)
          .multiply(Matrix.RotationYawPitchRoll(random() * 3, random() * 3, random() * 3));
        if (test % 3 === 0) transform.setRowFromFloats(0, transform.m[0], transform.m[1] + 0.2, transform.m[2], 0);
        transform.setTranslationFromFloats(EARTH + 20, 0, 0);
        const min = test % 7 === 0 ? Vector3.Zero() : new Vector3(-10, -20, -30);
        const max = test % 7 === 0 ? Vector3.Zero() : new Vector3(10, 20, 30);
        const tile = boxTile(transform, min, max), volume = tile.engineData.boundingVolume;
        const start = new Vector3(EARTH + 20 + random() * 300 - 150, random() * 300 - 150, random() * 300 - 150);
        const end = new Vector3(EARTH + 20 + random() * 300 - 150, random() * 300 - 150, random() * 300 - 150);
        // Independent numerical oracle: find the best 1/1000 interval, then
        // minimize only that neighbourhood at much higher precision.
        let best = Infinity, bestIndex = 0;
        const distanceAt = (fraction: number): number => { Vector3.LerpToRef(start, end, fraction, point); return volume.distanceToPoint(point); };
        for (let step = 0; step <= 1000; step++) {
          const distance = distanceAt(step / 1000);
          if (distance < best) { best = distance; bestIndex = step; }
        }
        let low = Math.max(0, (bestIndex - 1) / 1000), high = Math.min(1, (bestIndex + 1) / 1000);
        for (let iteration = 0; iteration < 60; iteration++) {
          const left = low + (high - low) / 3, right = high - (high - low) / 3;
          const a = distanceAt(left), b = distanceAt(right);
          best = Math.min(best, a, b);
          if (a < b) high = right; else low = left;
        }
        volume.distanceToPoint.mockClear();
        f.eye.copyFrom(start.scale(2).subtract(end)); f.advance(1000);
        f.eye.copyFrom(start); f.advance(1000);
        expect(f.measure(tile).distanceFromCamera, `box ${test}`).toBeCloseTo(best, 6);
        expect(volume.distanceToPoint).toHaveBeenCalledOnce();
      }
    } finally { f.runtime.dispose(); }
  });

  it("reuses unchanged capsule measurements and invalidates every input to proximity error", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.proximityAnchor", "eye");
    const f = setup();
    try {
      const tile = sphereTile(new Vector3(EARTH + 20, 300, 0), 2);
      const measure = vi.spyOn(tile.engineData.boundingVolume, "distanceToPoint");
      f.runtime.update();
      const first = f.measure(tile);
      for (let frame = 0; frame < 5; frame++) { f.advance(16); expect(f.measure(tile)).toEqual(first); }
      expect(measure).toHaveBeenCalledOnce();
      settings.set("map.terrain.proximityWeight", 2); f.runtime.update();
      expect(f.measure(tile).error).toBeCloseTo(first.error * 2);
      expect(measure).toHaveBeenCalledTimes(2);
      vi.spyOn(f.scene.activeCamera!, "getProjectionMatrix").mockReturnValue(Matrix.PerspectiveFovLH(Math.PI / 3, 1, 1, 1e7));
      f.runtime.update();
      expect(f.measure(tile).error).toBeGreaterThan(first.error * 2);
      expect(measure).toHaveBeenCalledTimes(3);
      tile.geometricError = 4;
      f.measure(tile);
      expect(measure).toHaveBeenCalledTimes(4);
      settings.set("map.terrain.proximityRadiusMeters", 50); f.runtime.update();
      expect(f.measure(tile).inView).toBe(false);
    } finally { f.runtime.dispose(); }
  });

  it("measures identical eye and focus capsules once while keeping distinct anchors independent", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const focus = new Vector3(EARTH + 20, 0, 0), f = setup({ getProximityFocus: () => focus });
    try {
      const tile = sphereTile(new Vector3(EARTH + 20, 300, 0), 2);
      const measure = vi.spyOn(tile.engineData.boundingVolume, "distanceToPoint");
      f.runtime.update(); f.measure(tile);
      expect(measure).toHaveBeenCalledOnce();
      focus.z = 20; f.runtime.update(); f.measure(tile);
      expect(measure).toHaveBeenCalledTimes(3);
    } finally { f.runtime.dispose(); }
  });
});

describe("hosted Google tiles", () => {
  function hosted(tokens: string[], statuses: number[]) {
    const seen: { url: string; authorization: string | null; cache: RequestCache | undefined }[] = [];
    const refreshes: boolean[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), authorization: headers.get("Authorization"), cache: init?.cache });
      return new Response("{}", { status: statuses[seen.length - 1] ?? 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    let root = "";
    let plugin: { fetchData(uri: string, init: RequestInit): Promise<Response> } | null = null;
    const runtime = createGoogleTilesRuntime({
      scene: {} as Scene,
      credential: {
        kind: "hosted",
        rootUrl: "https://login.foss.earth/v1/3dtiles/root.json",
        authorization: async request => {
          refreshes.push(Boolean(request?.refresh));
          const token = tokens.shift();
          if (!token) throw new Error("no token");
          return token;
        },
      },
      createTilesRenderer: (url, scene) => {
        root = url;
        const tiles = new TilesRenderer(url, scene);
        tiles.registerPlugin = (next: unknown) => { plugin = next as NonNullable<typeof plugin>; };
        return tiles;
      },
    });
    return { runtime, plugin: () => plugin, seen, refreshes, root: () => root };
  }

  it("sends the account token, retries a rejected one once, and never puts a key on the query", async () => {
    const session = hosted(["Bearer first-token", "Bearer second-token"], [401, 200]);
    try {
      expect(session.root()).toBe("https://login.foss.earth/v1/3dtiles/root.json");
      const response = await session.plugin()!.fetchData("https://login.foss.earth/v1/3dtiles/root.json?key=stolen", { cache: "force-cache" });
      expect(response.status).toBe(200);
      expect(session.seen.map(call => call.authorization)).toEqual(["Bearer first-token", "Bearer second-token"]);
      expect(session.refreshes).toEqual([false, true]);
      expect(session.seen[0]?.url).not.toContain("key=");
      expect(session.seen[0]?.url).not.toContain("stolen");
      expect(session.seen[0]?.cache).toBe("no-cache");
    } finally {
      session.runtime.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("stops with the budget message when the account refuses a root", async () => {
    const session = hosted(["Bearer session-token"], [402]);
    try {
      await expect(session.plugin()!.fetchData("https://login.foss.earth/v1/3dtiles/datasets/a.json", {})).rejects.toThrow("Google 3D Tiles are paused until the budget resets. Flat maps still work.");
    } finally {
      session.runtime.dispose();
      vi.unstubAllGlobals();
    }
  });
});
