import { MAPTERHORN, type TerrainSource, type TerrainTile, type TerrainGrid } from "./terrainGrid.js";
import type { NavigationAbortController, NavigationAbortSignal } from "../navigation/navigationLease.js";

export interface TerrainLoaderLimits {
  maxConcurrent: number;
  cacheEntries: number;
  timeoutMs: number;
  /**
   * A patch keeps of each neighbour at its own zoom only the band along the
   * shared edge, 1/2^levels of it wide, as sub-tiles (audit L6): 2 keeps a
   * quarter, 20 grids a patch; 4 a sixteenth, 68 grids, the most every
   * reader takes (MAX_TERRAIN_NEIGHBORS), TypeScript and WebAssembly. 0 or
   * absent keeps whole neighbours. Heights read are the same either way.
   */
  neighborBandLevels?: number;
  /**
   * The most bytes of heights the cache keeps of tiles it has loaded, oldest
   * used going first, as with `cacheEntries` (audit L6). Tiles still loading
   * and a tile under a missing one, which shares its ancestor's heights, are
   * not counted. Absent: no bound but the count.
   */
  cacheBytes?: number;
  /**
   * The most bytes of downloaded tiles, as the source sent them, kept to be
   * decoded again without asking the transport, most recently decoded kept
   * longest (audit L6). Absent or 0: none are kept.
   */
  encodedBytes?: number;
}
/** Preserved source defaults; hosts may map their named settings to the required limits port. */
export const DEFAULT_TERRAIN_LOADER_LIMITS: Readonly<TerrainLoaderLimits> = Object.freeze({ maxConcurrent: 16, cacheEntries: 256, timeoutMs: 20000 });
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

/** The most levels a band is split: 2^4 sub-tiles an edge, 68 grids a patch. */
const MAX_BAND_LEVELS = 4;
/** A corner keeps a sub-tile this many pixels wide. */
const CORNER_SIZE = 2;
const bands = new WeakMap<TerrainGrid, Map<string, readonly TerrainGrid[]>>();

/**
 * The part of a neighbour at the patch's own zoom that the patch reads, as
 * sub-tiles of the same pixels: for an edge neighbour, the band of its pixels
 * along the shared edge, 1/2^levels of it wide, as 2^levels sub-tiles; for
 * a corner, the 2 × 2 pixels at the shared corner. A height past the patch's edge reads the neighbour's nearest
 * pixel row or column and, with weight 0, the next one, so both are kept with
 * the rest of the band; each pixel keeps its place in the quadtree, so every
 * reader finds and interpolates it as before. Null when the neighbour is not
 * a square of 2^(levels + 1) or more pixels, a power of two, so a band
 * keeps at least 2 pixels, or for levels below 1. A patch bands only
 * neighbours of its own size: a read reaches half its own pixel past its edge.
 * Bands are made once for each neighbour grid and side, and live as long as it.
 */
export function neighborBand(neighbor: TerrainGrid, dx: number, dy: number, bandLevels: number): readonly TerrainGrid[] | null {
  const { size, heights } = neighbor;
  if (!(bandLevels >= 1 && bandLevels <= MAX_BAND_LEVELS && Number.isInteger(bandLevels))) return null;
  if (!(size >= 2 ** (bandLevels + 1) && (size & (size - 1)) === 0 && heights.length === size * size) || (!dx && !dy)) return null;
  const side = `${dx},${dy},${bandLevels}`;
  let made = bands.get(neighbor);
  const found = made?.get(side);
  if (found) return found;
  const corner = dx !== 0 && dy !== 0;
  const levels = corner ? Math.log2(size / CORNER_SIZE) : bandLevels, split = 2 ** levels, sub = size / split;
  // The sub-tile columns and rows nearest the patch: its first ones for a neighbour past the patch's right or bottom.
  const columns = dx > 0 ? [0] : dx < 0 ? [split - 1] : Array.from({ length: split }, (_, i) => i);
  const rows = dy > 0 ? [0] : dy < 0 ? [split - 1] : Array.from({ length: split }, (_, i) => i);
  // Shared heights stay shared, so posting a patch to a worker still copies none of them.
  const shared = typeof SharedArrayBuffer === "function" && heights.buffer instanceof SharedArrayBuffer;
  const result: TerrainGrid[] = [];
  for (const row of rows) for (const column of columns) {
    const part = shared ? new Float32Array(new SharedArrayBuffer(sub * sub * 4)) : new Float32Array(sub * sub);
    for (let line = 0; line < sub; line++) {
      const from = (row * sub + line) * size + column * sub;
      part.set(heights.subarray(from, from + sub), line * sub);
    }
    result.push({ z: neighbor.z + levels, x: neighbor.x * split + column, y: neighbor.y * split + row, size: sub, heights: part });
  }
  if (!made) bands.set(neighbor, made = new Map());
  made.set(side, result);
  return result;
}

