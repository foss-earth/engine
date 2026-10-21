import { createHash, type Hash } from "node:crypto";
import { Mesh, NullEngine, Scene, TransformNode, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { patchPoint, patchesForGeometryCommit, stitchTerrainEdges, updateTerrainPositions, type TerrainPatch } from "../src/babylon/meshRefinement.js";

// Every mesh's stored positions and their type, its bounds and its cached world
// matrix after each commit round, from the shipped commit (engine 1e3a0a3). It
// uploaded each committed target, then each stitched edge and each repaired
// corner, one write at a time.
const SHIPPED_DIGEST = "49d5ceafd8c195d3bb73291a76898cf5716e163d424dcf251f0a168aeabf9691";

const RADIUS = 6_378_137;
type Placement = "frozen" | "parented";
interface Tile { z: number; x: number; y: number }
interface TileRecord extends TerrainPatch { key: string; target: Float32Array }
type Commit = (visible: readonly TileRecord[], changed: readonly TileRecord[]) => void;

const engines: NullEngine[] = [];
afterEach(() => engines.splice(0).forEach(engine => engine.dispose()));

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const keyOf = (tile: Tile) => `${tile.z}/${tile.x}/${tile.y}`;

/** A point at Web Mercator coordinates (u, v) in [0, 1] on a sphere of the Earth's radius, raised by `height`. */
function surface(u: number, v: number, height: number): [number, number, number] {
  const lon = (u - 0.5) * 2 * Math.PI, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * v))), r = RADIUS + height;
  return [r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), -r * Math.cos(lat) * Math.sin(lon)];
}
const ground = (u: number, v: number) => 1500 * Math.sin(u * 40) * Math.cos(v * 33) + 300 * Math.sin(u * 517 + v * 211);

/**
 * The commit as the runtime ran it: upload every committed target, then stitch
 * the committed tiles and the visible tiles that read them.
 */
const oneWriteAtATime: Commit = (visible, changed) => {
  for (const record of changed) updateTerrainPositions(record.mesh, record.target);
  stitchTerrainEdges(patchesForGeometryCommit(visible, new Set(changed.map(record => record.key))));
};

/**
 * A random quadtree with a refined patch somewhere and another across the
 * antimeridian, holes, the odd ancestor drawn over its descendants, mixed
 * segment counts and tile origins on the Earth's surface. Each round refines a
 * leaf, coarsens a parent, gives some leaves new heights and commits the way
 * the runtime does. The digest covers every mesh after every round.
 */
