import { Matrix, Mesh, PickingCustomization, PickingInfo, Ray, TmpVectors, Vector3, VertexBuffer, type AbstractMesh, type Geometry, type Observer, type Scene } from "@babylonjs/core";
import { queryGroundBvh, refitGroundBvh, validateGroundBvh, type GroundBvhSnapshot } from "../../ground-TS/groundBvh.js";
import { GROUND_BUILD_QUEUE_FULL, type GroundBvhPreparer, type GroundBvhPreparerStatus } from "../browser/groundBvhProtocol.js";

/** Babylon `Matrix.m` values. `normalToWorld` is the matrix `getNormal(true, false)` transforms by; it defaults to `localToWorld`. */
export interface GroundPageTransform { worldToLocal: ArrayLike<number>; localToWorld: ArrayLike<number>; normalToWorld?: ArrayLike<number> }
/** An index imported into the page core: `GroundMesh` from `@foss-earth/engine/ground-WASM`. */
export interface GroundPageMesh {
  /** Mesh-space `getBoundingInfo()`: [minimum xyz, maximum xyz, sphere center xyz, sphere radius]. */
  setBounds(bounds: ArrayLike<number>): void;
  dispose(): void;
}
/** World rays and hit rows in WASM memory: `GroundWorldBatch`. A ray is `[origin xyz, direction xyz, length, epsilon]`, a row
 * `[mesh (0 for none), distance, face, bu, bv, point xyz, unit normal xyz]`. The views move when memory grows. */
export interface GroundPageBatch {
  readonly rays: Float64Array;
  readonly output: Float64Array;
  reset(count?: number): void;
  run(mesh: GroundPageMesh, transform: GroundPageTransform, count?: number): void;
  dispose(): void;
}
/** The page-side WASM core, `loadGroundCore({ page: true })` from `@foss-earth/engine/ground-WASM`. */
export interface GroundPageCore {
  /** Adopts a built index without rebuilding it; throws if it is not a sound index of this geometry. */
  importSnapshot(snapshot: Float64Array, positions: Float32Array, indices: Uint32Array, options?: { generation?: number }): GroundPageMesh;
  createWorldBatch(capacity: number): GroundPageBatch;
  dispose(): void;
}

export interface GroundAccelerationStatus {
  /** What answers ready meshes: "single" while the page core is loaded, for each mesh imported into it, and TypeScript for the rest. */
  queryKernel: "typescript" | "single";
  /** "single" when a page core was asked for (`loadQueryCore`). */
  requestedQueryKernel: "typescript" | "single";
  /** Ready meshes the page core answers. */
  wasmMeshes: number;
  /** Mesh queries the page core answered; included in `acceleratedQueries`. */
  wasmQueries: number;
  readyMeshes: number;
  pending: boolean;
  /** Index builds sent to the preparer and not yet answered. */
  queuedBuilds: number;
  snapshotBytes: number;
  acceleratedQueries: number;
  /** Each newly ready index's first query against Babylon's; "not-run" unless `compareFirstQueries` is on. */
  parity: "not-run" | "pending" | "same" | "different";
  fallbackReason: string | null;
  preparer: GroundBvhPreparerStatus;
}
export interface GroundAccelerationOptions {
  preparer: GroundBvhPreparer;
  now(): number;
  onReady?(): void;
  maxMeshes?: number;
  maxSnapshotBytes?: number;
  /** Index builds in flight at once, one per mesh; meshes past it wait for a later query. Default 8. */
  maxQueuedBuilds?: number;
  /**
   * Diagnostic: before trusting each newly ready index, also pick its mesh with Babylon's brute-force
   * scan and compare the first answers. Off by default. Every index is validated against its mesh's
   * own geometry (here, and WASM-built ones in the worker too), which already gives Babylon's
   * hits; the comparison scans every triangle of each tile on the frame its index arrives.
   */
  compareFirstQueries?: boolean;
  /**
   * Loads the page-side WASM core, normally `loadGroundCore({ page: true })`. Each ready index of Float32 positions is
   * then imported into it, which checks it against the geometry, and its meshes are picked there. Float64 positions,
   * refused imports and rays or transforms the core does not take stay with TypeScript; a failed load or query retires
   * the core for good. Every one of them is in `fallbackReason`.
   */
  loadQueryCore?(): Promise<GroundPageCore>;
}
export interface GroundAcceleration {
  /** Uses Babylon for every unsupported/unready mesh and retains scene-order ties. */
  pick(scene: Scene, ray: Ray, predicate: (mesh: AbstractMesh) => boolean): PickingInfo | null;
  status(): GroundAccelerationStatus;
  dispose(): void;
}
interface Entry {
  mesh: Mesh; geometry: Geometry; generation: number; positions: Float32Array | number[]; indices: Uint32Array; sourceIndices: ReturnType<Mesh["getIndices"]>;
  snapshot: GroundBvhSnapshot | null; validated: boolean; failed: boolean; building: boolean; touched: number; observer: Observer<import("@babylonjs/core").Node> | null;
  /** World-to-mesh transform, kept while the mesh's world matrix is unchanged. */
  inverse: Matrix; inverseOf: Matrix | null; inverseFlag: number;
  /** The index imported into the page core, and the bounds last given to it. */
  wasm: GroundPageMesh | null; bounds: Float64Array | null;
}
interface Hook { previous: Geometry["onGeometryUpdated"]; wrapper: Geometry["onGeometryUpdated"]; entries: Set<Entry> }

