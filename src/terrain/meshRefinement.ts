import { VertexBuffer, type Mesh } from "@babylonjs/core";
import type { TerrainTile } from "./terrainTiles";

export interface TerrainPatch { mesh: Mesh; tile: TerrainTile }
export interface MeshRefinement { from: number[]; to: number[]; started: number; duration: number }
export interface GeometryWriteCounters { geometryWrites: number; seamPasses: number }
const order = (a: TerrainPatch, b: TerrainPatch) => a.tile.z - b.tile.z || a.tile.x - b.tile.x || a.tile.y - b.tile.y;
export function meshPositions(mesh: Mesh): number[] { return Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!); }
export function updateTerrainPositions(mesh: Mesh, positions: number[]): void {
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
  // Babylon rebuilds the bounds in local space on a position upload. Frozen
  // tile transforms will not run the usual world-bounds update at render time.
  // Reapply the transform to those bounds without scanning the vertices again.
  const world = mesh.getWorldMatrix();
  mesh.getBoundingInfo().update(world);
  for (const subMesh of mesh.subMeshes) {
    if (!subMesh.IsGlobal) subMesh.updateBoundingInfo(world);
  }
}
export function refineMesh(mesh: Mesh, to: number[], now: number, duration = 1200): MeshRefinement {
  return { from: meshPositions(mesh), to, started: now, duration };
}
export function advanceRefinement(mesh: Mesh, refinement: MeshRefinement, now: number, counters?: GeometryWriteCounters): boolean {
  const t = Math.max(0, Math.min(1, (now - refinement.started) / refinement.duration));
  const blend = t * t * (3 - 2 * t);
  const positions = refinement.from.map((value, i) => value + (refinement.to[i] - value) * blend);
  updateTerrainPositions(mesh, positions);
  if (counters) counters.geometryWrites++;
  return t < 1;
}

/** Interpolate the actual parent triangles, not a different height interpolant. */
export function patchPoint(patch: TerrainPatch, x: number, y: number, zoom: number): number[] {
  const segments = patch.mesh.metadata.segments as number;
  const scale = 2 ** (patch.tile.z - zoom);
  const u = Math.max(0, Math.min(segments, (x * scale - patch.tile.x) * segments));
  const v = Math.max(0, Math.min(segments, (y * scale - patch.tile.y) * segments));
  const col = Math.min(segments - 1, Math.floor(u)), row = Math.min(segments - 1, Math.floor(v));
  const du = u - col, dv = v - row, a = row * (segments + 1) + col;
  const points = du + dv <= 1 ? [a, a + 1, a + segments + 1] : [a + 1, a + segments + 1, a + segments + 2];
  const weights = du + dv <= 1 ? [1 - du - dv, du, dv] : [1 - dv, 1 - du, du + dv - 1];
  const data = patch.mesh.getVerticesData(VertexBuffer.PositionKind)!;
  return [0, 1, 2].map(axis => points.reduce((sum, point, i) => sum + data[point * 3 + axis] * weights[i], 0)
    + patch.mesh.position.asArray()[axis]);
}

export function inheritParent(child: TerrainPatch, parent: TerrainPatch): number[] {
  const segments = child.mesh.metadata.segments as number;
  const origin = child.mesh.position.asArray();
  const positions: number[] = [];
  for (let row = 0; row <= segments; row++) for (let col = 0; col <= segments; col++) {
    const point = patchPoint(parent, child.tile.x + col / segments, child.tile.y + row / segments, child.tile.z);
    positions.push(...point.map((value, axis) => value - origin[axis]));
  }
  return positions;
}

