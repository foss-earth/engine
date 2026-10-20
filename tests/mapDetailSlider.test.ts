// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createMapDetailController } from "../fixtures/composition/mapPanelHost.js";
import { createMapDetailSlider } from "../src/map/mapDetailSlider.js";
import { MAP_DETAIL_LOADED_PRESENTATION_ID, MAP_DETAIL_PARAMETERS } from "../src/settings/catalogue/map.js";
import { createDetailDistribution } from "../src/terrain/detailDistribution.js";

afterEach(() => document.body.replaceChildren());

function population(count: number, generation = 1) {
  return createDetailDistribution({
    status: "measured", kind: "raster", sourceKey: "raster:usgs-imagery", generation,
    samples: [{ value: 0, count }], tileCount: count,
  });
}

function mount() {
  const controller = createMapDetailController({ storage: null });
  const spec = MAP_DETAIL_PARAMETERS.find(item => item.id === MAP_DETAIL_LOADED_PRESENTATION_ID);
  if (!spec) throw new Error("Loaded detail display setting is missing.");
  controller.settings.register([spec]);
  controller.setActiveSource({ key: "raster:usgs-imagery", availability: "ready" });
  controller.reportDelivery("raster:usgs-imagery", { pending: false, limits: [], loadedTarget: -0.4, distribution: population(3) });
  const slider = createMapDetailSlider({ document, controller });
  document.body.append(slider.element);
  const input = slider.element.querySelector<HTMLInputElement>("input")!;
  const bars = () => [...slider.element.querySelectorAll("rect")];
  const marker = slider.element.querySelector<HTMLElement>(".map-detail-control__loaded-marker")!;
  const graphic = slider.element.querySelector("svg")!;
  return { controller, slider, input, bars, marker, graphic };
}

describe("map detail rail", () => {
  it("draws the tile distribution by default and keeps the I-beam for the previous display", () => {
    const { controller, slider, bars, marker, graphic } = mount();
    expect(slider.element.classList.contains("is-distribution")).toBe(true);
    expect(marker.hidden).toBe(true);
    expect(marker.isConnected).toBe(true);
    expect(graphic.getAttribute("aria-hidden")).toBe("true");
    expect(graphic.getAttribute("pointer-events")).toBe("none");
    expect(graphic.getAttribute("viewBox")).toBe("0 0 41 28");
    const stops = [...graphic.querySelectorAll("stop")].map(stop => [stop.getAttribute("offset"), stop.getAttribute("stop-color")]);
    expect(stops).toEqual([["0%", "#46db8f"], ["55%", "#f6d365"], ["100%", "#ff6b6b"]]);
    expect(graphic.querySelector("linearGradient")?.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
    expect(bars()).toHaveLength(13);
    const drawn = bars().filter(bar => Number(bar.getAttribute("height")) > 0);
    expect(drawn.length).toBeGreaterThan(0);
    for (const bar of drawn) {
      const y = Number(bar.getAttribute("y"));
      const height = Number(bar.getAttribute("height"));
      expect(y + height / 2).toBeCloseTo(14);
      expect(bar.getAttribute("fill")).toBe(`url(#${graphic.querySelector("linearGradient")!.id})`);
    }
    expect(slider.element.title).toContain("3 visible imagery tiles");
    expect(slider.element.title).not.toContain("I-beam");

    controller.settings.set(MAP_DETAIL_LOADED_PRESENTATION_ID, "marker");
    expect(slider.element.classList.contains("is-distribution")).toBe(false);
    expect(marker.hidden).toBe(false);
    expect(graphic.hasAttribute("hidden")).toBe(true);
    expect(slider.element.title).toContain("I-beam · Loaded detail");

    controller.settings.set(MAP_DETAIL_LOADED_PRESENTATION_ID, "distribution");
    expect(marker.hidden).toBe(true);
    expect(graphic.hasAttribute("hidden")).toBe(false);
    slider.destroy();
  });

  it("fills the rail with the tallest bar, and does not move bars when the request changes", () => {
    const { controller, slider, input, bars } = mount();
    const tallest = () => Math.max(...bars().map(bar => Number(bar.getAttribute("height"))));
    expect(tallest()).toBe(28);
    controller.reportDelivery("raster:usgs-imagery", { pending: false, limits: [], loadedTarget: -0.4, distribution: population(1) });
    expect(tallest()).toBe(28);
    const before = bars().map(bar => `${bar.getAttribute("x")}:${bar.getAttribute("height")}`);
    input.value = "1";
    input.dispatchEvent(new Event("input"));
    expect(bars().map(bar => `${bar.getAttribute("x")}:${bar.getAttribute("height")}`)).toEqual(before);
    expect(controller.getState()?.sessionOverride).not.toBeNull();
    controller.reportDelivery("raster:usgs-imagery", { pending: false, limits: [], loadedTarget: -0.4, distribution: population(1, 2) });
    expect(Number(bars().find(bar => Number(bar.getAttribute("height")) > 0)?.getAttribute("height"))).toBe(28);
    slider.destroy();
  });

  it("does not invent a bar from the loaded scalar", () => {
    const { controller, slider, graphic, bars } = mount();
    controller.reportDelivery("raster:usgs-imagery", { pending: false, limits: [], loadedTarget: 0, distribution: null });
    expect(graphic.hasAttribute("hidden")).toBe(true);
    expect(bars().some(bar => Number(bar.getAttribute("height")) > 0)).toBe(false);
    expect(slider.element.title).toContain("not available");
    expect(slider.element.title).not.toContain("I-beam");
    slider.destroy();
  });

  it("does not write the range's bounds or hide what is hidden again as tiles load", () => {
    const { controller, slider, input, marker } = mount();
    const writes: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) writes.push(record.attributeName!);
    });
    observer.observe(input, { attributes: true, attributeFilter: ["min", "max", "step", "hidden"] });
    observer.observe(marker, { attributes: true, attributeFilter: ["hidden"] });
    controller.reportDelivery("raster:usgs-imagery", { pending: false, limits: [], loadedTarget: -0.2, distribution: population(2, 2) });
    controller.reportDelivery("raster:usgs-imagery", { pending: true, limits: [], loadedTarget: -0.3, distribution: population(4, 3) });
    writes.push(...observer.takeRecords().map(record => record.attributeName!));
    observer.disconnect();
    expect(marker.hidden).toBe(true);
    expect(writes).toEqual([]);
    slider.destroy();
  });
});
