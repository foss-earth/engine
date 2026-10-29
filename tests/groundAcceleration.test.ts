import { readFile } from "node:fs/promises";
import { Mesh, MeshBuilder, MorphTargetManager, NullEngine, NullEngineOptions, Ray, Scene, SubMesh, TransformNode, Vector3, VertexBuffer, type AbstractMesh, type PickingInfo } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiateGroundCore, type GroundCore, type GroundMesh, type GroundWorldBatch } from "../ground-WASM/index.js";
import { createGroundAcceleration } from "../src/babylon/groundAcceleration.js";
import { createSurfaceQuery } from "../src/babylon/surfaceQuery.js";
import { buildGroundBvh, queryGroundBvh, refitGroundBvh, validateGroundBvh } from "../ground-TS/groundBvh.js";
import { createGroundBvhPreparer } from "../src/browser/groundBvhPreparer.js";
import { GROUND_BUILD_QUEUE_FULL, type GroundBvhBuild, type GroundBvhPreparation, type GroundBvhPreparer, type GroundBvhWorkerPort, type GroundBvhWorkerReply, type GroundBvhWorkerRequest, type GroundBuildKernel, type GroundNumericCore } from "../src/browser/groundBvhProtocol.js";
import { installGroundBvhWorker } from "../src/browser/groundBvhWorker.js";

// Counts the reference builds, the worker's included, and the page's checks and queries, without changing them.
vi.mock("../ground-TS/groundBvh.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../ground-TS/groundBvh.js")>();
  return { ...actual, buildGroundBvh: vi.fn(actual.buildGroundBvh), validateGroundBvh: vi.fn(actual.validateGroundBvh),
    refitGroundBvh: vi.fn(actual.refitGroundBvh), queryGroundBvh: vi.fn(actual.queryGroundBvh) };
});

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
function fixture(useHighPrecisionMatrix = true) {
  const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix }); engines.push(engine);
  const scene = new Scene(engine), root = new TransformNode("world", scene);
  return { scene, root };
}
function f32(mesh: Mesh): Mesh {
  mesh.setVerticesData(VertexBuffer.PositionKind, Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), true);
  mesh.computeWorldMatrix(true); return mesh;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/**
 * A plain array's float64 positions where float32 numbers are 2 m apart: 0.37 m cells 30,000 km along x, whose
 * corners float32 rounds by up to a metre, much more than the boxes' padding.
 */
function farGrid(cells = 8) {
  const positions: number[] = [], indices: number[] = [];
  for (let row = 0; row <= cells; row++) for (let col = 0; col <= cells; col++) positions.push(3e7 + col * 0.37, Math.sin(col * 1.3) * Math.cos(row * 0.7) * 0.4 + 0.1, row * 0.37);
  for (let row = 0; row < cells; row++) for (let col = 0; col < cells; col++) {
    const a = row * (cells + 1) + col;
    indices.push(a, a + 1, a + cells + 1, a + 1, a + cells + 2, a + cells + 1);
  }
  return { positions, indices: Uint32Array.from(indices), size: cells * 0.37 };
}
/** Holds every build it is asked for; each answer completes the oldest. */
function heldPreparer() {
  const held: { request: GroundBvhBuild; answer(value: GroundBvhPreparation): void; refuse(error: Error): void }[] = [];
  const dispose = vi.fn();
  const preparer: GroundBvhPreparer = {
    prepare: request => new Promise((resolve, reject) => { held.push({ request, answer: resolve, refuse: reject }); }),
    status: () => ({ kernel: "typescript", state: held.length ? "busy" : "idle", actual: "typescript", parity: "not-run", failure: null, jobs: 0,
      queued: Math.max(0, held.length - 1), lastJob: null }), dispose,
  };
  return { preparer, dispose, held, answer: (edit?: (snapshot: Float64Array) => void) => { const current = held.shift()!;
    const snapshot = buildGroundBvh(current.request.positions, current.request.indices); edit?.(snapshot);
    current.answer({ generation: current.request.generation, snapshot, actual: "typescript", parity: "not-run", fallbackReason: null, workMs: 0 }); } };
}

