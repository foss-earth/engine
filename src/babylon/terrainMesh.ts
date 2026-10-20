import { Mesh, VertexData, Vector3, type Scene, type TransformNode } from "@babylonjs/core";
import { DEG_TO_RAD, ecefOnParallel, geodeticParallel, geodeticToEcef, type EcefCoord } from "../camera/cameraMath.js";
import { sampleTerrainGridRow, terrainGridColumns, type TerrainGrid, type TerrainTile } from "../terrain/terrainGrid.js";
import { copyTerrainNumericGeometry, type TerrainNumericGeometry } from "../../terrain-TS/terrainNumericGeometry.js";
export interface TerrainMeshOptions {
  scene: Scene;
  source: { id: string };
  worldRoot?: TransformNode;
  segments?: number;
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
  nowMs(): number;
  performanceCapture?: { counters: { preparationCpuMs: number; geometryWrites: number } };
}
/** Explicit host admission; native worker success alone never grants rendering admission. */
export type TerrainGeometryAdmission =
  | { backend: "typescript"; validationStatus: "reference" }
  | { backend: "wasm-single"; validationStatus: "validated"; evidence: string }
  | { backend: "wasm-single"; validationStatus: "unvalidated"; experimental: true; reason: string };
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

/** The triangles and texture coordinates of every tile with the same segments. */
export interface TerrainTopology { indices: Uint16Array | Uint32Array; uvs: Float32Array }
// Tiles of one segment count share these arrays: Babylon keeps each mesh's
// CPU indices and UVs for picking and context loss, and a copy per tile cost
// a few hundred kilobytes at the default segments and megabytes at the most.
// Nothing writes into them. Two counts coexist while a quality change
// replaces meshes; older entries leave the cache and live on while a mesh
// still holds them.
const topologies = new Map<number, TerrainTopology>();
const MAX_TOPOLOGIES = 4;
export function terrainTopology(segments: number): TerrainTopology {
  let topology = topologies.get(segments);
  if (topology) {
    topologies.delete(segments); topologies.set(segments, topology);
    return topology;
  }
  const stride = segments + 1;
  // 16-bit while every index is below 65535, as Babylon chooses for plain arrays.
  const indices = stride * stride - 1 < 65535 ? new Uint16Array(segments * segments * 6) : new Uint32Array(segments * segments * 6);
  let index = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let col = 0; col < segments; col += 1) {
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices[index++] = a; indices[index++] = c; indices[index++] = b;
      indices[index++] = b; indices[index++] = c; indices[index++] = d;
    }
  }
  const uvs = new Float32Array(stride * stride * 2);
  let uvIndex = 0;
  for (let row = 0; row <= segments; row += 1) {
    for (let col = 0; col <= segments; col += 1) { uvs[uvIndex++] = col / segments; uvs[uvIndex++] = row / segments; }
  }
  topology = { indices, uvs };
  topologies.set(segments, topology);
  if (topologies.size > MAX_TOPOLOGIES) topologies.delete(topologies.keys().next().value!);
  return topology;
}

interface TerrainSurface { positions: Float32Array; center: EcefCoord; segments: number; minHeight: number; maxHeight: number }
/**
 * A tile's vertices relative to its centre. Each is worked out in float64 and
 * stored as the float32 Babylon keeps for an updatable mesh.
 */
function terrainSurface(options: Pick<TerrainMeshOptions, "segments" | "getSurfaceHeightMeters">, tile: TileCoord, grid: TerrainGrid | undefined): TerrainSurface {
  const segments = Math.max(1, Math.round(options.segments ?? DEFAULT_TILE_SEGMENTS));
  const stride = segments + 1;
  const vertexCount = stride * stride;
  const positions = new Float32Array(vertexCount * 3);
  const center = geodeticToEcef(tileYToLat(tile.y + 0.5, tile.z) * DEG_TO_RAD, tileXToLon(tile.x + 0.5, tile.z) * DEG_TO_RAD, 0);
  let minHeight = Infinity, maxHeight = -Infinity;
  // Every row has the same longitudes and every vertex of a row the same
  // latitude: their trigonometry is done once each, with geodeticToEcef's bits.
  const lonDegs = new Float64Array(stride), sinLons = new Float64Array(stride), cosLons = new Float64Array(stride);
  for (let col = 0; col <= segments; col += 1) {
    const lonDeg = tileXToLon(tile.x + col / segments, tile.z);
    lonDegs[col] = lonDeg; sinLons[col] = Math.sin(lonDeg * DEG_TO_RAD); cosLons[col] = Math.cos(lonDeg * DEG_TO_RAD);
  }
  const scale = grid ? 2 ** (grid.z - tile.z) : 1;
  // Grid samples: what depends on the column alone is worked out once per
  // tile and the rest once per row, with sampleTerrainGrid's bits.
  const columns = grid ? terrainGridColumns(grid, Float64Array.from({ length: stride }, (_, col) => (tile.x + col / segments) * scale)) : null;
  const rowHeights = new Float64Array(stride);
  const ecef = { x: 0, y: 0, z: 0 };
  let positionIndex = 0;

  for (let row = 0; row <= segments; row += 1) {
    const v = row / segments;
    const mercatorY = tile.y + v;
    const latDeg = tileYToLat(mercatorY, tile.z);
    const parallel = geodeticParallel(latDeg * DEG_TO_RAD);
    if (grid && columns) sampleTerrainGridRow(grid, columns, mercatorY * scale, rowHeights);

    for (let col = 0; col <= segments; col += 1) {
      const altitudeMeters = columns
        ? rowHeights[col]
        : options.getSurfaceHeightMeters?.(latDeg, lonDegs[col]) ?? 0;
      if (altitudeMeters < minHeight) minHeight = altitudeMeters;
      if (altitudeMeters > maxHeight) maxHeight = altitudeMeters;
      ecefOnParallel(parallel, sinLons[col], cosLons[col], altitudeMeters, ecef);
      positions[positionIndex++] = ecef.x - center.x;
      positions[positionIndex++] = ecef.y - center.y;
      positions[positionIndex++] = ecef.z - center.z;
    }
  }
  return { positions, center, segments, minHeight, maxHeight };
}

