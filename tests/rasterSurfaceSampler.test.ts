import { MeshBuilder, NullEngine, NullEngineOptions, Scene, TransformNode, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEG_TO_RAD, geodeticToEcef } from "../src/camera/cameraMath.js";
import { createTerrainMesh } from "../src/babylon/terrainMesh.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import { advanceRefinement, inheritParent, meshPositions, refineMesh, stitchTerrainEdges, type TerrainPatch } from "../src/babylon/meshRefinement.js";
import { createRasterSurfaceSampler, type RasterQueryCounters } from "../src/babylon/rasterSurfaceSampler.js";
import { createSurfaceQuery } from "../src/babylon/surfaceQuery.js";
import { sampleTerrainGrid, type TerrainGrid, type TerrainTile } from "../src/terrain/terrainGrid.js";

const engines: NullEngine[] = [];
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); });
const coord = (tile: TerrainTile, u: number, v: number): [number, number] => [
  Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + v) / 2 ** tile.z))) / DEG_TO_RAD,
  (tile.x + u) / 2 ** tile.z * 360 - 180,
];
function setup() {
  const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); engines.push(engine);
  const scene = new Scene(engine), root = new TransformNode("world", scene);
  const counters: RasterQueryCounters = { samples: 0, patches: 0, triangles: 0, fallbacks: 0, misses: 0 };
  const sampler = createRasterSurfaceSampler(() => 27, counters);
  const reference = createSurfaceQuery(scene, () => root, mesh => Boolean(mesh.metadata?.mapSurface), () => 27);
  function patch(tile: TerrainTile, height = 250): TerrainPatch {
    // The segments these comparisons were written for; at 64 the dateline seam differs by about 5 cm.
    const mesh = createTerrainMesh({ scene, source: RASTER_BASE_MAP_SOURCES[0], nowMs: () => 0, worldRoot: root, segments: 128 },
      tile, { ...tile, size: 2, heights: new Float32Array([height, height + 25, height - 30, height + 80]) });
    mesh.setEnabled(true); mesh.computeWorldMatrix(true);
    return { tile, mesh };
  }
  function compare(lat: number, lon: number, checkNormal = true) {
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
    const actual = sampler.sample(lat, lon), expected = reference.sample(lat, lon);
    expect(expected, `reference ${lat},${lon}`).not.toBeNull();
    expect(actual, `indexed ${lat},${lon}`).not.toBeNull();
    expect(Math.abs(actual!.heightMeters - expected!.heightMeters)).toBeLessThan(0.01);
    expect(Math.abs(actual!.distanceMeters - expected!.distanceMeters)).toBeLessThan(0.01);
    expect(actual!.revision).toBe(27);
    if (checkNormal) {
      const a = actual!.normal, b = expected!.normal;
      const dot = a.x * b.x + a.y * b.y + a.z * b.z;
      expect(Math.acos(Math.min(1, Math.max(-1, dot))) / DEG_TO_RAD).toBeLessThan(0.1);
    }
    return actual!;
  }
  return { scene, root, patch, sampler, reference, compare, counters };
}

