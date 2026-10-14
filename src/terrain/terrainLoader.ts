import { MAPTERHORN, type TerrainSource, type TerrainTile, type TerrainGrid } from "./terrainGrid.js";
import type { NavigationAbortController, NavigationAbortSignal } from "../navigation/navigationLease.js";

export interface TerrainLoaderLimits { maxConcurrent: number; cacheEntries: number; timeoutMs: number }
/** Preserved source defaults; hosts may map their named settings to the required limits port. */
export const DEFAULT_TERRAIN_LOADER_LIMITS: Readonly<TerrainLoaderLimits> = Object.freeze({ maxConcurrent: 6, cacheEntries: 256, timeoutMs: 20000 });
export interface TerrainTileLoaderPorts<TBlob, TSignal extends NavigationAbortSignal> {
  createAbortController(): NavigationAbortController<TSignal>;
  /** Host timeout/cancellation authority, shared with its transport. */
  requestSignal(signal: TSignal, timeoutMs: number): TSignal;
  fetchTile(url: string, signal: TSignal): Promise<{ ok: boolean; status: number; blob(): Promise<TBlob> }>;
  byteLength(blob: TBlob): number;
}
export interface TerrainTileLoaderOptions<TBlob, TSignal extends NavigationAbortSignal> {
  source?: TerrainSource;
  /** `prioritize`: the loader moved this tile ahead of its queue (a neighbour or parent a started tile waits for). `signal` aborts when the loader is disposed. */
  decode(blob: TBlob, request: { prioritize: boolean; signal: TSignal }): Promise<{ size: number; heights: Float32Array }>;
  ports: TerrainTileLoaderPorts<TBlob, TSignal>;
  limits(): TerrainLoaderLimits;
  /**
   * Downloaded tiles that may wait for or be in decode past the download
   * slots, read at each start: at most `maxConcurrent` tiles download, and at
   * most `maxConcurrent + decodeSlots()` download or decode. Absent or 0: a
   * tile keeps its download slot until it is decoded.
   */
  decodeSlots?(): number;
  onBytes?: (bytes: number) => void;
  trackMemory?: boolean;
}

export function createTerrainTileLoader<TBlob, TSignal extends NavigationAbortSignal>(options: TerrainTileLoaderOptions<TBlob, TSignal>) {
  const { source = MAPTERHORN, decode: decodeTile, onBytes, trackMemory = false, ports } = options;
  const controller = ports.createAbortController();
  const cache = new Map<string, Promise<TerrainGrid>>();
  const settled = new Set<string>();
  const decodedArrays = trackMemory ? new Map<string, Float32Array>() : null;
  // Tiles downloading, and tiles downloaded but not yet decoded.
  let downloading = 0, decoding = 0;
  let paused = false;
  const queue: Array<{ key: string; start: () => void; reject: (reason: unknown) => void }> = [];
  const disposedError = (): unknown => controller.signal.reason ?? new Error("Terrain loader disposed");
  const requireCurrent = (): void => { if (controller.signal.aborted) throw disposedError(); };
  async function download(tile: TerrainTile, prioritize: boolean): Promise<TerrainGrid> {
    await new Promise<void>((resolve, reject) => {
      const entry = { key: `${tile.z}/${tile.x}/${tile.y}`, start: resolve, reject };
      if (prioritize) queue.unshift(entry);
      else queue.push(entry);
      pump();
    });
    let blob: TBlob;
    try {
      requireCurrent();
      const url = source.urlTemplate.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
      const response = await ports.fetchTile(url, ports.requestSignal(controller.signal, options.limits().timeoutMs));
      if (!response.ok) {
        if (response.status === 404 && tile.z > 0) return awaitFallback(tile);
        throw new Error(`Terrain request failed (${response.status}): ${url}`);
      }
      blob = await response.blob();
      requireCurrent();
      onBytes?.(ports.byteLength(blob));
      decoding++;
    } finally { downloading--; pump(); }
    try {
      const decoded = await decodeTile(blob, { prioritize, signal: controller.signal });
      requireCurrent();
      return { ...tile, ...decoded };
    } finally { decoding--; pump(); }
  }
  // Release the download slot before awaiting a parent (avoid queue deadlock).
  function awaitFallback(tile: TerrainTile): Promise<TerrainGrid> {
    return load({ z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) }, true);
  }
  function pump() {
    const { maxConcurrent } = options.limits(), slots = Math.max(0, options.decodeSlots?.() || 0);
    while (!controller.signal.aborted && !paused && downloading < maxConcurrent && downloading + decoding < maxConcurrent + slots && queue.length) {
      downloading++; queue.shift()!.start();
    }
  }
  function load(tile: TerrainTile, prioritize = false): Promise<TerrainGrid> {
    if (controller.signal.aborted) return Promise.reject(disposedError());
    const shift = Math.max(0, tile.z - source.maxZoom);
    tile = { z: tile.z - shift, x: Math.floor(tile.x / 2 ** shift), y: Math.floor(tile.y / 2 ** shift) };
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const found = cache.get(key);
    if (found) {
      // A neighbor may already be queued as another tile's center. Promote
      // that same request rather than issuing a duplicate download.
      if (prioritize) {
        const index = queue.findIndex(entry => entry.key === key);
        if (index > 0) queue.unshift(queue.splice(index, 1)[0]);
      }
      cache.delete(key); cache.set(key, found); return found;
    }
    const pending = download(tile, prioritize).catch(error => { cache.delete(key); settled.delete(key); decodedArrays?.delete(key); throw error; });
    cache.set(key, pending);
    // Settled arrays are small and bounded; geometry retains its own samples.
    void pending.then(grid => {
      if (cache.get(key) !== pending) return;
      settled.add(key);
      decodedArrays?.set(key, grid.heights);
      for (const candidate of cache.keys()) {
        if (cache.size <= options.limits().cacheEntries) break;
        if (settled.has(candidate)) { cache.delete(candidate); settled.delete(candidate); decodedArrays?.delete(candidate); }
      }
    }, () => {});
    return pending;
  }
  async function loadPatch(tile: TerrainTile): Promise<TerrainGrid> {
    const grid = await load(tile);
    const neighbors: Array<Promise<TerrainGrid>> = [];
    const n = 2 ** grid.z;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || grid.y + dy < 0 || grid.y + dy >= n) continue;
      // Finish this already-started patch before downloading unrelated
      // centers. Otherwise a displayed tile can wait behind the whole globe
      // even though its own elevation request completed long ago.
      neighbors.push(load({ z: grid.z, x: (grid.x + dx + n) % n, y: grid.y + dy }, true));
    }
    return { ...grid, neighbors: await Promise.all(neighbors) };
  }
  return { load, loadPatch,
    /**
     * Holds the queue: no download starts while paused, and those running
     * finish. Queued tiles wait rather than fail, since their promises are
     * shared by every tile record that asked.
     */
    setPaused(next: boolean) { paused = next; pump(); },
    /** `active`: tiles downloading or decoding. */
    getMetrics() { return { active: downloading + decoding, decoding, queued: queue.length,
      decodedBytes: decodedArrays ? [...new Set(decodedArrays.values())].reduce((sum, array) => sum + array.byteLength, 0) : null }; },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort(new Error("Terrain loader disposed"));
      for (const entry of queue.splice(0)) entry.reject(disposedError());
      cache.clear(); settled.clear(); decodedArrays?.clear();
    } };
}