function run(seed: number, placement: Placement, commit: Commit, hash: Hash): void {
  const rand = seeded(seed);
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const records = new Map<string, TileRecord>(), tiles = new Map<string, Tile>(), leaves = new Set<string>();
  const focus: Array<[number, number]> = [[rand(), 0.2 + rand() * 0.6], [rand() < 0.5 ? 0.0004 : 0.9996, 0.2 + rand() * 0.6]];
  const [fx, fy, fz] = surface(focus[0][0], focus[0][1], 0);
  const root = placement === "parented" ? new TransformNode("terrain-root", scene) : null;
  root?.position.set(-fx, -fy, -fz);

  function target(tile: Tile, segments: number, noise: number): Float32Array {
    const n = 2 ** tile.z, [cx, cy, cz] = surface((tile.x + 0.5) / n, (tile.y + 0.5) / n, 0);
    const positions = new Float32Array((segments + 1) ** 2 * 3);
    for (let row = 0, i = 0; row <= segments; row++) for (let col = 0; col <= segments; col++, i += 3) {
      const u = (tile.x + col / segments) / n, v = (tile.y + row / segments) / n;
      const [x, y, z] = surface(u, v, ground(u, v) + (rand() - 0.5) * noise);
      positions[i] = x - cx; positions[i + 1] = y - cy; positions[i + 2] = z - cz;
    }
    return positions;
  }
  function recordOf(tile: Tile): TileRecord {
    const key = keyOf(tile), cached = records.get(key);
    if (cached) return cached;
    const segments = [4, 8, 16, 32][Math.floor(rand() * 4)], n = 2 ** tile.z;
    const mesh = new Mesh(key, scene), indices: number[] = [];
    for (let row = 0; row < segments; row++) for (let col = 0; col < segments; col++) {
      const i = row * (segments + 1) + col;
      indices.push(i, i + segments + 1, i + 1, i + 1, i + segments + 1, i + segments + 2);
    }
    const data = new VertexData(); data.positions = target(tile, segments, 400); data.indices = indices; data.applyToMesh(mesh, true);
    mesh.position = new Vector3(...surface((tile.x + 0.5) / n, (tile.y + 0.5) / n, 0));
    mesh.metadata = { segments };
    if (root) mesh.parent = root; else mesh.freezeWorldMatrix();
    const record: TileRecord = { key, tile, mesh, target: target(tile, segments, 200) };
    // About half the tiles were prepared while hidden, which uploads the target itself.
    if (rand() < 0.5) updateTerrainPositions(mesh, record.target);
    records.set(key, record); tiles.set(key, tile);
    return record;
  }
  const near = (tile: Tile) => {
    const n = 2 ** tile.z;
    return focus.some(([u, v]) => {
      const du = Math.abs((tile.x + 0.5) / n - u);
      return Math.min(du, 1 - du) * n < 1.5 && Math.abs((tile.y + 0.5) / n - v) * n < 1.5;
    });
  };
  const children = (tile: Tile): Tile[] => [0, 1, 2, 3].map(i => ({ z: tile.z + 1, x: tile.x * 2 + (i & 1), y: tile.y * 2 + (i >> 1) }));
  const partition = (tile: Tile): void => {
    tiles.set(keyOf(tile), tile);
    if (tile.z < 2 || (tile.z < 7 && near(tile) && rand() < 0.85) || (tile.z < 4 && rand() < 0.25)) children(tile).forEach(partition);
    else leaves.add(keyOf(tile));
  };
  partition({ z: 0, x: 0, y: 0 });
  for (const key of leaves) recordOf(tiles.get(key)!);

  let shown = new Set<string>();
  for (let round = 0; round < 7; round++) {
    const dirty = new Set<string>(), list = [...leaves];
    if (rand() < 0.7) {
      const key = list[Math.floor(rand() * list.length)], tile = tiles.get(key)!;
      if (tile.z < 9) {
        leaves.delete(key);
        for (const child of children(tile)) { recordOf(child); leaves.add(keyOf(child)); dirty.add(keyOf(child)); }
      }
    }
    if (rand() < 0.6) {
      const start = Math.floor(rand() * list.length);
      for (let i = 0; i < list.length; i++) {
        const tile = tiles.get(list[(start + i) % list.length]);
        if (!tile || tile.z < 2) continue;
        const parent = { z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 }, siblings = children(parent).map(keyOf);
        if (!siblings.every(key => leaves.has(key))) continue;
        siblings.forEach(key => leaves.delete(key));
        recordOf(parent); leaves.add(keyOf(parent)); dirty.add(keyOf(parent));
        break;
      }
    }
    for (const key of leaves) if (rand() < 0.15) {
      const record = records.get(key)!;
      record.target = target(record.tile, record.mesh.metadata.segments as number, 200);
      dirty.add(key);
    }
    const visible: TileRecord[] = [];
    for (const key of leaves) if (rand() > 0.04) visible.push(records.get(key)!);
    if (rand() < 0.3) {
      const tile = visible[Math.floor(rand() * visible.length)].tile;
      if (tile.z > 0) visible.push(recordOf({ z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 }));
    }
    // As in the runtime, a tile that comes into view is committed too.
    for (const record of visible) if (!shown.has(record.key)) dirty.add(record.key);
    shown = new Set(visible.map(record => record.key));
    // A floating origin moves between frames, and frames advance the render id.
    if (root) root.position.addInPlaceFromFloats((rand() - 0.5) * 2000, (rand() - 0.5) * 2000, (rand() - 0.5) * 2000);
    scene.incrementRenderId();
    commit(visible, visible.filter(record => dirty.has(record.key)));

    hash.update(`round ${round} ${visible.map(record => record.key).join(",")};`);
    for (const record of records.values()) digestMesh(hash, record.mesh);
  }
}

function digestNumbers(hash: Hash, values: ArrayLike<number>): void {
  hash.update(new Uint8Array(Float64Array.from(values).buffer));
}

