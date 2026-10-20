import { readFile } from "node:fs/promises";
import { Mesh, MeshBuilder, MorphTargetManager, NullEngine, NullEngineOptions, Ray, Scene, SubMesh, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiateGroundCore } from "../ground-WASM/index.js";
import { createGroundAcceleration } from "../src/babylon/groundAcceleration.js";
import { createSurfaceQuery } from "../src/babylon/surfaceQuery.js";
import { buildGroundBvh, queryGroundBvh, refitGroundBvh, validateGroundBvh } from "../ground-TS/groundBvh.js";
import { createGroundBvhPreparer } from "../src/browser/groundBvhPreparer.js";
import type { GroundBvhBuild, GroundBvhPreparation, GroundBvhPreparer, GroundBvhWorkerReply, GroundBvhWorkerRequest, GroundBuildKernel, GroundNumericCore } from "../src/browser/groundBvhProtocol.js";
import { installGroundBvhWorker } from "../src/browser/groundBvhWorker.js";

// Counts the reference builds, the worker's included, without changing them.
vi.mock("../ground-TS/groundBvh.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../ground-TS/groundBvh.js")>();
  return { ...actual, buildGroundBvh: vi.fn(actual.buildGroundBvh) };
});

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
function fixture() {
  const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true }); engines.push(engine);
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
function heldPreparer() {
  let next: { request: GroundBvhBuild; answer(value: GroundBvhPreparation): void } | null = null;
  const dispose = vi.fn();
  const preparer: GroundBvhPreparer = {
    prepare: request => new Promise(resolve => { next = { request, answer: resolve }; }),
    status: () => ({ kernel: "typescript", state: next ? "busy" : "idle", actual: "typescript", parity: "not-run", failure: null, jobs: 0, lastJob: null }), dispose,
  };
  return { preparer, dispose, answer: (edit?: (snapshot: Float64Array) => void) => { const current = next!; next = null;
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
    const secondWorker = heldPreparer(), second = createGroundAcceleration({ preparer: secondWorker.preparer, now: () => 0 });
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
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
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
      // The first query is checked against Babylon's; from then on the index answers alone.
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
    const worker = heldPreparer(), acceleration = createGroundAcceleration({ preparer: worker.preparer, now: () => 0 });
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

describe("ground numerical BVH", () => {
  it("matches Babylon and the actual worker-only Rust queries, including ties and finite boundaries", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("grid", { width: 20, height: 20, subdivisions: 8 }, scene));
    const positions = Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), indices = Uint32Array.from(mesh.getIndices()!);
    for (let at = 0; at < positions.length; at += 3) positions[at + 1] = Math.sin(positions[at] * 0.37) * Math.cos(positions[at + 2] * 0.29) * 2;
    // Overlapping first face must keep its original lower ID even when partition order changes.
    const duplicated = new Uint32Array(indices.length + 3); duplicated.set(indices); duplicated.set(indices.subarray(0, 3), indices.length);
    const reference = buildGroundBvh(positions, duplicated); validateGroundBvh(reference, duplicated.length / 3, { positions, indices: duplicated });
    const core = await instantiateGroundCore(await readFile(new URL("../ground-WASM/single/ground.wasm", import.meta.url)));
    const native = core.buildBvh(positions, duplicated, { generation: 1 });
    const snapshot = native.snapshot(); validateGroundBvh(snapshot, duplicated.length / 3, { positions, indices: duplicated });
    const rays: number[] = [];
    let seed = 47;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let ray = 0; ray < 512; ray++) rays.push((random() - 0.5) * 24, 10, (random() - 0.5) * 24, ray % 3 === 0 ? 10 : ray % 3 === 1 ? 9.99 : 100,
      (random() - 0.5) * 0.4, -1, (random() - 0.5) * 0.4, 0.001);
    rays.push(-10, 10, -10, 10, 0, -1, 0, 0.001, -10.001, 10, -10.001, 10, 0, -1, 0, 0.001);
    const nativeResults = native.query(new Float64Array(rays));
    for (let at = 0; at < rays.length; at += 8) {
      const ray = new Ray(new Vector3(rays[at], rays[at + 1], rays[at + 2]), new Vector3(rays[at + 4], rays[at + 5], rays[at + 6]), rays[at + 3], rays[at + 7]);
      let hit: { distance: number; face: number; bu: number; bv: number } | null = null;
      for (let face = 0; face < duplicated.length / 3; face++) {
        const result = ray.intersectsTriangle(Vector3.FromArray(positions, duplicated[face * 3] * 3), Vector3.FromArray(positions, duplicated[face * 3 + 1] * 3), Vector3.FromArray(positions, duplicated[face * 3 + 2] * 3));
        if (result && (!hit || result.distance < hit.distance)) hit = { distance: result.distance, face, bu: result.bu!, bv: result.bv! };
      }
      expect(queryGroundBvh(reference, positions, duplicated, ray)).toEqual(hit);
      expect(queryGroundBvh(snapshot, positions, duplicated, ray)).toEqual(hit);
      expect(nativeResults[at]).toBe(hit ? 1 : 0);
      if (hit) { expect(nativeResults[at + 1]).toBe(hit.distance); expect(nativeResults[at + 2]).toBe(hit.face); expect(nativeResults[at + 3]).toBe(hit.bu); expect(nativeResults[at + 4]).toBe(hit.bv); }
    }
    native.dispose(); core.dispose();
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
      const native = core.buildBvh(positions, indices), snapshot = native.snapshot(), reference = buildGroundBvh(positions, indices);
      expect(snapshot.length).toBe(reference.length);
      expect(snapshot.findIndex((value, at) => !Object.is(value, reference[at]))).toBe(-1);
      native.dispose();
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
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, parity: "same" });
      for (const [indices, expectedY] of [[new Uint32Array([3, 4, 5, 3, 4, 5]), 3], [new Uint32Array([0, 2, 1, 0, 2, 1]), 0]] as const) {
        const oldCpu = mesh.getIndices();
        input.set(indices); mesh.updateIndices(input);
        expect(mesh.getIndices()).not.toBe(oldCpu); expect(updated).not.toHaveBeenCalled();
        expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(expectedY);
        expect(acceleration.status()).toMatchObject({ readyMeshes: 0, pending: true });
        worker.answer(); await settle();
        expect(compare(scene, mesh, acceleration, ray)?.pickedPoint?.y).toBe(expectedY);
        expect(acceleration.status()).toMatchObject({ readyMeshes: 1, pending: false, parity: "same" });
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
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, pending: false, parity: "same" });
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
      expect(acceleration.status()).toMatchObject({ readyMeshes: 1, pending: false, parity: "same" });
    } finally { acceleration.dispose(); }
  });
});