/** A tile's place in the quadtree, unique below zoom 26: the tiles of the zooms above it, then its row and column. */
function tileIndex(tile: TerrainTile): number {
  return (4 ** tile.z - 1) / 3 + tile.y * 2 ** tile.z + tile.x;
}

export function createTerrainTileLoader<TBlob, TSignal extends NavigationAbortSignal>(options: TerrainTileLoaderOptions<TBlob, TSignal>) {
  const { source = MAPTERHORN, decode: decodeTile, onBytes, trackMemory = false, ports } = options;
  const controller = ports.createAbortController();
  const cache = new Map<string, Promise<TerrainGrid>>();
  const settled = new Set<string>();
  // The bytes of heights of each settled tile that has its own, and their sum.
  const settledBytes = new Map<string, number>();
  let cachedBytes = 0;
  // Downloaded tiles kept as they came, by tile, oldest decoded first, and their bytes.
  const encoded = new Map<string, { blob: TBlob; bytes: number }>();
  let encodedBytes = 0;
  /** Keeps a decoded tile's download, letting the oldest go past the bound. */
  function dropEncoded(key: string): void {
    const previous = encoded.get(key);
    if (previous) { encoded.delete(key); encodedBytes -= previous.bytes; }
  }
  function keepEncoded(key: string, blob: TBlob): void {
    const limit = options.limits().encodedBytes ?? 0, bytes = ports.byteLength(blob);
    dropEncoded(key);
    if (!(bytes <= limit)) return;
    encoded.set(key, { blob, bytes }); encodedBytes += bytes;
    for (const [oldest, entry] of encoded) {
      if (encodedBytes <= limit) break;
      encoded.delete(oldest); encodedBytes -= entry.bytes;
    }
  }
  const forget = (key: string): void => {
    settled.delete(key); decodedArrays?.delete(key);
    cachedBytes -= settledBytes.get(key) ?? 0; settledBytes.delete(key);
  };
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
  // The claims holding a patch with each tile in it, whether or not the tile is asked for yet.
  const wants = new Map<string, Set<TerrainInterest>>();
  // Those waiting for a tile to arrive, however it was asked for, by tile.
  const arrivals = new Map<string, Set<() => void>>();
  // Tiles the source answered 404 for, by quadtree index. The archives keep no tile without its parent (Mapterhorn
  // makes each zoom from the one below), so a tile under a missing one is missing too, and takes its nearest
  // existing ancestor's grid without a request (docs/performance/2026-11-06/missing-elevation.md).
  const missing = new Set<number>();
  const disposedError = (): unknown => controller.signal.reason ?? new Error("Terrain loader disposed");
  const requireCurrent = (): void => { if (controller.signal.aborted) throw disposedError(); };
  async function download(tile: TerrainTile, prioritize: boolean): Promise<TerrainGrid> {
    await new Promise<void>((resolve, reject) => {
      const entry: Waiting = { key: `${tile.z}/${tile.x}/${tile.y}`, start: () => { prioritize = entry.ahead; resolve(); }, reject, withdrawn: false, ahead: prioritize };
      waiting.set(entry.key, entry);
      (prioritize ? ahead : queue).push(entry);
      pump();
    });
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    let blob: TBlob;
    try {
      requireCurrent();
      // An ancestor may have answered 404 while this tile waited.
      const absent = knownMissing(tile);
      if (absent) return awaitFallback(absent);
      const kept = encoded.get(key);
      if (kept) blob = kept.blob;
      else {
        const url = source.urlTemplate.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
        const response = await ports.fetchTile(url, ports.requestSignal(controller.signal, options.limits().timeoutMs));
        if (!response.ok) {
          if (response.status === 404 && tile.z > 0) { missing.add(tileIndex(tile)); return awaitFallback(tile); }
          throw new Error(`Terrain request failed (${response.status}): ${url}`);
        }
        blob = await response.blob();
        requireCurrent();
        onBytes?.(ports.byteLength(blob));
      }
      decoding++;
    } finally { downloading--; pump(); }
    try {
      const decoded = await decodeTile(blob, { prioritize, signal: controller.signal });
      requireCurrent();
      keepEncoded(key, blob);
      return { ...tile, ...decoded };
    } catch (error) {
      // A download that would not decode is asked for again next time.
      dropEncoded(key);
      throw error;
    } finally { decoding--; pump(); }
  }
  // Release the download slot before awaiting a parent (avoid queue deadlock).
  function awaitFallback(tile: TerrainTile): Promise<TerrainGrid> {
    return load({ z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) }, true);
  }
  /** The deepest of a tile and its ancestors known to be missing; null when none is known (always, inside coverage). */
  function knownMissing(tile: TerrainTile): TerrainTile | null {
    if (missing.size === 0) return null;
    for (let { z, x, y } = tile; z > 0; z--, x = Math.floor(x / 2), y = Math.floor(y / 2)) {
      if (missing.has(tileIndex({ z, x, y }))) return { z, x, y };
    }
    return null;
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
  function sourceTile(tile: TerrainTile): TerrainTile {
    const shift = Math.max(0, tile.z - source.maxZoom);
    return { z: tile.z - shift, x: Math.floor(tile.x / 2 ** shift), y: Math.floor(tile.y / 2 ** shift) };
  }
  function load(tile: TerrainTile, prioritize = false, interest?: TerrainInterest): Promise<TerrainGrid> {
    if (controller.signal.aborted) return Promise.reject(disposedError());
    if (interest?.released) return Promise.reject(withdrawnError());
    tile = sourceTile(tile);
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
    const absent = knownMissing(tile);
    const pending: Promise<TerrainGrid> = (absent ? awaitFallback(absent) : download(tile, prioritize)).catch(error => {
      // A withdrawn tile has already left the cache, and the same tile asked for again since is another request.
      if (cache.get(key) === pending) { cache.delete(key); claims.delete(key); forget(key); }
      throw error;
    });
    cache.set(key, pending);
    claims.set(key, new Set());
    claim(key, interest);
    for (const holder of wants.get(key) ?? []) claim(key, holder);
    // Settled arrays are small and bounded; geometry retains its own samples.
    void pending.then(grid => {
      if (cache.get(key) !== pending) return;
      claims.delete(key);
      settled.add(key);
      decodedArrays?.set(key, grid.heights);
      if (grid.z === tile.z) { settledBytes.set(key, grid.heights.byteLength); cachedBytes += grid.heights.byteLength; }
      const waiting = arrivals.get(key);
      arrivals.delete(key);
      for (const arrived of waiting ?? []) arrived();
      const { cacheEntries, cacheBytes = Infinity } = options.limits();
      for (const candidate of cache.keys()) {
        if (cache.size <= cacheEntries && cachedBytes <= cacheBytes) break;
        if (settled.has(candidate)) { cache.delete(candidate); forget(candidate); }
      }
    }, () => {});
    return pending;
  }
  /**
   * Claims the tiles of a patch to be asked for later, asking for none: one
   * already waiting keeps its place in the queue, and one asked for later is
   * claimed as it is. A neighbour another patch brings is asked for this
   * claim if no claim still wants that patch.
   */
  function holdPatch(tile: TerrainTile, interest: TerrainInterest): void {
    if (controller.signal.aborted || interest.released) return;
    const center = sourceTile(tile), n = 2 ** center.z;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (center.y + dy < 0 || center.y + dy >= n) continue;
      const key = `${center.z}/${(center.x + dx + n) % n}/${center.y + dy}`;
      claim(key, interest);
      let holders = wants.get(key);
      if (!holders) wants.set(key, holders = new Set());
      if (holders.has(interest)) continue;
      holders.add(interest);
      interest.onRelease(() => {
        const current = wants.get(key);
        if (current?.delete(interest) && current.size === 0) wants.delete(key);
      });
    }
  }
  /** Resolves once a tile is loaded, asking for nothing; never, once the claim is released. */
  function whenLoaded(tile: TerrainTile, interest: TerrainInterest): Promise<void> {
    tile = sourceTile(tile);
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (settled.has(key)) return Promise.resolve();
    return new Promise(resolve => {
      if (controller.signal.aborted || interest.released) return;
      let waiting = arrivals.get(key);
      if (!waiting) arrivals.set(key, waiting = new Set());
      waiting.add(resolve);
      interest.onRelease(() => {
        const current = arrivals.get(key);
        if (current?.delete(resolve) && current.size === 0) arrivals.delete(key);
      });
    });
  }
  async function loadPatch(tile: TerrainTile, interest?: TerrainInterest, prioritize = false): Promise<TerrainGrid> {
    const grid = await load(tile, prioritize, interest);
    const released = interest?.released ?? false;
    const neighbors: Array<Promise<TerrainGrid>> = [];
    const sides: Array<[number, number]> = [];
    const n = 2 ** grid.z;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || grid.y + dy < 0 || grid.y + dy >= n) continue;
      // Finish this already-started patch before downloading unrelated
      // centers. Otherwise a displayed tile can wait behind the whole globe
      // even though its own elevation request completed long ago.
      const neighbor = { z: grid.z, x: (grid.x + dx + n) % n, y: grid.y + dy };
      // Without a claim of its own, a neighbour is asked for one holding it in another patch.
      const asking = released ? wants.get(`${neighbor.z}/${neighbor.x}/${neighbor.y}`)?.values().next().value : interest;
      if (!released || asking) { neighbors.push(load(neighbor, true, asking)); sides.push([dx, dy]); }
    }
    if (released) {
      for (const neighbor of neighbors) neighbor.catch(() => {});
      throw withdrawnError();
    }
    const whole = await Promise.all(neighbors);
    const bandLevels = options.limits().neighborBandLevels ?? 0;
    if (!bandLevels) return { ...grid, neighbors: whole };
    // In each neighbour's place, in order: where a coarser neighbour and a
    // band could both cover a pixel, the first still decides it.
    return { ...grid, neighbors: whole.flatMap((neighbor, index) => {
      const [dx, dy] = sides[index]!;
      return (neighbor.z === grid.z && neighbor.size === grid.size && neighborBand(neighbor, dx, dy, bandLevels)) || [neighbor];
    }) };
  }
  return { load, loadPatch, holdPatch, whenLoaded,
    /**
     * Holds the queue: no download starts while paused, and those running
     * finish. Queued tiles wait rather than fail, since their promises are
     * shared by every tile record that asked.
     */
    setPaused(next: boolean) { paused = next; pump(); },
    /** `active`: tiles downloading or decoding. `cachedBytes` and `encodedBytes`: what the cache's two bounds count. */
    getMetrics(): { active: number; decoding: number; queued: number; decodedBytes: number | null; cachedBytes?: number; encodedBytes?: number } { return { active: downloading + decoding, decoding, queued: waiting.size, cachedBytes, encodedBytes,
      decodedBytes: decodedArrays ? [...new Set(decodedArrays.values())].reduce((sum, array) => sum + array.byteLength, 0) : null }; },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort(new Error("Terrain loader disposed"));
      for (const entry of [...ahead.splice(0), ...queue.splice(0)]) entry.reject(disposedError());
      waiting.clear(); claims.clear(); wants.clear(); arrivals.clear(); cache.clear(); settled.clear(); decodedArrays?.clear(); missing.clear();
      settledBytes.clear(); cachedBytes = 0; encoded.clear(); encodedBytes = 0;
    } };
}
