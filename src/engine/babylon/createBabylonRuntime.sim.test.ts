// @vitest-environment jsdom

import { NullEngine, Scene } from "@babylonjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInputController: vi.fn(),
  createGoogleTilesRuntime: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
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
});