describe("ground immutable index integration", () => {
  it("keeps current triangles while a build is pending and invalidates a completed index immediately on mutation", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("ground", { width: 20, height: 20, subdivisions: 4 }, scene));
    let revision = 1;
    const worker = heldPreparer(), ready = vi.fn(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, onReady: ready });
    const accelerated = createSurfaceQuery(scene, () => null, () => true, () => revision, undefined, acceleration);
    const reference = createSurfaceQuery(scene, () => null, () => true, () => revision);
    const origin = { x: 0.17, y: 10, z: 0.23 }, direction = { x: 0, y: -1, z: 0 };
    expect(accelerated.raycast(origin, direction, 20)).toEqual(reference.raycast(origin, direction, 20));
    const previous = vi.fn(); mesh.geometry!.onGeometryUpdated = previous;
    // Recreate to verify callback preservation as well as synchronous invalidation.
    acceleration.dispose();
    const secondWorker = heldPreparer(), second = createGroundAcceleration({ preparer: secondWorker.preparer, now: () => 0, compareFirstQueries: true });
    const query = createSurfaceQuery(scene, () => null, () => true, () => revision, undefined, second);
    query.raycast(origin, direction, 20); secondWorker.answer(); await settle();
    expect(query.raycast(origin, direction, 20)).toEqual(reference.raycast(origin, direction, 20));
    expect(second.status()).toMatchObject({ readyMeshes: 1, parity: "same", acceleratedQueries: 1 });
    const scan = vi.spyOn(mesh.subMeshes[0], "intersects");
    query.raycast(origin, direction, 20); expect(scan).not.toHaveBeenCalled();
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    mesh.updateVerticesData(VertexBuffer.PositionKind, Float32Array.from(positions, (value, index) => index % 3 === 1 ? value + 3 : value), true);
    revision++;
    expect(previous).toHaveBeenCalled(); expect(second.status().readyMeshes).toBe(0);
    expect(query.raycast(origin, direction, 20)).toEqual(reference.raycast(origin, direction, 20));
    expect(scan).toHaveBeenCalled();
    // A second mutation before the reply makes that queued generation unusable too.
    mesh.updateVerticesData(VertexBuffer.PositionKind, Float32Array.from(positions), true); revision++;
    secondWorker.answer(); await settle(); expect(second.status().readyMeshes).toBe(0);
    expect(query.raycast(origin, direction, 20)).toEqual(reference.raycast(origin, direction, 20));
    second.dispose(); expect(secondWorker.dispose).toHaveBeenCalledOnce(); expect(mesh.geometry!.onGeometryUpdated).toBe(previous);
  });

  it("indexes a mesh whose positions are a plain array of float64 numbers, and leaves Babylon nothing to scan once every mesh is indexed", async () => {
    const { scene } = fixture(), grid = farGrid(), mesh = new Mesh("far", scene);
    // Babylon keeps a plain array only from an update, as terrain stitching writes its seams.
    mesh.setVerticesData(VertexBuffer.PositionKind, Float32Array.from(grid.positions), true); mesh.setIndices(grid.indices);
    mesh.updateVerticesData(VertexBuffer.PositionKind, grid.positions, true); mesh.computeWorldMatrix(true);
    expect(mesh.getVerticesData(VertexBuffer.PositionKind)).toBe(grid.positions);
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, compareFirstQueries: true });
    const accelerated = createSurfaceQuery(scene, () => null, () => true, () => 0, undefined, acceleration);
    const reference = createSurfaceQuery(scene, () => null, () => true);
    let seed = 13;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const rays = Array.from({ length: 64 }, () => ({ origin: { x: 3e7 + random() * grid.size, y: 5, z: random() * grid.size },
      direction: { x: (random() - 0.5) * 0.2, y: -1, z: (random() - 0.5) * 0.2 } }));
    try {
      accelerated.raycast(rays[0].origin, rays[0].direction, 20);
      // The worker builds from the float32 rounding, whose boxes do not hold the float64 corners until the page fits them.
      worker.answer(); await settle();
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, fallbackReason: null });
      const scan = vi.spyOn(mesh.subMeshes[0], "intersects"), pickWithRay = vi.spyOn(scene, "pickWithRay");
      // With the diagnostic on, the first query is checked against Babylon's; from then on the index answers alone.
      expect(accelerated.raycast(rays[0].origin, rays[0].direction, 20)).toEqual(reference.raycast(rays[0].origin, rays[0].direction, 20));
      expect(acceleration.status()).toMatchObject({ parity: "same", acceleratedQueries: 1 });
      scan.mockClear(); pickWithRay.mockClear();
      const answers = rays.map(ray => accelerated.raycast(ray.origin, ray.direction, 20));
      expect(scan).not.toHaveBeenCalled(); expect(pickWithRay).not.toHaveBeenCalled();
      expect(answers.filter(Boolean).length).toBeGreaterThan(32);
      // Past x = 3e7 + 2, where float32 boxes would end, as well.
      expect(answers.some(hit => hit && hit.point.x > 3e7 + 2.1)).toBe(true);
      pickWithRay.mockRestore();
      expect(answers).toEqual(rays.map(ray => reference.raycast(ray.origin, ray.direction, 20)));
    } finally { acceleration.dispose(); }
  });

  it("preserves exact world transforms, finite endpoints, normals, scene ties, hidden meshes and unsupported submeshes", async () => {
    const { scene, root } = fixture();
    const first = f32(MeshBuilder.CreateBox("first", { size: 10 }, scene)); first.parent = root; first.position.x = 20;
    const tied = f32(MeshBuilder.CreateBox("tied", { size: 10 }, scene)); tied.parent = root; tied.position.x = 20;
    const unsupported = f32(MeshBuilder.CreateBox("submeshes", { size: 2 }, scene)); unsupported.parent = root; unsupported.position.x = 9;
    unsupported.releaseSubMeshes(); new SubMesh(0, 0, unsupported.getTotalVertices(), 0, 18, unsupported); new SubMesh(0, 0, unsupported.getTotalVertices(), 18, 18, unsupported);
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
    const reference = createSurfaceQuery(scene, () => root, () => true), query = createSurfaceQuery(scene, () => root, () => true, () => 0, undefined, acceleration);
    const origin = { x: 0.17, y: 0.23, z: 0.31 }, direction = { x: 1, y: 0, z: 0 };
    query.raycast(origin, direction, 40); worker.answer(); await settle(); query.raycast(origin, direction, 40); worker.answer(); await settle();
    for (const mirrored of [false, true]) {
      if (mirrored) { root.rotation.set(0.2, -0.4, 1.1); root.scaling.set(-0.8, 1.2, 1.5); root.position.set(-500000, -866000, 15); }
      root.computeWorldMatrix(true); for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
      for (const visible of [true, false]) {
        unsupported.isVisible = visible;
        for (const length of [5, 7.83, 8, 14.83, 15, 100]) for (const direction of [{ x: 1, y: 0, z: 0 }, { x: 1, y: 0.1, z: -0.1 }]) {
          expect(query.raycast(origin, direction, length)).toEqual(reference.raycast(origin, direction, length));
        }
      }
    }
    root.rotation.setAll(0); root.position.setAll(0); root.scaling.setAll(1); root.computeWorldMatrix(true);
    first.computeWorldMatrix(true); tied.computeWorldMatrix(true); unsupported.isVisible = false;
    expect(query.raycast(origin, direction, 40)?.meshId).toBe("first");
    first.setEnabled(false); expect(query.raycast(origin, direction, 40)?.meshId).toBe("tied");
    const morph = new MorphTargetManager(scene); tied.morphTargetManager = morph;
    expect(query.raycast(origin, direction, 40)).toEqual(reference.raycast(origin, direction, 40));
    acceleration.dispose();
  });

  it("keeps reporting what the page rejected after later meshes are admitted", async () => {
    const { scene } = fixture(), ray = new Ray(new Vector3(0.17, 10, 0.23), new Vector3(0, -1, 0), 40);
    const meshes = ["a", "b", "c"].map((name, at) => {
      const mesh = f32(MeshBuilder.CreateGround(name, { width: 20, height: 20, subdivisions: 4 }, scene)); mesh.position.y = -at; mesh.computeWorldMatrix(true); return mesh;
    });
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, compareFirstQueries: true });
    const pick = (mesh: Mesh) => acceleration.pick(scene, ray, candidate => candidate === mesh);
    try {
      // a: a root box narrower than its children is rejected before use.
      pick(meshes[0]); worker.answer(snapshot => { snapshot[5] -= 1; }); await settle();
      expect(pick(meshes[0])?.pickedMesh).toBe(meshes[0]);
      expect(acceleration.status()).toMatchObject({ readyMeshes: 0, parity: "pending", fallbackReason: "Ground BVH node outside its parent's bounds." });
      // b: its first query disagrees with Babylon's, here because Babylon is made to miss once.
      pick(meshes[1]); worker.answer(); await settle();
      vi.spyOn(scene, "pickWithRay").mockReturnValueOnce(null);
      expect(pick(meshes[1])?.pickedMesh).toBe(meshes[1]);
      expect(acceleration.status()).toMatchObject({ readyMeshes: 0, parity: "different" });
      // c: admitted, and its worker reported nothing wrong; both earlier findings still stand.
      pick(meshes[2]); worker.answer(); await settle(); pick(meshes[2]);
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, parity: "different",
        fallbackReason: "Ground BVH node outside its parent's bounds.; first-query-parity-mismatch" });
    } finally { acceleration.dispose(); }
  });
});

