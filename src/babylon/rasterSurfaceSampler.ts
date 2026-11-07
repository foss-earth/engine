import { Ray, Vector3, VertexBuffer } from "@babylonjs/core";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef } from "../camera/cameraMath.js";
import type { TerrainPatch } from "./meshRefinement.js";
import type { SurfaceHit } from "../surface/contracts.js";
import { sampleTerrainGrid, type TerrainGrid } from "../terrain/terrainGrid.js";

export interface RasterQueryCounters {
  samples: number;
  patches: number;
  triangles: number;
  fallbacks: number;
  misses: number;
}

const MAX_LAT = 85.05112878;
const EDGE_EPSILON = 1e-10;
const wrap = (x: number) => ((x % 1) + 1) % 1;
const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

/** Index only adopted coverage, independently of camera frustum culling/cache size.
 * Terrain buffers are ECEF offsets from mesh.position. The shared world-root
 * transform moves those meshes into display space; ECEF queries deliberately stay
 * before that transform, so floating-origin translation/rotation cancels exactly.
 * This helper is for createTerrainMesh patches, not arbitrary transformed meshes.
 */
export function createRasterSurfaceSampler(getRevision: () => number, counters?: RasterQueryCounters) {
  type PatchLevel = { z: number; n: number; cells: Map<number | string, TerrainPatch> };
  let levels: PatchLevel[] = [];
  const decoded = new Map<string, TerrainGrid>();
  const decodedOwners = new Map<string, string>();
  const decodedBuckets = new Map<string, Map<string, TerrainGrid>>();
  type DecodedLevel = { z: number; n: number; cells: Map<number | string, TerrainGrid> };
  const decodedByLevel = new Map<number, DecodedLevel>();
  let decodedLevels: DecodedLevel[] = [];
  const candidates: TerrainPatch[] = [];
  const ray = new Ray(Vector3.Zero(), Vector3.Zero(), 40000);
  const origin = Vector3.Zero(), a = Vector3.Zero(), b = Vector3.Zero(), c = Vector3.Zero();
  const edge1 = Vector3.Zero(), edge2 = Vector3.Zero(), normal = Vector3.Zero();
  const bestNormal = Vector3.Zero();
  let bestDistance = Infinity;
  let bestPatch: TerrainPatch | null = null;

  function setCoverage(patches: Iterable<TerrainPatch>): void {
    const byLevel = new Map<number, PatchLevel>();
    for (const patch of patches) {
      const { z, x, y } = patch.tile;
      let level = byLevel.get(z);
      if (!level) { level = { z, n: 2 ** z, cells: new Map() }; byLevel.set(z, level); }
      level.cells.set(level.n <= 2 ** 26 ? y * level.n + x : `${x}/${y}`, patch);
    }
    levels = [...byLevel.values()].sort((a, b) => b.z - a.z);
  }

  /** Grids are immutable after decode; shared heights are read without a copy. */
  function setDecodedGrids(grids: Iterable<TerrainGrid>): boolean {
    const incoming = new Map<string, TerrainGrid>();
    for (const grid of grids) {
      incoming.set(key(grid.z, grid.x, grid.y), grid);
    }
    let changed = incoming.size !== decoded.size;
    if (!changed) for (const [id, grid] of incoming) if (decoded.get(id) !== grid) { changed = true; break; }
    if (!changed) return false;
    clearDecodedGrids();
    for (const [id, grid] of incoming) setDecodedGrid(id, grid);
    return true;
  }

  function publishGrid(id: string, grid: TerrainGrid | undefined): void {
    // An owner may replace or release a reused wrapper after its metadata has
    // changed. Remove the registered address, not the wrapper's new address.
    const first = id.indexOf("/"), second = id.indexOf("/", first + 1);
    const z = Number(id.slice(0, first)), x = Number(id.slice(first + 1, second)), y = Number(id.slice(second + 1));
    let level = decodedByLevel.get(z);
    if (grid && !level) {
      level = { z, n: 2 ** z, cells: new Map() };
      decodedByLevel.set(z, level);
      decodedLevels = [...decodedByLevel.values()].sort((a, b) => b.z - a.z);
    }
    if (!level) return;
    const cell = level.n <= 2 ** 26 ? y * level.n + x : `${x}/${y}`;
    if (grid) { decoded.set(id, grid); level.cells.set(cell, grid); }
    else {
      decoded.delete(id); level.cells.delete(cell);
      if (level.cells.size === 0) {
        decodedByLevel.delete(z);
        decodedLevels = [...decodedByLevel.values()].sort((a, b) => b.z - a.z);
      }
    }
  }

  /** A record owns its decoded grid until replacement or eviction. Shared tiles retain their other owners. */
  function setDecodedGrid(owner: string, grid: TerrainGrid | null): boolean {
    const oldId = decodedOwners.get(owner);
    const id = grid ? key(grid.z, grid.x, grid.y) : undefined;
    if (oldId === id && (!id || decodedBuckets.get(id)?.get(owner) === grid)) return false;
    let changed = false;
    if (oldId) {
      const bucket = decodedBuckets.get(oldId)!;
      const previous = decoded.get(oldId);
      bucket.delete(owner); decodedOwners.delete(owner);
      let replacement: TerrainGrid | undefined;
      for (const value of bucket.values()) replacement = value;
      if (replacement !== previous) { publishGrid(oldId, replacement); changed = true; }
      if (!bucket.size) decodedBuckets.delete(oldId);
    }
    if (grid && id) {
      let bucket = decodedBuckets.get(id);
      if (!bucket) { bucket = new Map(); decodedBuckets.set(id, bucket); }
      bucket.set(owner, grid); decodedOwners.set(owner, id);
      if (decoded.get(id) !== grid) { publishGrid(id, grid); changed = true; }
    }
    return changed;
  }

  function clearDecodedGrids(): boolean {
    const changed = decoded.size > 0;
    decoded.clear(); decodedOwners.clear(); decodedBuckets.clear(); decodedByLevel.clear(); decodedLevels = [];
    return changed;
  }

  function findGrid(u: number, v: number): TerrainGrid | undefined {
    for (const { n, cells } of decodedLevels) {
      const x = Math.floor(u * n), y = Math.min(n - 1, Math.floor(v * n));
      const grid = cells.get(n <= 2 ** 26 ? y * n + x : `${x}/${y}`);
      if (grid) return grid;
    }
  }

  function find(u: number, v: number): TerrainPatch | undefined {
    if (v < -EDGE_EPSILON || v > 1 + EDGE_EPSILON) return;
    const wrappedU = wrap(u);
    for (const { n, cells } of levels) {
      const x = Math.floor(wrappedU * n), y = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
      const patch = cells.get(n <= 2 ** 26 ? y * n + x : `${x}/${y}`);
      if (patch && patch.mesh.isEnabled() && patch.mesh.isVisible && !patch.mesh.isDisposed()) return patch;
    }
  }

  function add(patch: TerrainPatch | undefined): void {
    if (patch && !candidates.includes(patch)) candidates.push(patch);
  }

  function intersect(patch: TerrainPatch, u: number, v: number, full: boolean): void {
    const { mesh, tile } = patch;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    const segments = mesh.metadata.segments as number;
    if (!positions || !indices || !Number.isInteger(segments) || segments < 1) return;
    if (counters) counters.patches++;
    ray.origin.copyFrom(origin).subtractInPlace(mesh.position);
    // Choose the longitude copy nearest this patch, including the dateline.
    const n = 2 ** tile.z;
    let x = u * n - tile.x;
    if (x > n / 2) x -= n;
    if (x < -n / 2) x += n;
    const col = Math.max(0, Math.min(segments - 1, Math.floor(x * segments)));
    const row = Math.max(0, Math.min(segments - 1, Math.floor((v * n - tile.y) * segments)));
    const r0 = full ? 0 : Math.max(0, row - 1), r1 = full ? segments - 1 : Math.min(segments - 1, row + 1);
    const c0 = full ? 0 : Math.max(0, col - 1), c1 = full ? segments - 1 : Math.min(segments - 1, col + 1);
    for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) {
      const start = (r * segments + col) * 6;
      for (let face = start; face < start + 6; face += 3) {
        if (counters) counters.triangles++;
        Vector3.FromArrayToRef(positions, indices[face] * 3, a);
        Vector3.FromArrayToRef(positions, indices[face + 1] * 3, b);
        Vector3.FromArrayToRef(positions, indices[face + 2] * 3, c);
        const hit = ray.intersectsTriangle(a, b, c);
        if (!hit || !Number.isFinite(hit.distance) || hit.distance >= bestDistance) continue;
        b.subtractToRef(a, edge1); c.subtractToRef(a, edge2);
        Vector3.CrossToRef(edge1, edge2, normal);
        if (normal.lengthSquared() === 0) continue;
        normal.normalize();
        if (Vector3.Dot(normal, ray.direction) > 0) normal.negateInPlace();
        bestNormal.copyFrom(normal);
        bestDistance = hit.distance;
        bestPatch = patch;
      }
    }
  }

  /** Contact queries use only the adopted mesh's current triangles, including
   * active morphs and stitched seams. Decoded residency cannot replace them. */
  function sample(latDeg: number, lonDeg: number): SurfaceHit | null {
    if (counters) counters.samples++;
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > MAX_LAT) return null;
    const u = wrap((lonDeg + 180) / 360);
    const lat = latDeg * DEG_TO_RAD, lon = (u * 360 - 180) * DEG_TO_RAD;
    const v = Math.max(0, Math.min(1, (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2));
    const primary = find(u, v);
    const start = geodeticToEcef(lat, lon, 20000);
    origin.set(start.x, start.y, start.z);
    ray.direction.set(-Math.cos(lat) * Math.cos(lon), -Math.cos(lat) * Math.sin(lon), -Math.sin(lat));
    bestDistance = Infinity; bestPatch = null; candidates.length = 0;
    add(primary);
    if (primary) {
      const { tile, mesh } = primary, n = 2 ** tile.z;
      // Shared/coarse edges can shift vertices away from nominal grid addressing.
      // Include the adjacent adopted owners when within two cells of a boundary.
      const margin = 2 / mesh.metadata.segments;
      const dx = u * n - tile.x, dy = v * n - tile.y;
      const nx = dx < margin ? (tile.x - EDGE_EPSILON) / n
        : dx > 1 - margin ? (tile.x + 1 + EDGE_EPSILON) / n : u;
      const ny = dy < margin ? (tile.y - EDGE_EPSILON) / n
        : dy > 1 - margin ? (tile.y + 1 + EDGE_EPSILON) / n : v;
      add(find(nx, v)); add(find(u, ny)); add(find(nx, ny));
    } else {
      // At an uncovered boundary its incident adopted patch can still own a hit.
      for (const dx of [-EDGE_EPSILON, 0, EDGE_EPSILON]) for (const dy of [-EDGE_EPSILON, 0, EDGE_EPSILON]) add(find(u + dx, v + dy));
    }
    for (const patch of candidates) intersect(patch, u, v, false);
    if (!bestPatch && candidates.length) {
      if (counters) counters.fallbacks++;
      // Exceptional restricted raycast: only adjacent adopted patches, never scene
      // traversal. Read actual indices here too, including currently morphed seams.
      for (const patch of candidates) intersect(patch, u, v, true);
    }
    const patch = bestPatch as TerrainPatch | null;
    if (!patch) {
      if (counters) counters.misses++;
      return null;
    }
    const point = { x: origin.x + ray.direction.x * bestDistance, y: origin.y + ray.direction.y * bestDistance,
      z: origin.z + ray.direction.z * bestDistance };
    const heightMeters = ecefToGeodetic(point.x, point.y, point.z).altMeters;
    if (![heightMeters, bestNormal.x, bestNormal.y, bestNormal.z].every(Number.isFinite)) return null;
    return { point, normal: { x: bestNormal.x, y: bestNormal.y, z: bestNormal.z }, distanceMeters: bestDistance,
      heightMeters, meshId: patch.mesh.id, revision: getRevision(), quality: patch.mesh.metadata.terrainZoom ?? -1 };
  }

  /** Camera eye contact may use finer resident decoded heights before mesh
   * adoption. It needs height/quality, not the displayed contact triangles. */
  function sampleHeight(latDeg: number, lonDeg: number): Pick<SurfaceHit, "heightMeters" | "quality"> | null {
    if (decodedLevels.length && Number.isFinite(latDeg) && Number.isFinite(lonDeg) && Math.abs(latDeg) <= MAX_LAT) {
      const u = wrap((lonDeg + 180) / 360);
      const v = Math.max(0, Math.min(1, (1 - Math.asinh(Math.tan(latDeg * DEG_TO_RAD)) / Math.PI) / 2));
      const grid = findGrid(u, v);
      if (grid && grid.z > (find(u, v)?.mesh.metadata.terrainZoom ?? -1)) {
        const heightMeters = sampleTerrainGrid(grid, u * 2 ** grid.z, v * 2 ** grid.z);
        if (Number.isFinite(heightMeters)) {
          if (counters) counters.samples++;
          return { heightMeters, quality: grid.z };
        }
      }
    }
    const hit = sample(latDeg, lonDeg);
    return hit ? { heightMeters: hit.heightMeters, quality: hit.quality } : null;
  }

  return { setCoverage, setDecodedGrids, setDecodedGrid, clearDecodedGrids, sample, sampleHeight };
}
