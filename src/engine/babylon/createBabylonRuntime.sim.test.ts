// @vitest-environment jsdom

import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
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
    reportFrame: vi.fn(),
    dispose: vi.fn(),
  }));
});

describe("createBabylonRuntime simulation mode", () => {
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
});