describe("indexed adopted raster triangles", () => {
  it("updates decoded residency by owner without dropping another record's shared grid", () => {
    const s = setup(), tile = { z: 15, x: 7898, y: 11805 };
    const grid = { ...tile, size: 2, heights: new Float32Array(4).fill(275) };
    const replacement = { ...tile, size: 2, heights: new Float32Array(4).fill(310) };
    const location = coord(tile, 0.41, 0.63);
    expect(s.sampler.setDecodedGrid("a", grid)).toBe(true);
    expect(s.sampler.setDecodedGrid("a", grid)).toBe(false);
    expect(s.sampler.setDecodedGrid("b", grid)).toBe(false);
    expect(s.sampler.setDecodedGrid("a", null)).toBe(false);
    expect(s.sampler.sampleHeight(...location)).toEqual({ heightMeters: 275, quality: 15 });
    expect(s.sampler.setDecodedGrid("b", replacement)).toBe(true);
    expect(s.sampler.sampleHeight(...location)).toEqual({ heightMeters: 310, quality: 15 });
    expect(s.sampler.setDecodedGrid("c", grid)).toBe(true);
    expect(s.sampler.setDecodedGrid("c", null)).toBe(true);
    expect(s.sampler.sampleHeight(...location)).toEqual({ heightMeters: 310, quality: 15 });
    expect(s.sampler.clearDecodedGrids()).toBe(true);
    expect(s.sampler.clearDecodedGrids()).toBe(false);
    expect(s.sampler.sampleHeight(...location)).toBeNull();
  });

  it("returns the same height and quality as full queries for decoded and adopted surfaces", () => {
    const s = setup(), tile = { z: 15, x: 7898, y: 11805 };
    const patch = s.patch(tile);
    s.sampler.setCoverage([patch]);
    const location = coord(tile, 0.41, 0.63);
    const meshHit = s.sampler.sample(...location)!;
    expect(s.sampler.sampleHeight(...location)).toEqual({ heightMeters: meshHit.heightMeters, quality: meshHit.quality });
    s.sampler.setDecodedGrid("fine", { z: 16, x: tile.x * 2, y: tile.y * 2 + 1, size: 2,
      heights: new Float32Array([100, 200, 300, 400]) });
    const gridHit = s.sampler.sample(...location)!;
    const triangles = s.counters.triangles;
    expect(s.sampler.sampleHeight(...location)).toEqual({ heightMeters: gridHit.heightMeters, quality: 16 });
    expect(s.counters.triangles).toBe(triangles);
    expect(s.sampler.setDecodedGrid("fine", null)).toBe(true);
    expect(s.sampler.sampleHeight(...location)).toEqual({ heightMeters: meshHit.heightMeters, quality: meshHit.quality });
  });

  it.each(["x", "z"] as const)("releases a reused grid's original index after its %s changes", axis => {
    const s = setup(), tile = { z: 15, x: 7898, y: 11805 };
    const grid = { ...tile, size: 2, heights: new Float32Array(4).fill(275) };
    const location = coord(tile, 0.4, 0.6);
    s.sampler.setDecodedGrid("owner", grid);
    expect(s.sampler.sampleHeight(...location)?.heightMeters).toBe(275);
    grid[axis]++;
    expect(s.sampler.setDecodedGrid("owner", null)).toBe(true);
    expect(s.sampler.sampleHeight(...location)).toBeNull();
    expect(s.sampler.clearDecodedGrids()).toBe(false);
  });

  it.each([false, true])("samples finer resident decoded heights before mesh adoption (shared=%s)", shared => {
    const s = setup();
    const coarse = s.patch({ z: 14, x: 3949, y: 5902 }, 1000);
    const tile = { z: 15, x: 7898, y: 11805 };
    const heights = shared ? new Float32Array(new SharedArrayBuffer(4 * 4)) : new Float32Array(4);
    heights.set([200, 210, 220, 230]);
    const grid: TerrainGrid = { ...tile, size: 2, heights };
    const location = coord(tile, 0.41, 0.63);
    s.sampler.setCoverage([coarse]);
    expect(s.sampler.setDecodedGrids([grid])).toBe(true);
    expect(s.sampler.setDecodedGrids([grid])).toBe(false);
    const hit = s.sampler.sample(...location)!;
    expect(hit.heightMeters).toBeCloseTo(sampleTerrainGrid(grid, tile.x + 0.41, tile.y + 0.63), 7);
    expect(hit.quality).toBe(15);
    expect(hit.meshId).toBe(`terrain-grid:15/7898/11805`);
    expect(hit.revision).toBe(27);
    expect(Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z)).toBeCloseTo(1, 8);
    expect(s.counters.triangles).toBe(0);
    // A decoded grid can serve a proximity tile without a displayed mesh.
    s.sampler.setCoverage([]);
    expect(s.sampler.sample(...location)?.heightMeters).toBeCloseTo(hit.heightMeters, 8);
    expect(s.sampler.setDecodedGrids([])).toBe(true);
    expect(s.sampler.sample(...location)).toBeNull();
  });

  it("keeps adopted geometry when decoded data has no finer quality", () => {
    const s = setup(), tile = { z: 15, x: 7898, y: 11805 };
    const patch = s.patch(tile, 250);
    s.sampler.setCoverage([patch]);
    s.sampler.setDecodedGrids([{ ...tile, size: 2, heights: new Float32Array(4).fill(900) }]);
    expect(s.sampler.sample(...coord(tile, 0.41, 0.63))?.meshId).toBe(patch.mesh.id);
  });

  it.each([{ z: 15, x: 7898, y: 11805 }, { z: 2, x: 1, y: 1 }, { z: 15, x: 0, y: 0 },
    { z: 15, x: 32767, y: 32767 }])("matches curved geometry and normals at $z/$x/$y", tile => {
    const s = setup(), patch = s.patch(tile);
    s.sampler.setCoverage([patch]);
    for (let i = 0; i < 31; i++) s.compare(...coord(tile, 0.08 + (i * 0.0713) % 0.84, 0.08 + (i * 0.1379) % 0.84));
    for (const offset of [-1e-9, 0, 1e-9]) s.compare(...coord(tile, 0.5 + offset, 0.5), false);
    expect(s.counters.fallbacks).toBe(0);
    s.root.rotation.set(0.4, -0.7, 1.1);
    s.root.position.set(-4000000, 3000000, 600000);
    s.compare(...coord(tile, 0.411, 0.633));
  });

  it("reads active morphs and mixed-detail stitched edges/corners", () => {
    const s = setup();
    const coarse = s.patch({ z: 13, x: 1500, y: 3000 }, 100);
    const top = s.patch({ z: 14, x: 3002, y: 6000 }, 400);
    const bottom = s.patch({ z: 14, x: 3002, y: 6001 }, 700);
    const patches = [coarse, top, bottom];
    s.sampler.setCoverage(patches);
    const target = meshPositions(top.mesh);
    top.mesh.updateVerticesData(VertexBuffer.PositionKind, target.map(value => value + 10), true);
    const morph = refineMesh(top.mesh, target, 0);
    for (const time of [0, 500, 1200]) {
      advanceRefinement(top.mesh, morph, time);
      stitchTerrainEdges(patches);
      for (const v of [0.001, 0.25, 0.5, 0.75, 0.999]) for (const u of [-1e-7, 0, 1e-7, 0.015, 0.1]) {
        s.compare(...coord(top.tile, u, v), u === 0.1);
      }
      s.compare(...coord(bottom.tile, 0.001, 0.001), false);
    }
    expect(s.counters.fallbacks).toBe(0);
  });

  it("indexes the active parent, then the adopted children with inherited triangles", () => {
    const s = setup(), parent = s.patch({ z: 13, x: 1500, y: 3000 });
    s.sampler.setCoverage([parent]);
    const children = [0, 1].flatMap(y => [0, 1].map(x => s.patch({ z: 14, x: 3000 + x, y: 6000 + y }, 800)));
    children.forEach(child => child.mesh.setEnabled(false));
    const location = coord(children[0].tile, 0.34, 0.57);
    expect(s.compare(...location).meshId).toBe(parent.mesh.id);
    for (const child of children) {
      child.mesh.updateVerticesData(VertexBuffer.PositionKind, inheritParent(child, parent), true);
      child.mesh.setEnabled(true);
    }
    parent.mesh.setEnabled(false);
    s.sampler.setCoverage(children);
    expect(s.compare(...location).meshId).toBe(children[0].mesh.id);
    s.sampler.setCoverage([]);
    expect(s.sampler.sample(...location)).toBeNull();
  });

  it("wraps dateline edges and rejects unavailable/invalid coordinates", () => {
    const s = setup(), west = s.patch({ z: 15, x: 32767, y: 16384 });
    const east = s.patch({ z: 15, x: 0, y: 16384 }, 500);
    stitchTerrainEdges([west, east]);
    s.sampler.setCoverage([west, east]);
    const [lat] = coord(west.tile, 1, 0.47);
    for (const lon of [-180 - 1e-7, -180, 180, 180 + 1e-7, 540]) s.compare(lat, lon, false);
    for (const location of [[NaN, 0], [0, Infinity], [90, 0], [-90, 0], [0, 0]]) expect(s.sampler.sample(...location as [number, number])).toBeNull();
    east.mesh.setEnabled(false);
    expect(s.sampler.sample(...coord(east.tile, 0.5, 0.5))).toBeNull();
  });

  it("restricts exceptional misses to nearby adopted triangles", () => {
    const s = setup(), patch = s.patch({ z: 15, x: 7898, y: 11805 });
    s.sampler.setCoverage([patch]);
    const [lat, lon] = coord(patch.tile, 0.5, 0.5), [lat2, lon2] = coord(patch.tile, 0.55, 0.5);
    const a = geodeticToEcef(lat * DEG_TO_RAD, lon * DEG_TO_RAD, 0);
    const b = geodeticToEcef(lat2 * DEG_TO_RAD, lon2 * DEG_TO_RAD, 0);
    const delta = [b.x - a.x, b.y - a.y, b.z - a.z];
    patch.mesh.updateVerticesData(VertexBuffer.PositionKind, meshPositions(patch.mesh).map((value, i) => value + delta[i % 3]), true);
    s.compare(lat, lon);
    expect(s.counters.fallbacks).toBe(1);
  });

  it("does not traverse unrelated scene or cached geometry", () => {
    const s = setup(), patch = s.patch({ z: 15, x: 7898, y: 11805 });
    s.sampler.setCoverage([patch]);
    const location = coord(patch.tile, 0.411, 0.633);
    s.sampler.sample(...location);
    const tested = s.counters.triangles;
    for (let i = 0; i < 100; i++) MeshBuilder.CreateBox(`unrelated-${i}`, {}, s.scene);
    const cached = s.patch({ z: 16, x: 15796, y: 23610 }, 900); cached.mesh.setEnabled(false);
    const pick = vi.spyOn(s.scene, "pickWithRay");
    s.sampler.sample(...location);
    expect(s.counters.triangles).toBe(2 * tested);
    expect(tested).toBe(18);
    expect(pick).not.toHaveBeenCalled();
    expect(s.counters.fallbacks).toBe(0);
  });
});
