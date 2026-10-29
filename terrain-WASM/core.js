import { createTerrainHeightSampler } from "./heightSampler.js";

const MAX_SEGMENTS = 512, MAX_GRID_SIDE = 4096, MAX_GRIDS = 33;
const MAX_LIVE_BYTES = 128 * 1024 ** 2, MAX_MEMORY_BYTES = 256 * 1024 ** 2;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
const REQUIRED = ["terrain_abi_version", "terrain_last_error", "terrain_alloc", "terrain_free", "terrain_build",
  "terrain_result_ptr", "terrain_result_len", "terrain_release_result"];

/** Node worker hosts may explicitly attest workerRealm; a DOM page is always refused. */
export function assertTerrainWorker({ workerRealm = false } = {}) {
  if (typeof globalThis.document !== "undefined" || globalThis.window === globalThis) throw new Error("WASM terrain computation belongs in an owning worker, not the page");
  const browserWorker = typeof globalThis.WorkerGlobalScope !== "undefined" && globalThis instanceof globalThis.WorkerGlobalScope;
  if (!browserWorker && workerRealm !== true) throw new Error("WASM terrain requires an explicit worker realm");
}

const statusError = code => new Error(({
  1: "WASM terrain descriptor, tile, or segment dimensions are invalid",
  2: "WASM terrain allocation ownership or length is invalid",
  3: "WASM terrain allocation or live payload budget is exhausted",
  4: "WASM terrain grid layout is invalid",
  5: "WASM terrain result handle or slot is invalid",
  6: "WASM terrain instance is already computing; reentry is refused",
  7: "WASM terrain needs executing-realm JavaScript Math imports",
})[code] ?? `WASM terrain returned an unknown status (${String(code)})`);

function tile(value, label) {
  if (!value || !Number.isInteger(value.z) || value.z < 0 || value.z > 30
      || !Number.isInteger(value.x) || !Number.isInteger(value.y) || value.x < 0 || value.y < 0
      || value.x >= 2 ** value.z || value.y >= 2 ** value.z) throw new RangeError(`Invalid ${label} tile`);
  return { z: value.z, x: value.x, y: value.y };
}

function requestData(request) {
  const target = tile(request?.tile, "terrain");
  if (request.segments != null && typeof request.segments !== "number") throw new TypeError("Terrain segments must be numeric");
  const segments = Math.max(1, Math.round(request.segments ?? 64));
  if (!Number.isInteger(segments) || segments < 1 || segments > MAX_SEGMENTS) throw new RangeError("WASM terrain segments must round to 1–512");
  if (request.withUvs !== undefined && typeof request.withUvs !== "boolean") throw new TypeError("withUvs must be boolean");
  const withUvs = request.withUvs ?? true;
  const grid = request.grid;
  if (grid != null && (typeof grid !== "object" || Array.isArray(grid))) throw new TypeError("Terrain grid must be a numeric grid object");
  if (!grid && request.getSurfaceHeightMeters != null) throw new Error("Callback-based terrain heights remain on the TypeScript path; pass a prepared numeric grid");
  const neighborsPresent = !!grid?.neighbors;
  if (neighborsPresent && !Array.isArray(grid.neighbors)) throw new TypeError("Terrain neighbors must be an ordered array");
  const sources = grid ? [grid, ...(grid.neighbors ?? [])] : [];
  if (sources.length > MAX_GRIDS) throw new RangeError("WASM terrain supports at most 32 direct neighbors");
  let inputBytes = (7 + sources.length * 6) * 8;
  const grids = sources.map((source, index) => {
    const coordinate = tile(source, `grid${index}`), size = source.size, heights = source.heights;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_GRID_SIDE
        || Object.prototype.toString.call(heights) !== "[object Float32Array]" || heights.length !== size * size) throw new RangeError("Terrain grids need complete Float32 heights with side 1–4096");
    // Heights may be shared: decode workers publish a grid once and never
    // write it again, so the snapshot below reads settled bytes.
    inputBytes += heights.byteLength;
    if (inputBytes > MAX_LIVE_BYTES) throw new RangeError("WASM terrain grid input budget exceeds 128 MiB");
    // Snapshot before any WASM allocation can grow/detach a caller's view.
    const bytes = new Uint8Array(heights.byteLength);
    bytes.set(new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength));
    return { ...coordinate, size, elements: heights.length, bytes };
  });
  const vertices = (segments + 1) ** 2, positionElements = vertices * 3, uvElements = withUvs ? vertices * 2 : 0;
  const indexElements = segments * segments * 6;
  const outputBytes = positionElements * 12 + uvElements * 8 + indexElements * 4 + 56;
  if (inputBytes + outputBytes > MAX_LIVE_BYTES) throw new RangeError("WASM terrain input/output payload exceeds 128 MiB");
  return { target, segments, rawSegments: request.segments ?? 64, grids, neighborsPresent, withUvs, positionElements, uvElements, indexElements };
}

