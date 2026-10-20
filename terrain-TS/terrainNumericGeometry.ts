/** Opt-in renderer-free terrain preparation. Legacy rendering remains unchanged. */
import { DEG_TO_RAD, ecefOnParallel, geodeticParallel, geodeticToEcef, type EcefCoord } from "../src/camera/cameraMath.js";
import { sampleTerrainGridRow, terrainGridColumns, type TerrainGrid, type TerrainTile } from "../src/terrain/terrainGrid.js";

export interface TerrainNumericRequest {
  tile: TerrainTile;
  grid?: TerrainGrid;
  segments?: number;
  withUvs?: boolean;
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
}
export interface TerrainNumericGeometry {
  positions: Float64Array;
  targetPositions: Float32Array;
  uvs: Float64Array | null;
  indices: Uint32Array;
  center: EcefCoord;
  segments: number;
  heightBounds: { min: number; max: number };
  terrainZoom: number;
}

/** Shared bounds for an explicit worker job; these do not alter existing mesh calls. */
export function validateTerrainNumericRequest(request: TerrainNumericRequest): number {
  if (!request || typeof request !== "object") throw new TypeError("Terrain numeric request must be an object.");
  const tile = (value: TerrainTile): void => {
    if (!value || !Number.isInteger(value.z) || value.z < 0 || value.z > 30 || !Number.isInteger(value.x) || !Number.isInteger(value.y)
      || value.x < 0 || value.y < 0 || value.x >= 2 ** value.z || value.y >= 2 ** value.z) throw new RangeError("Invalid terrain numeric tile.");
  };
  tile(request.tile);
  if (request.segments != null && typeof request.segments !== "number") throw new TypeError("Terrain numeric segments must be numeric.");
  const segments = Math.max(1, Math.round(request.segments ?? 64));
  if (!Number.isInteger(segments) || segments > 512) throw new RangeError("Terrain numeric segments must round to 1–512.");
  if (request.withUvs !== undefined && typeof request.withUvs !== "boolean") throw new TypeError("Terrain numeric withUvs must be boolean.");
  if (request.grid != null && (typeof request.grid !== "object" || Array.isArray(request.grid))) throw new TypeError("Terrain numeric grid must be an object.");
  if (request.grid) {
    const neighbors = request.grid.neighbors ?? [];
    if (!Array.isArray(neighbors) || neighbors.length > 32) throw new RangeError("Terrain numeric jobs support at most 32 ordered neighbors.");
    let bytes = (7 + (neighbors.length + 1) * 6) * 8 + 56;
    for (const grid of [request.grid, ...neighbors]) {
      tile(grid);
      // Heights may be shared: decode workers publish them once and nothing writes them after.
      if (!Number.isSafeInteger(grid.size) || grid.size < 1 || grid.size > 4096 || !(grid.heights instanceof Float32Array)
        || grid.heights.length !== grid.size * grid.size) throw new RangeError("Malformed terrain numeric heights.");
      bytes += grid.heights.byteLength;
    }
    const vertices = (segments + 1) ** 2;
    bytes += vertices * 36 + (request.withUvs === false ? 0 : vertices * 16) + segments * segments * 24;
    if (bytes > 128 * 1024 ** 2) throw new RangeError("Terrain numeric payload exceeds 128 MiB.");
  }
  return segments;
}

/**
 * Renderer-free copy of the shipped surface arithmetic, for explicit worker
 * reference jobs. Keep expression order aligned with babylon/terrainMesh.ts.
 * No runtime is rewired to this helper until later parity work accepts it.
 */