describe("ground index admission and build queue", () => {
  const down = () => new Ray(new Vector3(0.17, 10, 0.23), new Vector3(0, -1, 0), 40);
  it("answers each newly ready index's first query without a Babylon re-pick unless the diagnostic asks for one", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("ground", { width: 20, height: 20, subdivisions: 8 }, scene));
    const only = (candidate: AbstractMesh) => candidate === mesh;
    for (const compareFirstQueries of [false, true]) {
      const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, compareFirstQueries });
      const expected = scene.pickWithRay(down(), only, false);
      try {
        acceleration.pick(scene, down(), only); worker.answer(); await settle();
        const pickWithRay = vi.spyOn(scene, "pickWithRay");
        const first = acceleration.pick(scene, down(), only);
        expect(pickWithRay).toHaveBeenCalledTimes(compareFirstQueries ? 1 : 0);
        pickWithRay.mockRestore();
        expect(first?.pickedMesh).toBe(mesh); expect(first?.faceId).toBe(expected?.faceId);
        expect(first?.distance).toBe(expected?.distance); expect(first?.pickedPoint?.asArray()).toEqual(expected?.pickedPoint?.asArray());
        expect(acceleration.status()).toMatchObject({ readyMeshes: 1, acceleratedQueries: 1, parity: compareFirstQueries ? "same" : "not-run", fallbackReason: null });
      } finally { acceleration.dispose(); }
    }
  });

  it("queues builds for every mesh under a ray, up to its bound, and indexes each one without dropping any", async () => {
    const { scene } = fixture();
    // Different sizes tell the requests apart: 2, 3, 4 and 5 subdivisions.
    const meshes = [2, 3, 4, 5].map((subdivisions, at) => {
      const mesh = f32(MeshBuilder.CreateGround(`tile-${subdivisions}`, { width: 20, height: 20, subdivisions }, scene)); mesh.position.y = -at; mesh.computeWorldMatrix(true); return mesh;
    });
    const faces = (subdivisions: number) => subdivisions * subdivisions * 2;
    const worker = heldPreparer(), ready = vi.fn();
    const acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, onReady: ready, maxQueuedBuilds: 3 });
    const expected = scene.pickWithRay(down(), () => true, false), sent = () => worker.held.map(job => job.request.indices.length / 3);
    try {
      // One query asks for as many builds as the bound allows, in scene order; Babylon answers meanwhile.
      expect(acceleration.pick(scene, down(), () => true)?.pickedMesh).toBe(expected?.pickedMesh);
      expect(sent()).toEqual([faces(2), faces(3), faces(4)]);
      expect(acceleration.status()).toMatchObject({ pending: true, queuedBuilds: 3, readyMeshes: 0 });
      // Asking again sends nothing more while those are in flight.
      acceleration.pick(scene, down(), () => true); expect(sent()).toEqual([faces(2), faces(3), faces(4)]);
      worker.answer(); await settle();
      expect(acceleration.status()).toMatchObject({ queuedBuilds: 2, readyMeshes: 1 });
      // The freed place goes to the mesh that waited.
      acceleration.pick(scene, down(), () => true); expect(sent()).toEqual([faces(3), faces(4), faces(5)]);
      while (worker.held.length) { worker.answer(); await settle(); }
      expect(acceleration.status()).toMatchObject({ pending: false, queuedBuilds: 0, readyMeshes: 4, fallbackReason: null });
      expect(ready).toHaveBeenCalledTimes(4);
      const pickWithRay = vi.spyOn(scene, "pickWithRay"), answer = acceleration.pick(scene, down(), () => true);
      expect(pickWithRay).not.toHaveBeenCalled();
      expect(answer?.pickedMesh).toBe(meshes[0]); expect(answer?.distance).toBe(expected?.distance);
    } finally { acceleration.dispose(); }
  });

  it("answers through a surface query frame exactly as Babylon does, with no scan once indexed", async () => {
    const { scene, root } = fixture();
    const tiles = [0, 1].map(at => { const tile = f32(MeshBuilder.CreateGround(`tile-${at}`, { width: 30, height: 30, subdivisions: 6 }, scene)); tile.parent = root; tile.position.set(at * 30, -at, 0); return tile; });
    root.rotation.set(0.2, -0.4, 1.1); root.position.set(-500000, -866000, 15); root.computeWorldMatrix(true); for (const tile of tiles) tile.computeWorldMatrix(true);
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
    const query = createSurfaceQuery(scene, () => root, () => true, () => 0, undefined, acceleration), reference = createSurfaceQuery(scene, () => root, () => true);
    const rays = [0.17, 7, 22, 31, 44, 80].map(x => ({ origin: { x, y: 10, z: 0.31 }, direction: { x: 0.05, y: -1, z: 0.02 } }));
    try {
      query.beginFrame(); for (const ray of rays) query.raycast(ray.origin, ray.direction, 20); query.endFrame();
      // Both tiles were asked for in the one frame.
      expect(worker.held).toHaveLength(2);
      while (worker.held.length) { worker.answer(); await settle(); }
      expect(acceleration.status()).toMatchObject({ readyMeshes: 2, parity: "not-run" });
      const pickWithRay = vi.spyOn(scene, "pickWithRay");
      query.beginFrame(); const answers = rays.map(ray => query.raycast(ray.origin, ray.direction, 20)); query.endFrame();
      expect(pickWithRay).not.toHaveBeenCalled(); pickWithRay.mockRestore();
      expect(answers.filter(Boolean)).toHaveLength(5);
      expect(answers).toEqual(rays.map(ray => reference.raycast(ray.origin, ray.direction, 20)));
    } finally { acceleration.dispose(); }
  });

  it("defers a mesh whose build was refused for a full queue instead of failing it", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("ground", { width: 20, height: 20, subdivisions: 4 }, scene));
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
    try {
      acceleration.pick(scene, down(), () => true); worker.held.shift()!.refuse(new Error(GROUND_BUILD_QUEUE_FULL)); await settle();
      expect(acceleration.status()).toMatchObject({ pending: false, readyMeshes: 0, fallbackReason: null });
      expect(acceleration.pick(scene, down(), () => true)?.pickedMesh).toBe(mesh); expect(worker.held).toHaveLength(1);
      worker.answer(); await settle();
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, fallbackReason: null });
    } finally { acceleration.dispose(); }
  });
});

