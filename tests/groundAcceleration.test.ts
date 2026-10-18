import { readFile } from "node:fs/promises";
import { Mesh, MeshBuilder, MorphTargetManager, NullEngine, NullEngineOptions, Ray, Scene, SubMesh, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiateGroundCore } from "../../native/packages/native-ground/index.js";
import { createGroundAcceleration } from "../src/babylon/groundAcceleration.js";
import { createSurfaceQuery } from "../src/babylon/surfaceQuery.js";
import { buildGroundBvh, queryGroundBvh, validateGroundBvh } from "../src/browser/groundBvh.js";
import { createGroundBvhPreparer } from "../src/browser/groundBvhPreparer.js";
import type { GroundBvhBuild, GroundBvhPreparation, GroundBvhPreparer, GroundBvhWorkerReply, GroundBvhWorkerRequest, GroundBuildKernel } from "../src/browser/groundBvhProtocol.js";
import { installGroundBvhWorker } from "../src/browser/groundBvhWorker.js";

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
function heldPreparer() {
  let next: { request: GroundBvhBuild; answer(value: GroundBvhPreparation): void } | null = null;
  const dispose = vi.fn();
  const preparer: GroundBvhPreparer = {
    prepare: request => new Promise(resolve => { next = { request, answer: resolve }; }),
    status: () => ({ kernel: "typescript", state: next ? "busy" : "idle", actual: "typescript", parity: "not-run", failure: null, jobs: 0, lastJob: null }), dispose,
  };
  return { preparer, dispose, answer: () => { const current = next!; next = null; current.answer({ generation: current.request.generation,
    snapshot: buildGroundBvh(current.request.positions, current.request.indices), actual: "typescript", parity: "not-run", fallbackReason: null, workMs: 0 }); } };
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
});

describe("ground numerical BVH", () => {
  it("matches Babylon and the actual worker-only Rust queries, including ties and finite boundaries", async () => {
    const { scene } = fixture(), mesh = f32(MeshBuilder.CreateGround("grid", { width: 20, height: 20, subdivisions: 8 }, scene));
    const positions = Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), indices = Uint32Array.from(mesh.getIndices()!);
    for (let at = 0; at < positions.length; at += 3) positions[at + 1] = Math.sin(positions[at] * 0.37) * Math.cos(positions[at + 2] * 0.29) * 2;
    // Overlapping first face must keep its original lower ID even when partition order changes.
    const duplicated = new Uint32Array(indices.length + 3); duplicated.set(indices); duplicated.set(indices.subarray(0, 3), indices.length);
    const reference = buildGroundBvh(positions, duplicated); validateGroundBvh(reference, duplicated.length / 3);
    const core = await instantiateGroundCore(await readFile(new URL("../../native/packages/native-ground/single/ground.wasm", import.meta.url)));
    const native = core.buildBvh(positions, duplicated, { generation: 1 });
    const snapshot = native.snapshot(); validateGroundBvh(snapshot, duplicated.length / 3);
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

function connected(kernel: GroundBuildKernel, missingNative = false) {
  let workerListener: (event: { data: unknown }) => void = () => {};
  const listeners = new Map<string, Array<(event: { data?: unknown; message?: string }) => void>>();
  const loadNumericCore = vi.fn(async () => { if (missingNative) throw new Error("missing"); return instantiateGroundCore(await readFile(new URL("../../native/packages/native-ground/single/ground.wasm", import.meta.url))); });
  const timers = { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  installGroundBvhWorker({ kernel, loadNumericCore, now: () => 0, timers, scope: {
    addEventListener: (_type, listener) => { workerListener = listener; }, postMessage: (message: GroundBvhWorkerReply, transfer) => {
      const data = structuredClone(message, { transfer: transfer as ArrayBuffer[] }); queueMicrotask(() => { for (const listener of listeners.get("message") ?? []) listener({ data }); });
    },
  } });
  const terminate = vi.fn();
  const preparer = createGroundBvhPreparer({ kernel, now: () => 0, timers, createWorker: () => ({
    postMessage: (message: GroundBvhWorkerRequest, transfer) => { const data = structuredClone(message, { transfer: transfer as ArrayBuffer[] }); queueMicrotask(() => workerListener({ data })); },
    addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); }, terminate,
  }) });
  return { preparer, loadNumericCore, terminate };
}

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
    const result = await pair.preparer.prepare({ generation: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });
    expect(result).toMatchObject({ actual: "typescript", fallbackReason: "startup-failed", parity: "not-run" }); pair.preparer.dispose();
  });
});
