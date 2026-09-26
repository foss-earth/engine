import {
  DEFAULT_RASTER_BASE_MAP_ID,
  isKnownRasterBaseMapId,
  resolveRasterBaseMapSource,
  type RasterBaseMapSource,
} from "./rasterBaseMaps";
import { resolveTerrainSource, type TerrainSource } from "../../terrain/terrainTiles";
import { getAppSettings } from "../../settings/appSettings";
import { FOSS_EARTH_PARAMETERS, fossEarthUrlAliases } from "../../settings/catalogue";
import { createSettingsRegistry, type SettingsRegistry } from "../../settings/registry";

export interface MapRuntimeConfig {
  googleApiKey: string | null;
  rasterBaseMap: RasterBaseMapSource;
  terrainSource: TerrainSource;
  /**
   * @deprecated Always undefined: the quality profiles are retired, and
   * `?terrainQuality` sets `map.detail.terrain.*` for the visit instead.
   */
  rasterQuality?: undefined;
  /** How 2D basemap imagery is selected and drawn; see RasterImageryMode. */
  rasterImagery: RasterImageryMode;
  preferGoogleTiles: boolean;
}

/**
 * "atlas" selects 2D imagery by its projected pixel size, independently of
 * terrain; "legacy" binds one image to each terrain tile.
 */
export type RasterImageryMode = "atlas" | "legacy";

/**
 * Projected imagery, released with the evidence in
 * validation/evidence/map-detail/. `?rasterImagery=legacy` rolls back.
 */
export const DEFAULT_RASTER_IMAGERY: RasterImageryMode = "atlas";

export interface ResolveMapRuntimeConfigOptions {
  googleApiKey?: string | null;
  baseMap?: string | RasterBaseMapSource | null;
  preferGoogleTiles?: boolean;
  terrainSource?: string | TerrainSource | null;
  /** @deprecated Ignored: see MapRuntimeConfig.rasterQuality. */
  rasterQuality?: unknown;
  rasterImagery?: RasterImageryMode | null;
  /**
   * A query to read instead of the page's, in a registry of its own: for tests
   * and previews. Omitted, the app's registry, which read the page's query.
   */
  searchParams?: URLSearchParams;
  /** The registry to read and to give the app's defaults to; the app's when omitted. */
  settings?: SettingsRegistry;
}

export function getGoogleApiKeyFromSearchParams(searchParams: URLSearchParams): string | null {
  const key = searchParams.get("key") ?? searchParams.get("googleKey");
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getMapSourcePreferenceFromSearchParams(searchParams: URLSearchParams): string | null {
  const value = (searchParams.get("mapSource") ?? searchParams.get("tiles") ?? "").trim().toLowerCase();
  if (value === "google" || value === "google-3d-tiles") return "google";
  if (value === "fallback" || value === "fallback-globe") return DEFAULT_RASTER_BASE_MAP_ID;
  if (isKnownRasterBaseMapId(value)) return value;
  return null;
}

/** Drops query parameters a saved choice replaces, so a reload does not bring the old one back. */
function dropUrlParameters(names: readonly string[]): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of names) {
    if (url.searchParams.has(name)) { url.searchParams.delete(name); changed = true; }
  }
  if (changed) window.history.replaceState(window.history.state, "", url);
}

/** Saves the basemap choice, `map.source.basemap`: "google" or a raster source id. */
export function setMapSourcePreference(source: string, settings: SettingsRegistry = getAppSettings()): void {
  settings.set("map.source.basemap", source);
  dropUrlParameters(["mapSource", "tiles", `set.map.source.basemap`]);
}

export function getTerrainSourcePreferenceFromSearchParams(searchParams: URLSearchParams): string | null {
  const value = (searchParams.get("elevationSource") ?? searchParams.get("terrainSource") ?? "").trim().toLowerCase();
  return value || null;
}

/** Saves the elevation provider, `map.source.elevation`. */
export function setTerrainSourcePreference(source: string, settings: SettingsRegistry = getAppSettings()): void {
  settings.set("map.source.elevation", source);
  dropUrlParameters(["elevationSource", "terrainSource", "set.map.source.elevation"]);
}

/** A development and rollback switch: `?rasterImagery=atlas` or `legacy`; anything else is the default. */
export function getRasterImageryPreferenceFromSearchParams(searchParams: URLSearchParams): RasterImageryMode {
  const value = (searchParams.get("rasterImagery") ?? "").trim().toLowerCase();
  return value === "atlas" || value === "legacy" ? value : DEFAULT_RASTER_IMAGERY;
}

function registryFor(options: ResolveMapRuntimeConfigOptions): SettingsRegistry {
  if (options.settings) return options.settings;
  if (!options.searchParams) return getAppSettings();
  const isolated = createSettingsRegistry({ storage: null, searchParams: options.searchParams, urlAliases: fossEarthUrlAliases });
  isolated.register(FOSS_EARTH_PARAMETERS);
  return isolated;
}

/**
 * The map the runtime starts with, from the `map.source.*` and
 * `map.detail.imageryPath` parameters. The host's options become the app's
 * defaults: a Google key makes Google 3D Tiles the default basemap, and a host
 * basemap the default 2D one. A saved or URL choice still wins.
 */
export function resolveMapRuntimeConfig(
  options: ResolveMapRuntimeConfigOptions = {},
): MapRuntimeConfig {
  const settings = registryFor(options);
  const configuredBaseMap = resolveRasterBaseMapSource(options.baseMap ?? DEFAULT_RASTER_BASE_MAP_ID);
  const savedKey = settings.get("map.source.googleKey");
  const googleApiKey = options.googleApiKey?.trim() || (typeof savedKey === "string" && savedKey.trim() ? savedKey.trim() : null);
  const preferGoogleTiles = options.preferGoogleTiles !== false;
  if (preferGoogleTiles && googleApiKey) {
    settings.setHostDefault("map.source.basemap", "google", "a Google Maps API key was given");
  } else if (options.baseMap && isKnownRasterBaseMapId(configuredBaseMap.id)) {
    settings.setHostDefault("map.source.basemap", configuredBaseMap.id, "the app's basemap");
  }
  const selected = String(settings.get("map.source.basemap"));
  const shouldUseGoogle = selected === "google";
  const imagery = settings.get("map.detail.imageryPath");

  return {
    // Keep the key available while a flat map is selected so a live switch
    // back to Google tiles does not need to reconstruct the application.
    googleApiKey,
    rasterBaseMap: selected === "google"
      ? configuredBaseMap
      : isKnownRasterBaseMapId(selected) ? resolveRasterBaseMapSource(selected) : configuredBaseMap,
    terrainSource: resolveTerrainSource(options.terrainSource ?? String(settings.get("map.source.elevation"))),
    rasterImagery: options.rasterImagery ?? (imagery === "legacy" ? "legacy" : DEFAULT_RASTER_IMAGERY),
    preferGoogleTiles: shouldUseGoogle,
  };
}

export function getActiveMapSourceId(
  status: { mode: string; rasterBaseMap: RasterBaseMapSource | null },
): string {
  if (status.mode === "google-tiles") return "google";
  return status.rasterBaseMap?.id ?? DEFAULT_RASTER_BASE_MAP_ID;
}
