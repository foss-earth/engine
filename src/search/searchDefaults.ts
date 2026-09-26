// A leaf module: the settings catalogue reads these defaults, so it imports nothing.

/** Location and airport lookups: `search.cacheDuration`, `search.cacheEntries` and `search.timeout`'s defaults. */
export const SEARCH_DEFAULTS = Object.freeze({
  /** How long an answer is kept, hours. */
  cacheHours: 24,
  /** How many answers each lookup keeps. */
  cacheEntries: 64,
  /** How long one request may take, seconds. */
  timeoutSeconds: 20,
});

/** What the search reads: the app's `search.*` parameters. */
export interface SearchTuning {
  cacheMs: number;
  cacheEntries: number;
  timeoutMs: number;
}