function copyTyped(buffer, pointer, length, Constructor) {
  const bytesPerElement = Constructor.BYTES_PER_ELEMENT, output = new Constructor(length);
  const source = new Uint8Array(buffer, pointer, length * bytesPerElement), destination = new Uint8Array(output.buffer);
  if (LITTLE_ENDIAN) destination.set(source);
  else for (let offset = 0; offset < source.length; offset += bytesPerElement) {
    for (let byte = 0; byte < bytesPerElement; byte++) destination[offset + byte] = source[offset + bytesPerElement - 1 - byte];
  }
  return output;
}

function writeFloat32(buffer, pointer, bytes) {
  const destination = new Uint8Array(buffer, pointer, bytes.length);
  if (LITTLE_ENDIAN) destination.set(bytes);
  else for (let offset = 0; offset < bytes.length; offset += 4) {
    for (let byte = 0; byte < 4; byte++) destination[offset + byte] = bytes[offset + 3 - byte];
  }
}

/** Numeric mesh output is copied before release. This package never selects a fallback. */
export function createTerrainCore(exports, options = {}) {
  assertTerrainWorker(options);
  for (const name of REQUIRED) if (typeof exports?.[name] !== "function") throw new Error(`WASM terrain ABI is missing ${name}`);
  if (!(exports.memory instanceof WebAssembly.Memory) || exports.terrain_abi_version() !== 1) throw new Error("Unsupported WASM terrain ABI");
  let wasm = exports, memory = exports.memory, busy = false, disposed = false;
  const samplers = new Set();
  const buffer = () => {
    const value = memory?.buffer;
    if (!(value instanceof ArrayBuffer) || value.byteLength === 0 || value.byteLength > MAX_MEMORY_BYTES) throw new Error("WASM terrain memory must be unshared and bounded to 256 MiB");
    return value;
  };
  const pointer = value => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) throw statusError(wasm.terrain_last_error());
    return value;
  };
  const span = (value, length, bytes, existing) => {
    const current = buffer(), byteLength = length * bytes;
    if (!Number.isSafeInteger(length) || length < 0 || value % bytes || value > current.byteLength || byteLength > current.byteLength - value) throw new Error("WASM terrain span is misaligned or out of memory bounds");
    if (byteLength && existing.some(other => value < other.pointer + other.bytes && other.pointer < value + byteLength)) throw new Error("WASM terrain allocations or results overlap");
    return { pointer: value, bytes: byteLength };
  };
  buffer();
  return {
    actualTier: "single",
    validationStatus: "unvalidated",
    createHeightSampler(grid) {
      const active = () => { if (disposed) throw new Error("WASM terrain core has been disposed"); if (busy) throw statusError(6); };
      let sampler;
      sampler = createTerrainHeightSampler(wasm, grid, active, () => samplers.delete(sampler));
      samplers.add(sampler);
      return sampler;
    },
    buildSurface(request) {
      if (disposed) throw new Error("WASM terrain core has been disposed");
      if (busy) throw statusError(6);
      busy = true;
      let inputs = [], resultHandle = 0, failed = false, failure;
      try {
        const data = requestData(request), spans = [];
        const allocate = (kind, elements, bytes) => {
          const value = pointer(wasm.terrain_alloc(kind, elements));
          inputs.push({ kind, pointer: value, elements });
          spans.push(span(value, elements, bytes, spans)); return value;
        };
        const heightPointers = data.grids.map(grid => allocate(1, grid.elements, 4));
        const descriptorElements = 7 + data.grids.length * 6;
        const descriptor = allocate(0, descriptorElements, 8);
        const current = buffer();
        for (let i = 0; i < data.grids.length; i++) writeFloat32(current, heightPointers[i], data.grids[i].bytes);
        const words = [1, data.target.z, data.target.x, data.target.y, data.rawSegments, data.grids.length, Number(data.neighborsPresent)];
        data.grids.forEach((grid, index) => words.push(grid.z, grid.x, grid.y, grid.size, heightPointers[index], grid.elements));
        const descriptorView = new DataView(current, descriptor, descriptorElements * 8);
        words.forEach((value, index) => descriptorView.setFloat64(index * 8, value, true));
        resultHandle = wasm.terrain_build(descriptor, descriptorElements, Number(data.withUvs));
        if (!Number.isSafeInteger(resultHandle) || resultHandle <= 0 || resultHandle > 0xffff_ffff) throw statusError(wasm.terrain_last_error());
        const read = (slot, elements, Constructor) => {
          const length = wasm.terrain_result_len(resultHandle, slot);
          const lengthStatus = wasm.terrain_last_error();
          if (lengthStatus !== 0) throw statusError(lengthStatus);
          if (length !== elements) throw new Error("WASM terrain output length differs from the requested mesh");
          const value = wasm.terrain_result_ptr(resultHandle, slot);
          const pointerStatus = wasm.terrain_last_error();
          if (pointerStatus !== 0) throw statusError(pointerStatus);
          if (elements === 0) { if (value !== 0) throw new Error("WASM terrain empty result has a pointer"); return null; }
          pointer(value); spans.push(span(value, length, Constructor.BYTES_PER_ELEMENT, spans));
          return copyTyped(buffer(), value, length, Constructor);
        };
        const positions = read(0, data.positionElements, Float64Array);
        const targetPositions = read(1, data.positionElements, Float32Array);
        const uvs = read(2, data.uvElements, Float64Array);
        const indices = read(3, data.indexElements, Uint32Array);
        const metadata = read(4, 7, Float64Array);
        if (metadata[5] !== data.segments || metadata[6] !== (data.grids[0]?.z ?? -1) || !metadata.subarray(0, 3).every(Number.isFinite)) throw new Error("WASM terrain result metadata differs from the requested mesh");
        return { positions, targetPositions, uvs, indices, center: { x: metadata[0], y: metadata[1], z: metadata[2] },
          segments: data.segments, heightBounds: { min: metadata[3], max: metadata[4] }, terrainZoom: metadata[6],
          actualTier: "single", validationStatus: "unvalidated" };
      } catch (error) { failed = true; failure = error; throw error; }
      finally {
        const cleanup = [];
        if (resultHandle) try {
          const status = wasm.terrain_release_result(resultHandle); if (status !== 0) throw statusError(status);
        } catch (error) { cleanup.push(error); }
        for (const input of inputs.reverse()) try {
          const status = wasm.terrain_free(input.kind, input.pointer, input.elements); if (status !== 0) throw statusError(status);
        } catch (error) { cleanup.push(error); }
        busy = false;
        if (cleanup.length) {
          disposed = true; wasm = null; memory = null;
          throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, "WASM terrain operation/cleanup failed; dispose its owning worker", { cause: failure });
        }
      }
    },
    dispose() {
      if (busy) throw statusError(6);
      for (const sampler of [...samplers]) sampler.dispose();
      disposed = true; wasm = null; memory = null;
    },
  };
}
