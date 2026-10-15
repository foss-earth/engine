import { describe, expect, it, vi } from "vitest";
import { createMapCache, isPublicMapCacheUrl, mapCacheLimits, mapResponseExpiresAt } from "../src/browser/mapCache.js";

class MemoryCache {
  readonly values = new Map<string, Response>();

  async match(request: RequestInfo): Promise<Response | undefined> {
    const response = this.values.get(typeof request === "string" ? request : request.url);
    return response?.clone();
  }

  async put(request: RequestInfo, response: Response): Promise<void> {
    this.values.set(typeof request === "string" ? request : request.url, response.clone());
  }

  async delete(request: RequestInfo): Promise<boolean> {
    return this.values.delete(typeof request === "string" ? request : request.url);
  }

  async keys(): Promise<Request[]> {
    return [...this.values.keys()].map(url => new Request(url));
  }
}

describe("managed map cache", () => {
  it("never persists Google, signed, or query-string map requests", () => {
    expect(isPublicMapCacheUrl("https://tile.googleapis.com/v1/3dtiles/root.json")).toBe(false);
    expect(isPublicMapCacheUrl("https://tiles.mapterhorn.com/7/12/42.png?signature=secret")).toBe(false);
    expect(isPublicMapCacheUrl("https://tiles.mapterhorn.com/7/12/42.png")).toBe(true);
  });

  it("requires explicitly readable current freshness before saving a response", () => {
    const now = Date.parse("2026-09-09T00:00:00Z");
    const fresh = new Response("tile", { headers: {
      "cache-control": "public, max-age=3600", date: new Date(now).toUTCString(), age: "0",
    } });
    expect(mapResponseExpiresAt(fresh, now)).toBe(now + 3600_000);
    expect(mapResponseExpiresAt(new Response("tile", { headers: { "cache-control": "no-store, max-age=3600" } }), now)).toBeNull();
    expect(mapResponseExpiresAt(new Response("tile", { headers: { "cache-control": "max-age=3600" } }), now)).toBeNull();
  });

  it("uses a fresh managed response and clears all persistent entries on request", async () => {
    const body = new MemoryCache();
    const index = new MemoryCache();
    const fetcher = vi.fn(async () => new Response("tile", { headers: {
      "cache-control": "max-age=3600", date: new Date(0).toUTCString(), age: "0",
    } }));
    let now = 0;
    const cache = createMapCache({ Response, Request, Headers,
      storage: () => ({ open: async (name: string) => name.includes("index") ? index : body }) as unknown as CacheStorage,
      fetcher, now: () => now,
      maxBytes: 128 * 1024 * 1024, maxEntries: 1024, maxTileBytes: 8 * 1024 * 1024,
    });
    const url = "https://tiles.mapterhorn.com/7/12/42.png";
    expect(await (await cache.fetch(url)).text()).toBe("tile");
    // Cache writes are intentionally asynchronous, so let the write queue
    // settle through the public inspection API before asking for a hit.
    expect((await cache.inspect()).entries).toHaveLength(1);
    expect(await (await cache.fetch(url)).text()).toBe("tile");
    expect(fetcher).toHaveBeenCalledOnce();
    await cache.clear();
    expect((await cache.inspect()).entries).toHaveLength(0);
    now = 1;
    await cache.fetch(url);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing until it has limits, and shrinks to new ones", async () => {
    const body = new MemoryCache();
    const index = new MemoryCache();
    const fetcher = vi.fn(async () => new Response("tile", { headers: {
      "cache-control": "max-age=3600", date: new Date(0).toUTCString(), age: "0",
    } }));
    const cache = createMapCache({ Response, Request, Headers,
      storage: () => ({ open: async (name: string) => name.includes("index") ? index : body }) as unknown as CacheStorage,
      fetcher, now: () => 0,
    });
    const urls = [1, 2, 3].map(x => `https://tiles.mapterhorn.com/7/${x}/42.png`);
    await cache.fetch(urls[0]);
    expect((await cache.inspect()).entries).toHaveLength(0);
    cache.setLimits({ maxBytes: 1024, maxEntries: 1024, maxTileBytes: 1024 });
    for (const url of urls) await cache.fetch(url);
    expect((await cache.inspect()).entries).toHaveLength(3);
    cache.setLimits({ maxBytes: 1024, maxEntries: 1, maxTileBytes: 1024 });
    const snapshot = await cache.inspect();
    expect(snapshot.entries.map(entry => entry.url)).toEqual([urls[2]]);
    cache.setLimits({ maxBytes: 1024, maxEntries: 10, maxTileBytes: 2 });
    await cache.fetch("https://tiles.mapterhorn.com/7/9/42.png");
    expect((await cache.inspect()).entries).toHaveLength(1);
  });

  it("opens before the first fetch, which then serves a tile saved by an earlier visit", async () => {
    const body = new MemoryCache();
    const index = new MemoryCache();
    const url = "https://tiles.mapterhorn.com/7/12/42.png";
    await body.put(url, new Response("saved"));
    await index.put("https://foss-earth.invalid/map-cache/index", new Response(JSON.stringify([
      { url, bytes: 5, storedAt: 0, expiresAt: 3600_000 },
    ])));
    const opened: string[] = [];
    const fetcher = vi.fn(async () => new Response("network"));
    const cache = createMapCache({ Response, Request, Headers,
      storage: () => ({ open: async (name: string) => { opened.push(name); return name.includes("index") ? index : body; } }) as unknown as CacheStorage,
      fetcher, now: () => 0, maxBytes: 1024, maxEntries: 16, maxTileBytes: 1024,
    });
    await cache.open();
    expect(opened).toHaveLength(2);
    expect(await (await cache.fetch(url)).text()).toBe("saved");
    expect(opened).toHaveLength(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("applies limits given while opening only after the saved index is read", async () => {
    const body = new MemoryCache();
    const index = new MemoryCache();
    const urls = [1, 2, 3].map(x => `https://tiles.mapterhorn.com/7/${x}/42.png`);
    for (const url of urls) await body.put(url, new Response("saved"));
    await index.put("https://foss-earth.invalid/map-cache/index", new Response(JSON.stringify(
      urls.map((url, at) => ({ url, bytes: 5, storedAt: at, expiresAt: 3600_000 })))));
    // The saved index is read only when released; every index the cache writes is kept.
    let release!: () => void;
    const read = new Promise<void>(resolve => { release = resolve; });
    const written: string[] = [];
    const gated = {
      match: async (request: RequestInfo) => { const response = await index.match(request); await read; return response; },
      put: async (request: RequestInfo, response: Response) => { written.push(await response.clone().text()); await index.put(request, response); },
      delete: (request: RequestInfo) => index.delete(request),
      keys: () => index.keys(),
    };
    const cache = createMapCache({ Response, Request, Headers,
      storage: () => ({ open: async (name: string) => name.includes("index") ? gated : body }) as unknown as CacheStorage,
      fetcher: vi.fn(async () => new Response("network")), now: () => 0,
    });
    const opening = cache.open();
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    cache.setLimits({ maxBytes: 1024, maxEntries: 2, maxTileBytes: 1024 });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(written).toEqual([]);
    release();
    await opening;
    const snapshot = await cache.inspect();
    expect(snapshot.entries.map(entry => entry.url)).toEqual(urls.slice(1));
    expect(written.every(saved => JSON.parse(saved).length >= 2)).toBe(true);
    expect(JSON.parse(written.at(-1)!).map((entry: { url: string }) => entry.url)).toEqual(urls.slice(1));
  });

  it("reads its limits from the map.cache parameters", () => {
    const values: Record<string, unknown> = { "map.cache.httpBytes": 128, "map.cache.httpEntries": 1024.4, "map.cache.maxTileBytes": 0.25 };
    expect(mapCacheLimits(id => values[id])).toEqual({ maxBytes: 128 * 1024 * 1024, maxEntries: 1024, maxTileBytes: 256 * 1024 });
    expect(mapCacheLimits(() => undefined)).toEqual({ maxBytes: 0, maxEntries: 0, maxTileBytes: 0 });
  });
});
