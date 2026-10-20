const MAX_MEMORY = 256 * 1024 * 1024;
const MAX_LIVE = 128 * 1024 * 1024;
const MAX_RAYS = 65_536;
const TYPES = { 1: Float32Array, 2: Uint32Array, 3: Float64Array };
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const functions = ["ground_abi_version", "ground_last_error", "ground_alloc", "ground_free", "ground_build", "ground_release", "ground_query", "ground_snapshot_len", "ground_snapshot"];

function workerOnly() {
  if (typeof document !== "undefined") throw new Error("Native ground kernels must run in a worker, not on the page");
}

/** No binary fetch or native work happens on import. No hidden JS fallback. */
export async function loadGroundCore({ wasmUrl = new URL("./single/ground.wasm", import.meta.url), fetch: fetchBytes = globalThis.fetch } = {}) {
  workerOnly();
  const response = await fetchBytes(wasmUrl);
  if (!response.ok) throw new Error(`Native ground WASM request failed (${response.status})`);
  return instantiateGroundCore(await response.arrayBuffer());
}

export async function instantiateGroundCore(bytes) {
  workerOnly();
  const result = await WebAssembly.instantiate(bytes, {});
  return createGroundCore((result.instance ?? result).exports);
}

/** Raw ABI adapter. Inputs/outputs belong to JS; BVHs live until dispose(). */
export function createGroundCore(exports) {
  workerOnly();
  for (const name of functions) if (typeof exports?.[name] !== "function") throw new Error(`Invalid ground ABI: ${name}`);
  if (!(exports.memory instanceof WebAssembly.Memory) || exports.ground_abi_version() !== 1) throw new Error("Unsupported ground ABI");
  let closed = false;
  const meshes = new Set();
  function buffer() {
    const value = exports.memory.buffer;
    if (!(value instanceof ArrayBuffer) || value.byteLength === 0 || value.byteLength > MAX_MEMORY) throw new Error("Invalid native ground memory");
    return value;
  }
  function active() { if (closed) throw new Error("Native ground core is disposed"); }
  function span(pointer, length, kind) {
    const bytes = TYPES[kind].BYTES_PER_ELEMENT * length;
    if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer > 0xffff_ffff || pointer % TYPES[kind].BYTES_PER_ELEMENT !== 0
      || pointer > buffer().byteLength || bytes > buffer().byteLength - pointer) throw new Error("Invalid native ground allocation");
    return bytes;
  }
  function failure(operation, status = exports.ground_last_error()) { return new Error(`Native ground ${operation} failed (${status})`); }
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
      && other.pointer < pointer + bytes) throw new Error("Overlapping native ground allocations");
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
  function withAllocations(run) {
    const owned = []; let failed = false, failure;
    try { return run(owned); } catch (error) { failed = true; failure = error; throw error; }
    finally {
      const cleanup = [];
      for (const { pointer, kind, length } of owned.reverse()) {
        try { const status = exports.ground_free(pointer, kind, length); if (status !== 0) throw new Error(`Ground buffer release failed (${status})`); }
        catch (error) { cleanup.push(error); }
      }
      if (cleanup.length) throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, "Native ground cleanup failed");
    }
  }
  buffer();
  return {
    backend: "single",
    actualTier: "single",
    validationStatus: "unvalidated",
    buildBvh(positions, indices, { generation = 0 } = {}) {
      active();
      if (!(positions instanceof Float32Array) || !positions.length || positions.length % 3 || positions.length / 3 > 1_048_576
        || !(indices instanceof Uint32Array) || !indices.length || indices.length % 3 || indices.length / 3 > 262_144
        || !Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid ground geometry or generation");
      let handle = 0;
      try {
        withAllocations(owned => {
          const p = allocate(1, positions.length, owned), i = allocate(2, indices.length, owned);
          write(p, positions, 1); write(i, indices, 2);
          handle = exports.ground_build(p, positions.length, i, indices.length);
          if (!Number.isSafeInteger(handle) || handle < 1 || handle > 0xffff_ffff) throw failure("BVH construction");
        });
      } catch (error) { if (handle > 0) exports.ground_release(handle); throw error; }
      let disposed = false;
      const mesh = {
        generation,
        snapshot() {
          active(); if (disposed) throw new Error("Ground BVH is disposed");
          return withAllocations(owned => {
            const length = exports.ground_snapshot_len(handle);
            const output = allocate(3, length, owned);
            const status = exports.ground_snapshot(handle, output, length);
            if (status !== 0) throw failure("snapshot", status);
            return read(output, length);
          });
        },
        query(rays) {
          active(); if (disposed) throw new Error("Ground BVH is disposed");
          if (!(rays instanceof Float64Array) || !rays.length || rays.length % 8 || rays.length / 8 > MAX_RAYS) throw new Error("Invalid ground ray batch");
          return withAllocations(owned => {
            const input = allocate(3, rays.length, owned), output = allocate(3, rays.length, owned);
            write(input, rays, 3);
            const status = exports.ground_query(handle, input, rays.length, output, rays.length);
            if (status !== 0) throw failure("query", status);
            return read(output, rays.length);
          });
        },
        dispose() {
          if (disposed) return;
          const status = exports.ground_release(handle);
          if (status !== 0) throw failure("BVH release", status);
          disposed = true; meshes.delete(mesh);
        },
      };
      meshes.add(mesh); return mesh;
    },
    dispose() { if (closed) return; for (const mesh of [...meshes]) mesh.dispose(); closed = true; },
  };
}
