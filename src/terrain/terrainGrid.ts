/** Streamed elevation data. Values retain the provider's vertical reference. */
export interface TerrainTile { z: number; x: number; y: number }
export interface TerrainGrid extends TerrainTile { size: number; heights: Float32Array; neighbors?: TerrainGrid[] }
export interface TerrainSource {
  /** Stable selection key used by settings and cache boundaries. */
  id: string;
  label: string;
  provider: string;
  urlTemplate: string;
  maxZoom: number;
  attribution: string;
}
export const MAPTERHORN: TerrainSource = {
  id: "mapterhorn",
  label: "Mapterhorn Terrain",
  provider: "Mapterhorn",
  urlTemplate: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
  maxZoom: 15,
  attribution: "https://mapterhorn.com/attribution/",
};

/** Mapzen's public Terrarium archive, mirrored as static AWS terrain tiles. */
export const AWS_TERRARIUM: TerrainSource = {
  id: "aws-terrarium",
  label: "AWS Terrarium",
  provider: "Mapzen terrain tiles on AWS",
  urlTemplate: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  maxZoom: 15,
  attribution: "https://registry.opendata.aws/terrain-tiles/",
};

export const TERRAIN_SOURCES: readonly TerrainSource[] = [MAPTERHORN, AWS_TERRARIUM];
const TERRAIN_SOURCE_BY_ID = new Map(TERRAIN_SOURCES.map(source => [source.id, source]));

export function resolveTerrainSource(source: string | TerrainSource | null | undefined): TerrainSource {
  if (source && typeof source !== "string") return source;
  return TERRAIN_SOURCE_BY_ID.get(source ?? "") ?? MAPTERHORN;
}

export function isKnownTerrainSourceId(value: string | null | undefined): boolean {
  return typeof value === "string" && TERRAIN_SOURCE_BY_ID.has(value);
}

export { decodeTerrarium } from "../../raster-TS/terrarium.js";

/** Pixel-center interpolation; x/y are fractional tile coordinates at grid.z. */
export function sampleTerrainGrid(grid: TerrainGrid, x: number, y: number): number {
  if (grid.neighbors && (x - grid.x < 0.5 / grid.size || x - grid.x > 1 - 0.5 / grid.size
    || y - grid.y < 0.5 / grid.size || y - grid.y > 1 - 0.5 / grid.size)) {
    const px = (x - grid.x) * grid.size - 0.5, py = (y - grid.y) * grid.size - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), u = px - ix, v = py - iy;
    return (samplePixel(grid, grid.neighbors, ix, iy) * (1 - u) + samplePixel(grid, grid.neighbors, ix + 1, iy) * u) * (1 - v)
      + (samplePixel(grid, grid.neighbors, ix, iy + 1) * (1 - u) + samplePixel(grid, grid.neighbors, ix + 1, iy + 1) * u) * v;
  }
  return sampleOwnGrid(grid, x, y);
}

/**
 * What sampleTerrainGrid works out from x alone, for points that share their
 * x row after row, as a mesh's columns do.
 */
export interface TerrainGridColumns {
  xs: Float64Array;
  /** 1 where x lies within half a pixel of the grid's edge and neighbours may be read. */
  edge: Uint8Array;
  left: Float64Array;
  right: Float64Array;
  weight: Float64Array;
  rest: Float64Array;
}

export function terrainGridColumns(grid: TerrainGrid, xs: Float64Array): TerrainGridColumns {
  const count = xs.length, edge = new Uint8Array(count);
  const left = new Float64Array(count), right = new Float64Array(count), weight = new Float64Array(count), rest = new Float64Array(count);
  for (let col = 0; col < count; col++) {
    const x = xs[col];
    edge[col] = grid.neighbors && (x - grid.x < 0.5 / grid.size || x - grid.x > 1 - 0.5 / grid.size) ? 1 : 0;
    // sampleOwnGrid's expressions, in its order.
    const px = Math.max(0, Math.min(grid.size - 1, (x - grid.x) * grid.size - 0.5));
    const ix = Math.floor(px), u = px - ix;
    left[col] = ix; right[col] = Math.min(ix + 1, grid.size - 1); weight[col] = u; rest[col] = 1 - u;
  }
  return { xs, edge, left, right, weight, rest };
}

/** sampleTerrainGrid(grid, columns.xs[col], y) into out[col] for every column, with its bits. */
export function sampleTerrainGridRow(grid: TerrainGrid, columns: TerrainGridColumns, y: number, out: Float64Array): void {
  const { size, heights } = grid;
  const edgeRow = !!grid.neighbors && (y - grid.y < 0.5 / size || y - grid.y > 1 - 0.5 / size);
  const py = Math.max(0, Math.min(size - 1, (y - grid.y) * size - 0.5));
  const iy = Math.floor(py), jy = Math.min(iy + 1, size - 1), v = py - iy, restV = 1 - v;
  const top = iy * size, bottom = jy * size;
  const { xs, edge, left, right, weight, rest } = columns;
  for (let col = 0; col < out.length; col++) {
    if (edgeRow || edge[col]) { out[col] = sampleTerrainGrid(grid, xs[col], y); continue; }
    const ix = left[col], jx = right[col], u = weight[col], restU = rest[col];
    const a = heights[top + ix] * restU + heights[top + jx] * u;
    const b = heights[bottom + ix] * restU + heights[bottom + jx] * u;
    out[col] = a * restV + b * v;
  }
}

/** A pixel of the grid's tile or, past its edge, of the first neighbour that covers it; the grid's own when none does. */
function samplePixel(grid: TerrainGrid, neighbors: readonly TerrainGrid[], col: number, row: number): number {
  const n = 2 ** grid.z;
  const tx = ((grid.x + (col + 0.5) / grid.size) % n + n) % n;
  const ty = Math.max(0, Math.min(n - 1e-9, grid.y + (row + 0.5) / grid.size));
  let source = grid;
  if (!covers(grid, grid.z, tx, ty)) {
    for (const neighbor of neighbors) if (covers(neighbor, grid.z, tx, ty)) { source = neighbor; break; }
  }
  const scale = 2 ** (source.z - grid.z);
  // The source's own pixels: the patch is not followed again on its centre grid.
  return sampleOwnGrid(source, tx * scale, ty * scale);
}

function covers(candidate: TerrainTile, z: number, tx: number, ty: number): boolean {
  const scale = 2 ** (candidate.z - z);
  return Math.floor(tx * scale) === candidate.x && Math.floor(ty * scale) === candidate.y;
}

/** Pixel-center interpolation within the grid's own pixels, clamped at its edge. */
function sampleOwnGrid(grid: TerrainGrid, x: number, y: number): number {
  const px = Math.max(0, Math.min(grid.size - 1, (x - grid.x) * grid.size - 0.5));
  const py = Math.max(0, Math.min(grid.size - 1, (y - grid.y) * grid.size - 0.5));
  const ix = Math.floor(px), iy = Math.floor(py);
  const jx = Math.min(ix + 1, grid.size - 1), jy = Math.min(iy + 1, grid.size - 1);
  const u = px - ix, v = py - iy;
  const a = grid.heights[iy * grid.size + ix] * (1 - u) + grid.heights[iy * grid.size + jx] * u;
  const b = grid.heights[jy * grid.size + ix] * (1 - u) + grid.heights[jy * grid.size + jx] * u;
  return a * (1 - v) + b * v;
}

