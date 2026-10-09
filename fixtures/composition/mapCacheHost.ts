import { createMapCache } from "../../src/browser/mapCache.js";
import type { MapCachePresentationRefresh, MapCachePresentationVisibility } from "../../src/map/mapCachePresentation.js";

/** Minimal CacheStorage backend fixture only; the actual Engine cache owns policy. */
class MemoryCache {
  readonly values = new Map<string, Response>();
  async match(request: RequestInfo): Promise<Response | undefined> {
    return this.values.get(typeof request === "string" ? request : request.url)?.clone();
  }
  async put(request: RequestInfo, response: Response): Promise<void> {
    this.values.set(typeof request === "string" ? request : request.url, response.clone());
  }
  async delete(request: RequestInfo): Promise<boolean> {
    return this.values.delete(typeof request === "string" ? request : request.url);
  }
  async keys(): Promise<Request[]> { return [...this.values.keys()].map(url => new Request(url)); }
}
export async function createManagedMapCacheFixture(urls: readonly string[], maxBytes = 64 * 1024) {
  const stores = new Map<string, MemoryCache>(), now = 1800000000000;
  const storage = { async open(name: string) { let store = stores.get(name);if (!store) { store = new MemoryCache();stores.set(name, store); }return store; } } as unknown as CacheStorage;
  const cache = createMapCache({ storage: () => storage, now: () => now, Response, Request, Headers,
    maxBytes, maxEntries: 1024, maxTileBytes: 8192,
    fetcher: async () => new Response(new Uint8Array(1024), { headers: { "cache-control": "public,max-age=3600", date: new Date(now).toUTCString(), age: "0" } }) });
  for (const url of urls) await cache.fetch(url);
  await cache.inspect(); // drain actual serialized storage writes before presentation
  return cache;
}

/** One manually advanced host authority: no timer, RAF, renderer or polling. */
export function createMapCachePresentationHost(initialVisible = true) {
  let now = 0, visible = initialVisible;
  const refreshListeners = new Set<() => void>(), visibilityListeners = new Set<() => void>();
  const refresh: MapCachePresentationRefresh = { subscribe(listener) { refreshListeners.add(listener);return () => { refreshListeners.delete(listener); }; } };
  const visibility: MapCachePresentationVisibility = { isVisible: () => visible, subscribe(listener) { visibilityListeners.add(listener);return () => { visibilityListeners.delete(listener); }; } };
  return { refresh, visibility, nowMs: () => now, refreshListeners, visibilityListeners,
    pulse(atMs: number) { now = atMs;for (const listener of [...refreshListeners]) listener(); },
    setVisible(value: boolean) { visible = value;for (const listener of [...visibilityListeners]) listener(); },
  };
}
