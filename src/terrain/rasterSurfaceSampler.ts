import { Ray, Vector3, VertexBuffer } from "@babylonjs/core";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef } from "../camera/cameraMath";
import type { TerrainPatch } from "./meshRefinement";
import type { SurfaceHit } from "./surfaceQuery";

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
  const coverage = new Map<string, TerrainPatch>();
  let levels: number[] = [];
  const candidates: TerrainPatch[] = [];
  const ray = new Ray(Vector3.Zero(), Vector3.Zero(), 40000);
  const origin = Vector3.Zero(), a = Vector3.Zero(), b = Vector3.Zero(), c = Vector3.Zero();
  const edge1 = Vector3.Zero(), edge2 = Vector3.Zero(), normal = Vector3.Zero();
  const bestNormal = Vector3.Zero();
  let bestDistance = Infinity;
  let bestPatch: TerrainPatch | null = null;

  function setCoverage(patches: Iterable<TerrainPatch>): void {
    coverage.clear();
    const zooms = new Set<number>();
    for (const patch of patches) {
      const { z, x, y } = patch.tile;
      coverage.set(key(z, x, y), patch);
      zooms.add(z);
    }
    levels = [...zooms].sort((a, b) => b - a);
  }

  function find(u: number, v: number): TerrainPatch | undefined {
    if (v < -EDGE_EPSILON || v > 1 + EDGE_EPSILON) return;
    for (const z of levels) {
      const n = 2 ** z;
      const patch = coverage.get(key(z, Math.floor(wrap(u) * n), Math.min(n - 1, Math.max(0, Math.floor(v * n)))));
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

  function sample(latDeg: number, lonDeg: number): SurfaceHit | null {
    if (counters) counters.samples++;
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > MAX_LAT) return null;
    const u = wrap((lonDeg + 180) / 360);
    const lat = latDeg * DEG_TO_RAD, lon = (u * 360 - 180) * DEG_TO_RAD;
    const v = Math.max(0, Math.min(1, (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2));
    const start = geodeticToEcef(lat, lon, 20000);
    origin.set(start.x, start.y, start.z);
    ray.direction.set(-Math.cos(lat) * Math.cos(lon), -Math.cos(lat) * Math.sin(lon), -Math.sin(lat));
    bestDistance = Infinity; bestPatch = null; candidates.length = 0;
    const primary = find(u, v);
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
    if (!patch) { if (counters) counters.misses++; return null; }
    const point = { x: origin.x + ray.direction.x * bestDistance, y: origin.y + ray.direction.y * bestDistance,
      z: origin.z + ray.direction.z * bestDistance };
    const heightMeters = ecefToGeodetic(point.x, point.y, point.z).altMeters;
    if (![heightMeters, bestNormal.x, bestNormal.y, bestNormal.z].every(Number.isFinite)) return null;
    return { point, normal: { x: bestNormal.x, y: bestNormal.y, z: bestNormal.z }, distanceMeters: bestDistance,
      heightMeters, meshId: patch.mesh.id, revision: getRevision(), quality: patch.mesh.metadata.terrainZoom ?? -1 };
  }

  return { setCoverage, sample };
}