function tileKeyOf(tile: TerrainTile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function neighborLookupKeys(tile: TerrainTile): string[] {
  const keys: string[] = [];
  for (let side = 0; side < 4; side += 1) {
    const x = tile.x + (side === 0 ? -1e-6 : side === 1 ? 1 + 1e-6 : 0.5);
    const y = tile.y + (side === 2 ? -1e-6 : side === 3 ? 1 + 1e-6 : 0.5);
    for (let z = 0; z <= tile.z; z += 1) {
      const factor = 2 ** (z - tile.z);
      const n = 2 ** z;
      const nx = ((Math.floor(x * factor) % n) + n) % n;
      const ny = Math.floor(y * factor);
      if (ny >= 0 && ny < n) keys.push(`${z}/${nx}/${ny}`);
    }
  }
  return keys;
}

/**
 * Seam stitching only has to revisit tiles whose stored vertices can change:
 * the tiles that just committed, every visible tile whose edge reads one of
 * those commits, and the neighbors those tiles sample. A remote tile is left
 * out of the upload.
 */
export function patchesForGeometryCommit(visible: readonly TerrainPatch[], dirtyKeys: ReadonlySet<string>): TerrainPatch[] {
  if (dirtyKeys.size === 0) return [];
  const byKey = new Map(visible.map((patch) => [tileKeyOf(patch.tile), patch]));
  const selected = new Set<string>();
  for (const patch of visible) {
    const key = tileKeyOf(patch.tile);
    if (dirtyKeys.has(key) || neighborLookupKeys(patch.tile).some((neighbor) => dirtyKeys.has(neighbor))) {
      selected.add(key);
    }
  }
  for (const key of [...selected]) {
    const patch = byKey.get(key);
    if (!patch) continue;
    for (const neighbor of neighborLookupKeys(patch.tile)) {
      if (byKey.has(neighbor)) selected.add(neighbor);
    }
  }
  return [...selected].map((key) => byKey.get(key)!);
}

/** Fine boundary vertices lie on the adjacent coarser triangles, including
 * during refinement. A short interior band blends the seam into fine detail. */
export function stitchTerrainEdges(patches: TerrainPatch[], counters?: GeometryWriteCounters): void {
  if (counters) counters.seamPasses++;
  const byKey = new Map(patches.map(patch => [`${patch.tile.z}/${patch.tile.x}/${patch.tile.y}`, patch]));
  for (const patch of [...patches].sort(order)) {
    const { tile, mesh } = patch;
    const segments = mesh.metadata.segments as number;
    let positions: number[] | null = null;
    for (let side = 0; side < 4; side++) {
      const x = tile.x + (side === 0 ? -1e-6 : side === 1 ? 1 + 1e-6 : 0.5);
      const y = tile.y + (side === 2 ? -1e-6 : side === 3 ? 1 + 1e-6 : 0.5);
      let neighbor: TerrainPatch | undefined;
      for (let z = 0; z <= tile.z && !neighbor; z++) {
        const factor = 2 ** (z - tile.z), n = 2 ** z;
        neighbor = byKey.get(`${z}/${((Math.floor(x * factor) % n) + n) % n}/${Math.floor(y * factor)}`);
      }
      if (!neighbor || order(neighbor, patch) >= 0) continue;
      positions ??= meshPositions(mesh);
      const origin = mesh.position.asArray();
      for (let i = 0; i <= segments; i++) {
        const col = side === 0 ? 0 : side === 1 ? segments : i;
        const row = side === 2 ? 0 : side === 3 ? segments : i;
        let sampleX = tile.x + col / segments;
        if (neighbor.tile.x === 0 && sampleX === 2 ** tile.z) sampleX = 0;
        if (neighbor.tile.x === 2 ** neighbor.tile.z - 1 && sampleX === 0) sampleX = 2 ** tile.z;
        const point = patchPoint(neighbor, sampleX, tile.y + row / segments, tile.z);
        const index = (row * (segments + 1) + col) * 3;
        const delta = point.map((value, axis) => value - origin[axis] - positions![index + axis]);
        for (let band = 0; band < 4; band++) {
          const c = col + (side === 0 ? band : side === 1 ? -band : 0);
          const r = row + (side === 2 ? band : side === 3 ? -band : 0);
          const vertex = (r * (segments + 1) + c) * 3;
          const weight = (1 - band / 4) ** 2;
          // Other boundary vertices are constrained separately, not pushed by
          // the interior feathering of this edge.
          if (band > 0 && (c === 0 || r === 0 || c === segments || r === segments)) continue;
          for (let axis = 0; axis < 3; axis++) positions[vertex + axis] += delta[axis] * weight;
        }
      }
    }
    if (positions) {
      updateTerrainPositions(mesh, positions);
      if (counters) counters.geometryWrites++;
    }
  }
  // T-junction corners choose the same coarsest owner on all participating tiles.
  for (const patch of [...patches].sort(order)) {
    const { tile, mesh } = patch;
    const segments = mesh.metadata.segments as number;
    const current = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const origin = mesh.position.asArray();
    let positions: number[] | null = null;
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      let owner = patch;
      for (let z = 0; z <= tile.z; z++) for (const dx of [-1e-7, 1e-7]) for (const dy of [-1e-7, 1e-7]) {
        const scale = 2 ** (z - tile.z), n = 2 ** z;
        const candidate = byKey.get(`${z}/${((Math.floor((tile.x + cx + dx) * scale) % n) + n) % n}/${Math.floor((tile.y + cy + dy) * scale)}`);
        if (candidate && order(candidate, owner) < 0) owner = candidate;
      }
      if (owner === patch) continue;
      let x = tile.x + cx;
      if (owner.tile.x === 0 && x === 2 ** tile.z) x = 0;
      if (owner.tile.x === 2 ** owner.tile.z - 1 && x === 0) x = 2 ** tile.z;
      const point = patchPoint(owner, x, tile.y + cy, tile.z);
      const index = (cy * segments * (segments + 1) + cx * segments) * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = point[axis] - origin[axis];
        if (value === current[index + axis]) continue;
        positions ??= Array.from(current);
        positions[index + axis] = value;
      }
    }
    // Most patches already have correct corners after the edge pass. Copy and
    // upload a position buffer only when a corner actually needs repair.
    if (positions) {
      updateTerrainPositions(mesh, positions);
      if (counters) counters.geometryWrites++;
    }
  }
}
