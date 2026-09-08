/** Streamed elevation data. Values retain the provider's vertical reference. */
export interface TerrainTile { z: number; x: number; y: number }
export interface TerrainGrid extends TerrainTile { size: number; heights: Float32Array; neighbors?: TerrainGrid[] }
export interface TerrainSource {
  urlTemplate: string;
  maxZoom: number;
  attribution: string;
}
export const MAPTERHORN: TerrainSource = {
  urlTemplate: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
  maxZoom: 15,
  attribution: "https://mapterhorn.com/attribution/",
};

export function decodeTerrarium(data: Uint8ClampedArray, size: number): Float32Array {
  if (data.length !== size * size * 4) throw new Error("Invalid terrain image dimensions");
  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) {
    if (data[i * 4 + 3] !== 255) throw new Error("Terrain image contains missing samples");
    heights[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
  }
  return heights;
}

/** Pixel-center interpolation; x/y are fractional tile coordinates at grid.z. */
export function sampleTerrainGrid(grid: TerrainGrid, x: number, y: number): number {
  if (grid.neighbors && (x - grid.x < 0.5 / grid.size || x - grid.x > 1 - 0.5 / grid.size
    || y - grid.y < 0.5 / grid.size || y - grid.y > 1 - 0.5 / grid.size)) {
    const candidates = [grid, ...grid.neighbors];
    const px = (x - grid.x) * grid.size - 0.5, py = (y - grid.y) * grid.size - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), u = px - ix, v = py - iy;
    const samplePixel = (col: number, row: number) => {
      const n = 2 ** grid.z;
      const tx = ((grid.x + (col + 0.5) / grid.size) % n + n) % n;
      const ty = Math.max(0, Math.min(n - 1e-9, grid.y + (row + 0.5) / grid.size));
      const source = candidates.find(candidate => {
        const scale = 2 ** (candidate.z - grid.z);
        return Math.floor(tx * scale) === candidate.x && Math.floor(ty * scale) === candidate.y;
      }) ?? grid;
      const scale = 2 ** (source.z - grid.z);
      // Avoid recursively following the patch on its center grid.
      return sampleTerrainGrid({ ...source, neighbors: undefined }, tx * scale, ty * scale);
    };
    return (samplePixel(ix, iy) * (1 - u) + samplePixel(ix + 1, iy) * u) * (1 - v)
      + (samplePixel(ix, iy + 1) * (1 - u) + samplePixel(ix + 1, iy + 1) * u) * v;
  }
  const px = Math.max(0, Math.min(grid.size - 1, (x - grid.x) * grid.size - 0.5));
  const py = Math.max(0, Math.min(grid.size - 1, (y - grid.y) * grid.size - 0.5));
  const ix = Math.floor(px), iy = Math.floor(py);
  const jx = Math.min(ix + 1, grid.size - 1), jy = Math.min(iy + 1, grid.size - 1);
  const u = px - ix, v = py - iy;
  const a = grid.heights[iy * grid.size + ix] * (1 - u) + grid.heights[iy * grid.size + jx] * u;
  const b = grid.heights[jy * grid.size + ix] * (1 - u) + grid.heights[jy * grid.size + jx] * u;
  return a * (1 - v) + b * v;
}

async function decodeImage(blob: Blob): Promise<{ size: number; heights: Float32Array }> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  try {
    if (bitmap.width !== bitmap.height || bitmap.width > 1024) throw new Error("Invalid terrain tile size");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = bitmap.width;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Terrain image decoder unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return { size: bitmap.width, heights: decodeTerrarium(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width) };
  } finally { bitmap.close(); }
}

export function createTerrainTileLoader(
  source = MAPTERHORN,
  onBytes?: (bytes: number) => void,
  decode = decodeImage,
) {
  const controller = new AbortController();
  const cache = new Map<string, Promise<TerrainGrid>>();
  const settled = new Set<string>();
  let active = 0;
  const queue: Array<() => void> = [];
  async function download(tile: TerrainTile): Promise<TerrainGrid> {
    await new Promise<void>(resolve => { queue.push(resolve); pump(); });
    try {
      const url = source.urlTemplate.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
      const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), mode: "cors" });
      if (!response.ok) {
        if (response.status === 404 && tile.z > 0) return awaitFallback(tile);
        throw new Error(`Terrain request failed (${response.status}): ${url}`);
      }
      const blob = await response.blob();
      onBytes?.(blob.size);
      return { ...tile, ...await decode(blob) };
    } finally { active--; pump(); }
  }
  // Release the download slot before awaiting a parent (avoid queue deadlock).
  function awaitFallback(tile: TerrainTile): Promise<TerrainGrid> {
    return load({ z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) });
  }
  function pump() { while (active < 6 && queue.length) { active++; queue.shift()!(); } }
  function load(tile: TerrainTile): Promise<TerrainGrid> {
    if (controller.signal.aborted) return Promise.reject(new Error("Terrain loader disposed"));
    const shift = Math.max(0, tile.z - source.maxZoom);
    tile = { z: tile.z - shift, x: Math.floor(tile.x / 2 ** shift), y: Math.floor(tile.y / 2 ** shift) };
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const found = cache.get(key);
    if (found) { cache.delete(key); cache.set(key, found); return found; }
    const pending = download(tile).catch(error => { cache.delete(key); settled.delete(key); throw error; });
    cache.set(key, pending);
    // Settled arrays are small and bounded; geometry retains its own samples.
    void pending.then(() => {
      settled.add(key);
      for (const candidate of cache.keys()) {
        if (cache.size <= 256) break;
        if (settled.has(candidate)) { cache.delete(candidate); settled.delete(candidate); }
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
      neighbors.push(load({ z: grid.z, x: (grid.x + dx + n) % n, y: grid.y + dy }));
    }
    return { ...grid, neighbors: await Promise.all(neighbors) };
  }
  return { load, loadPatch, dispose() { controller.abort(); cache.clear(); settled.clear(); } };
}
