// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createExternalLinkIcon } from "@foss-earth/ui/browser";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import { createMapSourceHud, type MapSourceHudOptions, type MapSourceHudStatus } from "../src/map/mapSourceHud.js";
import { createMapDetailController } from "../fixtures/composition/mapPanelHost.js";

afterEach(() => document.body.replaceChildren());

const TOPO = RASTER_BASE_MAP_SOURCES.find(source => source.id === "usgs-imagery-topo")!;

function mount(extra: Partial<MapSourceHudOptions> = {}) {
  const slot = document.createElement("span");
  document.body.append(slot);
  const hud = createMapSourceHud(slot, {
    document,
    ui: {
      createExternalLinkIcon,
      attachMapDownloadSpeed: () => () => {},
      setMapSourceLabel: (button, text) => { button.querySelector(".map-source-label")!.textContent = text; },
      attachTileStreamingActivity: () => () => {},
    },
    activity: {
      getMapDownloadBytesPerSecond: () => 0, onMapDownloadRateChange: () => () => {},
      isStreamingTiles: () => false, onTilesStreamingChange: () => () => {},
    },
    onProviderClick: () => {},
    ...extra,
  });
  const provider = slot.querySelector<HTMLButtonElement>(".map-source-hud__provider")!;
  return { hud, provider, label: provider.querySelector(".map-source-label")!, warning: provider.querySelector<HTMLElement>(".map-source-hud__warning")! };
}

describe("the map source HUD", () => {
  it("marks a basemap with a warning by a sign after its name, which a shortened name keeps", () => {
    const { hud, provider, label, warning } = mount();
    const status = (lastError: string | null): MapSourceHudStatus => ({ mode: "raster-basemap", rasterBaseMap: TOPO, lastError });

    hud.update(status(null));
    expect(label.textContent).toBe("USGS Imagery Topo");
    expect(warning.hidden).toBe(true);

    hud.update(status("Some tiles failed to load."));
    expect(label.textContent).toBe("USGS Imagery Topo");
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe("⚠️");
    // Outside the label, whose overflow is the part an ellipsis replaces.
    expect(label.contains(warning)).toBe(false);
    expect(label.nextElementSibling).toBe(warning);
    // The sign is not read out; the button's name says it in words.
    expect(warning.getAttribute("aria-hidden")).toBe("true");
    expect(provider.getAttribute("aria-label")).toBe("Basemap: USGS Imagery Topo warning. Show or hide the Basemap tab");

    hud.update(status(null));
    expect(warning.hidden).toBe(true);
    expect(provider.getAttribute("aria-label")).toBe("Basemap: USGS Imagery Topo. Show or hide the Basemap tab");
    hud.destroy();
  });

  it("shows Google's mark in place of the word Google, and keeps the full name for the button", () => {
    const { hud, provider, label } = mount();
    hud.update({ mode: "google-tiles", rasterBaseMap: null, lastError: null });
    const logo = provider.querySelector<HTMLImageElement>(".map-source-hud__logo")!;
    expect(label.textContent).toBe("3D Tiles");
    expect(logo.hidden).toBe(false);
    expect(logo.getAttribute("src")).toContain("4285F4");
    expect(provider.getAttribute("aria-label")).toBe("Basemap: Google 3D Tiles. Show or hide the Basemap tab");
    expect(provider.textContent).not.toContain("Google");
    hud.destroy();
  });

  it("puts the detail rail beside the chip, or inside it before the basemap", () => {
    const controller = createMapDetailController({ storage: null });
    const { hud, provider } = mount({ detail: { document, controller } });
    const chip = provider.parentElement!;
    const rail = () => hud.element.querySelector(".map-detail-control")!;
    expect(hud.element.firstElementChild).toBe(rail());
    expect(rail().nextElementSibling).toBe(chip);

    hud.setDetailPlacement("inside");
    expect(chip.firstElementChild).toBe(rail());
    expect(rail().nextElementSibling).toBe(provider);
    expect(hud.element.dataset.mapDetailPlacement).toBe("inside");

    hud.setDetailPlacement("beside");
    expect(hud.element.firstElementChild).toBe(rail());
    expect(chip.contains(rail())).toBe(false);
    expect(() => hud.setDetailPlacement("above" as never)).toThrow(RangeError);
    hud.destroy();
  });
});