export function prepareTerrainNumericGeometry(request: TerrainNumericRequest): TerrainNumericGeometry {
  const segments = validateTerrainNumericRequest(request), { tile, grid } = request;
  const stride = segments + 1, vertexCount = stride * stride, withUvs = request.withUvs !== false;
  const positions = new Array<number>(vertexCount * 3), uvs = withUvs ? new Array<number>(vertexCount * 2) : null;
  const tileXToLon = (x: number, z: number): number => (x / (2 ** z)) * 360 - 180;
  const tileYToLat = (y: number, z: number): number => {
    const n = Math.PI - (2 * Math.PI * y) / (2 ** z);
    return Math.atan(Math.sinh(n)) / DEG_TO_RAD;
  };
  const center = geodeticToEcef(tileYToLat(tile.y + 0.5, tile.z) * DEG_TO_RAD, tileXToLon(tile.x + 0.5, tile.z) * DEG_TO_RAD, 0);
  let minHeight = Infinity, maxHeight = -Infinity;
  const lonDegs = new Float64Array(stride), sinLons = new Float64Array(stride), cosLons = new Float64Array(stride);
  for (let col = 0; col <= segments; col += 1) {
    const lonDeg = tileXToLon(tile.x + col / segments, tile.z);
    lonDegs[col] = lonDeg; sinLons[col] = Math.sin(lonDeg * DEG_TO_RAD); cosLons[col] = Math.cos(lonDeg * DEG_TO_RAD);
  }
  const scale = grid ? 2 ** (grid.z - tile.z) : 1;
  const columns = grid ? terrainGridColumns(grid, Float64Array.from({ length: stride }, (_, col) => (tile.x + col / segments) * scale)) : null;
  const rowHeights = new Float64Array(stride), ecef = { x: 0, y: 0, z: 0 };
  let positionIndex = 0, uvIndex = 0;
  for (let row = 0; row <= segments; row += 1) {
    const v = row / segments, mercatorY = tile.y + v, latDeg = tileYToLat(mercatorY, tile.z);
    const parallel = geodeticParallel(latDeg * DEG_TO_RAD);
    if (grid && columns) sampleTerrainGridRow(grid, columns, mercatorY * scale, rowHeights);
    for (let col = 0; col <= segments; col += 1) {
      const u = col / segments;
      const altitudeMeters = columns ? rowHeights[col] : request.getSurfaceHeightMeters?.(latDeg, lonDegs[col]) ?? 0;
      if (altitudeMeters < minHeight) minHeight = altitudeMeters;
      if (altitudeMeters > maxHeight) maxHeight = altitudeMeters;
      ecefOnParallel(parallel, sinLons[col], cosLons[col], altitudeMeters, ecef);
      positions[positionIndex++] = ecef.x - center.x; positions[positionIndex++] = ecef.y - center.y; positions[positionIndex++] = ecef.z - center.z;
      if (uvs) { uvs[uvIndex++] = u; uvs[uvIndex++] = v; }
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let index = 0;
  for (let row = 0; row < segments; row += 1) for (let col = 0; col < segments; col += 1) {
    const a = row * stride + col, b = a + 1, c = a + stride, d = c + 1;
    indices[index++] = a; indices[index++] = c; indices[index++] = b;
    indices[index++] = b; indices[index++] = c; indices[index++] = d;
  }
  return { positions: Float64Array.from(positions), targetPositions: Float32Array.from(positions), uvs: uvs ? Float64Array.from(uvs) : null,
    indices, center, segments, heightBounds: { min: minHeight, max: maxHeight }, terrainZoom: grid?.z ?? -1 };
}

/**
 * Validates geometry and keeps its arrays. Only for geometry the caller owns
 * outright: arrays a worker transferred, or ones this thread just allocated.
 */
export function adoptTerrainNumericGeometry(value: TerrainNumericGeometry): TerrainNumericGeometry {
  if (!value || !Number.isInteger(value.segments) || value.segments < 1 || value.segments > 512) throw new RangeError("Invalid terrain geometry segments.");
  const vertices = (value.segments + 1) ** 2;
  if (!(value.positions instanceof Float64Array) || value.positions.length !== vertices * 3
    || !(value.targetPositions instanceof Float32Array) || value.targetPositions.length !== vertices * 3
    || (value.uvs !== null && (!(value.uvs instanceof Float64Array) || value.uvs.length !== vertices * 2))
    || !(value.indices instanceof Uint32Array) || value.indices.length !== value.segments * value.segments * 6
    || !value.center || ![value.center.x, value.center.y, value.center.z].every(Number.isFinite)
    || !Number.isInteger(value.terrainZoom) || value.terrainZoom < -1 || value.terrainZoom > 30
    || typeof value.heightBounds?.min !== "number" || typeof value.heightBounds?.max !== "number") throw new Error("Malformed terrain numeric geometry.");
  if (value.indices.some(index => index >= vertices)) throw new RangeError("Terrain numeric indices exceed the vertex buffer.");
  for (const data of [value.positions, value.targetPositions, value.uvs, value.indices]) if (data && !(data.buffer instanceof ArrayBuffer)) throw new Error("Shared terrain outputs need an explicit publication protocol.");
  return { positions: value.positions, targetPositions: value.targetPositions, uvs: value.uvs, indices: value.indices,
    center: { ...value.center }, segments: value.segments, heightBounds: { ...value.heightBounds }, terrainZoom: value.terrainZoom };
}

/** Fresh ownership before transfer or Babylon, even when the producer already copied. */
export function copyTerrainNumericGeometry(value: TerrainNumericGeometry): TerrainNumericGeometry {
  const adopted = adoptTerrainNumericGeometry(value);
  return { ...adopted, positions: adopted.positions.slice(), targetPositions: adopted.targetPositions.slice(), uvs: adopted.uvs?.slice() ?? null,
    indices: adopted.indices.slice() };
}
