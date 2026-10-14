import { Mesh, VertexData, Vector3, type Scene, type TransformNode } from "@babylonjs/core";
import { DEG_TO_RAD, ecefOnParallel, geodeticParallel, geodeticToEcef, type EcefCoord } from "../camera/cameraMath.js";
import { sampleTerrainGrid, type TerrainGrid, type TerrainTile } from "../terrain/terrainGrid.js";
export interface TerrainMeshOptions {
  scene: Scene;
  source: { id: string };
  worldRoot?: TransformNode;
  segments?: number;
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
  nowMs(): number;
  performanceCapture?: { counters: { preparationCpuMs: number; geometryWrites: number } };
}
type TileCoord = TerrainTile;
export const DEFAULT_TILE_SEGMENTS = 64;
function tileXToLon(x: number, z: number): number {
  return (x / (2 ** z)) * 360 - 180;
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (2 ** z);
  return Math.atan(Math.sinh(n)) / DEG_TO_RAD;
}

function tileKey(tile: TileCoord): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

interface TerrainSurface { positions: number[]; uvs: number[] | null; center: EcefCoord; segments: number; minHeight: number; maxHeight: number }
/** A tile's vertices relative to its centre, as float64. */
function terrainSurface(options: Pick<TerrainMeshOptions, "segments" | "getSurfaceHeightMeters">, tile: TileCoord, grid: TerrainGrid | undefined, withUvs: boolean): TerrainSurface {
  const positions: number[] = [];
  const uvs: number[] | null = withUvs ? [] : null;
  const segments = Math.max(1, Math.round(options.segments ?? DEFAULT_TILE_SEGMENTS));
  const center = geodeticToEcef(tileYToLat(tile.y + 0.5, tile.z) * DEG_TO_RAD, tileXToLon(tile.x + 0.5, tile.z) * DEG_TO_RAD, 0);
  let minHeight = Infinity, maxHeight = -Infinity;
  const stride = segments + 1;
  // Every row has the same longitudes and every vertex of a row the same
  // latitude: their trigonometry is done once each, with geodeticToEcef's bits.
  const lonDegs = new Float64Array(stride), sinLons = new Float64Array(stride), cosLons = new Float64Array(stride);
  for (let col = 0; col <= segments; col += 1) {
    const lonDeg = tileXToLon(tile.x + col / segments, tile.z);
    lonDegs[col] = lonDeg; sinLons[col] = Math.sin(lonDeg * DEG_TO_RAD); cosLons[col] = Math.cos(lonDeg * DEG_TO_RAD);
  }
  const scale = grid ? 2 ** (grid.z - tile.z) : 1;
  const ecef = { x: 0, y: 0, z: 0 };

  for (let row = 0; row <= segments; row += 1) {
    const v = row / segments;
    const mercatorY = tile.y + v;
    const latDeg = tileYToLat(mercatorY, tile.z);
    const parallel = geodeticParallel(latDeg * DEG_TO_RAD);

    for (let col = 0; col <= segments; col += 1) {
      const u = col / segments;
      const mercatorX = tile.x + u;
      const altitudeMeters = grid
        ? sampleTerrainGrid(grid, mercatorX * scale, mercatorY * scale)
        : options.getSurfaceHeightMeters?.(latDeg, lonDegs[col]) ?? 0;
      if (altitudeMeters < minHeight) minHeight = altitudeMeters;
      if (altitudeMeters > maxHeight) maxHeight = altitudeMeters;
      ecefOnParallel(parallel, sinLons[col], cosLons[col], altitudeMeters, ecef);
      positions.push(ecef.x - center.x, ecef.y - center.y, ecef.z - center.z);
      uvs?.push(u, v);
    }
  }
  return { positions, uvs, center, segments, minHeight, maxHeight };
}

/**
 * The positions a new terrain mesh holds and its height range, without
 * building the mesh. Babylon stores an updatable mesh's positions as float32,
 * so each is rounded the same way.
 */
export function terrainMeshTarget(options: Pick<TerrainMeshOptions, "segments" | "getSurfaceHeightMeters">, tile: TileCoord, grid?: TerrainGrid): { positions: number[]; heightBounds: { min: number; max: number } } {
  const { positions, minHeight, maxHeight } = terrainSurface(options, tile, grid, false);
  for (let index = 0; index < positions.length; index++) positions[index] = Math.fround(positions[index]);
  return { positions, heightBounds: { min: minHeight, max: maxHeight } };
}

export function createTerrainMesh(options: TerrainMeshOptions, tile: TileCoord, grid?: TerrainGrid): Mesh {
  const started = options.performanceCapture ? options.nowMs() : 0;
  const { scene, source } = options;
  const mesh = new Mesh(`raster-basemap-tile-${source.id}-${tileKey(tile)}`, scene);
  const { positions, uvs, center, segments, minHeight, maxHeight } = terrainSurface(options, tile, grid, true);
  const stride = segments + 1;
  const indices: number[] = [];
  for (let row = 0; row < segments; row += 1) {
    for (let col = 0; col < segments; col += 1) {
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // No normal buffer. Tile materials disable scene lighting, and the terrain
  // light shades from the radial up direction, not vertex normals. Picking
  // asks for the face normal. A buffer here is computed, uploaded and never read.
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  data.applyToMesh(mesh, true);

  mesh.position = new Vector3(center.x, center.y, center.z);
  // The displayed height range, whatever the terrain came from; imagery culls with it.
  mesh.metadata = { mapSurface: true, terrainZoom: grid?.z ?? -1, segments, heightBounds: { min: minHeight, max: maxHeight } };

  mesh.isPickable = true;
  mesh.renderingGroupId = 0;
  mesh.setEnabled(false);
  if (options.worldRoot) {
    mesh.parent = options.worldRoot;
  } else {
    mesh.freezeWorldMatrix();
  }

  if (options.performanceCapture) {
    options.performanceCapture.counters.preparationCpuMs += options.nowMs() - started;
    options.performanceCapture.counters.geometryWrites++;
  }
  return mesh;
}
