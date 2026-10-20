import type { TerrainGrid } from "../terrain/terrainGrid.js";
import type { HeightBatch, PackedHeightBatches } from "./terrainHeightBatchProtocol.js";

/** Original pixel indices and values, with the original grid dimensions. Empty
 * neighbours still keep their place in first-covering-neighbour tie order. */
export interface TerrainHeightPixels extends TerrainGrid {
  indices: Uint32Array;
  neighbors?: TerrainHeightPixels[];
}

function ownIndices(grid: TerrainGrid, slot: number, x: number, y: number, visit: (slot: number, index: number) => void): void {
  const px = Math.max(0, Math.min(grid.size - 1, (x - grid.x) * grid.size - 0.5));
  const py = Math.max(0, Math.min(grid.size - 1, (y - grid.y) * grid.size - 0.5));
  const ix = Math.floor(px), iy = Math.floor(py);
  const jx = Math.min(ix + 1, grid.size - 1), jy = Math.min(iy + 1, grid.size - 1);
  visit(slot, iy * grid.size + ix); visit(slot, iy * grid.size + jx);
  visit(slot, jy * grid.size + ix); visit(slot, jy * grid.size + jx);
}
function covers(candidate: TerrainGrid, z: number, tx: number, ty: number): boolean {
  const scale = 2 ** (candidate.z - z);
  return Math.floor(tx * scale) === candidate.x && Math.floor(ty * scale) === candidate.y;
}
/** Slot 0 is the grid; slot i is its neighbour i - 1. */
function pixelSource(grid: TerrainGrid, col: number, row: number): { source: TerrainGrid; slot: number; x: number; y: number } {
  const n = 2 ** grid.z;
  const tx = ((grid.x + (col + 0.5) / grid.size) % n + n) % n;
  const ty = Math.max(0, Math.min(n - 1e-9, grid.y + (row + 0.5) / grid.size));
  let source = grid, slot = 0;
  if (!covers(grid, grid.z, tx, ty)) {
    const neighbors = grid.neighbors ?? [];
    for (let i = 0; i < neighbors.length; i++) if (covers(neighbors[i], grid.z, tx, ty)) { source = neighbors[i]; slot = i + 1; break; }
  }
  const scale = 2 ** (source.z - grid.z);
  return { source, slot, x: tx * scale, y: ty * scale };
}

/** Visit the slot (0 for the grid, then its neighbours in order) and index of
 * each leaf pixel the retained reference reads for the first `count`
 * coordinate pairs. A repeated neighbour object keeps its own slot: only the
 * first slot covering a pixel is read. Pixels may be visited more than once. */
export function visitTerrainHeightPixels(grid: TerrainGrid, coordinates: ArrayLike<number>, count: number, visit: (slot: number, index: number) => void): void {
  for (let at = 0; at < count * 2; at += 2) {
    const x = coordinates[at], y = coordinates[at + 1];
    if (grid.neighbors && (x - grid.x < 0.5 / grid.size || x - grid.x > 1 - 0.5 / grid.size
      || y - grid.y < 0.5 / grid.size || y - grid.y > 1 - 0.5 / grid.size)) {
      const ix = Math.floor((x - grid.x) * grid.size - 0.5), iy = Math.floor((y - grid.y) * grid.size - 0.5);
      for (let corner = 0; corner < 4; corner++) {
        const value = pixelSource(grid, ix + (corner & 1), iy + (corner >> 1));
        ownIndices(value.source, value.slot, value.x, value.y, visit);
      }
    } else ownIndices(grid, 0, x, y, visit);
  }
}

/** Collect exactly the leaf pixels the retained reference reads. This resolves
 * sparse input only; the worker still evaluates coordinates and interpolation.
 * No rectangle expansion, height narrowing or precomputed result is sent. */
export function collectTerrainHeightPixels(grid: TerrainGrid, coordinates: Float64Array): TerrainHeightPixels {
  // Unused duplicate slots carry no pixels.
  const used = [grid, ...(grid.neighbors ?? [])].map(() => new Set<number>());
  visitTerrainHeightPixels(grid, coordinates, coordinates.length / 2, (slot, index) => { used[slot].add(index); });
  const copy = (source: TerrainGrid, slot: number): TerrainHeightPixels => {
    // A typed array sorts numerically.
    const indices = Uint32Array.from(used[slot]).sort();
    const heights = new Float32Array(indices.length);
    for (let i = 0; i < indices.length; i++) heights[i] = source.heights[indices[i]];
    return { z: source.z, x: source.x, y: source.y, size: source.size, indices, heights };
  };
  return { ...copy(grid, 0), ...(grid.neighbors ? { neighbors: grid.neighbors.map((neighbor, i) => copy(neighbor, i + 1)) } : {}) };
}

// A pixel's key is its slot times 2^32 plus its index, so one numeric sort
// orders pixels by slot, then index. Indices of a 4096-square grid stay far
// below 2^32, and the keys of 33 slots are exact doubles.
const SLOT = 2 ** 32;
let keys = new Float64Array(4096);
/** The pixels of one request's sparse batches, as collectTerrainHeightPixels
 * would collect them, written into one table and three arrays. An unread
 * neighbour is left out: it is never the first to cover a pixel the
 * reference reads, so the neighbours kept still decide every pixel. */
