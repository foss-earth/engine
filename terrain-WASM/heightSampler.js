const MAX_BYTES = 128 * 1024 ** 2;
const MAX_MEMORY = 256 * 1024 ** 2;
// WebAssembly memory is little-endian. On a little-endian host, typed arrays over it copy whole arrays at once.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
const BATCH_ERROR = "Height batches need 1–65536 finite x/y pairs";

/** `values.every(Number.isFinite)`, without a call for each value. */
function allFinite(values) {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
}

/** Retain one immutable grid plus ordered direct neighbours, never the page's
 * arrays. Repeated coordinate batches cross the ABI once, not once per point.
 * Heights may be shared; published grids are never written again. */
export function createTerrainHeightSampler(wasm, grid, assertActive, onDispose) {
  assertActive();
  if (typeof wasm.terrain_sample_batch !== "function") throw new Error("WASM terrain height-batch ABI is unavailable");
  const sources = [grid, ...(grid?.neighbors ?? [])];
  if (!grid || sources.length > 69) throw new RangeError("Height batches need a grid and at most 68 direct neighbours");
  const sparse = grid.indices !== undefined;
  let elements = 0;
  for (const source of sources) {
    if (!Number.isInteger(source.z) || source.z < 0 || source.z > 30 || !Number.isInteger(source.x) || !Number.isInteger(source.y)
      || source.x < 0 || source.y < 0 || source.x >= 2 ** source.z || source.y >= 2 ** source.z
      || !Number.isInteger(source.size) || source.size < 1 || source.size > 4096
      || !(source.heights instanceof Float32Array)
      || (sparse ? !(source.indices instanceof Uint32Array) || source.indices.length !== source.heights.length
        || source.indices.some((value, index) => value >= source.size ** 2 || (index > 0 && value <= source.indices[index - 1]))
        : source.indices !== undefined || source.heights.length !== source.size ** 2)) throw new RangeError("Invalid height-batch grid");
    elements += source.heights.length * (sparse ? 2 : 1);
  }
  const descriptorLength = 3 + sources.length * 6;
  const bytes = elements * 4 + descriptorLength * 8;
  if (bytes > 64 * 1024 ** 2) throw new RangeError("Height-batch snapshot exceeds 64 MiB");
  const owned = [];
  let closed = false;
  function buffer() {
    const value = wasm.memory.buffer;
    if (!(value instanceof ArrayBuffer) || !value.byteLength || value.byteLength > MAX_MEMORY) throw new Error("Invalid terrain memory");
    return value;
  }
  function allocate(kind, length, list) {
    const width = kind === 0 ? 8 : 4;
    if (!Number.isSafeInteger(length) || length <= 0 || length * width > MAX_BYTES) throw new RangeError("Height allocation exceeds bounds");
    const pointer = wasm.terrain_alloc(kind, length);
    if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer > 0xffff_ffff) throw new Error(`Height allocation failed (${wasm.terrain_last_error()})`);
    list.push({ kind, pointer, length });
    if (pointer % width || pointer > buffer().byteLength || length * width > buffer().byteLength - pointer) throw new Error("Invalid height allocation span");
    return pointer;
  }
  function release(list) {
    const errors = [];
    for (const value of [...list].reverse()) try {
      const status = wasm.terrain_free(value.kind, value.pointer, value.length);
      if (status !== 0) throw new Error(`Height buffer release failed (${status})`);
      list.splice(list.indexOf(value), 1);
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "WASM height cleanup failed; retire its worker");
  }
  let descriptor, packed;
  try {
    packed = allocate(1, elements, owned);
    descriptor = allocate(0, descriptorLength, owned);
    const words = new DataView(buffer(), descriptor, descriptorLength * 8);
    [sparse ? 2 : 1, sources.length, Number(!!grid.neighbors)].forEach((value, index) => words.setFloat64(index * 8, value, true));
    const heights = new DataView(buffer(), packed, elements * 4), floats = LITTLE_ENDIAN ? new Float32Array(buffer(), packed, elements) : null;
    let offset = 0;
    sources.forEach((source, index) => {
      const count = source.heights.length * (sparse ? 2 : 1);
      [source.z, source.x, source.y, source.size, offset, count].forEach((value, col) => words.setFloat64((3 + index * 6 + col) * 8, value, true));
      if (floats && !sparse) floats.set(source.heights, offset);
      else if (floats) {
        const values = source.heights, indices = source.indices;
        for (let i = 0, at = offset; i < values.length; i++, at += 2) { floats[at] = indices[i]; floats[at + 1] = values[i]; }
      } else for (let i = 0; i < source.heights.length; i++) {
        if (sparse) heights.setFloat32((offset + i * 2) * 4, source.indices[i], true);
        heights.setFloat32((offset + i * (sparse ? 2 : 1) + Number(sparse)) * 4, source.heights[i], true);
      }
      offset += count;
    });
  } catch (error) {
    try { release(owned); } catch (cleanup) { throw new AggregateError([error, cleanup], "Height snapshot setup failed"); }
    throw error;
  }
  return {
    bytes,
    sample(coordinates) {
      assertActive();
      if (closed) throw new Error("Height snapshot is disposed");
      if (!(coordinates instanceof Float64Array) || !coordinates.length || coordinates.length % 2 || coordinates.length > 131072) throw new RangeError(BATCH_ERROR);
      // The core refuses a batch with a point that is not finite, so the points are looked at here only when a batch
      // fails, and such a batch is refused with the same error as when they were checked first.
      const temporary = [];
      let failure;
      try {
        const input = allocate(0, coordinates.length, temporary), count = coordinates.length / 2;
        const output = allocate(0, count, temporary);
        if (LITTLE_ENDIAN) new Float64Array(buffer(), input, coordinates.length).set(coordinates);
        else {
          const view = new DataView(buffer(), input, coordinates.byteLength);
          coordinates.forEach((value, index) => view.setFloat64(index * 8, value, true));
        }
        const status = wasm.terrain_sample_batch(descriptor, descriptorLength, packed, elements, input, coordinates.length, output, count);
        if (status !== 0) throw new Error(`WASM height batch failed (${status})`);
        const result = new Float64Array(count);
        if (LITTLE_ENDIAN) result.set(new Float64Array(buffer(), output, count));
        else {
          const resultView = new DataView(buffer(), output, count * 8);
          for (let i = 0; i < count; i++) result[i] = resultView.getFloat64(i * 8, true);
        }
        return result;
      } catch (error) { failure = allFinite(coordinates) ? error : new RangeError(BATCH_ERROR); throw failure; }
      finally {
        try { release(temporary); } catch (error) { throw new AggregateError(failure ? [failure, error] : [error], "Height batch cleanup failed"); }
      }
    },
    dispose() {
      if (closed) return;
      release(owned); closed = true; onDispose();
    },
  };
}
