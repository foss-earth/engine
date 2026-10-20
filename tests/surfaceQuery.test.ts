import { Matrix, MeshBuilder, NullEngine, NullEngineOptions, Ray, Scene, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createSurfaceQuery } from "../src/babylon/surfaceQuery.js";
import { createTerrainMesh } from "../src/babylon/terrainMesh.js";

/** A drawn Google tile's surface over 0° N 0° E, its top `heightMeters` above the ellipsoid. */
function googleSurface(scene: Scene, heightMeters: number, errorMeters: number) {
  const mesh = MeshBuilder.CreateBox(`google-${errorMeters}`, { size: 2 }, scene);
  mesh.position.x = 6378137 + heightMeters - 1;
  mesh.metadata = { googleGeometricErrorMeters: errorMeters };
  mesh.computeWorldMatrix(true);
  return mesh;
}

describe("visible map surface queries", () => {
  it("treats an indexed raster miss as final while retaining general raycasts", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const pick = vi.spyOn(scene, "pickWithRay");
    const sample = vi.fn<() => null | undefined>(() => null);
    const query = createSurfaceQuery(scene, () => null, () => true, () => 0, sample);
    expect(query.sample(34, -118)).toBeNull();
    expect(pick).not.toHaveBeenCalled();
    sample.mockReturnValue(undefined);
    query.sample(34, -118);
    expect(pick).toHaveBeenCalledOnce();
    query.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
    expect(pick).toHaveBeenCalledTimes(2);
    engine.dispose();
  });
  it("hits building walls sideways and ignores hidden meshes and unrelated aircraft", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const wall = MeshBuilder.CreateBox("building", { size: 10 }, scene);
    wall.position.x = 20; wall.computeWorldMatrix(true);
    const plane = MeshBuilder.CreateBox("aircraft", { size: 4 }, scene);
    plane.position.x = 8; plane.computeWorldMatrix(true);
    const query = createSurfaceQuery(scene, () => null, mesh => mesh === wall);
    const origin = { x: 0, y: 0, z: 0 }, direction = { x: 1, y: 0, z: 0 };
    expect(query.raycast(origin, direction, 30)?.distanceMeters).toBeCloseTo(15);
    wall.setEnabled(false);
    expect(query.raycast(origin, direction, 30)).toBeNull();
    engine.dispose();
  });
  it("skips triangle scans for visible geometry beyond a finite collision ray", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const distant = MeshBuilder.CreateGround("distant", { width: 1000, height: 1000, subdivisions: 128 }, scene);
    distant.position.y = -100;
    distant.computeWorldMatrix(true);
    const intersect = vi.spyOn(distant, "intersects");
    const query = createSurfaceQuery(scene, () => null, () => true);
    const origin = { x: 0.17, y: 10, z: 0.23 }, direction = { x: 0, y: -1, z: 0 };
    expect(query.raycast(origin, direction, 5)).toBeNull();
    expect(intersect).not.toHaveBeenCalled();
    const local = MeshBuilder.CreateBox("local", { size: 2 }, scene);
    local.position.y = 6;
    local.computeWorldMatrix(true);
    expect(query.raycast(origin, direction, 5)?.distanceMeters).toBeCloseTo(3);
    expect(intersect).not.toHaveBeenCalled();
    // A longer segment must still reach that same displayed distant geometry.
    local.setEnabled(false);
    expect(query.raycast(origin, direction, 120)?.distanceMeters).toBeCloseTo(110);
    expect(intersect).toHaveBeenCalledOnce();
    engine.dispose();
  });
  it("refreshes segment bounds after mesh movement and terrain vertex updates", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const ground = MeshBuilder.CreateGround("terrain", { width: 10, height: 10, updatable: true }, scene);
    const query = createSurfaceQuery(scene, () => null, () => true);
    const origin = { x: 0, y: 10, z: 0 }, direction = { x: 0, y: -1, z: 0 };
    expect(query.raycast(origin, direction, 5)).toBeNull();
    ground.position.y = 7;
    scene.incrementRenderId();
    expect(query.raycast(origin, direction, 5)?.distanceMeters).toBeCloseTo(3);
    const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
    ground.updateVerticesData(VertexBuffer.PositionKind, positions.map((value, i) => i % 3 === 1 ? value - 6 : value), true);
    expect(query.raycast(origin, direction, 5)).toBeNull();
    engine.dispose();
  });
  it("agrees with full triangle picking for endpoints, inside starts and transformed oblique rays", () => {
    const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const root = new TransformNode("world", scene);
    const distant = MeshBuilder.CreateBox("far", { size: 10 }, scene);
    distant.parent = root; distant.position.x = 50;
    const box = MeshBuilder.CreateBox("near", { size: 10 }, scene);
    box.parent = root; box.position.x = 20;
    distant.computeWorldMatrix(true); box.computeWorldMatrix(true);
    const query = createSurfaceQuery(scene, () => root, () => true);
    const origins = [new Vector3(0, 0, 0), new Vector3(20, 0, 0), new Vector3(40, 0, 0), new Vector3(0, 5, 5)];
    const directions = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(1, 0.15, -0.1), new Vector3(1, 1e-9, 0)];
    for (const transformed of [false, true]) {
      if (transformed) {
        root.rotation.set(0.2, -0.4, Math.PI / 3);
        root.position.set(-500000, -866000, 15);
        root.scaling.set(0.8, 1.2, 1.5);
      }
      const world = root.computeWorldMatrix(true);
      distant.computeWorldMatrix(true); box.computeWorldMatrix(true);
      const inverse = Matrix.Invert(world);
      for (const origin of origins) for (const direction of directions) for (const length of [5, 14.9, 15, 40, 100]) {
        const ray = Ray.Transform(new Ray(origin, direction.clone().normalize(), length), world);
        const reference = scene.pickWithRay(ray, () => true);
        const hit = query.raycast(origin, direction, length);
        expect(hit !== null).toBe(Boolean(reference?.hit));
        if (hit && reference?.pickedPoint) {
          const point = Vector3.TransformCoordinates(reference.pickedPoint, inverse);
          expect(Vector3.Distance(new Vector3(hit.point.x, hit.point.y, hit.point.z), point)).toBeLessThan(1e-6);
          expect(hit.meshId).toBe(reference.pickedMesh?.id);
        }
      }
    }
    engine.dispose();
  });
  it("returns the same ECEF intersection after a floating-origin rotation and translation", () => {
    const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const root = new TransformNode("world", scene);
    const box = MeshBuilder.CreateBox("map", { size: 10 }, scene);
    box.parent = root; box.position.x = 1000000;
    const query = createSurfaceQuery(scene, () => root, mesh => mesh === box);
    const origin = { x: 999980, y: 0, z: 0 }, direction = { x: 1, y: 0, z: 0 };
    box.computeWorldMatrix(true);
    const before = query.raycast(origin, direction, 40)!;
    root.rotation.z = Math.PI / 3; root.position = new Vector3(-500000, -866000, 15);
    root.computeWorldMatrix(true); box.computeWorldMatrix(true);
    expect(query.raycast(origin, direction, 40)?.point.x).toBeCloseTo(before.point.x, 4);
    engine.dispose();
  });
  it("samples the actual rendered terrain triangles, including Earth curvature", () => {
    const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const tile = { z: 15, x: 7898, y: 11805 };
    const mesh = createTerrainMesh({ scene, source: { id: "usgs-imagery" }, nowMs: () => 0 }, tile,
      { ...tile, size: 2, heights: new Float32Array([200, 200, 200, 200]) });
    mesh.setEnabled(true); mesh.computeWorldMatrix(true);
    const lon = (tile.x + 0.5) / 2 ** tile.z * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 0.5) / 2 ** tile.z))) * 180 / Math.PI;
    const query = createSurfaceQuery(scene, () => null, m => m === mesh);
    expect(query.sample(lat, lon)?.heightMeters).toBeCloseTo(200, 2);
    mesh.setEnabled(false);
    expect(query.sample(lat, lon)).toBeNull();
    engine.dispose();
  });
  it("samples the finer Google ground under coarser tiles drawn within their error above it", () => {
    const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const query = createSurfaceQuery(scene, () => null, () => true);
    // As over the campus while it loads: a tile thousands of kilometres across 6.5 km up, and two coarse levels.
    googleSurface(scene, 6800, 262979);
    googleSurface(scene, 600, 2054);
    googleSurface(scene, 400, 1027);
    googleSurface(scene, 260, 8);
    expect(query.sample(0, 0)?.geometricErrorMeters).toBe(8);
    expect(query.sample(0, 0)?.heightMeters).toBeCloseTo(260, 3);
    // Pointer and collision rays still meet the first surface drawn.
    expect(query.raycast({ x: 6378137 + 20000, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 40000)?.heightMeters).toBeCloseTo(6800, 3);
    engine.dispose();
  });
  it("keeps a coarser Google surface farther above the finer one than its error, such as a bridge", () => {
    const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const query = createSurfaceQuery(scene, () => null, () => true);
    googleSurface(scene, 280, 16);
    googleSurface(scene, 250, 8);
    expect(query.sample(0, 0)?.heightMeters).toBeCloseTo(280, 3);
    // A coarse tile drawn over the deck gives way to the deck, not to the river under it.
    googleSurface(scene, 900, 2054);
    expect(query.sample(0, 0)?.heightMeters).toBeCloseTo(280, 3);
    engine.dispose();
  });
});
