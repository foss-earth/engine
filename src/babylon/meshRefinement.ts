import { VertexBuffer, type Mesh } from "@babylonjs/core";
import type { TerrainTile } from "../terrain/terrainGrid.js";

export interface TerrainPatch { mesh: Mesh; tile: TerrainTile }
export interface MeshRefinement { from: Float32Array; to: number[] | Float32Array; started: number; duration: number }
export interface GeometryWriteCounters { geometryWrites: number; seamPasses: number }
const order = (a: TerrainPatch, b: TerrainPatch) => a.tile.z - b.tile.z || a.tile.x - b.tile.x || a.tile.y - b.tile.y;
/** A copy of the positions a mesh draws with. */
export function meshPositions(mesh: Mesh): Float32Array {
  const data = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  // Terrain meshes hold float32. A plain array another caller uploaded is
  // rounded the way Babylon converts it for drawing.
  return data instanceof Float32Array ? data.slice() : Float32Array.from(data);
}
/**
 * Seams are stitched in float64 and kept so on the CPU. Neighbouring tiles
 * have different origins, so rounding each side to float32 can move a seam
 * lying in an axis plane, such as the antimeridian or the equator, just off
 * it, where Babylon's exact bounding-box check no longer admits a ray along it.
 */
function copyPositions(data: number[] | Float32Array): number[] {
  // Array.from is slow on a Float32Array; a copy loop gives the same numbers.
  if (Array.isArray(data)) return data.slice();
  const positions = new Array<number>(data.length);
  for (let index = 0; index < data.length; index++) positions[index] = data[index];
  return positions;
}
export function updateTerrainPositions(mesh: Mesh, positions: number[] | Float32Array): void {
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions as number[], true);
  refreshWorldBounds(mesh);
}
function refreshWorldBounds(mesh: Mesh): void {
  // Babylon rebuilds the bounds in local space on a position upload. Frozen
  // tile transforms will not run the usual world-bounds update at render time.
  // Reapply the transform to those bounds without scanning the vertices again.
  const world = mesh.getWorldMatrix();
  mesh.getBoundingInfo().update(world);
  for (const subMesh of mesh.subMeshes) {
    if (!subMesh.IsGlobal) subMesh.updateBoundingInfo(world);
  }
}

/**
 * The positions a terrain commit gives each mesh, uploaded once when it ends.
 * Until then the stitch reads them in place of what the mesh holds. An owned
 * array is a copy made during the commit, which the stitch may change in
 * place; any other array, such as a tile's target, is never changed.
 */
export type StagedTerrainPositions = Map<Mesh, { positions: number[] | Float32Array; owned: boolean }>;
/** Whether Babylon hands these positions back as given once they are uploaded to the mesh. */
function readsBackAsGiven(mesh: Mesh, positions: number[] | Float32Array): boolean {
  const buffer = mesh.getVertexBuffer(VertexBuffer.PositionKind);
  return !!buffer && buffer.isUpdatable() && buffer.type === VertexBuffer.FLOAT && buffer.getSize() === 3 && buffer.byteOffset === 0
    && buffer.byteStride === 12 && (positions instanceof Array || positions instanceof Float32Array)
    && positions.length === mesh.getTotalVertices() * 3;
}
/** Stage positions for the commit's upload, or upload them now if the stitch could not read them as staged. */
export function stageTerrainPositions(staged: StagedTerrainPositions, mesh: Mesh, positions: number[] | Float32Array, counters?: GeometryWriteCounters): void {
  if (readsBackAsGiven(mesh, positions)) {
    staged.set(mesh, { positions, owned: false });
    return;
  }
  staged.delete(mesh);
  updateTerrainPositions(mesh, positions);
  if (counters) counters.geometryWrites++;
}
/**
 * Upload each staged mesh once. A mesh that already holds the staged array
 * holds those numbers, since no stored array is changed in place, so it only
 * has its world bounds brought up to date, the one thing the upload would
 * still change. That also keeps its ground BVH, built from the same numbers.
 */
