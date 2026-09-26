import { Matrix, Vector3, type Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";

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
    calculateTileViewError(_tile: unknown, target: { inView: boolean; error: number; distanceFromCamera: number }) {
      target.inView = false;
      target.error = 1;
      target.distanceFromCamera = 999;
    }
    update() {}
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

import { createGoogleTilesRuntime } from "./createTilesRuntime";

describe("Google loading budgets", () => {
  it("sizes the renderer's cache and queues from map.google.*, and follows changes", async () => {
    const { getAppSettings } = await import("../../settings/appSettings");
    const settings = getAppSettings();
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
    settings.set("map.google.cacheBytes", { min: 64, max: 128 });
    settings.set("map.google.downloads", 4);
    expect(tiles.lruCache).toMatchObject({ minBytesSize: 64 * 2 ** 20, maxBytesSize: 128 * 2 ** 20 });
    expect(tiles.downloadQueue.maxJobs).toBe(4);
    runtime.dispose();
    settings.set("map.google.downloads", 9);
    expect(tiles.downloadQueue.maxJobs).toBe(4);
  });
});

describe("Google terrain detail anchors", () => {
  it("keeps the active-camera frustum while measuring detail from the supplied anchor", () => {
    const anchor = new Vector3(12, 0, 0);
    const scene = {
      activeCamera: { getProjectionMatrix: () => Matrix.Identity() },
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
    dispatch("tile-visibility-change", { visible: true });
    dispatch("dispose-model");
    expect(runtime.getRevision()).toBe(disposed);
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
      calculateTileViewError(tile: ReturnType<typeof tile>, target: { inView: boolean; error: number; distanceFromCamera: number }): void;
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
