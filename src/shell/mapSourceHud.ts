import type { BabylonRuntimeStatus } from "../engine/babylon/createBabylonRuntime";
import { createExternalLinkIcon } from "./externalLinkIcon";
import { createMapDetailSlider, type MapDetailSliderHandle, type MapDetailSliderOptions } from "./mapDetailSlider";
import { attachMapDownloadSpeed, setMapSourceLabel, type MapDownloadSource } from "./mapDownloadHud";
import { attachTileStreamingActivity, type TileStreamingSource } from "./rendererActivity";

export const GOOGLE_3D_TILES = {
  name: "Google 3D Tiles",
  credit: "Google",
  attributionUrl: "https://www.google.com/help/legalnotices_maps/",
};

export interface MapSourceHudOptions {
  /** Download speed and tile streaming, as the runtime reports them. */
  activity: MapDownloadSource & TileStreamingSource;
  /** The provider's name toggles the host's Map tab, where the basemap is chosen. */
  onProviderClick(): void;
  /** The detail rail, driven by the app's detail controller. Left out, there is none. */
  detail?: MapDetailSliderOptions;
}

export type MapSourceHudStatus = Pick<BabylonRuntimeStatus, "mode" | "rasterBaseMap" | "lastError" | "displayedRasterBaseMap">;

export interface MapSourceHudHandle {
  element: HTMLElement;
  /** Shows the runtime's provider and refreshes the detail rail. Cheap enough for every frame. */
  update(status: MapSourceHudStatus): void;
  destroy(): void;
}

interface Provider {
  name: string;
  credit: string | null;
  attributionUrl: string | null;
  logo: string | null;
  wordmark: { onDark: string; onLight: string; label: string } | null;
}

function providerFor(status: MapSourceHudStatus): Provider {
  if (status.mode === "google-tiles") return { ...GOOGLE_3D_TILES, logo: null, wordmark: null };
  if (status.mode === "raster-basemap") {
    // Credit the imagery on screen, which lags a switch until the new source can show.
    const source = status.displayedRasterBaseMap ?? status.rasterBaseMap;
    return {
      name: source?.label ?? "Raster Basemap",
      credit: source?.attribution ?? null,
      attributionUrl: source?.attributionUrl ?? null,
      logo: source?.logo ?? null,
      wordmark: source?.wordmark ?? null,
    };
  }
  return { name: "Fallback Globe", credit: null, attributionUrl: null, logo: null, wordmark: null };
}

/**
 * The bottom-right end of the HUD bar: the detail rail, then a chip of two
 * halves. The first is one button, the download speed and the basemap's logo
 * and name, that toggles the Map tab; the second links to how the provider
 * asks to be credited. Mount it in the bar's last slot so the bar wraps
 * around it.
 */
export function createMapSourceHud(container: HTMLElement, options: MapSourceHudOptions): MapSourceHudHandle {
  const element = document.createElement("span");
  element.className = "map-source-hud";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Map source");

  const chip = document.createElement("span");
  chip.className = "hud-chip map-source-hud__chip";
  const provider = document.createElement("button");
  provider.type = "button";
  provider.className = "map-source-hud__provider";
  provider.title = "Basemap. Click to show or hide the Map tab.";
  const logo = document.createElement("img");
  logo.className = "map-source-hud__logo";
  logo.alt = "";
  logo.hidden = true;
  const label = document.createElement("span");
  label.className = "map-source-label";
  // A wordmark stands in for the mark and the provider's name, and the label
  // after it keeps only the basemap's own. The theme picks the provider's
  // artwork for a dark or a light chip.
  const wordmark = document.createElement("span");
  wordmark.className = "map-source-hud__wordmark";
  wordmark.hidden = true;
  const wordmarkOnDark = document.createElement("img");
  wordmarkOnDark.className = "map-source-hud__wordmark-on-dark";
  wordmarkOnDark.alt = "";
  const wordmarkOnLight = document.createElement("img");
  wordmarkOnLight.className = "map-source-hud__wordmark-on-light";
  wordmarkOnLight.alt = "";
  wordmark.append(wordmarkOnDark, wordmarkOnLight);
  provider.append(logo, wordmark, label);
  const credit = document.createElement("a");
  credit.className = "map-source-hud__credit";
  credit.target = "_blank";
  credit.rel = "noopener noreferrer";
  credit.append(createExternalLinkIcon());
  chip.append(provider, credit);
  element.append(chip);
  container.append(element);

  // The speed leads the button, so it highlights and opens the Map tab with the name.
  const detachDownloadSpeed = attachMapDownloadSpeed(provider, options.activity);
  const speed = provider.querySelector(".map-download-speed");
  if (speed) provider.prepend(speed);
  const detachStreaming = attachTileStreamingActivity(chip, options.activity);
  const detail: MapDetailSliderHandle | null = options.detail ? createMapDetailSlider(options.detail) : null;
  // The rail sits left of the chip, so the chip ends flush in the corner.
  if (detail) element.prepend(detail.element);

  let shown = "";
  const update = (status: MapSourceHudStatus): void => {
    detail?.update();
    const current = providerFor(status);
    const name = status.lastError ? `${current.name} warning` : current.name;
    const key = [status.mode, name, current.attributionUrl, current.logo, current.wordmark?.onDark].join("|");
    if (key === shown) return;
    shown = key;
    const shortName = current.wordmark ? current.wordmark.label : current.name;
    setMapSourceLabel(provider, status.lastError ? `${shortName} warning` : shortName);
    provider.setAttribute("aria-label", `Basemap: ${name}. Show or hide the Map tab`);
    provider.title = `${name}. Click to show or hide the Map tab.`;
    wordmark.hidden = current.wordmark === null;
    if (current.wordmark) {
      wordmarkOnDark.src = current.wordmark.onDark;
      wordmarkOnLight.src = current.wordmark.onLight;
    }
    logo.hidden = current.logo === null || current.wordmark !== null;
    if (current.logo) logo.src = current.logo;
    else logo.removeAttribute("src");
    credit.hidden = current.attributionUrl === null;
    if (current.attributionUrl) {
      credit.href = current.attributionUrl;
      credit.title = `Map data: ${current.credit ?? current.name}. Opens its attribution page.`;
      credit.setAttribute("aria-label", `${current.name} attribution, opens in a new tab`);
    } else {
      credit.removeAttribute("href");
    }
    chip.classList.toggle("hud-chip--fallback", status.mode === "fallback");
    chip.classList.toggle("hud-chip--raster", status.mode === "raster-basemap");
  };

  provider.addEventListener("click", options.onProviderClick);

  return {
    element,
    update,
    destroy(): void {
      provider.removeEventListener("click", options.onProviderClick);
      detachDownloadSpeed();
      detachStreaming();
      detail?.destroy();
      element.remove();
    },
  };
}
