import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { createMapCache } from "../browser/mapCache.js";

/** The supplied existing Engine cache; presentation creates no storage service. */
export type MapCacheAccess = Pick<ReturnType<typeof createMapCache>, "inspect" | "clear">;
export interface MapCachePresentationRefresh { subscribe(listener: () => void): () => void }
export interface MapCachePresentationVisibility {
  isVisible(): boolean;
  /** Notify on host tab/content visibility changes, using its existing authority. */
  subscribe(listener: () => void): () => void;
}
export interface MapCachePresentationPolicy { rowLimit(): number; refreshIntervalMs(): number }
/** Original React and DOM source values, now visible host policy. */
export const MAP_CACHE_PRESENTATION_DEFAULTS = { rowsShown: 40, inspectIntervalMs: 2000 } as const;
export const MAP_CACHE_PRESENTATION_IDS = { rowsShown: "map.cache.rowsShown", inspectIntervalMs: "map.cache.inspectInterval" } as const;

export function mapCacheRowLimit(value: number): number {
  return Number.isFinite(value) ? Math.min(4096, Math.max(1, Math.floor(value))) : MAP_CACHE_PRESENTATION_DEFAULTS.rowsShown;
}
export function mapCacheRefreshInterval(value: number): number {
  return Number.isFinite(value) ? Math.min(60000, Math.max(250, value)) : MAP_CACHE_PRESENTATION_DEFAULTS.inspectIntervalMs;
}
/** Read the one host registry live; no catalogue registration or default registry. */
export function createMapCachePresentationPolicy(settings: Pick<SettingsRegistry, "get">): MapCachePresentationPolicy {
  return {
    rowLimit: () => {
      const value = settings.get(MAP_CACHE_PRESENTATION_IDS.rowsShown);
      return mapCacheRowLimit(typeof value === "number" ? value : MAP_CACHE_PRESENTATION_DEFAULTS.rowsShown);
    },
    refreshIntervalMs: () => {
      const value = settings.get(MAP_CACHE_PRESENTATION_IDS.inspectIntervalMs);
      return mapCacheRefreshInterval(typeof value === "number" ? value : MAP_CACHE_PRESENTATION_DEFAULTS.inspectIntervalMs);
    },
  };
}
