import { Matrix, Mesh, PickingCustomization, PickingInfo, Ray, Vector3, VertexBuffer, type AbstractMesh, type Geometry, type Observer, type Scene } from "@babylonjs/core";
import { queryGroundBvh, validateGroundBvh, type GroundBvhSnapshot } from "../browser/groundBvh.js";
import type { GroundBvhPreparer, GroundBvhPreparerStatus } from "../browser/groundBvhProtocol.js";

export interface GroundAccelerationStatus {
  /** Only immutable index construction runs in the worker/native core. */
  queryKernel: "typescript";
  readyMeshes: number;
  pending: boolean;
  snapshotBytes: number;
  acceleratedQueries: number;
  parity: "pending" | "same" | "different";
  fallbackReason: string | null;
  preparer: GroundBvhPreparerStatus;
}
export interface GroundAcceleration {
  /** Uses Babylon for every unsupported/unready mesh and retains scene-order ties. */
  pick(scene: Scene, ray: Ray, predicate: (mesh: AbstractMesh) => boolean): PickingInfo | null;
  status(): GroundAccelerationStatus;
  dispose(): void;
}
interface Entry {
  mesh: Mesh; geometry: Geometry; generation: number; positions: Float32Array; indices: Uint32Array; sourceIndices: ReturnType<Mesh["getIndices"]>;
  snapshot: GroundBvhSnapshot | null; validated: boolean; failed: boolean; touched: number; observer: Observer<import("@babylonjs/core").Node> | null;
}
interface Hook { previous: Geometry["onGeometryUpdated"]; wrapper: Geometry["onGeometryUpdated"]; entries: Set<Entry> }

/** Build off-page, publish immutable spatial indices, and query current transforms
 * synchronously. Geometry mutations invalidate before their new buffers are drawn;
 * until replacement is ready Babylon answers from the current geometry. */
