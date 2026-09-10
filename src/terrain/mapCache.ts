/** HTTP-compliant, bounded storage for public tiles. Google stays in the browser HTTP cache. */
const BODY_CACHE = "foss-earth-map-tiles-v1";
const INDEX_CACHE = "foss-earth-map-index-v1";
const INDEX_URL = "https://foss-earth.invalid/map-cache/index";
export const MAP_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const MAX_TILE_BYTES = 8 * 1024 * 1024;

export interface MapCacheEntry { url: string; provider: string; bytes: number; storedAt: number; expiresAt: number }
export interface MapCacheSnapshot {
  available: boolean;
  entries: MapCacheEntry[];
  bytes: number;
  maxBytes: number;
  hits: number;
  browserRequests: Array<{ provider: string; requests: number }>;
}

function providerForUrl(url: string): string | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === "tile.googleapis.com") return "Google 3D Tiles";
    if (hostname === "tiles.mapterhorn.com") return "Mapterhorn elevation";
    if (hostname === "s3.amazonaws.com" && pathname.startsWith("/elevation-tiles-prod/")) return "AWS Terrarium elevation";
    if (hostname === "basemap.nationalmap.gov") return "USGS imagery / maps";
    if (hostname === "tile.openstreetmap.org") return "OpenStreetMap";
    if (hostname === "basemaps.cartocdn.com") return "CARTO";
    if (hostname === "tile.opentopomap.org") return "OpenTopoMap";
  } catch { /* Unsupported URLs use ordinary fetch. */ }
  return null;
}

/** Never persist keys, sessions, signed URLs, or user-provided provider endpoints. */
export function isPublicMapCacheUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.hostname !== "tile.googleapis.com" && providerForUrl(value) !== null;
  } catch { return false; }
}

/** Do not invent a TTL or extend an already-aged HTTP response's freshness. */
export function mapResponseExpiresAt(response: Response, receivedAt: number): number | null {
  if (!response.ok || response.status !== 200 || response.type === "opaque") return null;
  const control = response.headers.get("cache-control") ?? "";
  if (/\b(?:no-store|no-cache)\b/i.test(control)) return null;
  const maxAge = control.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i);
  if (!maxAge || Number(maxAge[1]) <= 0) return null;
  // Cross-origin Date and Age are not CORS-safelisted. Without both, freshness
  // cannot be calculated reliably (CDN tiles may already be several days old).
  // Let the browser enforce all HTTP headers in that case.
  if (!response.headers.has("date") || !response.headers.has("age")) return null;
  if (response.headers.get("vary")?.trim() === "*") return null;
  const date = Date.parse(response.headers.get("date") ?? "");
  const ageSeconds = Number(response.headers.get("age") ?? "0");
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return null;
  const age = Math.max(Number.isFinite(date) ? receivedAt - date : 0, ageSeconds * 1000);
  const expiresAt = receivedAt + Number(maxAge[1]) * 1000 - age;
  return Number.isFinite(expiresAt) && expiresAt > receivedAt ? expiresAt : null;
}