export function packTerrainHeightPixels(): {
  add(gridId: number, grid: TerrainGrid, coordinates: ArrayLike<number>, count: number, budget: number): number | null;
  finish(): PackedHeightBatches;
} {
  const table: number[] = [], coordinates: number[] = [], heights: number[] = [], indices: number[] = [];
  let length = 0;
  const visit = (slot: number, index: number) => {
    if (length === keys.length) { const grown = new Float64Array(length * 2); grown.set(keys); keys = grown; }
    keys[length++] = slot * SLOT + index;
  };
  return {
    /** Append a batch of the first `count` coordinate pairs and return its
     * snapshot bytes, or append nothing and return null above `budget`. */
    add(gridId, grid, xy, count, budget) {
      length = 0;
      visitTerrainHeightPixels(grid, xy, count, visit);
      const sorted = keys.subarray(0, length).sort();
      let unique = 0;
      for (let k = 0; k < length; k++) if (!k || sorted[k] !== sorted[k - 1]) unique++;
      if (unique * 8 > budget) return null;
      const sources = [grid, ...(grid.neighbors ?? [])], row = table.length;
      table.push(gridId, count, 0, grid.neighbors ? 1 : 0);
      for (let slot = 0, k = 0; slot < sources.length; slot++) {
        const source = sources[slot], start = heights.length;
        for (; k < length && sorted[k] < (slot + 1) * SLOT; k++) if (!k || sorted[k] !== sorted[k - 1]) {
          const index = sorted[k] - slot * SLOT;
          indices.push(index); heights.push(source.heights[index]);
        }
        if (slot && heights.length === start) continue;
        table.push(source.z, source.x, source.y, source.size, heights.length - start); table[row + 2]++;
      }
      for (let i = 0; i < count * 2; i++) coordinates.push(xy[i]);
      return unique * 8;
    },
    finish: () => ({ table: new Float64Array(table), coordinates: new Float64Array(coordinates), heights: new Float32Array(heights), indices: new Uint32Array(indices) }),
  };
}
/** The sparse batches of a packed request, as views of its arrays. Pixel and
 * grid contents are validated where batches are evaluated. */
export function unpackTerrainHeightPixels(packed: PackedHeightBatches): HeightBatch[] {
  const { table, coordinates, heights, indices } = packed ?? {};
  if (!(table instanceof Float64Array) || !(coordinates instanceof Float64Array) || !(heights instanceof Float32Array)
    || !(indices instanceof Uint32Array) || heights.length !== indices.length) throw new Error("Invalid packed height request");
  const batches: HeightBatch[] = [];
  let at = 0, xy = 0, pixel = 0;
  while (at < table.length) {
    const gridId = table[at], pairs = table[at + 1], count = table[at + 2], present = table[at + 3];
    at += 4;
    if (at > table.length || !Number.isSafeInteger(pairs) || pairs < 1 || xy + pairs * 2 > coordinates.length
      || !Number.isSafeInteger(count) || count < 1 || count > 33 || (present !== 0 && present !== 1) || (count > 1 && !present)
      || at + count * 5 > table.length) throw new Error("Invalid packed height batch");
    const sources: TerrainHeightPixels[] = [];
    for (let i = 0; i < count; i++, at += 5) {
      const length = table[at + 4];
      if (!Number.isSafeInteger(length) || length < 0 || pixel + length > heights.length) throw new Error("Invalid packed height source");
      sources.push({ z: table[at], x: table[at + 1], y: table[at + 2], size: table[at + 3],
        heights: heights.subarray(pixel, pixel + length), indices: indices.subarray(pixel, pixel + length) });
      pixel += length;
    }
    batches.push({ gridId, coordinates: coordinates.subarray(xy, xy + pairs * 2), sparse: true,
      grid: present ? { ...sources[0], neighbors: sources.slice(1) } : sources[0] });
    xy += pairs * 2;
  }
  if (xy !== coordinates.length || pixel !== heights.length) throw new Error("Invalid packed height request");
  return batches;
}

function value(grid: TerrainHeightPixels, index: number): number {
  let low = 0, high = grid.indices.length;
  while (low < high) {
    const middle = (low + high) >>> 1, candidate = grid.indices[middle];
    if (candidate < index) low = middle + 1; else high = middle;
  }
  if (grid.indices[low] !== index) throw new Error("Sparse height snapshot is missing a required pixel");
  return grid.heights[low];
}
function own(grid: TerrainHeightPixels, x: number, y: number): number {
  const px = Math.max(0, Math.min(grid.size - 1, (x - grid.x) * grid.size - 0.5));
  const py = Math.max(0, Math.min(grid.size - 1, (y - grid.y) * grid.size - 0.5));
  const ix = Math.floor(px), iy = Math.floor(py);
  const jx = Math.min(ix + 1, grid.size - 1), jy = Math.min(iy + 1, grid.size - 1);
  const u = px - ix, v = py - iy;
  const a = value(grid, iy * grid.size + ix) * (1 - u) + value(grid, iy * grid.size + jx) * u;
  const b = value(grid, jy * grid.size + ix) * (1 - u) + value(grid, jy * grid.size + jx) * u;
  return a * (1 - v) + b * v;
}
/** The complete reference operation order over original sparse pixel values. */
export function sampleTerrainHeightPixels(grid: TerrainHeightPixels, x: number, y: number): number {
  if (grid.neighbors && (x - grid.x < 0.5 / grid.size || x - grid.x > 1 - 0.5 / grid.size
    || y - grid.y < 0.5 / grid.size || y - grid.y > 1 - 0.5 / grid.size)) {
    const px = (x - grid.x) * grid.size - 0.5, py = (y - grid.y) * grid.size - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), u = px - ix, v = py - iy;
    const pixel = (col: number, row: number) => {
      const point = pixelSource(grid, col, row);
      return own(point.source as TerrainHeightPixels, point.x, point.y);
    };
    return (pixel(ix, iy) * (1 - u) + pixel(ix + 1, iy) * u) * (1 - v)
      + (pixel(ix, iy + 1) * (1 - u) + pixel(ix + 1, iy + 1) * u) * v;
  }
  return own(grid, x, y);
}
