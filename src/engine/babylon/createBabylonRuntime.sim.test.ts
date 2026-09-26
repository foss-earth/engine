// @vitest-environment jsdom

import { FreeCamera, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInputController: vi.fn(),
  createGoogleTilesRuntime: vi.fn(),
  createRasterTilesRuntime: vi.fn(),
}));

vi.mock("./createRendererMode", async (importOriginal) => {
  const original = await importOriginal<typeof import("./createRendererMode")>();
  return {
    ...original,
    bootstrapGlobeRenderer: vi.fn(async () => {
      const engine = new NullEngine();
      return {
        renderer: { requested: "auto" as const, mode: "webgl2" as const, engine },
        scene: new Scene(engine),
      };
    }),
  };
});

vi.mock("../../input/createInputController", () => ({
  createInputController: mocks.createInputController,
}));

vi.mock("./createTilesRuntime", () => ({
  createGoogleTilesRuntime: mocks.createGoogleTilesRuntime,
}));

vi.mock("./createRasterTilesRuntime", () => ({
  createRasterTilesRuntime: mocks.createRasterTilesRuntime,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createRasterTilesRuntime.mockImplementation((options: { source: { id: string } }) => ({
    source: options.source,
    update: vi.fn(),
    setSource: vi.fn(),
    setTerrainSource: vi.fn(),
    getMetrics: () => ({ visibleTiles: 1, activeTiles: 1 }),
    getRevision: () => 0,
    sample: () => null,
    getQualityState: () => ({ setting: "auto", activeProfile: "balanced" }),
    setQuality: vi.fn(),
    setDetailTarget: vi.fn(),
    getDetailFeedback: () => ({ support: "unavailable", pending: false, limits: [], effectiveTarget: null }),
    getImageryDiagnostics: () => ({ mode: "legacy", atlas: null }),
    getDisplayedSourceId: () => options.source.id,
    reportFrame: vi.fn(),
    dispose: vi.fn(),
  }));
});

describe("createBabylonRuntime simulation mode", () => {
  it("publishes Google surface revisions to flight contact queries", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    let revision = 1;
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      getRevision: () => revision,
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });
    try {
      const wall = MeshBuilder.CreateBox("surface", { size: 2 }, runtime.scene);
      wall.metadata = { mapSurface: true };
      wall.position.x = 5;
      wall.parent = runtime.getWorldRoot();
      wall.computeWorldMatrix(true);
      const cast = () => runtime.surface.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
      expect(cast()?.revision).toBe(1);
      revision = 2;
      expect(cast()?.revision).toBe(2);
    } finally { runtime.destroy(); }
  });
  it("releases streaming and startup holds after Google tiles fail into fallback", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });
    runtime.setSimRunning(false);
    const callbacks = mocks.createGoogleTilesRuntime.mock.calls[0][0] as {
      onLoadStart(): void;
      onLoadError(error: Error, url: string): void;
    };
    callbacks.onLoadStart();
    expect(runtime.isStreamingTiles()).toBe(true);
    callbacks.onLoadError(new Error("test failure"), "test-tile");
    const frame = scheduledFrame as FrameRequestCallback | null;
    frame?.(performance.now());
    expect(runtime.status.mode).toBe("fallback");
    expect(runtime.isStreamingTiles()).toBe(false);
    expect(runtime.isRendering()).toBe(false);
    runtime.destroy();
  });

  it("exposes a world root, simulated view state, and frame tick without globe input", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { simMode: true });
    const tick = vi.fn();
    runtime.setSimTick(tick);
    runtime.setSimViewState({ latDeg: 12, lonDeg: 34, zoomMeters: 900 });

    expect(runtime.getWorldRoot()?.name).toBe("sim-world-root");
    expect(runtime.getViewState()).toMatchObject({ latDeg: 12, lonDeg: 34, zoomMeters: 900 });
    expect(mocks.createInputController).not.toHaveBeenCalled();

    const frame = scheduledFrame as FrameRequestCallback | null;
    expect(frame).not.toBeNull();
    frame?.(performance.now());
    expect(tick).toHaveBeenCalledOnce();
    expect(tick.mock.calls[0]?.[0]).toBeGreaterThan(0);
    expect(runtime.isRendering()).toBe(true);
    runtime.setSimRunning(false);
    const flush = () => {
      const callback = scheduledFrame;
      scheduledFrame = null;
      callback?.(performance.now());
    };
    flush();
    expect(runtime.isRendering()).toBe(false);
    expect(scheduledFrame).toBeNull();
    runtime.requestRender(); // camera movement or asynchronously loaded content
    expect(runtime.isRendering()).toBe(true);
    flush();
    expect(runtime.isRendering()).toBe(false);
    runtime.setSimRunning(true);
    flush();
    expect(runtime.isRendering()).toBe(true);
    expect(scheduledFrame).not.toBeNull();

    runtime.destroy();
  });

  it("keeps the flight camera active through paused raster and Google map switches", async () => {
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });
    const flightCamera = new FreeCamera("flight-camera", Vector3.Zero(), runtime.scene);
    runtime.scene.activeCamera = flightCamera;
    runtime.setSimRunning(false);

    runtime.setMapSource({ id: "test-raster", label: "Test raster", provider: "test", urlTemplate: "https://example.test/{z}/{x}/{y}.png", attribution: "test" });
    expect(runtime.scene.activeCamera).toBe(flightCamera);

    runtime.setMapSource("google");
    expect(runtime.scene.activeCamera).toBe(flightCamera);
    runtime.destroy();
  });

  it("retains visible Google coverage until replacement raster coverage is ready", async () => {
    const googleRuntime = {
      tiles: { visibleTiles: new Set(["google-tile"]), activeTiles: new Set(["google-tile"]), group: {} },
      update: vi.fn(), dispose: vi.fn(),
    };
    mocks.createGoogleTilesRuntime.mockReturnValue(googleRuntime);
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });

    runtime.setMapSource({ id: "test-raster", label: "Test raster", provider: "test", urlTemplate: "https://example.test/{z}/{x}/{y}.png", attribution: "test" });
    expect(googleRuntime.dispose).not.toHaveBeenCalled();

    const callbacks = mocks.createRasterTilesRuntime.mock.calls.at(-1)?.[0] as { onLoadEnd(visibleTiles: number, activeTiles: number): void };
    callbacks.onLoadEnd(1, 1);
    expect(googleRuntime.dispose).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it("exposes Google terrain detail controls and refines from the simulation origin once flight attaches it", async () => {
    const setTerrainDetailTarget = vi.fn();
    const detail = { defaultErrorTarget: 20, errorTarget: 20, overrideErrorTarget: null };
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      getTerrainDetailState: () => detail,
      setTerrainDetailTarget,
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const { getAppSettings } = await import("../../settings/appSettings");
    // A flight refines from its focus point, the simulation origin.
    getAppSettings().setHostDefault("map.focus.refineFrom", "focus", "the flight");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });

    expect(runtime.getGoogleTerrainDetailState()).toEqual(detail);
    runtime.setGoogleTerrainDetailTarget(48);
    expect(setTerrainDetailTarget).toHaveBeenCalledWith(48);
    expect(runtime.getGoogleTerrainDetailAnchor()).toBe("focus-point");

    const callbacks = mocks.createGoogleTilesRuntime.mock.calls[0][0] as {
      getTerrainDetailAnchor(): Vector3 | null;
    };
    expect(callbacks.getTerrainDetailAnchor()).toBeNull();
    runtime.getWorldRoot()!.parent = new TransformNode("world-shift", runtime.scene);
    expect(callbacks.getTerrainDetailAnchor()).toEqual(Vector3.Zero());

    getAppSettings().set("map.focus.refineFrom", "camera");
    expect(runtime.getGoogleTerrainDetailAnchor()).toBe("camera");
    expect(callbacks.getTerrainDetailAnchor()).toBeNull();
    runtime.destroy();
  });

  it("lists a host's focus points and hands the selected one's region to the map", async () => {
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const { getAppSettings } = await import("../../settings/appSettings");
    const settings = getAppSettings();
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });
    const google = mocks.createGoogleTilesRuntime.mock.calls[0][0] as {
      getTerrainDetailAnchor(): Vector3 | null;
      getFocus(): { mode: string; position: { x: number; y: number; z: number }; radiusMeters: number; finestErrorPx: number | null; horizonCull: boolean } | null;
    };
    const choices = () => settings.inspect("map.focus.point")?.choices.map(choice => choice.id);
    expect(choices()).toEqual(["orbit-target"]);

    let position: { x: number; y: number; z: number } | null = { x: 6_378_137, y: 10, z: 20 };
    const getPosition = vi.fn(() => position);
    const unregister = runtime.registerFocusPoint({ id: "aircraft", label: "Aircraft", getPosition });
    expect(choices()).toEqual(["orbit-target", "aircraft"]);
    // Before flight attaches the floating origin, the simulation origin is not known.
    expect(runtime.getFocusPosition()).toBeNull();
    settings.set("map.focus.point", "aircraft");
    expect(runtime.getFocusPosition()).toEqual(position);

    // The view alone decides what loads until the mode asks for a region.
    expect(google.getFocus()).toBeNull();
    settings.set("map.focus.mode", "around");
    settings.set("map.focus.radius", 5000);
    settings.set("map.focus.detailBelow.google", 64);
    expect(google.getFocus()).toEqual({ mode: "around", position, radiusMeters: 5000, finestErrorPx: 64, horizonCull: true });

    // Mesh detail can be measured from the same point; the world root is not shifted, so scene is ECEF.
    settings.set("map.focus.refineFrom", "focus");
    expect(google.getTerrainDetailAnchor()).toEqual(new Vector3(6_378_137, 10, 20));

    // A point that cannot say where it is gives no region, rather than a wrong one.
    position = { x: Number.NaN, y: 0, z: 0 };
    expect(google.getFocus()).toBeNull();
    getPosition.mockImplementation(() => { throw new Error("no aircraft"); });
    expect(runtime.getFocusPosition()).toBeNull();

    // Removed, the saved choice waits for the point to come back.
    unregister();
    expect(choices()).toEqual(["orbit-target"]);
    expect(settings.get("map.focus.point")).toBe("orbit-target");
    runtime.registerFocusPoint({ id: "aircraft", label: "Aircraft", getPosition: () => ({ x: 1, y: 2, z: 3 }) });
    expect(settings.get("map.focus.point")).toBe("aircraft");
    expect(() => runtime.registerFocusPoint({ id: "orbit-target", label: "Mine", getPosition: () => null })).toThrow();
    runtime.destroy();
  });

  it("reads the focus point once per frame and gives 2D imagery its finest offset", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const { resolveRasterBaseMapSource } = await import("./rasterBaseMaps");
    const { getAppSettings } = await import("../../settings/appSettings");
    const settings = getAppSettings();
    const runtime = await createBabylonRuntime(document.createElement("canvas"), {
      preferGoogleTiles: false, rasterBaseMap: resolveRasterBaseMapSource("usgs-topo"), simMode: true,
    });
    const raster = mocks.createRasterTilesRuntime.mock.calls[0][0] as {
      getFocus(): { mode: string; position: { x: number; y: number; z: number }; offsetCap: number | null } | null;
    };
    const getPosition = vi.fn(() => ({ x: 6_378_137, y: 0, z: 0 }));
    runtime.registerFocusPoint({ id: "aircraft", label: "Aircraft", getPosition });
    settings.set("map.focus.point", "aircraft");
    settings.set("map.focus.mode", "both");
    // "As the detail setting" leaves the offset to the view.
    expect(raster.getFocus()).toMatchObject({ mode: "both", offsetCap: null });
    settings.set("map.focus.detailBelow.imagery", -1);
    expect(raster.getFocus()).toMatchObject({ offsetCap: -1 });

    // Within a frame both maps see one position; the tick reads it once.
    const rasterRuntime = mocks.createRasterTilesRuntime.mock.results[0].value as { update: ReturnType<typeof vi.fn> };
    rasterRuntime.update.mockImplementation(() => { raster.getFocus(); raster.getFocus(); });
    getPosition.mockClear();
    runtime.requestRender();
    (scheduledFrame as FrameRequestCallback | null)?.(performance.now());
    expect(getPosition).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it("follows the map source and elevation parameters wherever they change", async () => {
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const { resolveRasterBaseMapSource } = await import("./rasterBaseMaps");
    const { getAppSettings } = await import("../../settings/appSettings");
    const settings = getAppSettings();
    const runtime = await createBabylonRuntime(document.createElement("canvas"), {
      googleApiKey: "test", preferGoogleTiles: false, rasterBaseMap: resolveRasterBaseMapSource("usgs-topo"), simMode: true,
    });
    expect(runtime.status.mode).toBe("raster-basemap");
    settings.set("map.source.basemap", "google");
    expect(runtime.status.mode).toBe("google-tiles");
    settings.set("map.source.basemap", "osm-standard");
    expect(runtime.status.rasterBaseMap?.id).toBe("osm-standard");
    settings.set("map.source.elevation", "aws-terrarium");
    expect(runtime.status.terrainSource?.id).toBe("aws-terrarium");
    runtime.destroy();
    settings.set("map.source.basemap", "usgs-topo");
    expect(runtime.status.rasterBaseMap?.id).toBe("osm-standard");
  });

  it("requests a keyed source with the provider's key, and follows key changes", async () => {
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const { resolveRasterBaseMapSource } = await import("./rasterBaseMaps");
    const { getAppSettings } = await import("../../settings/appSettings");
    const settings = getAppSettings();
    const runtime = await createBabylonRuntime(document.createElement("canvas"), {
      preferGoogleTiles: false, rasterBaseMap: resolveRasterBaseMapSource("carto-positron"), simMode: true,
    });
    const created = mocks.createRasterTilesRuntime.mock.calls[0][0] as { source: { urlTemplate: string } };
    expect(created.source.urlTemplate).not.toContain("api_key");
    settings.set("map.source.cartoKey", "k 1");
    const raster = mocks.createRasterTilesRuntime.mock.results[0].value as { setSource: ReturnType<typeof vi.fn> };
    expect(raster.setSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "carto-positron", urlTemplate: expect.stringMatching(/\?api_key=k%201$/) }));
    // The rest of the app never sees the key.
    expect(runtime.status.rasterBaseMap?.urlTemplate).not.toContain("api_key");
    runtime.destroy();
  });

  it("uses an overhead camera to select normal Google tiles while terrain is preparing", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });
    const flightCamera = new FreeCamera("flight-camera", Vector3.Zero(), runtime.scene);
    runtime.scene.activeCamera = flightCamera;
    const worldShift = new TransformNode("world-shift", runtime.scene);
    runtime.getWorldRoot()!.parent = worldShift;
    const abort = new AbortController();
    const preparation = runtime.prepareTerrain({ latDeg: 45, lonDeg: -93, radiusMeters: 1000, signal: abort.signal });

    expect(runtime.scene.activeCamera?.name).toBe("terrain-preparation-camera");
    abort.abort();
    await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.scene.activeCamera).toBe(flightCamera);
    runtime.destroy();
  });

  it("starts once one complete displayed-terrain snapshot is available", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    mocks.createGoogleTilesRuntime.mockReturnValue({
      tiles: { visibleTiles: new Set(), activeTiles: new Set(), group: {} },
      update: vi.fn(), dispose: vi.fn(),
    });
    const { createBabylonRuntime } = await import("./createBabylonRuntime");
    const runtime = await createBabylonRuntime(document.createElement("canvas"), { googleApiKey: "test", simMode: true });
    vi.spyOn(runtime.surface, "sample").mockReturnValue({
      point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, distanceMeters: 1,
      heightMeters: 300, meshId: "terrain", revision: 1, quality: 10, geometricErrorMeters: 500_000,
    });
    const progress = vi.fn();
    const preparation = runtime.prepareTerrain({ latDeg: 45, lonDeg: -93, radiusMeters: 1000, onProgress: progress });

    scheduledFrame?.(0);
    await expect(preparation).resolves.toEqual({ groundHeightMeters: 300, altitudeMeters: 1824 });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "ready", progress: 1 }));
    expect(runtime.geospatialCamera?.isEnabled()).toBe(true);
    runtime.destroy();
  });
});
