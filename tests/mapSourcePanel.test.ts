// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { appendHostSections, checkChoice, createChoiceGroup, createChoiceNote, createHelpTooltip, createIconButton, createParameterSection, createSectionsElement, createTrack } from "@foss-earth/ui/browser";
import { createMapSourcePanel } from "../src/map/mapSourcePanel.js";
import { MAP_SOURCE_PARAMETERS } from "../src/settings/catalogue/map.js";
import { createMapDetailController } from "../fixtures/composition/mapPanelHost.js";

afterEach(() => document.body.replaceChildren());

function mount() {
  const settings = createSettingsRegistry();
  settings.register(MAP_SOURCE_PARAMETERS);
  const detail = createMapDetailController({ storage: null });
  detail.setActiveSource({ key: "raster:usgs-imagery", availability: "ready" });
  const onMapSourceChange = vi.fn();
  const panel = createMapSourcePanel({
    document, InputElement: HTMLInputElement, settings, refresh: { subscribe: () => () => {} }, panelStorage: null,
    ui: { appendHostSections, checkChoice, createChoiceGroup, createChoiceNote, createHelpTooltip, createIconButton, createParameterSection, createSectionsElement },
    cache: { inspect: async () => ({ available: true, entries: [], bytes: 0, maxBytes: 100, hits: 0, browserRequests: [] }), clear: async () => {}, nowMs: () => 0, refreshIntervalMs: () => 2000, rowLimit: () => 40 },
    detail, detailPanel: { createTrack, idSuffix: () => "1" },
    rasterSources: [{ id: "osm", label: "OpenStreetMap", attributionUrl: "https://example.test/osm" }, { id: "usgs-imagery", label: "USGS imagery" }],
    terrainSources: [{ id: "mapterhorn", label: "Mapterhorn", attribution: "https://example.test/mapterhorn" }],
    onMapSourceChange, onTerrainSourceChange: vi.fn(),
  });
  document.body.append(panel.element);
  return { panel, onMapSourceChange };
}

describe("Map tab", () => {
  it("draws the basemap as one track, 3D then 2D, with Terrain included and ? after it", () => {
    const { panel, onMapSourceChange } = mount();
    const basemap = panel.element.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Basemap"]')!;
    const tracks = basemap.querySelectorAll(".foss-earth-parameter__pills");
    expect(tracks).toHaveLength(1);
    expect([...tracks[0]!.querySelectorAll("input")].map(input => input.value)).toEqual(["google", "osm", "usgs-imagery"]);
    expect(panel.element.querySelectorAll('input[name="foss-earth-map-source"]')).toHaveLength(3);
    const status = basemap.querySelector<HTMLElement>(".foss-earth-choice-group__status")!;
    expect(basemap.lastElementChild!.querySelector("button")!.getAttribute("aria-label")).toBe("Explain Basemap");
    panel.update({ mode: "google-tiles", rasterBaseMap: null, terrainSource: null });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Terrain included");
    expect(panel.element.querySelector<HTMLElement>('[aria-label="Elevation"]')!.hidden).toBe(true);
    panel.update({ mode: "raster-basemap", rasterBaseMap: { id: "osm" } as never, terrainSource: { id: "mapterhorn" } as never });
    expect(status.hidden).toBe(true);
    expect(panel.element.querySelector<HTMLInputElement>('input[value="osm"]')!.checked).toBe(true);
    // The chosen basemap keeps its attribution link.
    expect(panel.element.querySelector<HTMLAnchorElement>('input[value="osm"] ~ a')!.hidden).toBe(false);
    panel.element.querySelector<HTMLInputElement>('input[value="google"]')!.click();
    expect(onMapSourceChange).toHaveBeenCalledWith("google");
    panel.destroy();
  });

  it("puts what a section is for behind the ? ending its title, not in a paragraph", () => {
    const { panel } = mount();
    for (const id of ["map.auto", "map.selection", "map.terrain-selection"]) {
      const section = panel.element.querySelector(`[data-section="${id}"]`)!;
      // The ? follows the title in the section's frame, outside the summary that opens it.
      const frame = section.parentElement!;
      expect(frame.classList.contains("foss-earth-panel-section__frame")).toBe(true);
      expect(frame.querySelector(":scope > .foss-earth-panel-section__help .foss-earth-parameter__help-button")).not.toBeNull();
      expect(section.querySelector("summary button")).toBeNull();
      expect([...section.querySelectorAll<HTMLElement>(".foss-earth-panel-section__body .foss-earth-choices__note")].filter(note => !note.hidden)).toHaveLength(0);
    }
    panel.destroy();
  });

  it("draws Saved default as one compact choice with icon actions and ? last", () => {
    const { panel } = mount();
    const group = panel.element.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Saved default"]')!;
    expect(group.querySelectorAll(".foss-earth-parameter__pills")).toHaveLength(1);
    expect([...group.querySelectorAll(".foss-earth-parameter__pills label")].map(label => label.textContent)).toEqual(["Normal", "Custom"]);
    expect([...group.querySelectorAll("button[data-icon]")].map(button => button.getAttribute("aria-label"))).toEqual(["Restore saved detail", "Reset detail settings"]);
    expect(group.lastElementChild!.querySelector("button")!.getAttribute("aria-label")).toBe("Explain detail");
    expect(panel.element.querySelector<HTMLElement>(".map-detail-panel__note")!.hidden).toBe(true);
    panel.destroy();
  });
});
