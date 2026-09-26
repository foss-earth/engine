import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GOOGLE_DETAIL_POLICY, type GoogleDetailPolicy, type RasterDetailPolicy } from "../terrain/mapDetailPolicy";
import { SETTINGS_STORAGE_KEY } from "../settings/registry";
import { createMapDetailController, MAP_DETAIL_STORAGE_KEY, type MapDetailStorage } from "./mapDetailController";

function memoryStorage(initial: Record<string, string> = {}): MapDetailStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

const RASTER = "raster:usgs-imagery";

function readyGoogle(controller: ReturnType<typeof createMapDetailController>): void {
  controller.setRecommendationContext({ rendererDefaultErrorPx: 20, rendererMode: "webgl2" });
  controller.setActiveSource({ key: "google", availability: "ready" });
}

describe("map detail controller", () => {
  it("starts from registered defaults and treats both endpoints as ordinary values", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    readyGoogle(controller);
    expect(controller.getState()).toMatchObject({ key: "google", availability: "ready", resolvedDefault: 20, requestedTarget: 20, sessionOverride: null });
    controller.setSessionOverride(64);
    expect(controller.getState()).toMatchObject({ sessionOverride: 64, requestedTarget: 64 });
    controller.setSessionOverride(4);
    expect(controller.getState()).toMatchObject({ sessionOverride: 4, requestedTarget: 4 });
    controller.clearSessionOverride();
    expect(controller.getState()).toMatchObject({ sessionOverride: null, requestedTarget: 20 });
  });

  it("stays initializing until a recommended default can be resolved", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    controller.setActiveSource({ key: "google", availability: "ready" });
    expect(controller.getState()?.availability).toBe("initializing");
    expect(controller.getRuntimeTarget()).toBeNull();
    expect(controller.setSessionOverride(8)).toBe(false);
    controller.setRecommendationContext({ rendererDefaultErrorPx: 20 });
    expect(controller.getState()?.availability).toBe("ready");
    expect(controller.getRuntimeTarget()).toEqual({ kind: "google", value: 20 });
  });

  it("saves one policy per kind as parameters in the settings record", () => {
    const storage = memoryStorage();
    const controller = createMapDetailController({ storage });
    readyGoogle(controller);
    const google: GoogleDetailPolicy = { kind: "google", finestErrorPx: 2, coarsestErrorPx: 256, defaultValue: 32 };
    expect(controller.updatePolicy(google)).toBe(true);
    controller.setActiveSource({ key: RASTER, availability: "ready" });
    const raster: RasterDetailPolicy = { kind: "raster", coarseOffset: -2, fineOffset: 0.5, defaultValue: "normal" };
    expect(controller.updatePolicy(raster)).toBe(true);
    const record = JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY)!);
    expect(record.values).toEqual({
      "map.detail.google.range": { min: 2, max: 256 },
      "map.detail.google.default": 32,
      "map.detail.imagery.range": { min: -2, max: 0.5 },
    });

    const reloaded = createMapDetailController({ storage });
    expect(reloaded.getPolicy("google")).toEqual(google);
    expect(reloaded.getPolicy(RASTER)).toEqual(raster);
    // Every 2D basemap shares the imagery policy: its offsets are relative to Normal.
    expect(reloaded.getPolicy("raster:osm-standard")).toEqual(raster);
  });

  it("imports the record kept before the settings registry, once", () => {
    const google: GoogleDetailPolicy = { kind: "google", finestErrorPx: 2, coarsestErrorPx: 8, defaultValue: 4 };
    const storage = memoryStorage({ [MAP_DETAIL_STORAGE_KEY]: JSON.stringify({ version: 1, policies: { google } }) });
    const controller = createMapDetailController({ storage });
    expect(controller.getPolicy("google")).toEqual(google);
    expect(controller.hasSavedPolicy("google")).toBe(true);
    readyGoogle(controller);
    controller.resetPolicy();
    expect(createMapDetailController({ storage }).hasSavedPolicy("google")).toBe(false);
  });

  it("follows edits made through the registry and draws host markers", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    readyGoogle(controller);
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.settings.set("map.detail.google.default", 32);
    expect(controller.getState()?.requestedTarget).toBe(32);
    const remove = controller.setTrackMarker({ id: "flight", kind: "google", value: 4096, colour: "#ef4444", label: "Flight minimum", ariaLabel: "Flight minimum", draggable: true });
    expect(controller.getState()?.markers.map(marker => marker.id)).toEqual(["flight"]);
    controller.setActiveSource({ key: RASTER, availability: "ready" });
    expect(controller.getState()?.markers).toEqual([]);
    controller.setActiveSource({ key: "google", availability: "ready" });
    remove();
    expect(controller.getState()?.markers).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });

  it("refuses a policy of the wrong kind or an invalid one", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    readyGoogle(controller);
    expect(controller.updatePolicy({ kind: "raster", coarseOffset: -1, fineOffset: 1, defaultValue: "normal" })).toBe(false);
    expect(controller.updatePolicy({ kind: "google", finestErrorPx: 8, coarsestErrorPx: 4, defaultValue: 6 })).toBe(false);
    expect(controller.getState()?.policy).toEqual(DEFAULT_GOOGLE_DETAIL_POLICY);
  });

  it("ignores a corrupt record and invalid entries without losing valid ones", () => {
    const valid: GoogleDetailPolicy = { kind: "google", finestErrorPx: 2, coarsestErrorPx: 8, defaultValue: 4 };
    const corrupt = createMapDetailController({ storage: memoryStorage({ [MAP_DETAIL_STORAGE_KEY]: "{not json" }) });
    expect(corrupt.hasSavedPolicy("google")).toBe(false);
    const mixed = createMapDetailController({ storage: memoryStorage({
      [MAP_DETAIL_STORAGE_KEY]: JSON.stringify({ version: 1, policies: { google: valid, [RASTER]: { kind: "raster", coarseOffset: 3 } } }),
    }) });
    expect(mixed.getPolicy("google")).toEqual(valid);
    expect(mixed.hasSavedPolicy(RASTER)).toBe(false);
    const future = createMapDetailController({ storage: memoryStorage({
      [MAP_DETAIL_STORAGE_KEY]: JSON.stringify({ version: 2, policies: { google: valid } }),
    }) });
    expect(future.hasSavedPolicy("google")).toBe(false);
  });

  it("keeps working in memory when storage is denied", () => {
    const denied: MapDetailStorage = {
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
    };
    const controller = createMapDetailController({ storage: denied });
    readyGoogle(controller);
    expect(controller.updatePolicy({ kind: "google", finestErrorPx: 2, coarsestErrorPx: 8, defaultValue: 4 })).toBe(true);
    expect(controller.getState()?.requestedTarget).toBe(4);
    expect(controller.getStorageError()).toMatch(/could not be saved/);
    expect(controller.hasSavedPolicy("google")).toBe(false);
  });

  it("applies a seed only while no valid saved policy exists", () => {
    const storage = memoryStorage();
    const seed: GoogleDetailPolicy = { kind: "google", finestErrorPx: 16, coarsestErrorPx: 4096, defaultValue: { mode: "recommended", policy: "device-hints" } };
    const first = createMapDetailController({ storage });
    expect(first.seedPolicy("google", seed)).toBe("saved");
    readyGoogle(first);
    first.updatePolicy({ ...seed, defaultValue: 64 });

    const second = createMapDetailController({ storage });
    expect(second.seedPolicy("google", seed)).toBe("exists");
    expect(second.getPolicy("google")).toEqual({ ...seed, defaultValue: 64 });
  });

  it("reports an unsaved seed so a migration can retry", () => {
    const storage: MapDetailStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const controller = createMapDetailController({ storage });
    expect(controller.seedPolicy("google", DEFAULT_GOOGLE_DETAIL_POLICY)).toBe("unsaved");
    expect(controller.getPolicy("google")).toEqual(DEFAULT_GOOGLE_DETAIL_POLICY);
  });

  it("lets a forced host policy win over saved ones and seeds", () => {
    const saved: GoogleDetailPolicy = { kind: "google", finestErrorPx: 2, coarsestErrorPx: 8, defaultValue: 4 };
    const forcedPolicy: GoogleDetailPolicy = { kind: "google", finestErrorPx: 8, coarsestErrorPx: 32, defaultValue: 16 };
    const storage = memoryStorage({ [MAP_DETAIL_STORAGE_KEY]: JSON.stringify({ version: 1, policies: { google: saved } }) });
    const controller = createMapDetailController({ storage, forcedPolicies: { google: forcedPolicy } });
    expect(controller.getPolicy("google")).toEqual(forcedPolicy);
    expect(controller.seedPolicy("google", saved)).toBe("forced");
  });

  it("clamps a session override once when the range narrows past it", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    readyGoogle(controller);
    controller.setSessionOverride(60);
    controller.updatePolicy({ ...DEFAULT_GOOGLE_DETAIL_POLICY, coarsestErrorPx: 32 });
    expect(controller.getState()?.sessionOverride).toBe(32);
    controller.updatePolicy({ ...DEFAULT_GOOGLE_DETAIL_POLICY, coarsestErrorPx: 64 });
    expect(controller.getState()?.sessionOverride).toBe(32);
  });

  it("keeps each source's session override and never mixes their units", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    readyGoogle(controller);
    controller.setSessionOverride(8);
    controller.setActiveSource({ key: RASTER, availability: "ready" });
    expect(controller.getState()).toMatchObject({ requestedTarget: 0, sessionOverride: null });
    controller.setSessionOverride(0.5);
    controller.setActiveSource({ key: "google", availability: "ready" });
    expect(controller.getState()).toMatchObject({ requestedTarget: 8, sessionOverride: 8 });
    controller.setActiveSource({ key: RASTER, availability: "ready" });
    expect(controller.getState()).toMatchObject({ requestedTarget: 0.5 });
  });

  it("resets only the active source's policy", () => {
    const storage = memoryStorage();
    const controller = createMapDetailController({ storage });
    readyGoogle(controller);
    controller.updatePolicy({ kind: "google", finestErrorPx: 2, coarsestErrorPx: 8, defaultValue: 4 });
    controller.setActiveSource({ key: RASTER, availability: "ready" });
    controller.updatePolicy({ kind: "raster", coarseOffset: -1, fineOffset: 0, defaultValue: -1 });
    controller.resetPolicy();
    expect(controller.getPolicy(RASTER)).toMatchObject({ coarseOffset: -3, fineOffset: 1, defaultValue: "normal" });
    expect(controller.getPolicy("google")).toMatchObject({ finestErrorPx: 2 });
    expect(Object.keys(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY)!).values)).toEqual(["map.detail.google.range", "map.detail.google.default"]);
  });

  it("composes consumer requirements as the finer target without moving the request", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    readyGoogle(controller);
    controller.setSessionOverride(64);
    const lease = controller.acquireRequirement(4096);
    expect(controller.getState()).toMatchObject({ requestedTarget: 64, effectiveTarget: 64, limits: [] });
    lease.update(2);
    // A requirement may go beyond the user's range; it is reported, not saved.
    expect(controller.getState()).toMatchObject({ requestedTarget: 64, effectiveTarget: 2, limits: ["consumer"] });
    expect(controller.getRuntimeTarget()).toEqual({ kind: "google", value: 2 });
    controller.clearSessionOverride();
    expect(controller.getState()).toMatchObject({ requestedTarget: 20, effectiveTarget: 2 });
    lease.release();
    expect(controller.getState()).toMatchObject({ effectiveTarget: 20, limits: [] });
    expect(controller.getPolicy("google")).toEqual(DEFAULT_GOOGLE_DETAIL_POLICY);
  });

  it("releases Google requirements when the source switches away, and all of them on dispose", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    readyGoogle(controller);
    const first = controller.acquireRequirement(4);
    controller.setActiveSource({ key: RASTER, availability: "ready" });
    expect(first.active).toBe(false);
    controller.setActiveSource({ key: "google", availability: "ready" });
    expect(controller.getState()?.effectiveTarget).toBe(20);
    const second = controller.acquireRequirement(4);
    controller.dispose();
    expect(second.active).toBe(false);
  });

  it("publishes each meaningful change once", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    const listener = vi.fn();
    controller.subscribe(listener);
    readyGoogle(controller);
    listener.mockClear();
    controller.setRecommendationContext({ rendererDefaultErrorPx: 20 });
    controller.reportDelivery("google", null);
    expect(listener).not.toHaveBeenCalled();
    controller.reportDelivery("google", { pending: true, limits: ["loading"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ pending: true, limits: ["loading"] });
  });

  it("reports raster delivery without inventing a single achieved target", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    controller.setActiveSource({ key: RASTER, availability: "ready" });
    controller.reportDelivery(RASTER, { pending: true, limits: ["source"], effectiveTarget: null });
    expect(controller.getState()).toMatchObject({ effectiveTarget: null, pending: true, limits: ["source"] });
    expect(controller.getRuntimeTarget()).toEqual({ kind: "raster", value: 0 });
  });

  it("offers no override while a source is unavailable", () => {
    const controller = createMapDetailController({ storage: memoryStorage() });
    controller.setActiveSource({ key: RASTER, availability: "unavailable", reason: "not yet" });
    expect(controller.setSessionOverride(1)).toBe(false);
    expect(controller.getRuntimeTarget()).toBeNull();
  });
});
