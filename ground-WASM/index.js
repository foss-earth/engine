const MAX_MEMORY = 256 * 1024 * 1024;
const MAX_LIVE = 128 * 1024 * 1024;
const MAX_RAYS = 65_536;
const MAX_TRIANGLES = 262_144;
const TYPES = { 1: Float32Array, 2: Uint32Array, 3: Float64Array };
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** World ray `[origin xyz, direction xyz, length, epsilon]` and hit row `[mesh, distance, face, bu, bv, point xyz, normal xyz]`. */
export const WORLD = Object.freeze({ rayStride: 8, rowStride: 11, maxRays: MAX_RAYS });
const functions = ["ground_abi_version", "ground_last_error", "ground_alloc", "ground_free", "ground_build", "ground_import_snapshot", "ground_release",
  "ground_set_bounds", "ground_query", "ground_query_world_batch", "ground_snapshot_len", "ground_snapshot"];

/** The page main thread only with `{ page: true }`; a worker always. */
function workerOnly(page) {
  if (page !== true && typeof document !== "undefined") throw new Error("WASM ground kernels run in a worker unless the page opts in with { page: true }");
}

/** No binary fetch or WASM work happens on import. No hidden JS fallback. */
export async function loadGroundCore({ wasmUrl = new URL("./single/ground.wasm", import.meta.url), fetch: fetchBytes = globalThis.fetch, page = false } = {}) {
  workerOnly(page);
  const response = await fetchBytes(wasmUrl);
  if (!response.ok) throw new Error(`Ground WASM request failed (${response.status})`);
  return instantiateGroundCore(await response.arrayBuffer(), { page });
}

export async function instantiateGroundCore(bytes, { page = false } = {}) {
  workerOnly(page);
  const result = await WebAssembly.instantiate(bytes, {});
  return createGroundCore((result.instance ?? result).exports, { page });
}