/** The preparer creates its worker on the first build, as the app does, and the worker starts its core then. */
function connected(kernel: GroundBuildKernel, missingNative = false, wrap = (core: GroundNumericCore): GroundNumericCore => core) {
  const listeners = new Map<string, Array<(event: { data?: unknown; message?: string }) => void>>();
  const loadNumericCore = vi.fn(async () => { if (missingNative) throw new Error("missing"); return wrap(await instantiateGroundCore(await readFile(new URL("../ground-WASM/single/ground.wasm", import.meta.url)))); });
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
  it("keeps a complete TS build after native startup failure", async () => {
    const pair = connected("single", true);
    const result = await pair.preparer.prepare({ generation: 1, ...triangle() });
    expect(result).toMatchObject({ actual: "typescript", fallbackReason: "startup-failed", parity: "not-run" }); pair.preparer.dispose();
  });
  it("admits the core on its startup fixture before the first mesh, then builds each mesh once, natively", async () => {
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
  it("builds in TypeScript from then on, and says why, when a mesh's native index does not contain the mesh", async () => {
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
      expect(result).toMatchObject({ actual: "typescript", parity: "same", fallbackReason: "native-index-invalid" });
      expect(Array.from(result.snapshot)).toEqual(Array.from(buildGroundBvh(positions, indices)));
    }
    expect(builds).toEqual([1088, 1]); expect(dispose).toHaveBeenCalledOnce(); pair.preparer.dispose();
  });
  it("returns to TypeScript when the core traps during admission, even if it cannot then be released", async () => {
    const trap = () => { throw new WebAssembly.RuntimeError("unreachable"); };
    const pair = connected("single", false, core => ({ dispose: () => { core.dispose(); trap(); }, buildBvh: trap }));
    const first = await pair.preparer.prepare({ generation: 1, ...triangle() }), second = await pair.preparer.prepare({ generation: 2, ...triangle() });
    for (const result of [first, second]) expect(result).toMatchObject({ actual: "typescript", parity: "not-run", fallbackReason: "native-build-failed" });
    expect(pair.preparer.status()).toMatchObject({ state: "idle", jobs: 2 }); pair.preparer.dispose();
  });
});
