import type { RasterBaseMapSource } from "./rasterBaseMaps.js";
import type { TerrainSource } from "../terrain/terrainGrid.js";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { checkChoice, createChoiceGroup, createChoiceNote, createHelpTooltip, createIconButton, Choice, appendHostSections, createParameterSection, createSectionsElement, ParameterSectionOptions } from "@foss-earth/ui/browser";
import { createMapCacheSection, type MapCacheSectionPorts } from "./mapCacheSection.js";
import { MAP_DETAIL_PARAMETER_IDS, type MapDetailController } from "./mapDetailController.js";
import { createMapDetailPanel, type MapDetailPanelHandle } from "./mapDetailPanel.js";
const GOOGLE_3D_TILES = { name: "Google 3D Tiles", attributionUrl: "https://www.google.com/help/legalnotices_maps/" };
export interface MapSourceUiPorts {
  checkChoice: typeof checkChoice; createChoiceGroup: typeof createChoiceGroup; createChoiceNote: typeof createChoiceNote;
  appendHostSections: typeof appendHostSections; createParameterSection: typeof createParameterSection; createSectionsElement: typeof createSectionsElement;
  createHelpTooltip: typeof createHelpTooltip; createIconButton: typeof createIconButton;
}

const MAP_SOURCE_CHOICE_NAME = "foss-earth-map-source";
const ELEVATION_CHOICE_NAME = "foss-earth-elevation-source";

export interface MapSourcePanelOptions {
  document: Document;
  InputElement: typeof HTMLInputElement;
  ui: MapSourceUiPorts;
  /** One host presentation pulse, also shared by parameter and cache sections. */
  refresh: NonNullable<ParameterSectionOptions["refresh"]>;
  panelStorage: ParameterSectionOptions["panelStorage"];
  cache: Omit<MapCacheSectionPorts, "document" | "refresh" | "createHelpTooltip" | "createIconButton">;
  detailPanel: Omit<Parameters<typeof createMapDetailPanel>[1], "document" | "heading" | "createChoiceGroup" | "createHelpTooltip" | "createIconButton">;
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
  settings: SettingsRegistry;
}

export interface MapSourceStatus { mode: "google-tiles" | "raster-basemap" | "fallback"; rasterBaseMap: RasterBaseMapSource | null; terrainSource: TerrainSource | null }

export interface MapSourcePanelHandle {
  element: HTMLElement;
  /** Marks what the runtime is using. Cheap enough to call every frame. */
  update(status: MapSourceStatus): void;
  destroy(): void;
}

/** The Map tab's own sections; hosts' sections for the tab follow them. */
const MAP_SECTIONS = ["source", "detail", "auto", "loading", "selection", "terrain-selection"] as const;

/**
 * The contents of the Map tab, one collapsible section per group: Source (a
 * 3D basemap, which brings its own terrain, or a 2D basemap draped over the
 * chosen elevation provider, and their keys), Detail, Loading and memory, and
 * any section a host's parameters are homed in.
 */