/** Raw ABI adapter. Inputs/outputs belong to JS; BVHs live until dispose(). */
export function createGroundCore(exports, { page = false } = {}) {
  workerOnly(page);
  for (const name of functions) if (typeof exports?.[name] !== "function") throw new Error(`Invalid ground ABI: ${name}`);
  if (!(exports.memory instanceof WebAssembly.Memory) || exports.ground_abi_version() !== 1) throw new Error("Unsupported ground ABI");
  let closed = false;
  // Live meshes and their handles, and live world batches.
  const meshes = new Map(), batches = new Set();
  function buffer() {
    const value = exports.memory.buffer;
    if (!(value instanceof ArrayBuffer) || value.byteLength === 0 || value.byteLength > MAX_MEMORY) throw new Error("Invalid WASM ground memory");
    return value;
  }
  function active() { if (closed) throw new Error("WASM ground core is disposed"); }
  function span(pointer, length, kind) {
    const bytes = TYPES[kind].BYTES_PER_ELEMENT * length;
    if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer > 0xffff_ffff || pointer % TYPES[kind].BYTES_PER_ELEMENT !== 0
      || pointer > buffer().byteLength || bytes > buffer().byteLength - pointer) throw new Error("Invalid WASM ground allocation");
    return bytes;
  }
  function failure(operation, status = exports.ground_last_error()) { return Object.assign(new Error(`WASM ground ${operation} failed (${status})`), { status }); }
  function allocate(kind, length, owned) {
    if (!Number.isSafeInteger(length) || length < 1 || length * TYPES[kind].BYTES_PER_ELEMENT > MAX_LIVE) throw new Error("Ground buffer exceeds its bounds");
    const pointer = exports.ground_alloc(kind, length);
    if (!pointer) throw failure("allocation");
    // Register before validation so a valid allocation is released even if the
    // module later violates its advertised memory layout.
    const allocation = { pointer, kind, length };
    owned.push(allocation);
    const bytes = span(pointer, length, kind);
    for (const other of owned) if (other !== allocation && pointer < other.pointer + other.length * TYPES[other.kind].BYTES_PER_ELEMENT
      && other.pointer < pointer + bytes) throw new Error("Overlapping WASM ground allocations");
    return pointer;
  }
  function write(pointer, source, kind) {
    span(pointer, source.length, kind);
    if (LITTLE_ENDIAN) { new TYPES[kind](buffer(), pointer, source.length).set(source); return; }
    const view = new DataView(buffer(), pointer);
    const method = kind === 1 ? "setFloat32" : kind === 2 ? "setUint32" : "setFloat64";
    for (let i = 0; i < source.length; i++) view[method](i * TYPES[kind].BYTES_PER_ELEMENT, source[i], true);
  }
  function read(pointer, length) {
    span(pointer, length, 3);
    if (LITTLE_ENDIAN) return new Float64Array(new Float64Array(buffer(), pointer, length));
    const out = new Float64Array(length), view = new DataView(buffer(), pointer, length * 8);
    for (let i = 0; i < length; i++) out[i] = view.getFloat64(i * 8, true);
    return out;
  }
  function release(owned, failed, cause) {
    const cleanup = [];
    for (const { pointer, kind, length } of owned.splice(0).reverse()) {
      try { const status = exports.ground_free(pointer, kind, length); if (status !== 0) throw new Error(`Ground buffer release failed (${status})`); }
      catch (error) { cleanup.push(error); }
    }
    if (cleanup.length) throw new AggregateError(failed ? [cause, ...cleanup] : cleanup, "WASM ground cleanup failed");
  }
  function withAllocations(run) {
    const owned = []; let failed = false, cause;
    try { return run(owned); } catch (error) { failed = true; cause = error; throw error; }
    finally { release(owned, failed, cause); }
  }
  function geometry(positions, indices, generation) {
    if (!(positions instanceof Float32Array) || !positions.length || positions.length % 3 || positions.length / 3 > 1_048_576
      || !(indices instanceof Uint32Array) || !indices.length || indices.length % 3 || indices.length / 3 > MAX_TRIANGLES
      || !Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid ground geometry or generation");
  }
  /** Copies the inputs in, runs `make` and publishes its handle as a mesh. */
  function construct(operation, inputs, make, generation) {
    let handle = 0;
    try {
      withAllocations(owned => {
        const pointers = inputs.map(([kind, values]) => { const pointer = allocate(kind, values.length, owned); write(pointer, values, kind); return pointer; });
        handle = make(...pointers);
        if (!Number.isSafeInteger(handle) || handle < 1 || handle > 0xffff_ffff) throw failure(operation);
      });
    } catch (error) { if (handle > 0) exports.ground_release(handle); throw error; }
    return adopt(handle, generation);
  }
  function rays(values) {
    if (!(values instanceof Float64Array) || !values.length || values.length % 8 || values.length / 8 > MAX_RAYS) throw new Error("Invalid ground ray batch");
  }
  /** `[world to mesh, mesh to world, normal to world]`, 16 values each; the normal matrix defaults to mesh to world. */
  function matrices({ worldToLocal, localToWorld, normalToWorld = localToWorld } = {}, values) {
    [worldToLocal, localToWorld, normalToWorld].forEach((matrix, k) => {
      if (matrix?.length !== 16) throw new Error("Invalid ground matrix");
      for (let i = 0; i < 16; i++) values[k * 16 + i] = matrix[i];
    });
  }
  function clear(rows, count) {
    for (let at = 0, end = count * WORLD.rowStride; at < end; at += WORLD.rowStride) {
      rows.fill(0, at, at + WORLD.rowStride); rows[at + 1] = -1; rows[at + 2] = -1;
    }
  }
  function adopt(handle, generation) {
    let disposed = false;
    const live = () => { active(); if (disposed) throw new Error("Ground BVH is disposed"); };
    const mesh = {
      generation,
      handle,
      snapshot() {
        live();
        return withAllocations(owned => {
          const length = exports.ground_snapshot_len(handle);
          const output = allocate(3, length, owned);
          const status = exports.ground_snapshot(handle, output, length);
          if (status !== 0) throw failure("snapshot", status);
          return read(output, length);
        });
      },
      query(values) {
        live(); rays(values);
        return withAllocations(owned => {
          const input = allocate(3, values.length, owned), output = allocate(3, values.length, owned);
          write(input, values, 3);
          const status = exports.ground_query(handle, input, values.length, output, values.length);
          if (status !== 0) throw failure("query", status);
          return read(output, values.length);
        });
      },
      setBounds(bounds) {
        live();
        if (bounds?.length !== 10) throw new Error("Invalid ground bounds");
        withAllocations(owned => {
          const pointer = allocate(3, 10, owned);
          write(pointer, bounds, 3);
          const status = exports.ground_set_bounds(handle, pointer, 10);
          if (status !== 0) throw failure("bounds", status);
        });
      },
      queryWorld(values, transform, previous) {
        live(); rays(values);
        const count = values.length / 8, length = count * WORLD.rowStride;
        if (previous !== undefined && (!(previous instanceof Float64Array) || previous.length !== length)) throw new Error("Invalid ground hit rows");
        const m = new Float64Array(48);
        matrices(transform, m);
        let rows = previous;
        if (!rows) { rows = new Float64Array(length); clear(rows, count); }
        return withAllocations(owned => {
          const mp = allocate(3, 48, owned), rp = allocate(3, values.length, owned), op = allocate(3, length, owned);
          write(mp, m, 3); write(rp, values, 3); write(op, rows, 3);
          const status = exports.ground_query_world_batch(handle, mp, 48, rp, values.length, op, length, count);
          if (status !== 0) throw failure("world query", status);
          return read(op, length);
        });
      },
      dispose() {
        if (disposed) return;
        const status = exports.ground_release(handle);
        if (status !== 0) throw failure("BVH release", status);
        disposed = true; meshes.delete(mesh);
      },
    };
    meshes.set(mesh, handle); return mesh;
  }
  buffer();
  return {
    backend: "single",
    actualTier: "single",
    validationStatus: "unvalidated",
    page: page === true,
    buildBvh(positions, indices, { generation = 0 } = {}) {
      active(); geometry(positions, indices, generation);
      return construct("BVH construction", [[1, positions], [2, indices]],
        (p, i) => exports.ground_build(p, positions.length, i, indices.length), generation);
    },
    importSnapshot(snapshot, positions, indices, { generation = 0 } = {}) {
      active(); geometry(positions, indices, generation);
      if (!(snapshot instanceof Float64Array) || snapshot.length < 2 || snapshot.length > 2 + 21 * MAX_TRIANGLES) throw new Error("Invalid ground BVH snapshot");
      return construct("snapshot import", [[3, snapshot], [1, positions], [2, indices]],
        (s, p, i) => exports.ground_import_snapshot(s, snapshot.length, p, positions.length, i, indices.length), generation);
    },
    createWorldBatch(capacity) {
      active();
      if (!LITTLE_ENDIAN) throw new Error("WASM ground world batches need a little-endian host");
      if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_RAYS) throw new Error("Invalid ground world batch capacity");
      const owned = [], rayLength = capacity * WORLD.rayStride, rowLength = capacity * WORLD.rowStride;
      let matrixPointer, rayPointer, rowPointer;
      try {
        matrixPointer = allocate(3, 48, owned); rayPointer = allocate(3, rayLength, owned); rowPointer = allocate(3, rowLength, owned);
      } catch (error) { release(owned, true, error); throw error; }
      // Views over WASM memory, replaced only when it grows.
      let memory = null, views = null, disposed = false;
      function view() {
        const current = buffer();
        if (current !== memory) {
          span(matrixPointer, 48, 3); span(rayPointer, rayLength, 3); span(rowPointer, rowLength, 3);
          views = { matrices: new Float64Array(current, matrixPointer, 48), rays: new Float64Array(current, rayPointer, rayLength), rows: new Float64Array(current, rowPointer, rowLength) };
          memory = current;
        }
        return views;
      }
      const live = () => { active(); if (disposed) throw new Error("Ground world batch is disposed"); };
      const counted = count => { if (!Number.isSafeInteger(count) || count < 1 || count > capacity) throw new Error("Invalid ground world batch count"); };
      const batch = {
        capacity,
        get rays() { live(); return view().rays; },
        get output() { live(); return view().rows; },
        reset(count = capacity) { live(); counted(count); clear(view().rows, count); },
        run(mesh, transform, count = capacity) {
          live(); counted(count);
          const handle = meshes.get(mesh);
          if (handle === undefined) throw new Error("Ground BVH is disposed or belongs to another core");
          matrices(transform, view().matrices);
          const status = exports.ground_query_world_batch(handle, matrixPointer, 48, rayPointer, rayLength, rowPointer, rowLength, count);
          if (status !== 0) throw failure("world query", status);
        },
        dispose() { if (disposed) return; disposed = true; batches.delete(batch); release(owned, false); },
      };
      batches.add(batch); return batch;
    },
    dispose() {
      if (closed) return;
      for (const batch of [...batches]) batch.dispose();
      for (const mesh of [...meshes.keys()]) mesh.dispose();
      closed = true;
    },
  };
}