export function createGroundAcceleration(options: { preparer: GroundBvhPreparer; now(): number; onReady?(): void; maxMeshes?: number; maxSnapshotBytes?: number }): GroundAcceleration {
  const entries = new Map<Mesh, Entry>(), hooks = new Map<Geometry, Hook>();
  const maxMeshes = options.maxMeshes ?? 64, maxBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024;
  let disposed = false, pending = false, nextGeneration = 0, queries = 0;
  let parity: GroundAccelerationStatus["parity"] = "pending", fallbackReason: string | null = null;
  const bytes = () => [...entries.values()].reduce((sum, entry) => sum + (entry.snapshot?.byteLength ?? 0), 0);
  function remove(entry: Entry): void {
    entries.delete(entry.mesh); entry.snapshot = null; entry.generation = ++nextGeneration;
    if (entry.observer) entry.mesh.onDisposeObservable.remove(entry.observer);
    const hook = hooks.get(entry.geometry);
    if (hook) {
      hook.entries.delete(entry);
      if (!hook.entries.size) {
        if (entry.geometry.onGeometryUpdated === hook.wrapper) entry.geometry.onGeometryUpdated = hook.previous;
        hooks.delete(entry.geometry);
      }
    }
  }
  function attach(entry: Entry): void {
    let hook = hooks.get(entry.geometry);
    if (!hook) {
      const previous = entry.geometry.onGeometryUpdated;
      const owned: Hook = { previous, entries: new Set(), wrapper: () => {} };
      owned.wrapper = (geometry, kind) => {
        // Invalidate before chaining so reentrant host queries cannot see old triangles.
        if (!kind || kind === VertexBuffer.PositionKind) for (const current of owned.entries) {
          current.generation = ++nextGeneration; current.snapshot = null; current.validated = false; current.failed = false;
        }
        previous?.(geometry, kind);
      };
      entry.geometry.onGeometryUpdated = owned.wrapper; hooks.set(entry.geometry, owned); hook = owned;
    }
    hook.entries.add(entry);
    entry.observer = entry.mesh.onDisposeObservable.addOnce(() => remove(entry));
  }
  function schedule(mesh: Mesh): Entry | null {
    let entry = entries.get(mesh);
    if (entry && entry.geometry !== mesh.geometry) { remove(entry); entry = undefined; }
    if (entry && hooks.get(entry.geometry)?.wrapper !== entry.geometry.onGeometryUpdated) { remove(entry); entry = undefined; }
    const sourceIndices = mesh.getIndices();
    // Babylon's updatable updateIndices replaces its CPU array without calling
    // onGeometryUpdated. Detect that identity before accepting a ready index.
    // A GPU-only update leaves the CPU picking array unchanged, as in Babylon.
    if (entry && entry.sourceIndices !== sourceIndices) {
      entry.sourceIndices = sourceIndices; entry.generation = ++nextGeneration;
      entry.snapshot = null; entry.validated = false; entry.failed = false;
    }
    if (entry) entry.touched = options.now();
    if (entry?.snapshot || entry?.failed || pending || disposed || options.preparer.status().state === "failed") return entry ?? null;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    // Do not quantize f64/JS geometry to manufacture parity with displayed f32.
    if (!(positions instanceof Float32Array) || !sourceIndices?.length || sourceIndices.length % 3 || sourceIndices.length / 3 > 262_144
      || positions.length / 3 > 1_048_576 || !mesh.geometry) return null;
    const indices = Uint32Array.from(sourceIndices);
    if (!entry) {
      if (entries.size >= maxMeshes) {
        const oldest = [...entries.values()].sort((a, b) => a.touched - b.touched)[0]; if (oldest) remove(oldest);
      }
      entry = { mesh, geometry: mesh.geometry, generation: ++nextGeneration, positions, indices, sourceIndices, snapshot: null, validated: false, failed: false, touched: options.now(), observer: null };
      entries.set(mesh, entry); attach(entry);
    } else { entry.positions = positions; entry.indices = indices; entry.sourceIndices = sourceIndices; }
    const current = entry, generation = entry.generation;
    // Only these owned copies cross the worker boundary; live renderer buffers stay attached.
    pending = true;
    void options.preparer.prepare({ positions: new Float32Array(positions), indices: new Uint32Array(indices), generation }).then(result => {
      if (disposed || entries.get(mesh) !== current || current.generation !== generation || mesh.isDisposed() || mesh.geometry !== current.geometry
        || mesh.getIndices() !== sourceIndices) return;
      try {
        if (result.generation !== generation) throw new Error("Ground generation mismatch.");
        validateGroundBvh(result.snapshot, current.indices.length / 3);
        if (result.snapshot.byteLength > maxBytes) throw new Error("Ground snapshot exceeds cache budget.");
        while (bytes() + result.snapshot.byteLength > maxBytes) {
          const oldest = [...entries.values()].filter(other => other !== current && other.snapshot).sort((a, b) => a.touched - b.touched)[0];
          if (!oldest) break; remove(oldest);
        }
        current.snapshot = result.snapshot; fallbackReason = result.fallbackReason;
      } catch (error) { current.failed = true; fallbackReason = error instanceof Error ? error.message : String(error); }
    }, error => { if (!disposed && entries.get(mesh) === current && current.generation === generation) { current.failed = true; fallbackReason = error instanceof Error ? error.message : String(error); } })
      .finally(() => { pending = false; if (!disposed) options.onReady?.(); });
    return entry;
  }
  function supported(mesh: AbstractMesh): mesh is Mesh {
    if (!(mesh instanceof Mesh) || !["Mesh", "GroundMesh"].includes(mesh.getClassName()) || mesh.isDisposed() || mesh.isWorldMatrixCameraDependent()
      || mesh.skeleton || mesh.morphTargetManager || mesh.hasThinInstances || !mesh.geometry || mesh.subMeshes.length !== 1
      || mesh.intersects !== Mesh.prototype.intersects) return false;
    const subMesh = mesh.subMeshes[0], material = subMesh.getMaterial();
    return Boolean(material && [0, 1, 2].includes(material.fillMode) && subMesh.indexStart === 0 && subMesh.indexCount === mesh.getTotalIndices());
  }
  function intersect(entry: Entry, ray: Ray): PickingInfo {
    const mesh = entry.mesh, world = mesh.computeWorldMatrix(), inverse = Matrix.Invert(world), local = Ray.Transform(ray, inverse);
    const pick = new PickingInfo(); pick.ray = ray;
    const candidates = mesh.getScene().getIntersectingSubMeshCandidates(mesh, local);
    if (candidates.length !== 1 || candidates.data[0] !== mesh.subMeshes[0]) {
      const fallback = mesh.intersects(local, false, undefined, false, world); fallback.ray = ray; return fallback;
    }
    const bounds = mesh.getBoundingInfo();
    if (!local.intersectsSphere(bounds.boundingSphere) || !local.intersectsBox(bounds.boundingBox)) return pick;
    const hit = queryGroundBvh(entry.snapshot!, entry.positions, entry.indices, local);
    if (!hit) return pick;
    // Same reconstruction/order as AbstractMesh.intersects; PickingInfo computes the
    // original face normal, including nonuniform transforms and ray-facing flip.
    const worldOrigin = Vector3.TransformCoordinates(local.origin, world);
    const direction = local.direction.scale(hit.distance);
    const pickedPoint = Vector3.TransformNormal(direction, world).addInPlace(worldOrigin);
    pick.hit = true; pick.distance = Vector3.Distance(worldOrigin, pickedPoint); pick.pickedPoint = pickedPoint; pick.pickedMesh = mesh;
    pick.bu = hit.bu || 0; pick.bv = hit.bv || 0; pick.faceId = hit.face; pick.subMeshFaceId = hit.face; pick.subMeshId = mesh.subMeshes[0]._id;
    return pick;
  }
  return {
    pick(scene, ray, predicate) {
      if (disposed || PickingCustomization.internalPickerForMesh) return scene.pickWithRay(ray, predicate, false);
      const skipped = new Set<AbstractMesh>();
      let best: PickingInfo | null = null, bestIndex = Infinity;
      for (let index = 0; index < scene.meshes.length; index++) {
        const mesh = scene.meshes[index];
        if (!predicate(mesh) || !supported(mesh)) continue;
        const entry = schedule(mesh);
        if (!entry?.snapshot || entry.failed) continue;
        let pick = intersect(entry, ray);
        if (!entry.validated) {
          const reference = scene.pickWithRay(ray, candidate => candidate === mesh, false);
          if (!samePick(pick, reference)) { entry.failed = true; entry.snapshot = null; parity = "different"; fallbackReason = "first-query-parity-mismatch"; continue; }
          entry.validated = true; parity = "same"; pick = reference ?? pick;
        }
        skipped.add(mesh); queries++;
        if (pick.hit && (!best || pick.distance < best.distance)) { best = pick; bestIndex = index; }
      }
      const fallback = scene.pickWithRay(ray, mesh => !skipped.has(mesh) && predicate(mesh), false);
      if (fallback?.hit && (!best || fallback.distance < best.distance || (fallback.distance === best.distance && scene.meshes.indexOf(fallback.pickedMesh!) < bestIndex))) best = fallback;
      return best;
    },
    status: () => ({ queryKernel: "typescript", readyMeshes: [...entries.values()].filter(entry => entry.snapshot && !entry.failed).length, pending,
      snapshotBytes: bytes(), acceleratedQueries: queries, parity, fallbackReason, preparer: options.preparer.status() }),
    dispose() {
      if (disposed) return; disposed = true;
      for (const entry of [...entries.values()]) remove(entry);
      options.preparer.dispose();
    },
  };
}

function samePick(a: PickingInfo, b: PickingInfo | null): boolean {
  if (!a.hit) return !b?.hit;
  return Boolean(b?.hit && a.faceId === b.faceId && Object.is(a.distance, b.distance) && a.pickedPoint && b.pickedPoint
    && Object.is(a.pickedPoint.x, b.pickedPoint.x) && Object.is(a.pickedPoint.y, b.pickedPoint.y) && Object.is(a.pickedPoint.z, b.pickedPoint.z));
}
