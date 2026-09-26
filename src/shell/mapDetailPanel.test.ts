// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BabylonRuntimeStatus } from "../engine/babylon/createBabylonRuntime";
import type { RasterDetailFeedback } from "../engine/babylon/createRasterTilesRuntime";
import { RASTER_BASE_MAP_SOURCES } from "../engine/babylon/rasterBaseMaps";
import { connectMapDetailRuntime, type MapDetailRuntime } from "./connectMapDetailRuntime";
import { createMapDetailController } from "./mapDetailController";
import { createMapDetailPanel } from "./mapDetailPanel";

afterEach(() => document.body.replaceChildren());

function mountRaster() {
  const controller = createMapDetailController({ storage: null });
  controller.setActiveSource({ key: "raster:usgs-imagery", availability: "ready" });
  const panel = createMapDetailPanel(controller);
  document.body.append(panel.element);
  const slider = (label: string) => panel.element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const choice = (value: string) => panel.element.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
  const button = (text: string) => [...panel.element.querySelectorAll("button")].find(item => item.textContent === text)!;
  const set = (input: HTMLInputElement, value: number) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  };
  return { controller, panel, slider, choice, button, set };
}

describe("Map tab detail editor", () => {
  it("edits the active source's range and keeps Normal inside it", () => {
    const { controller, slider, set } = mountRaster();
    // Positions run -d: moving the finer end to position 0.5 asks for d = -0.5,
    // which Normal does not allow, so the range keeps 0.
    set(slider("Finest end of the detail range"), 0.5);
    expect(controller.getState()?.policy).toEqual({ kind: "raster", coarseOffset: -3, fineOffset: 0, defaultValue: "normal" });
    set(slider("Coarsest end of the detail range"), 1);
    expect(controller.getState()?.policy).toMatchObject({ coarseOffset: -1, fineOffset: 0 });
  });

  it("puts both ends of the range and the default on one colour-mapped track", () => {
    const { controller, panel, slider, choice, set } = mountRaster();
    const tracks = panel.element.querySelectorAll(".map-detail-panel__track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].querySelectorAll('input[type="range"]')).toHaveLength(3);
    // Normal is marked, not dragged.
    expect(slider("Saved default detail").hidden).toBe(true);
    const finer = slider("Finest end of the detail range");
    const coarser = slider("Coarsest end of the detail range");
    expect(finer.style.getPropertyValue("--thumb-colour")).not.toBe(coarser.style.getPropertyValue("--thumb-colour"));
    // A thumb dragged past the other end stops there: an empty range, not a reversed one.
    const custom = choice("custom");
    custom.checked = true;
    custom.dispatchEvent(new Event("change"));
    set(finer, 3.5);
    expect(controller.getState()?.policy).toMatchObject({ fineOffset: -3, coarseOffset: -3 });
    expect(slider("Saved default detail").hidden).toBe(false);
    expect(slider("Saved default detail").disabled).toBe(true);
  });

  it("switches between Normal and Custom without silently changing the other", () => {
    const { controller, choice, slider, set } = mountRaster();
    const custom = choice("custom");
    custom.checked = true;
    custom.dispatchEvent(new Event("change"));
    expect(controller.getState()?.policy.defaultValue).toBe(0);
    set(slider("Saved default detail"), -0.5);
    expect(controller.getState()?.policy.defaultValue).toBe(0.5);
    set(slider("Finest end of the detail range"), 1);
    expect(controller.getState()?.policy).toMatchObject({ fineOffset: -1, coarseOffset: -3, defaultValue: -1 });
    const normal = choice("recommended");
    normal.checked = true;
    normal.dispatchEvent(new Event("change"));
    expect(controller.getState()?.policy).toEqual({ kind: "raster", coarseOffset: -3, fineOffset: 0, defaultValue: "normal" });
  });

  it("restores the saved detail and resets only the source's settings", () => {
    const { controller, button } = mountRaster();
    expect(button("Restore saved detail").disabled).toBe(true);
    controller.setSessionOverride(1);
    expect(button("Restore saved detail").disabled).toBe(false);
    button("Restore saved detail").click();
    expect(controller.getState()?.sessionOverride).toBeNull();
    controller.updatePolicy({ kind: "raster", coarseOffset: -1, fineOffset: 0, defaultValue: "normal" });
    controller.setSessionOverride(-1);
    button("Reset detail settings").click();
    expect(controller.getState()?.policy).toMatchObject({ coarseOffset: -3, fineOffset: 1 });
    expect(controller.getState()?.sessionOverride).toBe(-1);
  });

  it("shows why detail is limited only when something limits it", () => {
    const { controller, panel } = mountRaster();
    const status = panel.element.querySelector<HTMLElement>(".map-detail-panel__status")!;
    expect(status.hidden).toBe(true);
    controller.reportDelivery("raster:usgs-imagery", { pending: false, limits: ["memory"] });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Limited by the memory budget.");
  });

  it("offers the recommended Google target and labels it when the range clamps it", () => {
    const controller = createMapDetailController({ storage: null, googleRecommendation: "device-hints" });
    controller.setRecommendationContext({ rendererDefaultErrorPx: 20, rendererMode: "webgl2" });
    controller.setActiveSource({ key: "google", availability: "ready" });
    controller.updatePolicy({ kind: "google", finestErrorPx: 4, coarsestErrorPx: 16, defaultValue: 8 });
    const panel = createMapDetailPanel(controller);
    const recommended = panel.element.querySelector<HTMLInputElement>('input[value="recommended"]')!;
    recommended.checked = true;
    recommended.dispatchEvent(new Event("change"));
    expect(controller.getState()?.policy.defaultValue).toEqual({ mode: "recommended", policy: "device-hints" });
    expect(recommended.parentElement!.textContent).toMatch(/limited by the range/);
  });

  it("puts a host's requirement on the Google track, draggable past the range, striping what it refuses", () => {
    const controller = createMapDetailController({ storage: null });
    controller.setRecommendationContext({ rendererDefaultErrorPx: 20, rendererMode: "webgl2" });
    controller.setActiveSource({ key: "google", availability: "ready" });
    controller.updatePolicy({ kind: "google", finestErrorPx: 4, coarsestErrorPx: 16384, defaultValue: 32 });
    const onChange = vi.fn();
    const marker = { id: "flight", kind: "google" as const, value: 4096, colour: "#ef4444", label: "Flight minimum", ariaLabel: "Flight minimum", draggable: true, requirement: true, onChange };
    controller.setTrackMarker(marker);
    const panel = createMapDetailPanel(controller);
    document.body.append(panel.element);
    const thumb = panel.element.querySelector<HTMLInputElement>('input[aria-label="Flight minimum"]')!;
    expect(Number(thumb.value)).toBeCloseTo(12);
    expect(thumb.style.getPropertyValue("--thumb-colour")).toBe("#ef4444");
    const stripe = panel.element.querySelector<HTMLElement>(".foss-earth-track__stripe")!;
    expect(stripe.hidden).toBe(false);
    expect(panel.element.querySelector(".map-detail-panel__markers")!.textContent).toBe("Flight minimum: 4096 px");
    thumb.value = "14";
    thumb.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenLastCalledWith(16384);
    // A requirement is not a preference: it is not clamped into the range.
    thumb.value = "18";
    thumb.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenLastCalledWith(262144);
    expect(controller.getState()?.policy).toMatchObject({ finestErrorPx: 4, coarsestErrorPx: 16384 });
    // Waived for the session: hollow, and nothing is refused.
    controller.setTrackMarker({ ...marker, hollow: true });
    expect(thumb.classList.contains("is-hollow")).toBe(true);
    expect(stripe.hidden).toBe(true);
    // A marker the user may not drag is a tick.
    controller.setTrackMarker({ ...marker, draggable: false });
    expect(panel.element.querySelector('input[aria-label="Flight minimum"]')).toBeNull();
    expect(panel.element.querySelector(".foss-earth-track__marker-tick")).not.toBeNull();
  });

  it("disables editing while detail is unavailable and says why", () => {
    const controller = createMapDetailController({ storage: null });
    controller.setActiveSource({ key: "raster:osm-standard", availability: "unavailable" });
    const panel = createMapDetailPanel(controller);
    expect(panel.element.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(panel.element.querySelector(".map-detail-panel__note")!.textContent).toBe("Detail for 2D basemaps is not available yet.");
  });

  it("gives the renderer's reason when it has one", () => {
    const controller = createMapDetailController({ storage: null });
    controller.setActiveSource({ key: "raster:osm-standard", availability: "unavailable", reason: "This renderer cannot hold the imagery atlas." });
    const panel = createMapDetailPanel(controller);
    expect(panel.element.querySelector(".map-detail-panel__note")!.textContent).toBe("This renderer cannot hold the imagery atlas.");
  });
});

describe("detail runtime binding", () => {
  function fakeRuntime(mode: BabylonRuntimeStatus["mode"]) {
    const statusListeners = new Set<(status: BabylonRuntimeStatus) => void>();
    const status = { mode, rasterBaseMap: mode === "raster-basemap" ? RASTER_BASE_MAP_SOURCES[0] : null } as BabylonRuntimeStatus;
    let feedback: RasterDetailFeedback | null = { support: "ready", pending: false, limits: [], effectiveTarget: null };
    let google: { defaultErrorTarget: number } | null = mode === "google-tiles" ? { defaultErrorTarget: 20 } : null;
    const runtime: MapDetailRuntime & { emit(): void; setMode(next: BabylonRuntimeStatus["mode"]): void } = {
      status,
      renderer: { mode: "webgpu" },
      getGoogleTerrainDetailState: () => google,
      setGoogleTerrainDetailTarget: vi.fn(),
      setRasterDetailTarget: vi.fn(),
      getRasterDetailFeedback: () => (status.mode === "raster-basemap" ? feedback : null),
      subscribeStatus: listener => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
      onRasterDetailFeedback: () => () => {},
      isStreamingTiles: () => false,
      onTilesStreamingChange: () => () => {},
      emit: () => statusListeners.forEach(listener => listener(status)),
      setMode(next) {
        status.mode = next;
        status.rasterBaseMap = next === "raster-basemap" ? RASTER_BASE_MAP_SOURCES[0] : null;
        google = next === "google-tiles" ? { defaultErrorTarget: 20 } : null;
        feedback = { support: "ready", pending: false, limits: [], effectiveTarget: null };
        runtime.emit();
      },
    };
    return runtime;
  }

  it("applies the Google target, with consumer requirements composed in", () => {
    const runtime = fakeRuntime("google-tiles");
    const controller = createMapDetailController({ storage: null });
    const disconnect = connectMapDetailRuntime(controller, runtime);
    expect(runtime.setGoogleTerrainDetailTarget).toHaveBeenLastCalledWith(20);
    const lease = controller.acquireRequirement(4);
    expect(runtime.setGoogleTerrainDetailTarget).toHaveBeenLastCalledWith(4);
    controller.clearSessionOverride();
    expect(runtime.setGoogleTerrainDetailTarget).toHaveBeenLastCalledWith(4);
    lease.release();
    expect(runtime.setGoogleTerrainDetailTarget).toHaveBeenLastCalledWith(20);
    disconnect();
  });

  it("follows source switches without mixing units", () => {
    const runtime = fakeRuntime("google-tiles");
    const controller = createMapDetailController({ storage: null });
    connectMapDetailRuntime(controller, runtime);
    controller.setSessionOverride(8);
    runtime.setMode("raster-basemap");
    expect(controller.getState()?.key).toBe(`raster:${RASTER_BASE_MAP_SOURCES[0].id}`);
    expect(runtime.setRasterDetailTarget).toHaveBeenLastCalledWith(0);
    controller.setSessionOverride(0.5);
    expect(runtime.setRasterDetailTarget).toHaveBeenLastCalledWith(0.5);
    runtime.setMode("google-tiles");
    expect(runtime.setGoogleTerrainDetailTarget).toHaveBeenLastCalledWith(8);
    runtime.setMode("fallback");
    expect(controller.getState()).toBeNull();
  });
});
