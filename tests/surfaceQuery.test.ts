import { Matrix, MeshBuilder, NullEngine, NullEngineOptions, Ray, Scene, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createSurfaceQuery, intersectsSegmentBounds } from "../src/babylon/surfaceQuery.js";
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
  it("rejects a segment by its bounds exactly as the shipped per-axis loop did", () => {
    // The shipped filter, which read each axis by a computed key.
    const shipped = (ray: Ray, minimum: Vector3, maximum: Vector3): boolean => {
      let near = 0, far = ray.length;
      for (const axis of ["x", "y", "z"] as const) {
        const padding = 0.001 + 2 * ray.epsilon * (maximum[axis] - minimum[axis]);
        const low = minimum[axis] - padding, high = maximum[axis] + padding;
        const origin = ray.origin[axis], direction = ray.direction[axis];
        if (!Number.isFinite(low) || !Number.isFinite(high)) return true;
        if (direction === 0) {
          if (origin < low || origin > high) return false;
          continue;
        }
        const a = (low - origin) / direction, b = (high - origin) / direction;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
        if (near > far) return false;
      }
      return true;
    };
    let seed = 11;
    const random = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    // Components that are zero of either sign, tiny, Earth-sized, unbounded or not a number.
    const special = [0, -0, 1e-300, -1e-300, 6_378_137, -6_378_137, Number.MAX_VALUE, -Number.MAX_VALUE, Infinity, -Infinity, NaN];
    const component = (scale: number): number => random() < 0.15 ? special[Math.floor(random() * special.length)] : (random() - 0.5) * scale;
    const vector = (scale: number) => new Vector3(component(scale), component(scale), component(scale));
    const counts = { true: 0, false: 0 };
    for (let i = 0; i < 200_000; i++) {
      const scale = 10 ** Math.floor(random() * 8);
      const ray = new Ray(vector(scale), vector(1), random() < 0.1 ? Infinity : random() * scale * 2);
      if (random() < 0.3) ray.direction.normalize();
      ray.epsilon = random() < 0.5 ? 1e-7 : random() * 1e-3;
      const a = vector(scale), b = vector(scale);
      const minimum = Vector3.Minimize(a, b), maximum = random() < 0.1 ? b : Vector3.Maximize(a, b);
      const expected = shipped(ray, minimum, maximum);
      expect(intersectsSegmentBounds(ray, minimum, maximum)).toBe(expected);
      counts[`${expected}`] += 1;
    }
    expect(Math.min(counts.true, counts.false)).toBeGreaterThan(20_000);
  });
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
  it("reads the world transform, surface meshes and bounds once per frame and answers exactly as without one", () => {
    const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const root = new TransformNode("world", scene);
    root.rotation.set(0.2, -0.4, 1.1); root.position.set(-500000, -866000, 15); root.computeWorldMatrix(true);
    const tiles = [0, 1, 2].map(at => { const tile = MeshBuilder.CreateGround(`tile-${at}`, { width: 30, height: 30, subdivisions: 6 }, scene);
      tile.parent = root; tile.position.set(at * 30, -at, 0); tile.computeWorldMatrix(true); return tile; });
    const aircraft = MeshBuilder.CreateBox("aircraft", { size: 4 }, scene); aircraft.parent = root; aircraft.position.y = 3; aircraft.computeWorldMatrix(true);
    const isSurface = vi.fn((mesh: unknown) => tiles.includes(mesh as never));
    const framed = createSurfaceQuery(scene, () => root, isSurface, () => 7), reference = createSurfaceQuery(scene, () => root, mesh => tiles.includes(mesh as never), () => 7);
    const rays = [0, 7, 31, 44, 100].map(x => ({ origin: { x: x + 0.17, y: 10, z: 0.31 }, direction: { x: 0.05, y: -1, z: 0.02 } }));
    const expected = rays.map(ray => reference.raycast(ray.origin, ray.direction, 20));
    expect(expected.filter(Boolean)).toHaveLength(4);
    const rootMatrix = vi.spyOn(root, "computeWorldMatrix");
    framed.beginFrame();
    expect(rootMatrix).not.toHaveBeenCalled();
    for (let pass = 0; pass < 2; pass++) expect(rays.map(ray => framed.raycast(ray.origin, ray.direction, 20))).toEqual(expected);
    // One read for the whole frame: the root's transform, and each mesh's surface test once.
    expect(rootMatrix).toHaveBeenCalledOnce(); expect(isSurface).toHaveBeenCalledTimes(scene.meshes.length);
    // A render ends the frame early: the next query reads the world again.
    scene.incrementRenderId(); framed.raycast(rays[0].origin, rays[0].direction, 20);
    expect(rootMatrix).toHaveBeenCalledTimes(2);
    framed.endFrame();
    // After the frame the world moves, and the next query, framed or not, sees it.
    root.position.x += 3; root.computeWorldMatrix(true); for (const tile of tiles) tile.computeWorldMatrix(true);
    const moved = rays.map(ray => reference.raycast(ray.origin, ray.direction, 20));
    expect(moved).not.toEqual(expected);
    expect(rays.map(ray => framed.raycast(ray.origin, ray.direction, 20))).toEqual(moved);
    framed.beginFrame(); expect(rays.map(ray => framed.raycast(ray.origin, ray.direction, 20))).toEqual(moved);
    // Moving the world inside a frame, without a render, ends it as well.
    root.position.x -= 3; for (const tile of tiles) tile.computeWorldMatrix(true);
    expect(rays.map(ray => framed.raycast(ray.origin, ray.direction, 20))).toEqual(expected);
    // A mesh added during a frame ends it too.
    framed.beginFrame(); expect(framed.raycast(rays[0].origin, rays[0].direction, 20)).toEqual(expected[0]);
    const added = MeshBuilder.CreateGround("tile-3", { width: 30, height: 30 }, scene); added.parent = root; added.position.y = 5; added.computeWorldMatrix(true);
    tiles.push(added);
    expect(framed.raycast(rays[0].origin, rays[0].direction, 20)).toEqual(reference.raycast(rays[0].origin, rays[0].direction, 20));
    expect(framed.raycast(rays[0].origin, rays[0].direction, 20)?.meshId).toBe("tile-3");
    framed.endFrame();
    engine.dispose();
  });
  it("samples through a frame exactly as without one, Google refinement included", () => {
    const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); const scene = new Scene(engine);
    const query = createSurfaceQuery(scene, () => null, () => true);
    googleSurface(scene, 6800, 262979); googleSurface(scene, 600, 2054); googleSurface(scene, 400, 1027); googleSurface(scene, 260, 8);
    const expected = query.sample(0, 0);
    query.beginFrame();
    expect(query.sample(0, 0)).toEqual(expected); expect(query.sample(0, 0)?.geometricErrorMeters).toBe(8);
    expect(query.raycast({ x: 6378137 + 20000, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 40000)?.heightMeters).toBeCloseTo(6800, 3);
    query.endFrame();
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