describe("ground numerical BVH", () => {
  it("matches Babylon and the actual worker-only Rust queries, including ties and finite boundaries", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("grid", { width: 20, height: 20, subdivisions: 8 }, scene));
    const positions = Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), indices = Uint32Array.from(mesh.getIndices()!);
    for (let at = 0; at < positions.length; at += 3) positions[at + 1] = Math.sin(positions[at] * 0.37) * Math.cos(positions[at + 2] * 0.29) * 2;
    // Overlapping first face must keep its original lower ID even when partition order changes.
    const duplicated = new Uint32Array(indices.length + 3); duplicated.set(indices); duplicated.set(indices.subarray(0, 3), indices.length);
    const reference = buildGroundBvh(positions, duplicated); validateGroundBvh(reference, duplicated.length / 3, { positions, indices: duplicated });
    const core = await instantiateGroundCore(await readFile(new URL("../ground-WASM/single/ground.wasm", import.meta.url)));
    const wasm = core.buildBvh(positions, duplicated, { generation: 1 });
    const snapshot = wasm.snapshot(); validateGroundBvh(snapshot, duplicated.length / 3, { positions, indices: duplicated });
    const rays: number[] = [];
    let seed = 47;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let ray = 0; ray < 512; ray++) rays.push((random() - 0.5) * 24, 10, (random() - 0.5) * 24, ray % 3 === 0 ? 10 : ray % 3 === 1 ? 9.99 : 100,
      (random() - 0.5) * 0.4, -1, (random() - 0.5) * 0.4, 0.001);
    rays.push(-10, 10, -10, 10, 0, -1, 0, 0.001, -10.001, 10, -10.001, 10, 0, -1, 0, 0.001);
    const wasmResults = wasm.query(new Float64Array(rays));
    for (let at = 0; at < rays.length; at += 8) {
      const ray = new Ray(new Vector3(rays[at], rays[at + 1], rays[at + 2]), new Vector3(rays[at + 4], rays[at + 5], rays[at + 6]), rays[at + 3], rays[at + 7]);
      let hit: { distance: number; face: number; bu: number; bv: number } | null = null;
      for (let face = 0; face < duplicated.length / 3; face++) {
        const result = ray.intersectsTriangle(Vector3.FromArray(positions, duplicated[face * 3] * 3), Vector3.FromArray(positions, duplicated[face * 3 + 1] * 3), Vector3.FromArray(positions, duplicated[face * 3 + 2] * 3));
        if (result && (!hit || result.distance < hit.distance)) hit = { distance: result.distance, face, bu: result.bu!, bv: result.bv! };
      }
      expect(queryGroundBvh(reference, positions, duplicated, ray)).toEqual(hit);
      expect(queryGroundBvh(snapshot, positions, duplicated, ray)).toEqual(hit);
      expect(wasmResults[at]).toBe(hit ? 1 : 0);
      if (hit) { expect(wasmResults[at + 1]).toBe(hit.distance); expect(wasmResults[at + 2]).toBe(hit.face); expect(wasmResults[at + 3]).toBe(hit.bu); expect(wasmResults[at + 4]).toBe(hit.bv); }
    }
    wasm.dispose(); core.dispose();
  });

  it("fits an index built from float32 roundings to a plain array's float64 positions, and then answers as Babylon does on them", () => {
    const { positions, indices, size } = farGrid(), faces = indices.length / 3, rounded = Float32Array.from(positions);
    const built = buildGroundBvh(rounded, indices);
    expect(() => validateGroundBvh(built, faces, { positions, indices })).toThrow("Ground BVH face outside its leaf's bounds.");
    const fitted = refitGroundBvh(built, positions, indices);
    expect(() => validateGroundBvh(fitted, faces, { positions, indices })).not.toThrow();
    // Only the boxes change: the header, children, ranges and face order are the built index's.
    for (let node = 0; node < built[0]; node++) expect(Array.from(fitted.subarray(2 + node * 10 + 6, 2 + node * 10 + 10))).toEqual(Array.from(built.subarray(2 + node * 10 + 6, 2 + node * 10 + 10)));
    expect(Array.from(fitted.subarray(2 + built[0] * 10))).toEqual(Array.from(built.subarray(2 + built[0] * 10)));
    // Each box is the smallest holding its faces: the root's is the corners' extent.
    for (let axis = 0; axis < 3; axis++) {
      const values = positions.filter((_, at) => at % 3 === axis);
      expect([fitted[2 + axis], fitted[5 + axis]]).toEqual([Math.min(...values), Math.max(...values)]);
    }
    let seed = 29, missed = 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let at = 0; at < 512; at++) {
      const ray = new Ray(new Vector3(3e7 + (random() - 0.1) * size * 1.2, 5, (random() - 0.1) * size * 1.2), new Vector3((random() - 0.5) * 0.2, -1, (random() - 0.5) * 0.2), at % 2 ? 100 : 5.2, 0.001);
      let hit: { distance: number; face: number; bu: number; bv: number } | null = null;
      for (let face = 0; face < faces; face++) {
        const result = ray.intersectsTriangle(Vector3.FromArray(positions, indices[face * 3] * 3), Vector3.FromArray(positions, indices[face * 3 + 1] * 3), Vector3.FromArray(positions, indices[face * 3 + 2] * 3));
        if (result && result.distance >= 0 && (!hit || result.distance < hit.distance)) hit = { distance: result.distance, face, bu: result.bu!, bv: result.bv! };
      }
      expect(queryGroundBvh(fitted, positions, indices, ray)).toEqual(hit);
      if (hit && !queryGroundBvh(built, positions, indices, ray)) missed++;
    }
    // Unfitted, the float32 boxes lose hits.
    expect(missed).toBeGreaterThan(0);
  });

  it("answers every ray as the reference's index does on any index whose boxes contain their faces", () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("grid", { width: 20, height: 20, subdivisions: 8 }, scene));
    const positions = Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), source = Uint32Array.from(mesh.getIndices()!);
    for (let at = 0; at < positions.length; at += 3) positions[at + 1] = Math.sin(positions[at] * 0.37) * Math.cos(positions[at + 2] * 0.29) * 2;
    // Repeated faces, so distance ties must go to the lower face whatever the order.
    const indices = new Uint32Array(source.length * 2); indices.set(source); indices.set(source, source.length);
    const faces = indices.length / 3, geometry = { positions, indices }, reference = buildGroundBvh(positions, indices);
    // One leaf holding every face, last face first; and the reference's tree with every box 5 larger.
    const flat = new Float64Array(2 + 10 + faces); flat.set([1, faces, ...reference.subarray(2, 8), 0, 0, 0, faces]);
    for (let slot = 0; slot < faces; slot++) flat[12 + slot] = faces - 1 - slot;
    const loose = reference.slice();
    for (let node = 0; node < reference[0]; node++) for (let axis = 0; axis < 3; axis++) { loose[2 + node * 10 + axis] -= 5; loose[2 + node * 10 + axis + 3] += 5; }
    for (const index of [flat, loose]) expect(() => validateGroundBvh(index, faces, geometry)).not.toThrow();
    let seed = 91, hits = 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let at = 0; at < 512; at++) {
      const ray = new Ray(new Vector3((random() - 0.5) * 24, 10, (random() - 0.5) * 24), new Vector3((random() - 0.5) * 0.4, -1, (random() - 0.5) * 0.4), at % 2 ? 100 : 10, 0.001);
      const expected = queryGroundBvh(reference, positions, indices, ray);
      if (expected) { hits++; expect(expected.face).toBeLessThan(faces / 2); }
      for (const index of [flat, loose]) expect(queryGroundBvh(index, positions, indices, ray)).toEqual(expected);
    }
    expect(hits).toBeGreaterThan(200);
  });

  it("rejects, given the geometry, a leaf that misses a face's corner or a node outside its parent's box", () => {
    // 32 faces: a root, two 16-face nodes, four 8-face leaves; the last node is a leaf.
    const positions = new Float32Array(32 * 9), indices = Uint32Array.from({ length: 96 }, (_, at) => at);
    for (let face = 0; face < 32; face++) positions.set([face, 0, 0, face + 1, 0, 1, face, 1, 0], face * 9);
    const geometry = { positions, indices }, reference = buildGroundBvh(positions, indices), leaf = 2 + (reference[0] - 1) * 10;
    expect(reference[leaf + 9]).toBe(8);
    expect(() => validateGroundBvh(reference, 32, geometry)).not.toThrow();
    // narrow misses the last face's second corner, short every face's third; wide pokes out of its parent.
    const narrow = reference.slice(); narrow[leaf + 3] -= 0.5;
    const short = reference.slice(); short[leaf + 4] -= 0.5;
    const wide = reference.slice(); wide[leaf + 4] += 1;
    for (const index of [narrow, short, wide]) expect(() => validateGroundBvh(index, 32)).not.toThrow();
    for (const index of [narrow, short]) expect(() => validateGroundBvh(index, 32, geometry)).toThrow("Ground BVH face outside its leaf's bounds.");
    expect(() => validateGroundBvh(wide, 32, geometry)).toThrow("Ground BVH node outside its parent's bounds.");
    const missing = positions.slice(); missing[31 * 9 + 4] = NaN;
    expect(() => validateGroundBvh(reference, 32, { positions: missing, indices })).toThrow("Ground BVH face outside its leaf's bounds.");
    expect(() => validateGroundBvh(reference, 32, { positions, indices: indices.subarray(3) })).toThrow("Invalid ground BVH geometry.");
    const fractional = reference.slice(); fractional[2 + 6] += 0.5;
    expect(() => validateGroundBvh(fractional, 32)).toThrow("Invalid ground BVH topology.");
  });
});

describe("ground index identity with the TypeScript twin", () => {
  it("builds the reference's index bit for bit, with signed-zero centroid ties and 17-face nodes", async () => {
    const core = await instantiateGroundCore(await readFile(new URL("../ground-WASM/single/ground.wasm", import.meta.url)));
    // x centroids of exactly -0 and +0, alternating by face, straddle the root median. 139 faces split
    // into nodes of 17, whose median selection is not a full sort; 1088 is 17 × 64.
    for (const faces of [139, 1088]) {
      const positions = new Float32Array(faces * 9), indices = Uint32Array.from({ length: faces * 3 }, (_, at) => at);
      for (let face = 0; face < faces; face++) {
        const block = face - (faces >> 1) + 16, x = block >= 0 && block < 32 ? (block % 2 ? -0 : 0) : (face - faces / 2) * 3;
        const y = Math.sin(face) * 2, z = Math.cos(face * 1.3) * 2;
        positions.set([x, y, z, x, y + 1, z, x, y, z + 1], face * 9);
      }
      const wasm = core.buildBvh(positions, indices), snapshot = wasm.snapshot(), reference = buildGroundBvh(positions, indices);
      expect(snapshot.length).toBe(reference.length);
      expect(snapshot.findIndex((value, at) => !Object.is(value, reference[at]))).toBe(-1);
      wasm.dispose();
    }
    core.dispose();
  });
});

