import { describe, expect, it, vi } from "vitest";
import { createMapCache, isPublicMapCacheUrl, mapResponseExpiresAt } from "./mapCache";

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
    const cache = createMapCache({
      storage: () => ({ open: async (name: string) => name.includes("index") ? index : body }) as unknown as CacheStorage,
      fetcher, now: () => now,
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
});
