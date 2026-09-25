import {
  DEFAULT_RASTER_BASE_MAP_ID,
  isKnownRasterBaseMapId,
  resolveRasterBaseMapSource,
  type RasterBaseMapSource,
} from "./rasterBaseMaps";
import { resolveTerrainSource, type TerrainSource } from "../../terrain/terrainTiles";
import type { RasterQualitySetting } from "./rasterQuality";

export interface MapRuntimeConfig {
  googleApiKey: string | null;
  rasterBaseMap: RasterBaseMapSource;
  terrainSource: TerrainSource;
  rasterQuality: RasterQualitySetting;
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
  rasterQuality?: RasterQualitySetting | null;
  rasterImagery?: RasterImageryMode | null;
  searchParams?: URLSearchParams;
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

export function setMapSourcePreference(source: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("mapSource", source);
  window.history.replaceState(null, "", url);
}

export function getTerrainSourcePreferenceFromSearchParams(searchParams: URLSearchParams): string | null {
  const value = (searchParams.get("elevationSource") ?? searchParams.get("terrainSource") ?? "").trim().toLowerCase();
  return value || null;
}

export function setTerrainSourcePreference(source: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("elevationSource", source);
  window.history.replaceState(null, "", url);
}

export function getRasterQualityPreferenceFromSearchParams(searchParams: URLSearchParams): RasterQualitySetting {
  const value = (searchParams.get("terrainQuality") ?? "").trim().toLowerCase();
  return value === "low" || value === "balanced" || value === "high" || value === "auto" ? value : "auto";
}

/** A development and rollback switch: `?rasterImagery=atlas` or `legacy`; anything else is the default. */
export function getRasterImageryPreferenceFromSearchParams(searchParams: URLSearchParams): RasterImageryMode {
  const value = (searchParams.get("rasterImagery") ?? "").trim().toLowerCase();
  return value === "atlas" || value === "legacy" ? value : DEFAULT_RASTER_IMAGERY;
}

export function setRasterQualityPreference(setting: RasterQualitySetting): void {
  const url = new URL(window.location.href);
  url.searchParams.set("terrainQuality", setting);
  window.history.replaceState(null, "", url);
}

export function resolveMapRuntimeConfig(
  options: ResolveMapRuntimeConfigOptions = {},
): MapRuntimeConfig {
  const searchParams = options.searchParams ?? new URLSearchParams(window.location.search);
  const configuredBaseMap = resolveRasterBaseMapSource(options.baseMap ?? DEFAULT_RASTER_BASE_MAP_ID);
  const sourcePreference = getMapSourcePreferenceFromSearchParams(searchParams);
  const urlGoogleApiKey = options.googleApiKey ?? getGoogleApiKeyFromSearchParams(searchParams);
  const preferGoogleTiles = options.preferGoogleTiles !== false;
  const shouldUseGoogle = sourcePreference === "google"
    || (!sourcePreference && preferGoogleTiles && Boolean(urlGoogleApiKey));

  return {
    // Keep the key available while a flat map is selected so a live switch
    // back to Google tiles does not need to reconstruct the application.
    googleApiKey: urlGoogleApiKey,
    rasterBaseMap: shouldUseGoogle
      ? configuredBaseMap
      : resolveRasterBaseMapSource(sourcePreference ?? configuredBaseMap),
    terrainSource: resolveTerrainSource(options.terrainSource ?? getTerrainSourcePreferenceFromSearchParams(searchParams)),
    rasterQuality: options.rasterQuality ?? getRasterQualityPreferenceFromSearchParams(searchParams),
    rasterImagery: options.rasterImagery ?? getRasterImageryPreferenceFromSearchParams(searchParams),
    preferGoogleTiles: shouldUseGoogle,
  };
}

export function getActiveMapSourceId(
  status: { mode: string; rasterBaseMap: RasterBaseMapSource | null },
): string {
  if (status.mode === "google-tiles") return "google";
  return status.rasterBaseMap?.id ?? DEFAULT_RASTER_BASE_MAP_ID;
}
