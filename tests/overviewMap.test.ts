// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import type { RasterBaseMapSource } from "../src/map/rasterBaseMaps.js";
import {
  AERONAUTICAL_CHART, createOverviewMap, inverseOrthographic, mercatorX, mercatorY, orthographicPoint, overviewPointToLatLon, planOverview, resolveOverviewSource, sphereRadiusPx, tileUrl,
} from "../src/map/overviewMap.js";
import { OVERVIEW_MAP_PARAMETERS, OVERVIEW_PROJECTION_ID, OVERVIEW_PROJECTION_MERCATOR, OVERVIEW_PROVIDER_CHARTS, OVERVIEW_PROVIDER_CURRENT, OVERVIEW_PROVIDER_ID } from "../src/settings/catalogue/map.js";

const raster: RasterBaseMapSource = {
  id: "usgs-imagery",
  label: "USGS Imagery",
  provider: "USGS The National Map",
  protocol: "xyz",
  urlTemplate: "https://tiles.example/{z}/{x}/{y}.png",
  attribution: "USGS The National Map",
  attributionUrl: "https://example.test/usgs",
  minZoom: 0,
  maxZoom: 16,
};

afterEach(() => { document.body.replaceChildren(); });

describe("overview map projection", () => {
  it("builds the Minneapolis sectional tile the FAA service serves", () => {
    expect(Math.floor(mercatorX(-93.2277, 11))).toBe(493);
    expect(Math.floor(mercatorY(44.9738, 11))).toBe(736);
    expect(tileUrl(AERONAUTICAL_CHART.urlTemplate, 11, 493, 736)).toBe(
      "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/11/736/493",
    );
  });

  it("keeps the camera at the center of the planned frame", () => {
    const frame = planOverview({
      latDeg: 44.975, lonDeg: -93.234, widthPx: 400, heightPx: 300,
      zoomMeters: 1500, zoomOffset: 0, minZoom: 0, maxZoom: 18,
    });
    const center = overviewPointToLatLon(frame, 200, 150);
    expect(center.latDeg).toBeCloseTo(44.975, 5);
    expect(center.lonDeg).toBeCloseTo(-93.234, 5);
    expect(frame.tiles.length).toBeGreaterThan(0);
  });

  it("scales sectional tiles instead of asking for a zoom the charts do not publish", () => {
    const close = planOverview({
      latDeg: 44.975, lonDeg: -93.234, widthPx: 400, heightPx: 300,
      zoomMeters: 800, zoomOffset: 0, minZoom: AERONAUTICAL_CHART.minZoom, maxZoom: AERONAUTICAL_CHART.maxZoom,
    });
    expect(close.zoom).toBe(AERONAUTICAL_CHART.maxZoom);
    expect(close.scale).toBeGreaterThan(1);
    const readable = planOverview({
      latDeg: 44.975, lonDeg: -93.234, widthPx: 400, heightPx: 300,
      zoomMeters: 800, zoomOffset: 0, minZoom: AERONAUTICAL_CHART.minZoom, maxZoom: AERONAUTICAL_CHART.maxZoom,
      maxScale: 1,
    });
    expect(readable.scale).toBeLessThanOrEqual(1);
    expect(readable.zoom).toBe(AERONAUTICAL_CHART.maxZoom);
    const center = overviewPointToLatLon(readable, 200, 150);
    expect(center.latDeg).toBeCloseTo(44.975, 4);
    expect(center.lonDeg).toBeCloseTo(-93.234, 4);
    const far = planOverview({
      latDeg: 44.975, lonDeg: -93.234, widthPx: 800, heightPx: 600,
      zoomMeters: 2_000_000, zoomOffset: 0, minZoom: AERONAUTICAL_CHART.minZoom, maxZoom: AERONAUTICAL_CHART.maxZoom,
    });
    expect(far.zoom).toBe(AERONAUTICAL_CHART.minZoom);
    expect(far.tiles.length).toBeLessThanOrEqual(64);
  });

  it("reads a point on the sphere back from the screen, and leaves the disc empty", () => {
    expect(sphereRadiusPx(400, 300, 0)).toBeCloseTo(138, 5);
    const radius = 200;
    const center = orthographicPoint(44.97, -93.23, 44.97, -93.23, radius, 200, 150);
    expect(center).toMatchObject({ x: 200, y: 150, front: true });
    const shifted = orthographicPoint(50, -90, 44.97, -93.23, radius, 200, 150);
    const back = inverseOrthographic(shifted.x, shifted.y, 44.97, -93.23, radius, 200, 150);
    expect(back?.latDeg).toBeCloseTo(50, 3);
    expect(back?.lonDeg).toBeCloseTo(-90, 3);
    expect(orthographicPoint(-44.97, 86.77, 44.97, -93.23, radius, 200, 150).front).toBe(false);
    expect(inverseOrthographic(200 + radius + 5, 150, 44.97, -93.23, radius, 200, 150)).toBeNull();
  });
});

