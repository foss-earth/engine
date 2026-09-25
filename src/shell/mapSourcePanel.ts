import type { BabylonRuntimeStatus } from "../engine/babylon/createBabylonRuntime";
import { checkChoice, createChoiceGroup, createChoiceNote, type Choice } from "./choiceGroup";
import type { MapDetailController } from "./mapDetailController";
import { createMapDetailPanel, type MapDetailPanelHandle } from "./mapDetailPanel";
import { GOOGLE_3D_TILES } from "./mapSourceHud";

const MAP_SOURCE_CHOICE_NAME = "foss-earth-map-source";
const ELEVATION_CHOICE_NAME = "foss-earth-elevation-source";

export interface MapSourcePanelOptions {
  /** The 2D basemaps, each with its attribution page. */
  rasterSources: readonly (Choice & { attributionUrl?: string })[];
  /** Elevation providers for the 2D basemaps, each with its attribution page. Leave out to offer none. */
  terrainSources?: readonly (Choice & { attribution?: string })[];
  /** "google" for Google 3D Tiles, or a raster source id. */
  onMapSourceChange(sourceId: string): void;
  onTerrainSourceChange?(sourceId: string): void;
  /** The app's detail controller, edited in the tab's Detail group. Left out, there is none. */
  detail?: MapDetailController;
}

export type MapSourceStatus = Pick<BabylonRuntimeStatus, "mode" | "rasterBaseMap" | "terrainSource">;

export interface MapSourcePanelHandle {
  element: HTMLElement;
  /** Marks what the runtime is using. Cheap enough to call every frame. */
  update(status: MapSourceStatus): void;
  destroy(): void;
}

/**
 * The contents of the Map tab: a 3D basemap, which brings its own terrain, or
 * a 2D basemap draped over the chosen elevation provider.
 */
export function createMapSourcePanel(options: MapSourcePanelOptions): MapSourcePanelHandle {
  const element = document.createElement("div");
  element.className = "foss-earth-choice-panel";

  // The source in use, basemap and elevation provider alike, ends its pill with
  // a link to its attribution page.
  const threeD = createChoiceGroup(MAP_SOURCE_CHOICE_NAME, "3D basemaps", [{ id: "google", label: GOOGLE_3D_TILES.name, creditUrl: GOOGLE_3D_TILES.attributionUrl }]);
  const terrainIncluded = createChoiceNote("Terrain is included. No elevation provider is used.");
  threeD.append(terrainIncluded);
  const twoD = createChoiceGroup(MAP_SOURCE_CHOICE_NAME, "2D basemaps", options.rasterSources.map(({ id, label, attributionUrl }) => ({ id, label, creditUrl: attributionUrl })));
  element.append(threeD, twoD);
  const terrainSources = options.onTerrainSourceChange ? options.terrainSources ?? [] : [];
  const elevation = terrainSources.length > 0
    ? createChoiceGroup(ELEVATION_CHOICE_NAME, "Elevation provider", terrainSources.map(({ id, label, attribution }) => ({ id, label, creditUrl: attribution })))
    : null;
  if (elevation) element.append(elevation);
  const detail: MapDetailPanelHandle | null = options.detail ? createMapDetailPanel(options.detail) : null;
  if (detail) element.append(detail.element);

  let shown: string | null = null;
  const update = (status: MapSourceStatus): void => {
    const source = status.mode === "google-tiles" ? "google" : status.mode === "raster-basemap" ? status.rasterBaseMap?.id ?? null : null;
    const terrain = status.terrainSource?.id ?? null;
    const key = `${status.mode}|${source}|${terrain}`;
    if (key === shown) return;
    shown = key;
    checkChoice(element, MAP_SOURCE_CHOICE_NAME, source);
    checkChoice(element, ELEVATION_CHOICE_NAME, terrain);
    terrainIncluded.hidden = status.mode !== "google-tiles";
    if (elevation) elevation.hidden = status.mode !== "raster-basemap";
  };

  const onChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    // Show the runtime's answer on the next update, even if it refuses the switch.
    shown = null;
    if (input.name === MAP_SOURCE_CHOICE_NAME) options.onMapSourceChange(input.value);
    else if (input.name === ELEVATION_CHOICE_NAME) options.onTerrainSourceChange?.(input.value);
  };
  element.addEventListener("change", onChange);

  return {
    element,
    update,
    destroy(): void {
      element.removeEventListener("change", onChange);
      detail?.destroy();
      element.remove();
    },
  };
}