export function createMapCache(options: {
  storage?: () => CacheStorage | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
  maxBytes?: number;
  maxEntries?: number;
} = {}) {
  const storage = options.storage ?? (() => typeof caches === "undefined" ? undefined : caches);
  const fetcher: typeof fetch = options.fetcher ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? MAP_CACHE_MAX_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const entries = new Map<string, MapCacheEntry>();
  const browserRequests = new Map<string, number>();
  let initialized: Promise<void> | undefined;
  let bodyCache: Cache | undefined;
  let indexCache: Cache | undefined;
  let mutations = Promise.resolve();
  let generation = 0;
  let hits = 0;
  let pendingWrites = 0;
  const serialize = (task: () => Promise<void>) => {
    const pending = mutations.then(task);
    mutations = pending.catch(() => { /* Subsequent operations can retry after a storage failure. */ });
    return pending;
  };
  const saveIndex = async () => {
    await indexCache?.put(INDEX_URL, new Response(JSON.stringify([...entries.values()]), { headers: { "content-type": "application/json" } }));
  };
  async function remove(url: string) { entries.delete(url); await bodyCache?.delete(url, { ignoreVary: true }); }
  async function prune() {
    for (const entry of entries.values()) if (entry.expiresAt <= now()) await remove(entry.url);
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries.values()) {
      if (bytes <= maxBytes && entries.size <= maxEntries) break;
      await remove(entry.url);
      bytes -= entry.bytes;
    }
  }
  async function init() {
    initialized ??= (async () => {
      const available = storage();
      if (!available) return;
      try {
        [bodyCache, indexCache] = await Promise.all([available.open(BODY_CACHE), available.open(INDEX_CACHE)]);
        const response = await indexCache.match(INDEX_URL);
        const saved: unknown = response ? await response.json() : [];
        if (Array.isArray(saved)) for (const value of saved) {
          if (value && isPublicMapCacheUrl(value.url) && Number.isFinite(value.bytes) && value.bytes >= 0
            && value.bytes <= MAX_TILE_BYTES && Number.isFinite(value.expiresAt) && Number.isFinite(value.storedAt)) {
            entries.set(value.url, { ...value, provider: providerForUrl(value.url)! });
          }
        }
        // Recover from an interrupted write; no unaccounted persistent payloads.
        for (const key of await bodyCache.keys()) if (!entries.has(key.url)) await bodyCache.delete(key, { ignoreVary: true });
        await prune();
        await saveIndex();
      } catch { bodyCache = indexCache = undefined; entries.clear(); }
    })();
    await initialized;
  }
  function recordBrowserRequest(url: string) {
    const provider = providerForUrl(url);
    if (provider) browserRequests.set(provider, (browserRequests.get(provider) ?? 0) + 1);
  }
  async function fetchTile(url: string, requestInit: RequestInit = {}): Promise<Response> {
    const requestGeneration = generation;
    const headers = new Headers(requestInit.headers);
    const eligible = isPublicMapCacheUrl(url) && (!requestInit.method || requestInit.method === "GET")
      && [...headers.keys()].every(header => header === "accept" || header === "accept-language")
      && (!requestInit.cache || requestInit.cache === "default") && requestInit.credentials !== "include";
    if (!eligible) { recordBrowserRequest(url); return fetcher(url, requestInit); }
    await init();
    requestInit.signal?.throwIfAborted();
    if (!bodyCache) { recordBrowserRequest(url); return fetcher(url, requestInit); }
    const request = new Request(url, { ...requestInit, credentials: "omit" });
    const entry = entries.get(url);
    if (bodyCache && entry && entry.expiresAt > now()) {
      try {
        // Preserve the original Response and Request so CacheStorage enforces
        // Vary, including headers hidden from JavaScript by CORS filtering.
        const cached = await bodyCache.match(request);
        requestInit.signal?.throwIfAborted();
        if (cached && requestGeneration === generation) {
          entries.delete(url); entries.set(url, entry); hits++; return cached;
        }
      } catch { requestInit.signal?.throwIfAborted(); }
    }
    recordBrowserRequest(url);
    const response = await fetcher(url, { ...requestInit, credentials: "omit", cache: "default" });
    const expiresAt = mapResponseExpiresAt(response, now());
    if (bodyCache && expiresAt !== null && requestGeneration === generation && pendingWrites < 8) {
      const copy = response.clone();
      pendingWrites++;
      void serialize(async () => {
        try {
          const bytes = (await copy.clone().blob()).size;
          if (requestGeneration !== generation || bytes > Math.min(MAX_TILE_BYTES, maxBytes) || expiresAt <= now()) return;
          await bodyCache!.put(request, copy);
          entries.delete(url);
          entries.set(url, { url, provider: providerForUrl(url)!, bytes, storedAt: now(), expiresAt });
          await prune();
          await saveIndex();
        } catch {
          // Avoid invisible orphaned payloads after a partial/quota-failed write.
          await remove(url);
          await saveIndex();
        } finally { pendingWrites--; }
      }).catch(() => {});
    }
    return response;
  }
  async function inspect(): Promise<MapCacheSnapshot> {
    await init();
    await serialize(async () => { await prune(); });
    const values = [...entries.values()];
    return { available: Boolean(bodyCache), entries: values, bytes: values.reduce((sum, entry) => sum + entry.bytes, 0),
      maxBytes, hits, browserRequests: [...browserRequests].map(([provider, requests]) => ({ provider, requests })) };
  }
  async function clear() {
    generation++;
    await init();
    await serialize(async () => {
      if (!bodyCache || !indexCache) return;
      for (const key of await bodyCache.keys()) await bodyCache.delete(key, { ignoreVary: true });
      entries.clear(); hits = 0;
      await saveIndex();
    });
  }
  return { fetch: fetchTile, inspect, clear, recordBrowserRequest };
}

const mapCache = createMapCache();
export const fetchMapTile = mapCache.fetch;
export const inspectMapCache = mapCache.inspect;
export const clearMapCache = mapCache.clear;
export const recordBrowserMapRequest = mapCache.recordBrowserRequest;