describe("overview map provider", () => {
  it("follows a raster basemap, refuses Google's 3D tiles, and defaults an unknown choice to the charts", () => {
    expect(resolveOverviewSource(OVERVIEW_PROVIDER_CURRENT, { mode: "raster-basemap", source: raster }, [raster]).source?.urlTemplate).toBe(raster.urlTemplate);
    expect(resolveOverviewSource(OVERVIEW_PROVIDER_CURRENT, { mode: "google-tiles", source: null }, [raster])).toMatchObject({
      source: null, note: "Google 3D Tiles has no flat image. Choose a chart or another map.",
    });
    expect(resolveOverviewSource("missing", { mode: "fallback", source: null }, [raster]).source?.id).toBe(OVERVIEW_PROVIDER_CHARTS);
    expect(resolveOverviewSource(raster.id, { mode: "google-tiles", source: null }, [raster]).source?.id).toBe(raster.id);
  });

  it("opens on aeronautical charts and says when the current map is Google 3D Tiles", () => {
    const settings = createSettingsRegistry();
    settings.register(OVERVIEW_MAP_PARAMETERS);
    let basemap: { mode: "google-tiles" | "raster-basemap" | "fallback"; source: RasterBaseMapSource | null } = { mode: "raster-basemap", source: raster };
    const basemapListeners = new Set<() => void>();
    const frameListeners = new Set<() => void>();
    const map = createOverviewMap({
      document, sources: [raster], settings,
      basemap: () => basemap,
      subscribeBasemap(listener) { basemapListeners.add(listener); return () => { basemapListeners.delete(listener); }; },
      view: () => ({ latDeg: 44.97, lonDeg: -93.23, headingDeg: 20, zoomMeters: 1500 }),
      frames: { subscribe(listener) { frameListeners.add(listener); return () => { frameListeners.delete(listener); }; } },
    });
    document.body.append(map.element);
    const name = map.element.querySelector(".overview-map__name");
    if (!(name instanceof HTMLButtonElement)) throw new Error("The map tab has no provider name.");
    expect(name.textContent).toBe("Aeronautical charts");
    expect(map.element.querySelector("select")).toBeNull();
    const menu = map.element.querySelector(".overview-map__menu");
    const panel = map.element.querySelector(".overview-map__menu-panel");
    if (!(menu instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) throw new Error("The map tab has no menu.");
    expect(panel.hidden).toBe(true);
    menu.click();
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Save as preset");
    expect(panel.querySelector("[data-projection='sphere']")?.getAttribute("aria-pressed")).toBe("true");
    const flat = panel.querySelector("[data-projection='mercator']");
    if (!(flat instanceof HTMLButtonElement)) throw new Error("The map tab has no flat map choice.");
    flat.click();
    expect(settings.get(OVERVIEW_PROJECTION_ID)).toBe(OVERVIEW_PROJECTION_MERCATOR);
    expect(map.element.querySelector(".overview-map__recenter")?.hasAttribute("hidden")).toBe(true);
    expect(map.element.querySelector("[role='status']")?.hasAttribute("hidden")).toBe(true);
    name.click();
    const current = map.element.querySelector(`[data-provider='${OVERVIEW_PROVIDER_CURRENT}']`);
    if (!(current instanceof HTMLButtonElement)) throw new Error("The map tab has no current-basemap choice.");
    current.click();
    expect(settings.get(OVERVIEW_PROVIDER_ID)).toBe(OVERVIEW_PROVIDER_CURRENT);
    expect(name.textContent).toBe("USGS Imagery");
    expect(map.element.querySelector(".overview-map__credit")?.getAttribute("aria-label")).toContain("USGS The National Map");
    basemap = { mode: "google-tiles", source: null };
    for (const listener of basemapListeners) listener();
    expect(map.element.querySelector("[role='status']")?.textContent).toBe("Google 3D Tiles has no flat image. Choose a chart or another map.");
    map.destroy();
    expect(frameListeners.size).toBe(0);
    expect(basemapListeners.size).toBe(0);
    expect(map.element.isConnected).toBe(false);
  });

  it("pans the map off the view and recenters without moving the camera", () => {
    let nowMs = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const settings = createSettingsRegistry();
    settings.register(OVERVIEW_MAP_PARAMETERS);
    const frameListeners = new Set<() => void>();
    const map = createOverviewMap({
      document, sources: [raster], settings,
      basemap: () => ({ mode: "raster-basemap", source: raster }),
      subscribeBasemap: () => () => {},
      view: () => ({ latDeg: 44.97, lonDeg: -93.23, headingDeg: 20, zoomMeters: 1500 }),
      frames: { subscribe(listener) { frameListeners.add(listener); return () => { frameListeners.delete(listener); }; } },
    });
    document.body.append(map.element);
    const stage = map.element.querySelector(".overview-map__view");
    if (!(stage instanceof HTMLElement)) throw new Error("The map tab has no view.");
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 400 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 300 });
    const frame = (): void => { for (const listener of frameListeners) listener(); };
    frame();
    stage.dispatchEvent(new WheelEvent("wheel", { deltaX: 48.5, deltaY: 12.25, bubbles: true, cancelable: true }));
    frame();
    const recenter = map.element.querySelector(".overview-map__recenter");
    if (!(recenter instanceof HTMLButtonElement)) throw new Error("The map tab has no recenter button.");
    expect(recenter.hidden).toBe(false);
    recenter.click();
    expect(recenter.hidden).toBe(true);
    nowMs = 2_000;
    stage.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 120, bubbles: true, cancelable: true }));
    frame();
    expect(recenter.hidden).toBe(true);
    const canvas = map.element.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("The map tab has no canvas.");
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(recenter.hidden).toBe(true);
    canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 20, clientY: 20, button: 0, pointerId: 1, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: 21, clientY: 20, button: 0, pointerId: 1, bubbles: true }));
    frame();
    expect(recenter.hidden).toBe(true);
    canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: 80, clientY: 20, button: 0, pointerId: 1, bubbles: true }));
    frame();
    expect(recenter.hidden).toBe(false);
    now.mockRestore();
    map.destroy();
  });
});