/** Build off-page, publish immutable spatial indices, and query current transforms
 * synchronously. Geometry mutations invalidate before their new buffers are drawn;
 * until replacement is ready Babylon answers from the current geometry. */
export function createGroundAcceleration(options: GroundAccelerationOptions): GroundAcceleration {
  const entries = new Map<Mesh, Entry>(), hooks = new Map<Geometry, Hook>();
  const maxMeshes = options.maxMeshes ?? 64, maxBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024;
  const maxBuilds = Math.max(1, options.maxQueuedBuilds ?? 8), compareFirstQueries = options.compareFirstQueries ?? false;
  let disposed = false, building = 0, nextGeneration = 0, queries = 0;
  // Every mismatch or rejection found here stays reported; the worker's reason is its latest result's.
  let parity: GroundAccelerationStatus["parity"] = compareFirstQueries ? "pending" : "not-run", workerReason: string | null = null;
  const skipped = new Set<AbstractMesh>(), localRay = new Ray(Vector3.Zero(), Vector3.Up(), 1);
  const pageReasons = new Set<string>();
  const bytes = () => [...entries.values()].reduce((sum, entry) => sum + (entry.snapshot?.byteLength ?? 0), 0);
  let core: GroundPageCore | null = null, batch: GroundPageBatch | null = null, wasmQueries = 0;
  const transform = { worldToLocal: [] as ArrayLike<number>, localToWorld: [] as ArrayLike<number>, normalToWorld: [] as ArrayLike<number> };
  const nextBounds = new Float64Array(10);
  if (options.loadQueryCore) {
    const load = options.loadQueryCore;
    void new Promise<GroundPageCore>(resolve => resolve(load())).then(loaded => {
      if (disposed) { close(loaded, null); return; }
      try { batch = loaded.createWorldBatch(1); } catch (error) { close(loaded, null); pageReasons.add(`wasm-query-core-unavailable: ${message(error)}`); return; }
      core = loaded;
      for (const entry of entries.values()) if (entry.snapshot && !entry.failed) adopt(entry, entry.snapshot);
      options.onReady?.();
    }, error => { if (!disposed) pageReasons.add(`wasm-query-core-unavailable: ${message(error)}`); });
  }
  /** Imports a ready index into the page core, which accepts only what `validateGroundBvh` would with this geometry. */
  function adopt(entry: Entry, snapshot: GroundBvhSnapshot): boolean {
    if (!core || !(entry.positions instanceof Float32Array)) return false;
    release(entry);
    try { entry.wasm = core.importSnapshot(snapshot, entry.positions, entry.indices, { generation: entry.generation }); return true; }
    catch (error) { pageReasons.add(`wasm-import-refused: ${message(error)}`); return false; }
  }
  function release(entry: Entry): void {
    const wasm = entry.wasm;
    entry.wasm = null; entry.bounds = null;
    try { wasm?.dispose(); } catch (error) { pageReasons.add(`wasm-release-failed: ${message(error)}`); }
  }
  function close(owned: GroundPageCore | null, ownedBatch: GroundPageBatch | null): void {
    try { ownedBatch?.dispose(); owned?.dispose(); } catch (error) { pageReasons.add(`wasm-release-failed: ${message(error)}`); }
  }
  /** Back to TypeScript for every mesh. The imported indices were checked as `validateGroundBvh` checks them, so they stay. */
  function retire(reason: string | null): void {
    if (reason) pageReasons.add(reason);
    for (const entry of entries.values()) release(entry);
    const owned = core, ownedBatch = batch; core = null; batch = null;
    close(owned, ownedBatch);
  }
  function remove(entry: Entry): void {
    release(entry);
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
          current.generation = ++nextGeneration; current.snapshot = null; current.validated = false; current.failed = false; release(current);
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
      entry.snapshot = null; entry.validated = false; entry.failed = false; release(entry);
    }
    if (entry) entry.touched = options.now();
    // One build per mesh, and at most maxBuilds in all: a mesh past that is scheduled by a later query.
    if (entry?.snapshot || entry?.failed || entry?.building || building >= maxBuilds || disposed
      || options.preparer.status().state === "failed") return entry ?? null;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    // Queries read the positions Babylon picks against: Float32, or a plain array's
    // float64 numbers, such as stitched terrain seams. The worker builds from their
    // float32 rounding, and the page fits the boxes to the numbers themselves.
    if (!(positions instanceof Float32Array || Array.isArray(positions)) || !sourceIndices?.length || sourceIndices.length % 3
      || sourceIndices.length / 3 > 262_144 || positions.length / 3 > 1_048_576 || !mesh.geometry) return null;
    const indices = Uint32Array.from(sourceIndices);
    if (!entry) {
      if (entries.size >= maxMeshes) {
        const oldest = [...entries.values()].sort((a, b) => a.touched - b.touched)[0]; if (oldest) remove(oldest);
      }
      entry = { mesh, geometry: mesh.geometry, generation: ++nextGeneration, positions, indices, sourceIndices, snapshot: null, validated: false, failed: false,
        building: false, touched: options.now(), observer: null, inverse: new Matrix(), inverseOf: null, inverseFlag: -1, wasm: null, bounds: null };
      entries.set(mesh, entry); attach(entry);
    } else { entry.positions = positions; entry.indices = indices; entry.sourceIndices = sourceIndices; }
    const current = entry, generation = entry.generation;
    // Only these owned copies cross the worker boundary; live renderer buffers stay attached.
    current.building = true; building++;
    void options.preparer.prepare({ positions: new Float32Array(positions), indices: new Uint32Array(indices), generation }).then(result => {
      if (disposed || entries.get(mesh) !== current || current.generation !== generation || mesh.isDisposed() || mesh.geometry !== current.geometry
        || mesh.getIndices() !== sourceIndices) return;
      try {
        workerReason = result.fallbackReason;
        if (result.generation !== generation) throw new Error("Ground generation mismatch.");
        const faces = current.indices.length / 3;
        let snapshot = result.snapshot;
        if (!(current.positions instanceof Float32Array)) {
          // A sound tree first, then boxes that hold the float64 corners.
          validateGroundBvh(snapshot, faces);
          snapshot = refitGroundBvh(snapshot, current.positions, current.indices);
        }
        if (snapshot.byteLength > maxBytes) throw new Error("Ground snapshot exceeds cache budget.");
        if (!adopt(current, snapshot)) validateGroundBvh(snapshot, faces, { positions: current.positions, indices: current.indices });
        while (bytes() + snapshot.byteLength > maxBytes) {
          const oldest = [...entries.values()].filter(other => other !== current && other.snapshot).sort((a, b) => a.touched - b.touched)[0];
          if (!oldest) break; remove(oldest);
        }
        current.snapshot = snapshot;
      } catch (error) { release(current); current.failed = true; pageReasons.add(message(error)); }
    }, error => {
      // A full queue defers this mesh to a later query; any other rejection stays reported.
      if (error instanceof Error && error.message === GROUND_BUILD_QUEUE_FULL) return;
      if (!disposed && entries.get(mesh) === current && current.generation === generation) { current.failed = true; pageReasons.add(message(error)); }
    }).finally(() => { current.building = false; building--; if (!disposed) options.onReady?.(); });
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
    const mesh = entry.mesh, world = mesh.computeWorldMatrix();
    // The same inversion Babylon's pick makes, made again only when the world matrix changes.
    if (entry.inverseOf !== world || entry.inverseFlag !== world.updateFlag) { world.invertToRef(entry.inverse); entry.inverseOf = world; entry.inverseFlag = world.updateFlag; }
    const local = Ray.TransformToRef(ray, entry.inverse, localRay);
    const pick = new PickingInfo(); pick.ray = ray;
    const candidates = mesh.getScene().getIntersectingSubMeshCandidates(mesh, local);
    if (candidates.length !== 1 || candidates.data[0] !== mesh.subMeshes[0]) {
      const fallback = mesh.intersects(local, false, undefined, false, world); fallback.ray = ray; return fallback;
    }
    if (entry.wasm && batch) {
      const hit = intersectWasm(entry, entry.wasm, batch, ray, world);
      if (hit) return hit;
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
  /** The same pick, with its `getNormal(true, false)`, from the page core; null leaves this query to TypeScript. */
  function intersectWasm(entry: Entry, wasm: GroundPageMesh, wasmBatch: GroundPageBatch, ray: Ray, world: Matrix): PickingInfo | null {
    const mesh = entry.mesh, info = mesh.getBoundingInfo(), { minimum, maximum } = info.boundingBox, sphere = info.boundingSphere;
    nextBounds[0] = minimum.x; nextBounds[1] = minimum.y; nextBounds[2] = minimum.z; nextBounds[3] = maximum.x; nextBounds[4] = maximum.y; nextBounds[5] = maximum.z;
    nextBounds[6] = sphere.center.x; nextBounds[7] = sphere.center.y; nextBounds[8] = sphere.center.z; nextBounds[9] = sphere.radius;
    if (!acceptedRay(ray) || !nextBounds.every(Number.isFinite)) return null;
    try {
      if (!entry.bounds || nextBounds.some((value, index) => !Object.is(value, entry.bounds![index]))) {
        wasm.setBounds(nextBounds); entry.bounds = nextBounds.slice();
      }
      transform.worldToLocal = entry.inverse.m; transform.localToWorld = world.m;
      transform.normalToWorld = mesh.nonUniformScaling ? normalMatrix(world).m : world.m;
      const rays = wasmBatch.rays, { origin, direction } = ray;
      rays[0] = origin.x; rays[1] = origin.y; rays[2] = origin.z; rays[3] = direction.x; rays[4] = direction.y; rays[5] = direction.z; rays[6] = ray.length; rays[7] = ray.epsilon;
      wasmBatch.reset(1); wasmBatch.run(wasm, transform, 1);
      const row = wasmBatch.output, pick = new WasmPickingInfo(); pick.ray = ray; wasmQueries++;
      if (row[0] === 0) return pick;
      pick.hit = true; pick.distance = row[1]; pick.faceId = row[2]; pick.subMeshFaceId = row[2]; pick.bu = row[3]; pick.bv = row[4];
      pick.pickedPoint = new Vector3(row[5], row[6], row[7]); pick.pickedMesh = mesh; pick.subMeshId = mesh.subMeshes[0]._id;
      pick.answered(new Vector3(row[8], row[9], row[10]), world, direction);
      return pick;
    } catch (error) {
      // A transform the core does not take (status 7: not finite) is this query's; any other failure retires the core.
      if ((error as { status?: unknown }).status === 7) pageReasons.add(`wasm-transform-refused: ${message(error)}`);
      else retire(`wasm-query-failed: ${message(error)}`);
      return null;
    }
  }
  return {
    pick(scene, ray, predicate) {
      if (disposed || PickingCustomization.internalPickerForMesh) return scene.pickWithRay(ray, predicate, false);
      skipped.clear();
      let best: PickingInfo | null = null, bestIndex = Infinity, unanswered = false;
      for (let index = 0; index < scene.meshes.length; index++) {
        const mesh = scene.meshes[index];
        if (!predicate(mesh)) continue;
        const entry = supported(mesh) ? schedule(mesh) : null;
        if (!entry?.snapshot || entry.failed) { unanswered = true; continue; }
        let pick = intersect(entry, ray);
        if (compareFirstQueries && !entry.validated) {
          const reference = scene.pickWithRay(ray, candidate => candidate === mesh, false);
          if (!samePick(pick, reference)) {
            release(entry); entry.failed = true; entry.snapshot = null; parity = "different"; pageReasons.add("first-query-parity-mismatch"); unanswered = true; continue;
          }
          entry.validated = true; if (parity === "pending") parity = "same"; pick = reference ?? pick;
        }
        skipped.add(mesh); queries++;
        if (pick.hit && (!best || pick.distance < best.distance)) { best = pick; bestIndex = index; }
      }
      // Babylon answers the meshes no index did; when every one was, it would only run the predicate again.
      if (!unanswered) return best;
      const fallback = scene.pickWithRay(ray, mesh => !skipped.has(mesh) && predicate(mesh), false);
      if (fallback?.hit && (!best || fallback.distance < best.distance || (fallback.distance === best.distance && scene.meshes.indexOf(fallback.pickedMesh!) < bestIndex))) best = fallback;
      return best;
    },
    status: () => ({ queryKernel: core ? "single" : "typescript", requestedQueryKernel: options.loadQueryCore ? "single" : "typescript",
      wasmMeshes: [...entries.values()].filter(entry => entry.wasm && entry.snapshot && !entry.failed).length, wasmQueries,
      readyMeshes: [...entries.values()].filter(entry => entry.snapshot && !entry.failed).length,
      pending: building > 0, queuedBuilds: building, snapshotBytes: bytes(), acceleratedQueries: queries, parity, fallbackReason: [...pageReasons, workerReason].filter(Boolean).join("; ") || null,
      preparer: options.preparer.status() }),
    dispose() {
      if (disposed) return; disposed = true;
      for (const entry of [...entries.values()]) remove(entry);
      retire(null);
      options.preparer.dispose();
    },
  };
}

/** The page core's hit. Its face normal is `getNormal(true, false)` while the world matrix and the ray's direction are those it was picked with. */
class WasmPickingInfo extends PickingInfo {
  private worldNormal: Vector3 | null = null;
  private world: Matrix | null = null;
  private worldFlag = -1;
  private direction = Vector3.Zero();
  answered(normal: Vector3, world: Matrix, direction: Vector3): void {
    this.worldNormal = normal; this.world = world; this.worldFlag = world.updateFlag; this.direction.copyFrom(direction);
  }
  override getNormal(useWorldCoordinates = false, useVerticesNormals = true): Vector3 | null {
    const direction = this.ray?.direction;
    if (this.worldNormal && useWorldCoordinates && !useVerticesNormals && this.pickedMesh?.getWorldMatrix() === this.world && this.world.updateFlag === this.worldFlag
      && direction && Object.is(direction.x, this.direction.x) && Object.is(direction.y, this.direction.y) && Object.is(direction.z, this.direction.z)) return this.worldNormal.clone();
    return super.getNormal(useWorldCoordinates, useVerticesNormals);
  }
}

/** The rays the page core takes: finite, with a direction, a positive length and a non-negative epsilon. Babylon's defaults are. */
function acceptedRay(ray: Ray): boolean {
  const { origin, direction, length, epsilon } = ray;
  return Number.isFinite(origin.x) && Number.isFinite(origin.y) && Number.isFinite(origin.z) && Number.isFinite(direction.x) && Number.isFinite(direction.y)
    && Number.isFinite(direction.z) && (direction.x !== 0 || direction.y !== 0 || direction.z !== 0) && Number.isFinite(length) && length > 0
    && Number.isFinite(epsilon) && epsilon >= 0;
}

/** The translation-free inverse transpose `getNormal` uses for non-uniform scaling, made in its scratch matrices so it has their precision. */
function normalMatrix(world: Matrix): Matrix {
  const matrix = TmpVectors.Matrix[0].copyFrom(world);
  matrix.setTranslationFromFloats(0, 0, 0); matrix.invert(); matrix.transposeToRef(TmpVectors.Matrix[1]);
  return TmpVectors.Matrix[1];
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function samePick(a: PickingInfo, b: PickingInfo | null): boolean {
  if (!a.hit) return !b?.hit;
  return Boolean(b?.hit && a.faceId === b.faceId && Object.is(a.distance, b.distance) && a.pickedPoint && b.pickedPoint
    && Object.is(a.pickedPoint.x, b.pickedPoint.x) && Object.is(a.pickedPoint.y, b.pickedPoint.y) && Object.is(a.pickedPoint.z, b.pickedPoint.z));
}
