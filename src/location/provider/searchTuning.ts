import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { SEARCH_DEFAULTS, type SearchTuning } from "./searchDefaults.js";

function positive(settings: Pick<SettingsRegistry, "get">, id: string, fallback: number): number {
  const value = settings.get(id);
  return typeof value === "number" && value > 0 ? value : fallback;
}

/** The `search.*` parameters now, read at each lookup. */
export function readLocationSearchTuning(settings: Pick<SettingsRegistry, "get">): SearchTuning {
  return {
    cacheMs: positive(settings, "search.cacheDuration", SEARCH_DEFAULTS.cacheHours) * 3_600_000,
    cacheEntries: Math.max(1, Math.round(positive(settings, "search.cacheEntries", SEARCH_DEFAULTS.cacheEntries))),
    timeoutMs: positive(settings, "search.timeout", SEARCH_DEFAULTS.timeoutSeconds) * 1000,
  };
}

/** Bind the one host registry; values are read afresh at every lookup. */
export function createLocationSearchTuning(settings: Pick<SettingsRegistry, "get">): () => SearchTuning {
  return () => readLocationSearchTuning(settings);
}
