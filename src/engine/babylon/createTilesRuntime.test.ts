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
    downloadQueue = { maxJobs: 0, currJobs: 0 };
    parseQueue = { maxJobs: 0, currJobs: 0 };
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