/** Positions as float64 bits and their stored type, local and world bounds, and the cached world matrix. */
function digestMesh(hash: Hash, mesh: Mesh): void {
  const data = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  hash.update(`${mesh.name}:${Array.isArray(data) ? "array" : data.constructor.name}:${data.length};`);
  digestNumbers(hash, data);
  for (const info of [mesh.getBoundingInfo(), ...mesh.subMeshes.map(subMesh => subMesh.getBoundingInfo())]) {
    const box = info.boundingBox, sphere = info.boundingSphere;
    for (const vector of [box.minimum, box.maximum, box.center, box.extendSize, ...box.vectors, box.minimumWorld, box.maximumWorld,
      box.centerWorld, box.extendSizeWorld, ...box.vectorsWorld, sphere.center, sphere.centerWorld, sphere.minimum, sphere.maximum]) {
      digestNumbers(hash, vector.asArray());
    }
    digestNumbers(hash, [sphere.radius, sphere.radiusWorld]);
  }
  digestNumbers(hash, mesh.worldMatrixFromCache.m);
}

function digestOf(commit: Commit): string {
  const hash = createHash("sha256");
  for (const placement of ["frozen", "parented"] as const) for (const seed of [1, 2, 3, 4, 5, 6]) {
    hash.update(`${placement} ${seed};`);
    run(seed, placement, commit, hash);
  }
  return hash.digest("hex");
}

/** A flat tile in the plane y = `height`, as in meshRefinement.test.ts. */
function flat(scene: Scene, z: number, x: number, y: number, height: number): TerrainPatch {
  const mesh = new Mesh(`${z}/${x}/${y}`, scene), segments = 8, positions: number[] = [], indices: number[] = [];
  for (let row = 0; row <= segments; row++) for (let col = 0; col <= segments; col++) {
    positions.push((x + col / segments) / 2 ** z, height, (y + row / segments) / 2 ** z);
    if (col < segments && row < segments) { const i = row * (segments + 1) + col; indices.push(i, i + segments + 1, i + 1, i + 1, i + segments + 1, i + segments + 2); }
  }
  const data = new VertexData(); data.positions = positions; data.indices = indices; data.applyToMesh(mesh, true);
  mesh.metadata = { segments }; mesh.position = new Vector3(-0, -0, -0);
  return { mesh, tile: { z, x, y } };
}

describe("terrain seam identity", () => {
  it("gives the shipped positions, bounds and transforms over random quadtrees across the antimeridian", () => {
    expect(digestOf(oneWriteAtATime)).toBe(SHIPPED_DIGEST);
  });

  it("evaluates a point as the shipped sum, whose leading 0 turns −0 into +0", () => {
    const scene = new Scene(new NullEngine()); engines.push(scene.getEngine() as NullEngine);
    const terrain = flat(scene, 3, 4, 2, -0);
    const positions = Array.from(terrain.mesh.getVerticesData(VertexBuffer.PositionKind)!);
    positions[1 * 3 + 1] = -5; // the next vertex, weighted 0 at a grid point
    updateTerrainPositions(terrain.mesh, positions);
    const point = patchPoint(terrain, 4, 2, 3);
    expect(Object.is(point[1], 0)).toBe(true);
    expect(point[0]).toBe(0.5); expect(point[2]).toBe(0.25);
  });

  it("uploads a re-stitched edge whose only change turns −0 into +0", () => {
    const scene = new Scene(new NullEngine()); engines.push(scene.getEngine() as NullEngine);
    // The coarse tile's triangles meet the fine tile's west edge exactly, so every delta is +0.
    const coarse = flat(scene, 2, 1, 1, 0), fine = flat(scene, 3, 4, 2, -0);
    // A seam stitched before holds float64 numbers; this one still holds −0 heights.
    const stored = Array.from(fine.mesh.getVerticesData(VertexBuffer.PositionKind)!);
    updateTerrainPositions(fine.mesh, stored);
    expect(stored.filter((value, index) => index % 3 === 1 && Object.is(value, -0))).toHaveLength(81);
    const counters = { geometryWrites: 0, seamPasses: 0 };
    stitchTerrainEdges([fine, coarse], counters);
    expect(counters.geometryWrites).toBe(1);
    const after = fine.mesh.getVerticesData(VertexBuffer.PositionKind)!;
    expect(Array.isArray(after)).toBe(true);
    for (let row = 0; row <= 8; row++) for (let col = 0; col <= 8; col++) {
      const y = after[(row * 9 + col) * 3 + 1], banded = col < 4 && (col === 0 || (row > 0 && row < 8));
      expect(Object.is(y, banded ? 0 : -0), `${col}, ${row}`).toBe(true);
    }
  });
});
