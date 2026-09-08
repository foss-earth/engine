import { MeshBuilder, NullEngine, Scene, TransformNode, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEG_TO_RAD, geodeticToEcef } from "../camera/cameraMath";
import { createTerrainMesh } from "../engine/babylon/createRasterTilesRuntime";
import { RASTER_BASE_MAP_SOURCES } from "../engine/babylon/rasterBaseMaps";
import { advanceRefinement, inheritParent, meshPositions, refineMesh, stitchTerrainEdges, type TerrainPatch } from "./meshRefinement";
import { createRasterSurfaceSampler, type RasterQueryCounters } from "./rasterSurfaceSampler";
import { createSurfaceQuery } from "./surfaceQuery";
import type { TerrainTile } from "./terrainTiles";

const engines: NullEngine[] = [];
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); });
const coord = (tile: TerrainTile, u: number, v: number): [number, number] => [
  Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + v) / 2 ** tile.z))) / DEG_TO_RAD,
  (tile.x + u) / 2 ** tile.z * 360 - 180,
];
function setup() {
  const engine = new NullEngine({ useHighPrecisionMatrix: true }); engines.push(engine);
  const scene = new Scene(engine), root = new TransformNode("world", scene);
  const counters: RasterQueryCounters = { samples: 0, patches: 0, triangles: 0, fallbacks: 0, misses: 0 };
  const sampler = createRasterSurfaceSampler(() => 27, counters);
  const reference = createSurfaceQuery(scene, () => root, mesh => Boolean(mesh.metadata?.mapSurface), () => 27);
  function patch(tile: TerrainTile, height = 250): TerrainPatch {
    const mesh = createTerrainMesh({ scene, source: RASTER_BASE_MAP_SOURCES[0], worldRoot: root, getViewState: () => null },
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
