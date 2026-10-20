import type { TerrainGrid } from "../terrain/terrainGrid.js";

/** Original pixel indices and values, with the original grid dimensions. Empty
 * neighbours still keep their place in first-covering-neighbour tie order. */
export interface TerrainHeightPixels extends TerrainGrid {
  indices: Uint32Array;
  neighbors?: TerrainHeightPixels[];
}

function ownIndices(grid: TerrainGrid, x: number, y: number, add: (grid: TerrainGrid, index: number) => void): void {
  const px = Math.max(0, Math.min(grid.size - 1, (x - grid.x) * grid.size - 0.5));
  const py = Math.max(0, Math.min(grid.size - 1, (y - grid.y) * grid.size - 0.5));
  const ix = Math.floor(px), iy = Math.floor(py);
  const jx = Math.min(ix + 1, grid.size - 1), jy = Math.min(iy + 1, grid.size - 1);
  add(grid, iy * grid.size + ix); add(grid, iy * grid.size + jx);
  add(grid, jy * grid.size + ix); add(grid, jy * grid.size + jx);
}
function covers(candidate: TerrainGrid, z: number, tx: number, ty: number): boolean {
  const scale = 2 ** (candidate.z - z);
  return Math.floor(tx * scale) === candidate.x && Math.floor(ty * scale) === candidate.y;
}
function pixelSource(grid: TerrainGrid, col: number, row: number): { source: TerrainGrid; x: number; y: number } {
  const n = 2 ** grid.z;
  const tx = ((grid.x + (col + 0.5) / grid.size) % n + n) % n;
  const ty = Math.max(0, Math.min(n - 1e-9, grid.y + (row + 0.5) / grid.size));
  let source = grid;
  if (!covers(grid, grid.z, tx, ty)) {
    for (const neighbor of grid.neighbors ?? []) if (covers(neighbor, grid.z, tx, ty)) { source = neighbor; break; }
  }
  const scale = 2 ** (source.z - grid.z);
  return { source, x: tx * scale, y: ty * scale };
}

/** Collect exactly the leaf pixels the retained reference reads. This resolves
 * sparse input only; the worker still evaluates coordinates and interpolation.
 * No rectangle expansion, height narrowing or precomputed result is sent. */
export function collectTerrainHeightPixels(grid: TerrainGrid, coordinates: Float64Array): TerrainHeightPixels {
  // Give repeated source objects independent logical slots. Only the first
  // covering neighbour is sampled; unused duplicate slots carry no pixels.
  const sources: TerrainGrid[] = [grid, ...(grid.neighbors ?? [])].map(source => ({
    z: source.z, x: source.x, y: source.y, size: source.size, heights: source.heights,
  }));
  if (grid.neighbors) sources[0].neighbors = sources.slice(1);
  grid = sources[0];
  const used = new Map(sources.map(source => [source, new Set<number>()]));
  const add = (source: TerrainGrid, index: number) => { used.get(source)!.add(index); };
  for (let at = 0; at < coordinates.length; at += 2) {
    const x = coordinates[at], y = coordinates[at + 1];
    if (grid.neighbors && (x - grid.x < 0.5 / grid.size || x - grid.x > 1 - 0.5 / grid.size
      || y - grid.y < 0.5 / grid.size || y - grid.y > 1 - 0.5 / grid.size)) {
      const ix = Math.floor((x - grid.x) * grid.size - 0.5), iy = Math.floor((y - grid.y) * grid.size - 0.5);
      for (const [col, row] of [[ix, iy], [ix + 1, iy], [ix, iy + 1], [ix + 1, iy + 1]]) {
        const value = pixelSource(grid, col, row); ownIndices(value.source, value.x, value.y, add);
      }
    } else ownIndices(grid, x, y, add);
  }
  const copy = (source: TerrainGrid): TerrainHeightPixels => {
    // A typed array sorts numerically.
    const indices = Uint32Array.from(used.get(source)!).sort();
    const heights = new Float32Array(indices.length);
    for (let i = 0; i < indices.length; i++) heights[i] = source.heights[indices[i]];
    return { z: source.z, x: source.x, y: source.y, size: source.size, indices, heights };
  };
  return { ...copy(grid), ...(grid.neighbors ? { neighbors: grid.neighbors.map(copy) } : {}) };
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
