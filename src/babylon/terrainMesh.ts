import { Mesh, VertexData, Vector3, type Scene, type TransformNode } from "@babylonjs/core";
import { DEG_TO_RAD, geodeticToEcef } from "../camera/cameraMath.js";
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

export function createTerrainMesh(options: TerrainMeshOptions, tile: TileCoord, grid?: TerrainGrid): Mesh {
  const started = options.performanceCapture ? options.nowMs() : 0;
  const { scene, source } = options;
  const mesh = new Mesh(`raster-basemap-tile-${source.id}-${tileKey(tile)}`, scene);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const segments = Math.max(1, Math.round(options.segments ?? DEFAULT_TILE_SEGMENTS));
  const center = geodeticToEcef(tileYToLat(tile.y + 0.5, tile.z) * DEG_TO_RAD, tileXToLon(tile.x + 0.5, tile.z) * DEG_TO_RAD, 0);
  let minHeight = Infinity, maxHeight = -Infinity;

  for (let row = 0; row <= segments; row += 1) {
    const v = row / segments;
    const mercatorY = tile.y + v;
    const latDeg = tileYToLat(mercatorY, tile.z);

    for (let col = 0; col <= segments; col += 1) {
      const u = col / segments;
      const mercatorX = tile.x + u;
      const lonDeg = tileXToLon(mercatorX, tile.z);
      const scale = grid ? 2 ** (grid.z - tile.z) : 1;
      const altitudeMeters = grid
        ? sampleTerrainGrid(grid, mercatorX * scale, mercatorY * scale)
        : options.getSurfaceHeightMeters?.(latDeg, lonDeg) ?? 0;
      if (altitudeMeters < minHeight) minHeight = altitudeMeters;
      if (altitudeMeters > maxHeight) maxHeight = altitudeMeters;
      const ecef = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, altitudeMeters);
      positions.push(ecef.x - center.x, ecef.y - center.y, ecef.z - center.z);
      uvs.push(u, v);
    }
  }

  const stride = segments + 1;
  for (let row = 0; row < segments; row += 1) {
    for (let col = 0; col < segments; col += 1) {
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);

  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
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
