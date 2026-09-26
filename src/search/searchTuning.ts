import { getAppSettings } from "../settings/appSettings";
import { SEARCH_DEFAULTS, type SearchTuning } from "./searchDefaults";

function positive(id: string, fallback: number): number {
  const value = getAppSettings().get(id);
  return typeof value === "number" && value > 0 ? value : fallback;
}

/** The `search.*` parameters now, read at each lookup. */
export function searchTuning(): SearchTuning {
  return {
    cacheMs: positive("search.cacheDuration", SEARCH_DEFAULTS.cacheHours) * 3_600_000,
    cacheEntries: Math.max(1, Math.round(positive("search.cacheEntries", SEARCH_DEFAULTS.cacheEntries))),
    timeoutMs: positive("search.timeout", SEARCH_DEFAULTS.timeoutSeconds) * 1000,
  };
}