describe("ground CPU index identity", () => {
  function mutableMesh(scene: Scene) {
    const mesh = new Mesh("mutable-indices", scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array([
      0, 0, 0, 4, 0, 0, 0, 0, 4,
      0, 3, 0, 4, 3, 0, 0, 3, 4,
    ]));
    const input = new Uint32Array([0, 1, 2, 0, 1, 2]);
    mesh.setIndices(input, null, true); mesh.computeWorldMatrix(true);
    return { mesh, input };
  }
  const compare = (scene: Scene, mesh: Mesh, acceleration: ReturnType<typeof createGroundAcceleration>, ray: Ray) => {
    const result = acceleration.pick(scene, ray, candidate => candidate === mesh);
    const expected = scene.pickWithRay(ray, candidate => candidate === mesh, false);
    expect(result?.hit ?? false).toBe(expected?.hit ?? false);
    expect(result?.distance).toBe(expected?.distance);
    expect(result?.pickedPoint?.asArray()).toEqual(expected?.pickedPoint?.asArray());
    expect(result?.faceId).toBe(expected?.faceId);
    return result;
  };
  it("invalidates same-length updatable topology changes before using an admitted index", async () => {
    const { scene } = fixture(), { mesh, input } = mutableMesh(scene);
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
    const ray = new Ray(new Vector3(0.5, 10, 0.5), new Vector3(0, -1, 0), 20);
    const updated = vi.fn(); mesh.geometry!.onGeometryUpdated = updated;
    try {
      compare(scene, mesh, acceleration, ray); worker.answer(); await settle();
      expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(0);
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, parity: "not-run" });
      for (const [indices, expectedY] of [[new Uint32Array([3, 4, 5, 3, 4, 5]), 3], [new Uint32Array([0, 2, 1, 0, 2, 1]), 0]] as const) {
        const oldCpu = mesh.getIndices();
        input.set(indices); mesh.updateIndices(input);
        expect(mesh.getIndices()).not.toBe(oldCpu); expect(updated).not.toHaveBeenCalled();
        expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(expectedY);
        expect(acceleration.status()).toMatchObject({ readyMeshes: 0, pending: true });
        worker.answer(); await settle();
        expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(expectedY);
        expect(acceleration.status()).toMatchObject({ readyMeshes: 1, pending: false, parity: "not-run" });
      }
    } finally { acceleration.dispose(); }
  });
  it("rejects an old index build when CPU topology changes without any intervening query", async () => {
    const { scene } = fixture(), { mesh, input } = mutableMesh(scene);
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
    const ray = new Ray(new Vector3(0.5, 10, 0.5), new Vector3(0, -1, 0), 20);
    try {
      compare(scene, mesh, acceleration, ray);
      input.set([3, 4, 5, 3, 4, 5]); mesh.updateIndices(input);
      worker.answer(); await settle();
      expect(acceleration.status()).toMatchObject({ readyMeshes: 0, pending: false });
      expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(3);
      worker.answer(); await settle();
      expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(3);
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, pending: false, parity: "not-run" });
    } finally { acceleration.dispose(); }
  });
  it("keeps the existing CPU picking geometry for an explicit GPU-only index update", async () => {
    const { scene } = fixture(), { mesh, input } = mutableMesh(scene);
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
    const ray = new Ray(new Vector3(0.5, 10, 0.5), new Vector3(0, -1, 0), 20);
    try {
      compare(scene, mesh, acceleration, ray); worker.answer(); await settle(); compare(scene, mesh, acceleration, ray);
      const oldCpu = mesh.getIndices();
      // Use a fresh upload array: Babylon's initial CPU array aliases input.
      mesh.updateIndices(new Uint32Array([3, 4, 5, 3, 4, 5]), undefined, true);
      expect(mesh.getIndices()).toBe(oldCpu); expect(input).toEqual(new Uint32Array([0, 1, 2, 0, 1, 2]));
      expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(0);
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, pending: false, parity: "not-run" });
    } finally { acceleration.dispose(); }
  });
});

/** The preparer creates its worker on the first build, as the app does, and the worker starts its core then. */
function connected(kernel: GroundBuildKernel, missingWasm = false, wrap = (core: GroundNumericCore): GroundNumericCore => core) {
  const listeners = new Map<string, Array<(event: { data?: unknown; message?: string }) => void>>();
  const loadNumericCore = vi.fn(async () => { if (missingWasm) throw new Error("missing"); return wrap(await instantiateGroundCore(await readFile(new URL("../ground-WASM/single/ground.wasm", import.meta.url)))); });
  const timers = { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const terminate = vi.fn();
  const preparer = createGroundBvhPreparer({ kernel, now: () => 0, timers, createWorker: () => {
    let workerListener: (event: { data: unknown }) => void = () => {};
    installGroundBvhWorker({ kernel, loadNumericCore, now: () => 0, timers, scope: {
      addEventListener: (_type, listener) => { workerListener = listener; }, postMessage: (message: GroundBvhWorkerReply, transfer) => {
        const data = structuredClone(message, { transfer: transfer as ArrayBuffer[] }); queueMicrotask(() => { for (const listener of listeners.get("message") ?? []) listener({ data }); });
      },
    } });
    return {
      postMessage: (message: GroundBvhWorkerRequest, transfer) => { const data = structuredClone(message, { transfer: transfer as ArrayBuffer[] }); queueMicrotask(() => workerListener({ data })); },
      addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); }, terminate,
    };
  } });
  return { preparer, loadNumericCore, terminate };
}
const triangle = () => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });

describe("ground build worker lifecycle", () => {
  it("prepares queued builds one at a time, in order, and refuses one past its bound without retiring", async () => {
    let reply!: (event: { data?: unknown }) => void;
    const posted: GroundBvhWorkerRequest[] = [];
    const port: GroundBvhWorkerPort = { postMessage: message => { posted.push(message); }, terminate: vi.fn(), addEventListener(type, listener) { if (type === "message") reply = listener; } };
    const preparer = createGroundBvhPreparer({ kernel: "typescript", createWorker: () => port, now: () => 0, maxQueuedBuilds: 2, timers: { set: () => 0, clear: () => {} } });
    const results = [1, 2, 3].map(generation => preparer.prepare({ generation, ...triangle() }));
    await expect(preparer.prepare({ generation: 4, ...triangle() })).rejects.toThrow(GROUND_BUILD_QUEUE_FULL);
    expect(preparer.status()).toMatchObject({ state: "busy", queued: 2, failure: null });
    for (const generation of [1, 2, 3]) {
      // Each waits for the previous reply before it is sent.
      expect(posted.map(message => message.request.generation)).toEqual([1, 2, 3].slice(0, generation));
      const message = posted[generation - 1], { positions, indices } = triangle();
      reply({ data: { type: "built", id: message.id, result: { generation, snapshot: buildGroundBvh(positions, indices), actual: "typescript", parity: "not-run", fallbackReason: null, workMs: 0 } } });
      await expect(results[generation - 1]).resolves.toMatchObject({ generation });
    }
    expect(preparer.status()).toMatchObject({ state: "idle", queued: 0, jobs: 3, failure: null });
    expect(port.terminate).not.toHaveBeenCalled(); preparer.dispose();
  });
  it("queues builds that arrive while one runs and answers each in order", async () => {
    const replies: GroundBvhWorkerReply[] = [];
    let send!: (event: { data: unknown }) => void;
    installGroundBvhWorker({ kernel: "typescript", now: () => 0, timers: { set: () => 0, clear: () => {} }, maxQueuedBuilds: 2,
      scope: { addEventListener: (_type, listener) => { send = listener; }, postMessage: message => { replies.push(message); } } });
    for (const id of [1, 2, 3, 4]) send({ data: { type: "build", id, request: { generation: id, ...triangle() } } });
    // One builds and two wait; only a fourth is refused.
    expect(replies).toEqual([{ type: "failed", id: 4, message: GROUND_BUILD_QUEUE_FULL }]);
    await settle();
    expect(replies.map(message => `${message.type} ${message.id}`)).toEqual(["failed 4", "built 1", "built 2", "built 3"]);
  });
  it.each(["typescript", "single", "threaded"] as const)("runs the %s arm with owned transfer buffers and honest actual status", async kernel => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateBox("box", { size: 10 }, scene)), pair = connected(kernel);
    const positions = Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), indices = Uint32Array.from(mesh.getIndices()!);
    const result = await pair.preparer.prepare({ positions, indices, generation: 3 });
    expect(positions.byteLength).toBe(0); expect(indices.byteLength).toBe(0);
    expect(result).toMatchObject({ generation: 3, actual: kernel === "single" ? "single" : "typescript", parity: kernel === "single" ? "same" : "not-run" });
    expect(pair.loadNumericCore).toHaveBeenCalledTimes(kernel === "single" ? 1 : 0);
    expect(pair.preparer.status().lastJob!.outputBytes).toBe(result.snapshot.byteLength);
    pair.preparer.dispose(); expect(pair.terminate).toHaveBeenCalledOnce();
  });
  it("keeps a complete TS build after WASM startup failure", async () => {
    const pair = connected("single", true);
    const result = await pair.preparer.prepare({ generation: 1, ...triangle() });
    expect(result).toMatchObject({ actual: "typescript", fallbackReason: "startup-failed", parity: "not-run" }); pair.preparer.dispose();
  });
  it("admits the core on its startup fixture before the first mesh, then builds each mesh once, in WASM", async () => {
    const builds: number[] = [];
    const pair = connected("single", false, core => ({ ...core, buildBvh: (positions, indices, options) => { builds.push(indices.length / 3); return core.buildBvh(positions, indices, options); } }));
    expect(pair.loadNumericCore).not.toHaveBeenCalled();
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateBox("box", { size: 10 }, scene));
    const request = (generation: number) => ({ generation, positions: Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), indices: Uint32Array.from(mesh.getIndices()!) });
    const references = vi.mocked(buildGroundBvh); references.mockClear();
    const first = await pair.preparer.prepare(request(1)), second = await pair.preparer.prepare(request(2));
    expect(builds).toEqual([1088, 12, 12]);
    // The worker's only TypeScript build is the fixture's reference.
    expect(references.mock.calls.map(([, indices]) => indices.length / 3)).toEqual([1088]);
    expect(pair.loadNumericCore).toHaveBeenCalledOnce();
    for (const result of [first, second]) expect(result).toMatchObject({ actual: "single", parity: "same", fallbackReason: null });
    pair.preparer.dispose();
  });
  it("returns to TypeScript, and says why, when the startup fixture's index differs", async () => {
    const dispose = vi.fn();
    const pair = connected("single", false, core => ({ dispose: () => { dispose(); core.dispose(); }, buildBvh: (positions, indices, options) => {
      const mesh = core.buildBvh(positions, indices, options);
      // One looser root bound: still a valid index, but not the reference's.
      return { ...mesh, snapshot: () => { const snapshot = mesh.snapshot(); snapshot[2] -= 1; return snapshot; } };
    } }));
    const result = await pair.preparer.prepare({ generation: 1, ...triangle() });
    expect(result).toMatchObject({ actual: "typescript", parity: "different", fallbackReason: "startup-parity-mismatch" });
    expect(Array.from(result.snapshot)).toEqual(Array.from(buildGroundBvh(triangle().positions, triangle().indices)));
    expect(dispose).toHaveBeenCalledOnce(); pair.preparer.dispose();
  });
  it("counts a zero of the other sign in the startup fixture's index as a difference", async () => {
    let flipped = false;
    const pair = connected("single", false, core => ({ ...core, buildBvh: (positions, indices, options) => {
      const mesh = core.buildBvh(positions, indices, options);
      return { ...mesh, snapshot: () => {
        const snapshot = mesh.snapshot();
        // The first zero bound, sign flipped: equal under ===, different bit for bit.
        for (let at = 2; at < 2 + snapshot[0] * 10 && !flipped; at++) if ((at - 2) % 10 < 6 && snapshot[at] === 0) { snapshot[at] = Object.is(snapshot[at], 0) ? -0 : 0; flipped = true; }
        return snapshot;
      } };
    } }));
    const result = await pair.preparer.prepare({ generation: 1, ...triangle() });
    expect(flipped).toBe(true);
    expect(result).toMatchObject({ actual: "typescript", parity: "different", fallbackReason: "startup-parity-mismatch" }); pair.preparer.dispose();
  });
  it("builds in TypeScript from then on, and says why, when a mesh's WASM index does not contain the mesh", async () => {
    const dispose = vi.fn(), builds: number[] = [];
    const pair = connected("single", false, core => ({ dispose: () => { dispose(); core.dispose(); }, buildBvh: (positions, indices, options) => {
      builds.push(indices.length / 3);
      const mesh = core.buildBvh(positions, indices, options);
      if (indices.length / 3 === 1088) return mesh;
      // Well formed, but its only leaf lies far from the face.
      return { ...mesh, snapshot: () => { const snapshot = mesh.snapshot(); snapshot[2] = snapshot[5] = 1e6; return snapshot; } };
    } }));
    const { positions, indices } = triangle(), wrong = buildGroundBvh(positions, indices); wrong[2] = wrong[5] = 1e6;
    expect(() => validateGroundBvh(wrong, 1)).not.toThrow();
    const first = await pair.preparer.prepare({ generation: 1, ...triangle() }), second = await pair.preparer.prepare({ generation: 2, ...triangle() });
    for (const result of [first, second]) {
      expect(result).toMatchObject({ actual: "typescript", parity: "same", fallbackReason: "wasm-index-invalid" });
      expect(Array.from(result.snapshot)).toEqual(Array.from(buildGroundBvh(positions, indices)));
    }
    expect(builds).toEqual([1088, 1]); expect(dispose).toHaveBeenCalledOnce(); pair.preparer.dispose();
  });
  it("returns to TypeScript when the core traps during admission, even if it cannot then be released", async () => {
    const trap = () => { throw new WebAssembly.RuntimeError("unreachable"); };
    const pair = connected("single", false, core => ({ dispose: () => { core.dispose(); trap(); }, buildBvh: trap }));
    const first = await pair.preparer.prepare({ generation: 1, ...triangle() }), second = await pair.preparer.prepare({ generation: 2, ...triangle() });
    for (const result of [first, second]) expect(result).toMatchObject({ actual: "typescript", parity: "not-run", fallbackReason: "wasm-build-failed" });
    expect(pair.preparer.status()).toMatchObject({ state: "idle", jobs: 2 }); pair.preparer.dispose();
  });
});

const groundWasm = () => readFile(new URL("../ground-WASM/single/ground.wasm", import.meta.url));
/** The page core, watching each index it imports and each release. */
async function pageCore() {
  const core = await instantiateGroundCore(await groundWasm(), { page: true });
  const watch = (wasm: GroundMesh) => ({ wasm, dispose: vi.spyOn(wasm, "dispose") });
  const imported: ReturnType<typeof watch>[] = [], importSnapshot = core.importSnapshot.bind(core), createWorldBatch = core.createWorldBatch.bind(core);
  vi.spyOn(core, "importSnapshot").mockImplementation((...args) => { const wasm = importSnapshot(...args); imported.push(watch(wasm)); return wasm; });
  const batches: GroundWorldBatch[] = [];
  vi.spyOn(core, "createWorldBatch").mockImplementation(capacity => { const batch = createWorldBatch(capacity); batches.push(batch); return batch; });
  return { core, imported, batches, dispose: vi.spyOn(core, "dispose") };
}
/** All a pick answers, compared with Object.is, and its face normal as surface queries take it. */
const exact = (pick: PickingInfo | null) => pick?.hit ? [pick.pickedMesh?.name, pick.faceId, pick.subMeshFaceId, pick.subMeshId, pick.distance, pick.bu, pick.bv,
  ...pick.pickedPoint!.asArray(), ...pick.getNormal(true, false)!.asArray()] : null;
