import { createHash } from "node:crypto";
import { NullEngine, NullEngineOptions, Scene, TransformNode, VertexBuffer, VertexData } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerrainMesh, terrainMeshTarget } from "../src/babylon/terrainMesh.js";
import type { TerrainGrid, TerrainTile } from "../src/terrain/terrainGrid.js";

// The arrays every terrain mesh is drawn with, as Babylon stores them, for
// tiles at the poles, the antimeridian, parent and child grids, grid
// neighbours, and no grid at all. The digest was taken from the shipped
// builder, which handed Babylon plain float64 arrays; a faster builder must
// give the same stored bits. Normals are not drawn with: no terrain shader
// reads them (createRasterTilesRuntime.test.ts).
const SHIPPED_DIGEST = "e8ef6fb7b4ea754eaf932379781c227636038bc91d63ab38c8668e2ff3d6d1ac";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.restoreAllMocks(); });

function grid(tile: TerrainTile, size: number, seed: number): TerrainGrid {
  const heights = new Float32Array(size * size);
  let state = seed;
  // Terrarium heights are whole multiples of 1/256 m.
  for (let index = 0; index < heights.length; index++) { state = (state * 1103515245 + 12345) >>> 0; heights[index] = (state % 2_000_000) / 256 - 3000; }
  return { ...tile, size, heights };
}
function withNeighbors(center: TerrainGrid, size: number): TerrainGrid {
  const n = 2 ** center.z, neighbors: TerrainGrid[] = [];
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const y = center.y + dy;
    if (y < 0 || y >= n) continue;
    neighbors.push(grid({ z: center.z, x: ((center.x + dx) % n + n) % n, y }, size, 7 * (dx + 2) + dy + 100));
  }
  // A coarser parent fills in where a neighbour is missing.
  neighbors.splice(2, 1, grid({ z: center.z - 1, x: Math.floor(center.x / 2), y: Math.floor(center.y / 2) }, size, 999));
  return { ...center, neighbors };
}
const CASES: { name: string; tile: TerrainTile; segments: number; grid?: TerrainGrid; height?: (latDeg: number, lonDeg: number) => number | null }[] = [
  { name: "whole world, no heights", tile: { z: 0, x: 0, y: 0 }, segments: 64 },
  { name: "whole world, height function", tile: { z: 0, x: 0, y: 0 }, segments: 16, height: (lat, lon) => 1000 * Math.sin(lat / 7) + lon / 3 },
  { name: "height function with gaps", tile: { z: 5, x: 7, y: 11 }, segments: 9, height: (lat, lon) => (Math.round(lat * 10) % 3 ? lat * lon : null) },
  { name: "north polar row", tile: { z: 3, x: 2, y: 0 }, segments: 64, grid: grid({ z: 3, x: 2, y: 0 }, 32, 1) },
  { name: "south polar row at the antimeridian", tile: { z: 3, x: 7, y: 7 }, segments: 64, grid: grid({ z: 3, x: 7, y: 7 }, 32, 2) },
  { name: "Minneapolis, own grid", tile: { z: 12, x: 985, y: 1471 }, segments: 64, grid: grid({ z: 12, x: 985, y: 1471 }, 64, 3) },
  { name: "Minneapolis, grid with neighbours", tile: { z: 12, x: 985, y: 1471 }, segments: 64, grid: withNeighbors(grid({ z: 12, x: 985, y: 1471 }, 32, 4), 32) },
  { name: "antimeridian, grid with neighbours", tile: { z: 6, x: 63, y: 20 }, segments: 64, grid: withNeighbors(grid({ z: 6, x: 63, y: 20 }, 16, 5), 16) },
  { name: "parent grid", tile: { z: 14, x: 3941, y: 5884 }, segments: 64, grid: grid({ z: 12, x: 985, y: 1471 }, 64, 6) },
  { name: "child grid", tile: { z: 11, x: 492, y: 735 }, segments: 7, grid: grid({ z: 12, x: 985, y: 1471 }, 16, 7) },
  { name: "one segment", tile: { z: 15, x: 7883, y: 11768 }, segments: 1, grid: grid({ z: 15, x: 7883, y: 11768 }, 8, 8) },
];

function build(test: typeof CASES[number]) {
  const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); engines.push(engine);
  const scene = new Scene(engine), root = new TransformNode("world", scene);
  const apply = vi.spyOn(VertexData.prototype, "applyToMesh");
  const mesh = createTerrainMesh({ scene, source: { id: "identity" }, nowMs: () => 0, worldRoot: root, segments: test.segments,
    ...(test.height ? { getSurfaceHeightMeters: test.height } : {}) }, test.tile, test.grid);
  const data = apply.mock.contexts[0] as VertexData | undefined;
  vi.restoreAllMocks();
  if (!data) throw new Error("The mesh was not built from VertexData.");
  return { data, mesh };
}
function digestOf(test: typeof CASES[number]): string {
  const { data, mesh } = build(test), hash = createHash("sha256");
  // Every bit Babylon stores and draws: an updatable mesh converts plain
  // arrays to float32 on creation, and keeps float32 arrays as they are.
  for (const values of [data.positions, data.uvs]) hash.update(new Uint8Array(Float32Array.from(values as ArrayLike<number>).buffer));
  hash.update(new Uint8Array(Uint32Array.from(data.indices as ArrayLike<number>).buffer));
  hash.update(new Uint8Array(Float64Array.from(mesh.position.asArray()).buffer));
  hash.update(JSON.stringify(mesh.metadata));
  return hash.digest("hex");
}

describe("terrain mesh identity", () => {
  it("builds every case with the shipped builder's bits", () => {
    const digests = CASES.map(test => `${test.name}: ${digestOf(test)}`);
    const all = createHash("sha256").update(digests.join("\n")).digest("hex");
    expect(all, digests.join("\n")).toBe(SHIPPED_DIGEST);
  });
  it("gives the positions Babylon stores for a new mesh, and its height range, without building one", () => {
    for (const test of CASES) {
      const { mesh } = build(test), stored = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const target = terrainMeshTarget({ segments: test.segments, ...(test.height ? { getSurfaceHeightMeters: test.height } : {}) }, test.tile, test.grid);
      expect(stored, test.name).toBeInstanceOf(Float32Array);
      expect(mesh.isVerticesDataPresent(VertexBuffer.NormalKind), test.name).toBe(false);
      expect(target.positions.length, test.name).toBe(stored.length);
      expect(target.positions.every((value, index) => Object.is(value, stored[index])), test.name).toBe(true);
      expect(target.heightBounds, test.name).toEqual(mesh.metadata.heightBounds);
    }
  });
  it("covers the edge, gap and fallback paths it claims to", () => {
    const polar = build(CASES[3]).data.positions as number[];
    expect(polar.every(Number.isFinite)).toBe(true);
    const height = vi.fn(CASES[2].height!);
    build({ ...CASES[2], height });
    const answers = height.mock.results.map(result => result.value as number | null);
    expect(answers).toContain(null); expect(answers.some(value => value !== null && value !== 0)).toBe(true);
  });
});