/**
 * The positions a new terrain mesh holds and its height range, without
 * building the mesh.
 */
export function terrainMeshTarget(options: Pick<TerrainMeshOptions, "segments" | "getSurfaceHeightMeters">, tile: TileCoord, grid?: TerrainGrid): { positions: Float32Array; heightBounds: { min: number; max: number } } {
  const { positions, minHeight, maxHeight } = terrainSurface(options, tile, grid);
  return { positions, heightBounds: { min: minHeight, max: maxHeight } };
}

export function createTerrainMesh(options: TerrainMeshOptions, tile: TileCoord, grid?: TerrainGrid): Mesh {
  const started = options.performanceCapture ? options.nowMs() : 0;
  const { scene, source } = options;
  const mesh = new Mesh(`raster-basemap-tile-${source.id}-${tileKey(tile)}`, scene);
  const { positions, center, segments, minHeight, maxHeight } = terrainSurface(options, tile, grid);
  const { indices, uvs } = terrainTopology(segments);

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

/**
 * Explicit opt-in preparation boundary. Nothing in the existing raster runtime
 * calls this helper. Native results still need later functional parity before
 * a host enables them; structural checks here do not establish that parity.
 */
export function createTerrainMeshFromGeometry(options: TerrainMeshOptions, tile: TerrainTile, geometry: TerrainNumericGeometry, admission: TerrainGeometryAdmission): Mesh {
  const reference = admission?.backend === "typescript" && admission.validationStatus === "reference";
  const accepted = admission?.backend === "wasm-single" && admission.validationStatus === "validated"
    && typeof admission.evidence === "string" && admission.evidence.trim().length > 0;
  const experiment = admission?.backend === "wasm-single" && admission.validationStatus === "unvalidated"
    && admission.experimental === true && typeof admission.reason === "string" && admission.reason.trim().length > 0;
  if (!reference && !accepted && !experiment) throw new Error("Prepared terrain mesh needs explicit host validation or experimental admission.");
  const started = options.performanceCapture ? options.nowMs() : 0;
  const prepared = copyTerrainNumericGeometry(geometry);
  if (!prepared.uvs || !prepared.positions.every(Number.isFinite) || !prepared.targetPositions.every(Number.isFinite)
    || !prepared.uvs.every(Number.isFinite)
    || !Number.isFinite(prepared.heightBounds.min) || !Number.isFinite(prepared.heightBounds.max)
    || prepared.heightBounds.min > prepared.heightBounds.max) throw new Error("Prepared terrain mesh lacks finite geometry, height bounds, or UVs.");
  const mesh = new Mesh(`raster-basemap-tile-${options.source.id}-${tileKey(tile)}`, options.scene);
  const data = new VertexData();
  // These are newly owned copies. Babylon must never retain a worker/WASM
  // publication buffer that another generation could reuse.
  data.positions = prepared.targetPositions;
  data.indices = prepared.indices;
  data.uvs = Float32Array.from(prepared.uvs);
  data.applyToMesh(mesh, true);
  mesh.position = new Vector3(prepared.center.x, prepared.center.y, prepared.center.z);
  mesh.metadata = { mapSurface: true, terrainZoom: prepared.terrainZoom, segments: prepared.segments,
    heightBounds: { ...prepared.heightBounds }, preparationAdmission: { ...admission } };
  mesh.isPickable = true;
  mesh.renderingGroupId = 0;
  mesh.setEnabled(false);
  if (options.worldRoot) mesh.parent = options.worldRoot;
  else mesh.freezeWorldMatrix();
  if (options.performanceCapture) {
    options.performanceCapture.counters.preparationCpuMs += options.nowMs() - started;
    options.performanceCapture.counters.geometryWrites++;
  }
  return mesh;
}
