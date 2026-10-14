import { MAPTERHORN, type TerrainSource, type TerrainTile, type TerrainGrid } from "./terrainGrid.js";
import type { NavigationAbortController, NavigationAbortSignal } from "../navigation/navigationLease.js";

export interface TerrainLoaderLimits { maxConcurrent: number; cacheEntries: number; timeoutMs: number }
/** Preserved source defaults; hosts may map their named settings to the required limits port. */
export const DEFAULT_TERRAIN_LOADER_LIMITS: Readonly<TerrainLoaderLimits> = Object.freeze({ maxConcurrent: 6, cacheEntries: 256, timeoutMs: 20000 });
/**
 * One holder's claim on the tiles it asks for. Released, it withdraws them: a
 * tile no claim still wants leaves the queue before it downloads. A tile asked
 * for without a claim is always wanted, and one already downloading finishes
 * into the cache.
 */
export interface TerrainInterest {
  readonly released: boolean;
  release(): void;
  /** Runs once, when released. */
  onRelease(listener: () => void): void;
}
export function createTerrainInterest(): TerrainInterest {
  let listeners: Array<() => void> | null = [];
  return {
    get released() { return listeners === null; },
    release() {
      const current = listeners;
      listeners = null;
      for (const listener of current ?? []) listener();
    },
    onRelease(listener) { listeners?.push(listener); },
  };
}
/** The rejection of a tile its every claim withdrew before it downloaded. */
export function isTerrainWithdrawn(error: unknown): boolean {
  return error instanceof Error && error.name === "TerrainWithdrawn";
}
function withdrawnError(): Error {
  const error = new Error("Terrain request withdrawn");
  error.name = "TerrainWithdrawn";
  return error;
}
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
  interface Waiting { key: string; start: () => void; reject: (reason: unknown) => void; withdrawn: boolean; ahead: boolean }
  // Tiles moved ahead wait in `ahead`, in the order they were moved, before
  // the rest. Withdrawn entries stay in either queue until they reach its
  // front; `waiting` holds the rest, by tile.
  const ahead: Waiting[] = [], queue: Waiting[] = [];
  const waiting = new Map<string, Waiting>();
  // The claims on each tile not yet loaded; null once it was asked for without one.
  const claims = new Map<string, Set<TerrainInterest> | null>();
  const disposedError = (): unknown => controller.signal.reason ?? new Error("Terrain loader disposed");
  const requireCurrent = (): void => { if (controller.signal.aborted) throw disposedError(); };
  async function download(tile: TerrainTile, prioritize: boolean): Promise<TerrainGrid> {
    await new Promise<void>((resolve, reject) => {
      const entry: Waiting = { key: `${tile.z}/${tile.x}/${tile.y}`, start: resolve, reject, withdrawn: false, ahead: prioritize };
      waiting.set(entry.key, entry);
      (prioritize ? ahead : queue).push(entry);
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
    while (!controller.signal.aborted && !paused && downloading < maxConcurrent && downloading + decoding < maxConcurrent + slots && (ahead.length || queue.length)) {
      const entry = (ahead.length ? ahead : queue).shift()!;
      if (entry.withdrawn) continue;
      waiting.delete(entry.key);
      downloading++; entry.start();
    }
  }
  /** Adds a claim on a tile not yet loaded; none means it is always wanted. */
  function claim(key: string, interest: TerrainInterest | undefined): void {
    const current = claims.get(key);
    if (current === undefined || current === null) return;
    if (!interest) { claims.set(key, null); return; }
    if (current.has(interest)) return;
    current.add(interest);
    interest.onRelease(() => withdraw(key, interest));
  }
  /** Drops a released claim; the last one takes a tile still waiting out of the queue. */
  function withdraw(key: string, interest: TerrainInterest): void {
    const current = claims.get(key);
    if (!current || !current.delete(interest) || current.size > 0) return;
    const entry = waiting.get(key);
    if (!entry) return;
    entry.withdrawn = true;
    waiting.delete(key); claims.delete(key); cache.delete(key);
    entry.reject(withdrawnError());
  }
  function load(tile: TerrainTile, prioritize = false, interest?: TerrainInterest): Promise<TerrainGrid> {
    if (controller.signal.aborted) return Promise.reject(disposedError());
    if (interest?.released) return Promise.reject(withdrawnError());
    const shift = Math.max(0, tile.z - source.maxZoom);
    tile = { z: tile.z - shift, x: Math.floor(tile.x / 2 ** shift), y: Math.floor(tile.y / 2 ** shift) };
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const found = cache.get(key);
    if (found) {
      // A neighbor may already be queued as another tile's center. Promote
      // that same request rather than issuing a duplicate download.
      const entry = prioritize ? waiting.get(key) : undefined;
      if (entry && !entry.ahead) {
        queue.splice(queue.indexOf(entry), 1);
        entry.ahead = true;
        ahead.push(entry);
      }
      claim(key, interest);
      cache.delete(key); cache.set(key, found); return found;
    }
    const pending: Promise<TerrainGrid> = download(tile, prioritize).catch(error => {
      // A withdrawn tile has already left the cache, and the same tile asked for again since is another request.
      if (cache.get(key) === pending) { cache.delete(key); claims.delete(key); settled.delete(key); decodedArrays?.delete(key); }
      throw error;
    });
    cache.set(key, pending);
    claims.set(key, new Set());
    claim(key, interest);
    // Settled arrays are small and bounded; geometry retains its own samples.
    void pending.then(grid => {
      if (cache.get(key) !== pending) return;
      claims.delete(key);
      settled.add(key);
      decodedArrays?.set(key, grid.heights);
      for (const candidate of cache.keys()) {
        if (cache.size <= options.limits().cacheEntries) break;
        if (settled.has(candidate)) { cache.delete(candidate); settled.delete(candidate); decodedArrays?.delete(candidate); }
      }
    }, () => {});
    return pending;
  }
  async function loadPatch(tile: TerrainTile, interest?: TerrainInterest): Promise<TerrainGrid> {
    const grid = await load(tile, false, interest);
    const neighbors: Array<Promise<TerrainGrid>> = [];
    const n = 2 ** grid.z;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || grid.y + dy < 0 || grid.y + dy >= n) continue;
      // Finish this already-started patch before downloading unrelated
      // centers. Otherwise a displayed tile can wait behind the whole globe
      // even though its own elevation request completed long ago.
      neighbors.push(load({ z: grid.z, x: (grid.x + dx + n) % n, y: grid.y + dy }, true, interest));
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
    getMetrics() { return { active: downloading + decoding, decoding, queued: waiting.size,
      decodedBytes: decodedArrays ? [...new Set(decodedArrays.values())].reduce((sum, array) => sum + array.byteLength, 0) : null }; },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort(new Error("Terrain loader disposed"));
      for (const entry of [...ahead.splice(0), ...queue.splice(0)]) entry.reject(disposedError());
      waiting.clear(); claims.clear(); cache.clear(); settled.clear(); decodedArrays?.clear();
    } };
}
