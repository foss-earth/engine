import { describe, expect, it, vi } from "vitest";
import type { BabylonRuntimeStatus } from "../engine/babylon/createBabylonRuntime";
import type { RasterDetailFeedback } from "../engine/babylon/createRasterTilesRuntime";
import { connectMapDetailRuntime, type MapDetailRuntime } from "./connectMapDetailRuntime";
import { createMapDetailController, type MapDetailStorage } from "./mapDetailController";

function memoryStorage(): MapDetailStorage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

function fakeRuntime() {
  const statusListeners = new Set<(status: BabylonRuntimeStatus) => void>();
  const rasterListeners = new Set<() => void>();
  const streamingListeners = new Set<(streaming: boolean) => void>();
  let google: { defaultErrorTarget: number } | null = null;
  let feedback: RasterDetailFeedback | null = null;
  const status = { mode: "raster-basemap", rasterBaseMap: { id: "usgs-imagery" } } as BabylonRuntimeStatus;
  const runtime = {
    status,
    renderer: { mode: "webgpu" },
    getGoogleTerrainDetailState: () => google,
    setGoogleTerrainDetailTarget: vi.fn(),
    setRasterDetailTarget: vi.fn(),
    getRasterDetailFeedback: () => feedback,
    subscribeStatus: (listener: (status: BabylonRuntimeStatus) => void) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onRasterDetailFeedback: (listener: () => void) => { rasterListeners.add(listener); return () => rasterListeners.delete(listener); },
    isStreamingTiles: () => false,
    onTilesStreamingChange: (listener: (streaming: boolean) => void) => { streamingListeners.add(listener); return () => streamingListeners.delete(listener); },
  } satisfies MapDetailRuntime;
  return {
    runtime,
    setFeedback(next: RasterDetailFeedback | null) { feedback = next; for (const listener of rasterListeners) listener(); },
    showGoogle(defaultErrorTarget: number | null) {
      google = defaultErrorTarget === null ? null : { defaultErrorTarget };
      status.mode = "google-tiles";
      for (const listener of statusListeners) listener(status);
    },
    showRaster(id: string) {
      status.mode = "raster-basemap";
      status.rasterBaseMap = { id } as BabylonRuntimeStatus["rasterBaseMap"];
      for (const listener of statusListeners) listener(status);
    },
    listeners: () => statusListeners.size + rasterListeners.size + streamingListeners.size,
  };
}

const READY: RasterDetailFeedback = { support: "ready", pending: false, limits: [], effectiveTarget: 0 };

describe("connectMapDetailRuntime", () => {
  it("offers raster detail only once the renderer supports it, then drives its target", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    const fake = fakeRuntime();
    connectMapDetailRuntime(controller, fake.runtime);
    expect(controller.getState()).toMatchObject({ key: "raster:usgs-imagery", availability: "unavailable" });
    expect(controller.setSessionOverride(-1)).toBe(false);

    fake.setFeedback(READY);
    expect(controller.getState()).toMatchObject({ availability: "ready", effectiveTarget: 0 });
    expect(controller.setSessionOverride(-1)).toBe(true);
    expect(fake.runtime.setRasterDetailTarget).toHaveBeenLastCalledWith(-1);

    fake.setFeedback({ support: "ready", pending: true, limits: ["loading", "source"], effectiveTarget: null });
    expect(controller.getState()).toMatchObject({ pending: true, effectiveTarget: null, requestedTarget: -1 });
    expect([...controller.getState()!.limits].sort()).toEqual(["loading", "source"]);
  });

  it("passes on the renderer's reason while raster detail is unavailable", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    const fake = fakeRuntime();
    fake.setFeedback({ support: "unavailable", reason: "The imagery atlas needs a larger texture.", pending: false, limits: ["backend"], effectiveTarget: null });
    connectMapDetailRuntime(controller, fake.runtime);
    expect(controller.getState()).toMatchObject({ availability: "unavailable", reason: "The imagery atlas needs a larger texture." });
  });

  it("keeps each source's target, and applies Google's once the renderer knows its default", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    const fake = fakeRuntime();
    fake.setFeedback(READY);
    connectMapDetailRuntime(controller, fake.runtime);
    controller.setSessionOverride(0.5);

    fake.showGoogle(null);
    expect(controller.getState()).toMatchObject({ key: "google", availability: "initializing" });
    expect(fake.runtime.setGoogleTerrainDetailTarget).not.toHaveBeenCalled();
    fake.showGoogle(16);
    expect(fake.runtime.setGoogleTerrainDetailTarget).toHaveBeenLastCalledWith(16);

    fake.showRaster("usgs-imagery");
    expect(controller.getState()).toMatchObject({ key: "raster:usgs-imagery", requestedTarget: 0.5 });
    // Google's new tiles runtime gets its target again on return.
    fake.showGoogle(16);
    expect(fake.runtime.setGoogleTerrainDetailTarget).toHaveBeenCalledTimes(2);

    fake.showRaster("carto-positron");
    expect(controller.getState()).toMatchObject({ key: "raster:carto-positron", requestedTarget: 0 });
    expect(fake.runtime.setRasterDetailTarget).toHaveBeenLastCalledWith(0);
  });

  it("stops following the runtime once disconnected", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    const fake = fakeRuntime();
    const disconnect = connectMapDetailRuntime(controller, fake.runtime);
    disconnect();
    expect(fake.listeners()).toBe(0);
    fake.setFeedback(READY);
    expect(controller.getState()?.availability).toBe("unavailable");
  });
});