const downAt = (x = 0.17, z = 0.23, length = 40) => new Ray(new Vector3(x, 10, z), new Vector3(0, -1, 0), length);
const only = (mesh: AbstractMesh) => (candidate: AbstractMesh) => candidate === mesh;

describe("ground queries in the page core", () => {
  it.each([true, false])("picks each imported mesh as Babylon does, face normal included, with float64 matrices: %s", async useHighPrecisionMatrix => {
    const { scene, root } = fixture(useHighPrecisionMatrix);
    const ground = f32(MeshBuilder.CreateGround("ground", { width: 40, height: 40, subdivisions: 12 }, scene));
    const box = f32(MeshBuilder.CreateBox("box", { size: 6 }, scene)); box.position.set(4, 2, -3); box.rotation.set(0.3, 0.7, -0.2);
    const stretched = f32(MeshBuilder.CreateSphere("stretched", { diameter: 5, segments: 8 }, scene)); stretched.position.set(-8, 1, 6); stretched.scaling.set(2, 0.5, 1.3);
    for (const mesh of [ground, box, stretched]) mesh.parent = root;
    const { core, imported } = await pageCore(), all = () => true;
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, loadQueryCore: async () => core });
    const query = createSurfaceQuery(scene, () => root, () => true, () => 0, undefined, acceleration), reference = createSurfaceQuery(scene, () => root, () => true);
    let seed = 29;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    // Down onto the ground, across the box and the sphere, and some that end short of the surface.
    const local = [...Array.from({ length: 48 }, () => ({ origin: new Vector3(random() * 40 - 20, 12, random() * 40 - 20),
      direction: new Vector3(random() - 0.5, -1, random() - 0.5).normalize(), length: [8, 12.2, 40, Number.MAX_VALUE][Math.floor(random() * 4)] })),
    ...Array.from({ length: 16 }, () => ({ origin: new Vector3(-30, random() * 4, random() * 16 - 8), direction: new Vector3(1, random() * 0.1, random() * 0.2 - 0.1), length: 60 }))];
    try {
      await settle();
      expect(acceleration.status()).toMatchObject({ queryKernel: "single", requestedQueryKernel: "single", wasmMeshes: 0 });
      acceleration.pick(scene, downAt(), all); expect(worker.held).toHaveLength(3);
      vi.mocked(validateGroundBvh).mockClear();
      while (worker.held.length) { worker.answer(); await settle(); }
      // The core checked each index as it imported it; the page did not check them again.
      expect(imported).toHaveLength(3); expect(validateGroundBvh).not.toHaveBeenCalled();
      expect(acceleration.status()).toMatchObject({ readyMeshes: 3, wasmMeshes: 3, fallbackReason: null });
      for (const pose of ["level", "turned", "mirrored"]) {
        if (pose === "turned") { root.rotation.set(0.2, -0.4, 1.1); root.position.set(-500000, -866000, 15); }
        if (pose === "mirrored") root.scaling.set(-0.8, 1.2, 1.5);
        root.computeWorldMatrix(true); for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
        expect(stretched.nonUniformScaling).toBe(true); expect(ground.nonUniformScaling).toBe(pose === "mirrored");
        const world = root.getWorldMatrix(), rays = local.map(ray => new Ray(Vector3.TransformCoordinates(ray.origin, world), Vector3.TransformNormal(ray.direction, world), ray.length));
        const pickWithRay = vi.spyOn(scene, "pickWithRay"); vi.mocked(queryGroundBvh).mockClear();
        const before = acceleration.status().wasmQueries, answers = rays.map(ray => exact(acceleration.pick(scene, ray, all)));
        expect(pickWithRay).not.toHaveBeenCalled(); expect(queryGroundBvh).not.toHaveBeenCalled(); pickWithRay.mockRestore();
        expect(acceleration.status().wasmQueries - before).toBe(3 * rays.length);
        expect(new Set(answers.map(answer => answer?.[0])).size).toBe(4);
        expect(answers).toEqual(rays.map(ray => exact(scene.pickWithRay(ray, all, false))));
        for (const ray of local) expect(query.raycast(ray.origin, ray.direction, ray.length)).toEqual(reference.raycast(ray.origin, ray.direction, ray.length));
      }
    } finally { acceleration.dispose(); }
  });

  it("keeps a plain array's float64 positions on the fitted, validated TypeScript query beside an imported mesh", async () => {
    const { scene } = fixture(), grid = farGrid(), far = new Mesh("far", scene);
    far.setVerticesData(VertexBuffer.PositionKind, Float32Array.from(grid.positions), true); far.setIndices(grid.indices);
    far.updateVerticesData(VertexBuffer.PositionKind, grid.positions, true); far.computeWorldMatrix(true);
    const near = f32(MeshBuilder.CreateGround("near", { width: 3, height: 3, subdivisions: 4 }, scene)); near.position.set(3e7 + 1.5, -1, 1.5); near.computeWorldMatrix(true);
    const { core, imported } = await pageCore();
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, loadQueryCore: async () => core });
    let seed = 7;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const rays = Array.from({ length: 48 }, () => new Ray(new Vector3(3e7 + random() * grid.size, 5, random() * grid.size), new Vector3((random() - 0.5) * 0.2, -1, (random() - 0.5) * 0.2), 20));
    try {
      await settle();
      acceleration.pick(scene, rays[0], () => true); expect(worker.held).toHaveLength(2);
      vi.mocked(validateGroundBvh).mockClear(); vi.mocked(refitGroundBvh).mockClear();
      while (worker.held.length) { worker.answer(); await settle(); }
      expect(acceleration.status()).toMatchObject({ queryKernel: "single", readyMeshes: 2, wasmMeshes: 1, fallbackReason: null });
      // Only the Float32 mesh went to the core; the float64 one was fitted and checked against its own numbers.
      expect(core.importSnapshot).toHaveBeenCalledTimes(1); expect(imported).toHaveLength(1);
      expect(vi.mocked(core.importSnapshot).mock.calls[0][1]).toBe(near.getVerticesData(VertexBuffer.PositionKind));
      expect(refitGroundBvh).toHaveBeenCalledTimes(1); expect(vi.mocked(refitGroundBvh).mock.calls[0][1]).toBe(grid.positions);
      expect(vi.mocked(validateGroundBvh).mock.calls.map(call => call[2]?.positions)).toEqual([undefined, grid.positions]);
      for (const [mesh, kernel] of [[far, "typescript"], [near, "single"]] as const) {
        vi.mocked(queryGroundBvh).mockClear();
        const before = acceleration.status().wasmQueries, answers = rays.map(ray => exact(acceleration.pick(scene, ray, only(mesh))));
        expect(acceleration.status().wasmQueries - before).toBe(kernel === "single" ? rays.length : 0);
        if (kernel === "typescript") expect(queryGroundBvh).toHaveBeenCalled(); else expect(queryGroundBvh).not.toHaveBeenCalled();
        expect(answers.filter(Boolean).length).toBeGreaterThan(rays.length / 2);
        expect(answers).toEqual(rays.map(ray => exact(scene.pickWithRay(ray, only(mesh), false))));
      }
    } finally { acceleration.dispose(); }
  });

  it("releases each WASM index when its mesh is disposed, evicted or changed, and the core with the acceleration", async () => {
    const { scene } = fixture();
    const meshes = ["a", "b", "c"].map((name, at) => { const mesh = f32(MeshBuilder.CreateGround(name, { width: 20, height: 20, subdivisions: 2 + at }, scene)); mesh.position.y = -at; mesh.computeWorldMatrix(true); return mesh; });
    const { core, imported, batches, dispose } = await pageCore();
    let clock = 0;
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => clock, maxMeshes: 2, loadQueryCore: async () => core });
    const ready = async (mesh: Mesh) => { clock++; acceleration.pick(scene, downAt(), only(mesh)); worker.answer(); await settle(); };
    const released = () => imported.map(entry => entry.dispose.mock.calls.length);
    await settle(); await ready(meshes[0]); await ready(meshes[1]);
    expect(released()).toEqual([0, 0]); expect(acceleration.status().wasmMeshes).toBe(2);
    // c takes a's place: a, the least recently used, is evicted with its index.
    await ready(meshes[2]);
    expect(released()).toEqual([1, 0, 0]); expect(acceleration.status()).toMatchObject({ readyMeshes: 2, wasmMeshes: 2 });
    // b's positions change: its index goes before the new triangles can be picked, and its rebuild is imported anew.
    const positions = meshes[1].getVerticesData(VertexBuffer.PositionKind)!.slice(); positions[1] += 0.5;
    meshes[1].updateVerticesData(VertexBuffer.PositionKind, positions);
    expect(released()).toEqual([1, 1, 0]); expect(acceleration.status().wasmMeshes).toBe(1);
    await ready(meshes[1]);
    expect(exact(acceleration.pick(scene, downAt(), only(meshes[1])))).toEqual(exact(scene.pickWithRay(downAt(), only(meshes[1]), false)));
    // c is disposed with its index.
    meshes[2].dispose();
    expect(released()).toEqual([1, 1, 1, 0]); expect(acceleration.status()).toMatchObject({ readyMeshes: 1, wasmMeshes: 1 });
    const batch = vi.spyOn(batches[0], "dispose");
    acceleration.dispose();
    expect(released()).toEqual([1, 1, 1, 1]); expect(batch).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
    // A core that arrives after the acceleration is gone is released too.
    let deliver!: (loaded: GroundCore) => void;
    const late = createGroundAcceleration({ preparer: heldPreparer().preparer, now: () => 0, loadQueryCore: () => new Promise(resolve => { deliver = resolve; }) });
    late.dispose(); const second = await pageCore(); deliver(second.core); await settle();
    expect(second.dispose).toHaveBeenCalledTimes(1); expect(second.batches).toHaveLength(0);
  });

  it("imports indices made ready before the core loads, and says why it stays on TypeScript when the core does not", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("ground", { width: 20, height: 20, subdivisions: 6 }, scene));
    const { core, imported } = await pageCore(), onReady = vi.fn();
    let deliver!: (loaded: GroundCore) => void;
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, onReady, loadQueryCore: () => new Promise(resolve => { deliver = resolve; }) });
    try {
      acceleration.pick(scene, downAt(), only(mesh)); worker.answer(); await settle();
      expect(acceleration.status()).toMatchObject({ queryKernel: "typescript", requestedQueryKernel: "single", readyMeshes: 1, wasmMeshes: 0, fallbackReason: null });
      onReady.mockClear(); deliver(core); await settle();
      expect(onReady).toHaveBeenCalledTimes(1); expect(imported).toHaveLength(1);
      expect(acceleration.status()).toMatchObject({ queryKernel: "single", readyMeshes: 1, wasmMeshes: 1, wasmQueries: 0 });
      expect(exact(acceleration.pick(scene, downAt(), only(mesh)))).toEqual(exact(scene.pickWithRay(downAt(), only(mesh), false)));
      expect(acceleration.status().wasmQueries).toBe(1);
    } finally { acceleration.dispose(); }
    const missing = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, loadQueryCore: async () => { throw new Error("no ground WASM"); } });
    try {
      await settle();
      expect(missing.status()).toMatchObject({ queryKernel: "typescript", requestedQueryKernel: "single", fallbackReason: "wasm-query-core-unavailable: no ground WASM" });
      missing.pick(scene, downAt(), only(mesh)); worker.answer(); await settle();
      expect(exact(missing.pick(scene, downAt(), only(mesh)))).toEqual(exact(scene.pickWithRay(downAt(), only(mesh), false)));
      expect(missing.status()).toMatchObject({ readyMeshes: 1, wasmMeshes: 0, wasmQueries: 0, acceleratedQueries: 1 });
    } finally { missing.dispose(); }
  });

  it("refuses an index the core does not accept, as validateGroundBvh does, and leaves the mesh to Babylon", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("ground", { width: 20, height: 20, subdivisions: 4 }, scene));
    const { core, imported } = await pageCore();
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, loadQueryCore: async () => core });
    try {
      await settle();
      // A root box narrower than its children.
      acceleration.pick(scene, downAt(), only(mesh)); worker.answer(snapshot => { snapshot[5] -= 1; }); await settle();
      expect(core.importSnapshot).toHaveBeenCalledTimes(1); expect(imported).toHaveLength(0);
      expect(acceleration.status()).toMatchObject({ queryKernel: "single", readyMeshes: 0, wasmMeshes: 0,
        fallbackReason: "wasm-import-refused: WASM ground snapshot import failed (6); Ground BVH node outside its parent's bounds." });
      const pickWithRay = vi.spyOn(scene, "pickWithRay");
      expect(exact(acceleration.pick(scene, downAt(), only(mesh)))).toEqual(exact(scene.pickWithRay(downAt(), only(mesh), false)));
      expect(pickWithRay).toHaveBeenCalledTimes(2);
    } finally { acceleration.dispose(); }
  });

  it("leaves rays the core does not take to TypeScript, and retires the core, saying why, when a query fails", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("ground", { width: 20, height: 20, subdivisions: 6 }, scene));
    const { core, imported, batches, dispose } = await pageCore();
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0, loadQueryCore: async () => core });
    try {
      await settle(); acceleration.pick(scene, downAt(), only(mesh)); worker.answer(); await settle();
      expect(acceleration.status()).toMatchObject({ queryKernel: "single", wasmMeshes: 1 });
      // The core takes only finite rays; an unbounded one is answered from the same index in TypeScript.
      vi.mocked(queryGroundBvh).mockClear();
      expect(exact(acceleration.pick(scene, downAt(0.17, 0.23, Infinity), only(mesh)))).toEqual(exact(scene.pickWithRay(downAt(0.17, 0.23, Infinity), only(mesh), false)));
      expect(queryGroundBvh).toHaveBeenCalledTimes(1);
      expect(acceleration.status()).toMatchObject({ queryKernel: "single", wasmMeshes: 1, wasmQueries: 0, acceleratedQueries: 1, fallbackReason: null });
      vi.spyOn(batches[0], "run").mockImplementationOnce(() => { throw new Error("trap"); });
      expect(exact(acceleration.pick(scene, downAt(3, -4), only(mesh)))).toEqual(exact(scene.pickWithRay(downAt(3, -4), only(mesh), false)));
      expect(imported[0].dispose).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
      expect(acceleration.status()).toMatchObject({ queryKernel: "typescript", requestedQueryKernel: "single", readyMeshes: 1, wasmMeshes: 0, wasmQueries: 0,
        acceleratedQueries: 2, fallbackReason: "wasm-query-failed: trap" });
      expect(exact(acceleration.pick(scene, downAt(-5, 6), only(mesh)))).toEqual(exact(scene.pickWithRay(downAt(-5, 6), only(mesh), false)));
    } finally { acceleration.dispose(); }
  });
});
