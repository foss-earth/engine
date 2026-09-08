import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createSurfaceQuery } from "./surfaceQuery";
import { createTerrainMesh } from "../engine/babylon/createRasterTilesRuntime";
import { RASTER_BASE_MAP_SOURCES } from "../engine/babylon/rasterBaseMaps";

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
  it("returns the same ECEF intersection after a floating-origin rotation and translation", () => {
    const engine = new NullEngine({ useHighPrecisionMatrix: true }); const scene = new Scene(engine);
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
    const engine = new NullEngine({ useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const tile = { z: 15, x: 7898, y: 11805 };
    const mesh = createTerrainMesh({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => null }, tile,
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
});
