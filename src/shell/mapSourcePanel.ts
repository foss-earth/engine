import type { BabylonRuntimeStatus } from "../engine/babylon/createBabylonRuntime";
import { getAppSettings } from "../settings/appSettings";
import type { SettingsRegistry } from "../settings/registry";
import { checkChoice, createChoiceGroup, createChoiceNote, type Choice } from "./choiceGroup";
import { createMapCacheSection } from "./mapCacheSection";
import { MAP_DETAIL_PARAMETER_IDS, type MapDetailController } from "./mapDetailController";
import { createMapDetailPanel, type MapDetailPanelHandle } from "./mapDetailPanel";
import { GOOGLE_3D_TILES } from "./mapSourceHud";
import { appendHostSections, createParameterSection, createSectionsElement } from "./settings/parameterSection";

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
  /** The app's detail controller, edited in the tab's Detail section. Left out, there is none. */
  detail?: MapDetailController;
  /** The registry of the tab's parameters: the detail controller's, or the app's. */
  settings?: SettingsRegistry;
}

export type MapSourceStatus = Pick<BabylonRuntimeStatus, "mode" | "rasterBaseMap" | "terrainSource">;

export interface MapSourcePanelHandle {
  element: HTMLElement;
  /** Marks what the runtime is using. Cheap enough to call every frame. */
  update(status: MapSourceStatus): void;
  destroy(): void;
}

/** The Map tab's own sections; hosts' sections for the tab follow them. */
const MAP_SECTIONS = ["source", "detail", "loading"] as const;

/**
 * The contents of the Map tab, one collapsible section per group: Source (a
 * 3D basemap, which brings its own terrain, or a 2D basemap draped over the
 * chosen elevation provider, and their keys), Detail, Loading and memory, and
 * any section a host's parameters are homed in.
 */
export function createMapSourcePanel(options: MapSourcePanelOptions): MapSourcePanelHandle {
  const settings = options.settings ?? options.detail?.settings ?? getAppSettings();
  const sourceChoices = document.createElement("div");
  sourceChoices.className = "foss-earth-choice-panel";

  // The source in use, basemap and elevation provider alike, ends its pill with
  // a link to its attribution page.
  const threeD = createChoiceGroup(MAP_SOURCE_CHOICE_NAME, "3D basemaps", [{ id: "google", label: GOOGLE_3D_TILES.name, creditUrl: GOOGLE_3D_TILES.attributionUrl }]);
  const terrainIncluded = createChoiceNote("Terrain is included. No elevation provider is used.");
  threeD.append(terrainIncluded);
  const twoD = createChoiceGroup(MAP_SOURCE_CHOICE_NAME, "2D basemaps", options.rasterSources.map(({ id, label, attributionUrl }) => ({ id, label, creditUrl: attributionUrl })));
  sourceChoices.append(threeD, twoD);
  const terrainSources = options.onTerrainSourceChange ? options.terrainSources ?? [] : [];
  const elevation = terrainSources.length > 0
    ? createChoiceGroup(ELEVATION_CHOICE_NAME, "Elevation provider", terrainSources.map(({ id, label, attribution }) => ({ id, label, creditUrl: attribution })))
    : null;
  if (elevation) sourceChoices.append(elevation);
  const element = sourceChoices;
  const sourceSection = createParameterSection(settings, { tab: "map", section: "source", main: sourceChoices, covers: ["map.source.basemap", "map.source.elevation"] });
  const detail: MapDetailPanelHandle | null = options.detail ? createMapDetailPanel(options.detail, { heading: false }) : null;
  const detailSection = createParameterSection(settings, {
    tab: "map",
    section: "detail",
    main: detail?.element,
    covers: detail ? Object.values(MAP_DETAIL_PARAMETER_IDS).flatMap(ids => [ids.range, ids.default]) : [],
  });
  const cache = createMapCacheSection();
  const loading = createParameterSection(settings, { tab: "map", section: "loading", main: cache.element });
  const sections = createSectionsElement([
    { id: "map.source", title: settings.getSectionTitle("map", "source"), element: sourceSection.element, defaultOpen: true },
    { id: "map.detail", title: settings.getSectionTitle("map", "detail"), element: detailSection.element, defaultOpen: true },
    { id: "map.loading", title: settings.getSectionTitle("map", "loading"), element: loading.element, defaultOpen: false },
  ]);
  const hostSections = appendHostSections(settings, "map", sections, MAP_SECTIONS);

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
    element: sections.element,
    update,
    destroy(): void {
      element.removeEventListener("change", onChange);
      detail?.destroy();
      sourceSection.destroy();
      detailSection.destroy();
      cache.destroy();
      loading.destroy();
      hostSections.destroy();
      sections.destroy();
    },
  };
}