export function createMapSourcePanel(options: MapSourcePanelOptions): MapSourcePanelHandle {
  const settings = options.settings;
  const document = options.document;
  const { checkChoice, createChoiceGroup, appendHostSections, createParameterSection, createSectionsElement, createHelpTooltip, createIconButton } = options.ui;
  const sourceChoices = document.createElement("div");
  sourceChoices.className = "foss-earth-choice-panel";

  // One decision, one track: the 3D basemap, then the 2D ones. The source in
  // use, basemap and elevation provider alike, ends its segment with a link to
  // its attribution page.
  const terrainIncluded = document.createElement("span");
  terrainIncluded.textContent = "Terrain included";
  const basemap = createChoiceGroup(MAP_SOURCE_CHOICE_NAME, "Basemap", [
    { id: "google", label: GOOGLE_3D_TILES.name, creditUrl: GOOGLE_3D_TILES.attributionUrl },
    ...options.rasterSources.map(({ id, label, attributionUrl }) => ({ id, label, creditUrl: attributionUrl })),
  ], document, {
    status: terrainIncluded,
    help: `${GOOGLE_3D_TILES.name} is a 3D basemap: it brings its own terrain, so no elevation provider is used. The others are 2D basemaps, draped over the elevation provider. The link at the end of the chosen basemap opens its attribution page.`,
  });
  sourceChoices.append(basemap);
  const terrainSources = options.onTerrainSourceChange ? options.terrainSources ?? [] : [];
  const elevation = terrainSources.length > 0
    ? createChoiceGroup(ELEVATION_CHOICE_NAME, "Elevation", terrainSources.map(({ id, label, attribution }) => ({ id, label, creditUrl: attribution })), document, {
      help: "The heights a 2D basemap is draped over. The link at the end of the chosen provider opens its attribution page.",
      helpLabel: "Explain the elevation provider",
    })
    : null;
  if (elevation) sourceChoices.append(elevation);
  const element = sourceChoices;
  const sourceSection = createParameterSection(settings, { document, refresh: options.refresh, panelStorage: options.panelStorage, tab: "map", section: "source", main: sourceChoices, covers: ["map.source.basemap", "map.source.elevation"] });
  const detail: MapDetailPanelHandle | null = options.detail ? createMapDetailPanel(options.detail, { ...options.detailPanel, document, heading: false, createChoiceGroup, createHelpTooltip, createIconButton }) : null;
  const detailSection = createParameterSection(settings, { document, refresh: options.refresh, panelStorage: options.panelStorage,
    tab: "map",
    section: "detail",
    main: detail?.element,
    covers: detail ? Object.values(MAP_DETAIL_PARAMETER_IDS).flatMap(ids => [ids.range, ids.default]) : [],
  });
  // The budgets first, each beside what it bounds; then what the tile cache holds.
  const cache = createMapCacheSection({ ...options.cache, document, refresh: options.refresh, createHelpTooltip, createIconButton });
  const loading = createParameterSection(settings, { document, refresh: options.refresh, panelStorage: options.panelStorage, tab: "map", section: "loading", footer: cache.element });
  // What each section is for is behind the ? at the end of its title.
  const selection = createParameterSection(settings, { document, refresh: options.refresh, panelStorage: options.panelStorage, tab: "map", section: "selection" });
  const auto = createParameterSection(settings, { document, refresh: options.refresh, panelStorage: options.panelStorage, tab: "map", section: "auto" });
  const terrainSelection = createParameterSection(settings, { document, refresh: options.refresh, panelStorage: options.panelStorage, tab: "map", section: "terrain-selection" });
  const sections = createSectionsElement([
    { id: "map.source", title: settings.getSectionTitle("map", "source"), element: sourceSection.element, defaultOpen: true },
    { id: "map.detail", title: settings.getSectionTitle("map", "detail"), element: detailSection.element, defaultOpen: true },
    { id: "map.auto", title: settings.getSectionTitle("map", "auto"), element: auto.element, defaultOpen: false,
      help: "When frames take longer than the goal, 2D basemap detail may coarsen, a step at a time, toward the coarse end of the ranges in Detail, and return once frames are fast again. It never goes finer than you asked for." },
    { id: "map.loading", title: settings.getSectionTitle("map", "loading"), element: loading.element, defaultOpen: false },
    { id: "map.selection", title: settings.getSectionTitle("map", "selection"), element: selection.element, defaultOpen: false,
      help: "How 2D imagery is chosen as the view moves: when a region refines or coarsens, and what stands in while finer imagery loads. The values are the selector's starting calibration." },
    { id: "map.terrain-selection", title: settings.getSectionTitle("map", "terrain-selection"), element: terrainSelection.element, defaultOpen: false,
      help: "How the terrain mesh of 2D basemaps is chosen: a tile splits while its geometric error, seen from the camera or the focus point, is larger on screen than the detail target." },
  ], { document, storage: options.panelStorage });
  const hostSections = appendHostSections(settings, "map", sections, MAP_SECTIONS, { document, panelStorage: options.panelStorage, refresh: options.refresh });

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
    if (!(input instanceof options.InputElement)) return;
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
      selection.destroy();
      auto.destroy();
      terrainSelection.destroy();
      hostSections.destroy();
      sections.destroy();
    },
  };
}