export function uploadStagedTerrainPositions(staged: StagedTerrainPositions, counters?: GeometryWriteCounters): void {
  for (const [mesh, { positions }] of staged) {
    staged.delete(mesh);
    if (positions === mesh.getVerticesData(VertexBuffer.PositionKind)) {
      refreshWorldBounds(mesh);
      continue;
    }
    updateTerrainPositions(mesh, positions);
    if (counters) counters.geometryWrites++;
  }
}
export function refineMesh(mesh: Mesh, to: number[] | Float32Array, now: number, duration = 1200): MeshRefinement {
  return { from: meshPositions(mesh), to, started: now, duration };
}
export function advanceRefinement(mesh: Mesh, refinement: MeshRefinement, now: number, counters?: GeometryWriteCounters): boolean {
  const t = Math.max(0, Math.min(1, (now - refinement.started) / refinement.duration));
  const blend = t * t * (3 - 2 * t);
  const { from, to } = refinement, positions = new Float32Array(from.length);
  for (let i = 0; i < from.length; i++) positions[i] = from[i] + (to[i] - from[i]) * blend;
  updateTerrainPositions(mesh, positions);
  if (counters) counters.geometryWrites++;
  return t < 1;
}

/** Interpolate the actual parent triangles, not a different height interpolant. */
export function patchPoint(patch: TerrainPatch, x: number, y: number, zoom: number): number[] {
  evaluatePoint(patch, patch.mesh.getVerticesData(VertexBuffer.PositionKind)!, x, y, zoom);
  return [point[0], point[1], point[2]];
}
const point = [0, 0, 0];
/** `patchPoint` into `point`, from the given positions. The sums keep their order, and their leading 0 turns −0 into +0. */
function evaluatePoint(patch: TerrainPatch, data: number[] | Float32Array, x: number, y: number, zoom: number): void {
  const segments = patch.mesh.metadata.segments as number;
  const scale = 2 ** (patch.tile.z - zoom);
  const u = Math.max(0, Math.min(segments, (x * scale - patch.tile.x) * segments));
  const v = Math.max(0, Math.min(segments, (y * scale - patch.tile.y) * segments));
  const col = Math.min(segments - 1, Math.floor(u)), row = Math.min(segments - 1, Math.floor(v));
  const du = u - col, dv = v - row, a = row * (segments + 1) + col;
  const lower = du + dv <= 1;
  const p0 = (lower ? a : a + 1) * 3, p1 = (lower ? a + 1 : a + segments + 1) * 3, p2 = (lower ? a + segments + 1 : a + segments + 2) * 3;
  const w0 = lower ? 1 - du - dv : 1 - dv, w1 = lower ? du : 1 - du, w2 = lower ? dv : du + dv - 1;
  const position = patch.mesh.position;
  point[0] = 0 + data[p0] * w0 + data[p1] * w1 + data[p2] * w2 + position.x;
  point[1] = 0 + data[p0 + 1] * w0 + data[p1 + 1] * w1 + data[p2 + 1] * w2 + position.y;
  point[2] = 0 + data[p0 + 2] * w0 + data[p1 + 2] * w1 + data[p2 + 2] * w2 + position.z;
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

/**
 * The levels at which a key `${z}/…` built from a whole level z ≥ 0 can be one
 * of these keys, in ascending order: the numbers written canonically before
 * their first slash. Lookups at any other level are bound to miss.
 */
function keyLevels(keys: Iterable<string>): number[] {
  const levels = new Set<number>();
  for (const key of keys) {
    const slash = key.indexOf("/");
    if (slash < 0) continue;
    const text = key.slice(0, slash), z = Number(text);
    if (Number.isInteger(z) && z >= 0 && `${z}` === text) levels.add(z);
  }
  return [...levels].sort((a, b) => a - b);
}

/**
 * Each side's neighbor keys, at those of `levels` up to the tile's, in the
 * order the commit has always visited them: by side, then by level.
 */
function someNeighborKey(tile: TerrainTile, levels: readonly number[], visit: (key: string) => boolean): boolean {
  for (let side = 0; side < 4; side += 1) {
    const x = tile.x + (side === 0 ? -1e-6 : side === 1 ? 1 + 1e-6 : 0.5);
    const y = tile.y + (side === 2 ? -1e-6 : side === 3 ? 1 + 1e-6 : 0.5);
    for (const z of levels) {
      if (!(z <= tile.z)) break;
      const factor = 2 ** (z - tile.z);
      const n = 2 ** z;
      const nx = ((Math.floor(x * factor) % n) + n) % n;
      const ny = Math.floor(y * factor);
      if (ny >= 0 && ny < n && visit(`${z}/${nx}/${ny}`)) return true;
    }
  }
  return false;
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
  // Neighbor keys are built only at the levels where they can match.
  const dirtyLevels = keyLevels(dirtyKeys), visibleLevels = keyLevels(byKey.keys());
  const isDirty = (key: string) => dirtyKeys.has(key);
  for (const patch of visible) {
    const key = tileKeyOf(patch.tile);
    if (dirtyKeys.has(key) || someNeighborKey(patch.tile, dirtyLevels, isDirty)) {
      selected.add(key);
    }
  }
  const select = (key: string) => {
    if (byKey.has(key)) selected.add(key);
    return false;
  };
  for (const key of [...selected]) {
    const patch = byKey.get(key);
    if (!patch) continue;
    someNeighborKey(patch.tile, visibleLevels, select);
  }
  return [...selected].map((key) => byKey.get(key)!);
}

/** Every 2^z with z at most this is exact, and so is y · 2^z + x for tiles inside their level. */
const NUMERIC_LEVELS = 26;
/**
 * The patches by tile, found as the stitch has always found them by string key
 * `${z}/${x}/${y}`, the last of equal keys winning. While every tile lies
 * inside its level, a number per level stands in for the string. `levels`
 * lists the whole levels z ≥ 0 that hold a patch, ascending; a lookup at any
 * other level is bound to miss.
 */
function indexPatches(patches: readonly TerrainPatch[]): { levels: number[]; find: (z: number, x: number, y: number) => TerrainPatch | undefined } {
  const levelSet = new Set<number>();
  let numeric = true;
  for (const { tile: { z, x, y } } of patches) {
    if (Number.isInteger(z) && z >= 0) levelSet.add(z + 0);
    if (!(Number.isInteger(z) && z >= 0 && z <= NUMERIC_LEVELS && Number.isInteger(x) && x >= 0 && x < 2 ** z
      && Number.isInteger(y) && y >= 0 && y < 2 ** z)) numeric = false;
  }
  const levels = [...levelSet].sort((a, b) => a - b);
  if (!numeric) {
    const byKey = new Map(patches.map(patch => [`${patch.tile.z}/${patch.tile.x}/${patch.tile.y}`, patch]));
    return { levels, find: (z, x, y) => byKey.get(`${z}/${x}/${y}`) };
  }
  // Lookups give x in [0, 2^z) and a whole y, for which y · 2^z + x is one-to-one.
  const byLevel = new Map<number, Map<number, TerrainPatch>>();
  for (const patch of patches) {
    const { z, x, y } = patch.tile;
    let level = byLevel.get(z);
    if (!level) byLevel.set(z, level = new Map());
    level.set(y * 2 ** z + x, patch);
  }
  return { levels, find: (z, x, y) => byLevel.get(z)?.get(y * 2 ** z + x) };
}

const BAND_WEIGHTS = [0, 1, 2, 3].map(band => (1 - band / 4) ** 2);
const CORNER_OFFSETS = [-1e-7, 1e-7];
const repairIndices: number[] = [], repairValues: number[] = [];

/**
 * Fine boundary vertices lie on the adjacent coarser triangles, including
 * during refinement. A short interior band blends the seam into fine detail.
 *
 * Given `staged`, the stitch reads and stages positions there for the caller
 * to upload once; without it, it uploads them itself when it ends. A tile is
 * staged only if the stitch would always have written it, and holds its
 * stored array until a value changes, as `Object.is` tells, −0 from +0.
 */
export function stitchTerrainEdges(patches: TerrainPatch[], counters?: GeometryWriteCounters, staged?: StagedTerrainPositions): void {
  if (counters) counters.seamPasses++;
  const writes: StagedTerrainPositions = staged ?? new Map();
  try {
    stitch(patches, writes);
  } finally {
    if (!staged) uploadStagedTerrainPositions(writes, counters);
  }
}

function stitch(patches: readonly TerrainPatch[], staged: StagedTerrainPositions): void {
  const { levels, find } = indexPatches(patches);
  const read = (mesh: Mesh) => staged.get(mesh)?.positions ?? mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const sorted = [...patches].sort(order);
  for (const patch of sorted) {
    const { tile, mesh } = patch;
    const segments = mesh.metadata.segments as number;
    const held = staged.get(mesh);
    let positions = held ? held.positions : mesh.getVerticesData(VertexBuffer.PositionKind)!;
    let copied = false, stitched = false;
    for (let side = 0; side < 4; side++) {
      const x = tile.x + (side === 0 ? -1e-6 : side === 1 ? 1 + 1e-6 : 0.5);
      const y = tile.y + (side === 2 ? -1e-6 : side === 3 ? 1 + 1e-6 : 0.5);
      let neighbor: TerrainPatch | undefined;
      for (const z of levels) {
        if (!(z <= tile.z)) break;
        const factor = 2 ** (z - tile.z), n = 2 ** z;
        neighbor = find(z, ((Math.floor(x * factor) % n) + n) % n, Math.floor(y * factor));
        if (neighbor) break;
      }
      if (!neighbor || order(neighbor, patch) >= 0) continue;
      stitched = true;
      const data = read(neighbor.mesh), origin = mesh.position;
      for (let i = 0; i <= segments; i++) {
        const col = side === 0 ? 0 : side === 1 ? segments : i;
        const row = side === 2 ? 0 : side === 3 ? segments : i;
        let sampleX = tile.x + col / segments;
        if (neighbor.tile.x === 0 && sampleX === 2 ** tile.z) sampleX = 0;
        if (neighbor.tile.x === 2 ** neighbor.tile.z - 1 && sampleX === 0) sampleX = 2 ** tile.z;
        evaluatePoint(neighbor, data, sampleX, tile.y + row / segments, tile.z);
        const index = (row * (segments + 1) + col) * 3;
        const dx = point[0] - origin.x - positions[index];
        const dy = point[1] - origin.y - positions[index + 1];
        const dz = point[2] - origin.z - positions[index + 2];
        for (let band = 0; band < 4; band++) {
          const c = col + (side === 0 ? band : side === 1 ? -band : 0);
          const r = row + (side === 2 ? band : side === 3 ? -band : 0);
          const vertex = (r * (segments + 1) + c) * 3;
          const weight = BAND_WEIGHTS[band];
          // Other boundary vertices are constrained separately, not pushed by
          // the interior feathering of this edge.
          if (band > 0 && (c === 0 || r === 0 || c === segments || r === segments)) continue;
          for (let axis = 0; axis < 3; axis++) {
            const value = positions[vertex + axis] + (axis === 0 ? dx : axis === 1 ? dy : dz) * weight;
            if (Object.is(value, positions[vertex + axis])) continue;
            if (!copied) { positions = copyPositions(positions); copied = true; }
            positions[vertex + axis] = value;
          }
        }
      }
    }
    if (!stitched) continue;
    // A stitched tile always holds its seam as a plain array.
    if (!copied && !Array.isArray(positions)) { positions = copyPositions(positions); copied = true; }
    staged.set(mesh, { positions, owned: copied || (held?.owned ?? false) });
  }
  // T-junction corners choose the same coarsest owner on all participating tiles.
  for (const patch of sorted) {
    const { tile, mesh } = patch;
    const segments = mesh.metadata.segments as number;
    const held = staged.get(mesh);
    const current = held ? held.positions : mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const origin = mesh.position;
    let repairs = 0;
    for (let corner = 0; corner < 4; corner++) {
      const cx = corner & 1, cy = corner >> 1;
      let owner = patch;
      for (const z of levels) {
        // Owners are compared by level first, so none above a found one can win.
        if (!(z <= tile.z) || owner.tile.z < z) break;
        const scale = 2 ** (z - tile.z), n = 2 ** z;
        for (const dx of CORNER_OFFSETS) for (const dy of CORNER_OFFSETS) {
          const candidate = find(z, ((Math.floor((tile.x + cx + dx) * scale) % n) + n) % n, Math.floor((tile.y + cy + dy) * scale));
          if (candidate && order(candidate, owner) < 0) owner = candidate;
        }
      }
      if (owner === patch) continue;
      let x = tile.x + cx;
      if (owner.tile.x === 0 && x === 2 ** tile.z) x = 0;
      if (owner.tile.x === 2 ** owner.tile.z - 1 && x === 0) x = 2 ** tile.z;
      evaluatePoint(owner, read(owner.mesh), x, tile.y + cy, tile.z);
      const index = (cy * segments * (segments + 1) + cx * segments) * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = point[axis] - (axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z);
        if (value === current[index + axis]) continue;
        repairIndices[repairs] = index + axis; repairValues[repairs++] = value;
      }
    }
    // Most patches already have correct corners after the edge pass. Copy and
    // stage a position buffer only when a corner actually needs repair.
    if (repairs === 0) continue;
    const positions = held?.owned ? held.positions as number[] : copyPositions(current);
    for (let repair = 0; repair < repairs; repair++) positions[repairIndices[repair]] = repairValues[repair];
    staged.set(mesh, { positions, owned: true });
  }
}
