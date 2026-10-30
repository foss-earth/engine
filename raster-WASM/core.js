const MAX_SIDE = 4096;
// Rust owns at most 128 MiB of live RGBA+height buffers. Its allocator, stack and
// registry also occupy linear memory, whose linked maximum is 256 MiB.
const MAX_LIVE_BYTES = 128 * 1024 * 1024;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const DIMENSIONS_ERROR = "Invalid terrain image dimensions";
const MISSING_ERROR = "Terrain image contains missing samples";
const FUNCTIONS = ["raster_abi_version", "raster_alloc_rgba", "raster_free_rgba",
  "raster_alloc_heights", "raster_free_heights", "raster_decode"];
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

/** WASM memory is little-endian even on a host whose typed arrays are not. */
export function copyRasterHeights(buffer, pointer, length, littleEndian = LITTLE_ENDIAN, output = new Float32Array(length)) {
  if (littleEndian) { output.set(new Float32Array(buffer, pointer, length)); return output; }
  const view = new DataView(buffer, pointer, length * 4);
  for (let index = 0; index < length; index++) output[index] = view.getFloat32(index * 4, true);
  return output;
}

function decodeError(status) {
  switch (status) {
    case 1: case 2: return new Error(DIMENSIONS_ERROR);
    case 3: return new Error("WASM raster output length does not match image dimensions");
    case 4: return new Error(MISSING_ERROR);
    case 5: return new Error("WASM raster allocation is unavailable or invalid");
    default: return new Error(`WASM raster decode returned invalid status: ${String(status)}`);
  }
}

/** Internal ABI boundary, separately exercised with explicit mock exports. */
export function createRasterCore(exports) {
  if (!exports || typeof exports !== "object") throw new Error("Invalid WASM raster ABI exports");
  for (const name of FUNCTIONS) {
    if (typeof exports[name] !== "function") throw new Error(`Invalid WASM raster ABI: missing ${name}`);
  }
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Invalid WASM raster ABI memory");
  const buffer = () => {
    const current = memory.buffer;
    if (!(current instanceof ArrayBuffer) || current.byteLength === 0 || current.byteLength > MAX_MEMORY_BYTES) {
      throw new Error("WASM raster memory exceeds the single-core 256 MiB bound or is invalid");
    }
    return current;
  };
  buffer();
  if (exports.raster_abi_version() !== 1) throw new Error("Unsupported WASM raster ABI version");
  buffer();

  const allocation = (value, kind) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`WASM raster ${kind} allocator returned an invalid pointer`);
    }
    if (value === 0) throw new Error(`WASM raster ${kind} allocation failed`);
    return value;
  };
  const span = (current, pointer, byteLength, alignment) => {
    if (pointer % alignment !== 0 || pointer > current.byteLength || byteLength > current.byteLength - pointer) {
      throw new Error("WASM raster allocation is misaligned or outside linear memory");
    }
  };

  return {
    decodeTerrarium(data, size, reuseInput = false) {
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIDE
        || !ArrayBuffer.isView(data) || Object.prototype.toString.call(data) !== "[object Uint8ClampedArray]"
        || data.length !== size * size * 4) throw new Error(DIMENSIONS_ERROR);
      const pixels = size * size, rgbaBytes = pixels * 4, heightBytes = pixels * Float32Array.BYTES_PER_ELEMENT;
      if (rgbaBytes + heightBytes > MAX_LIVE_BYTES) throw new Error(DIMENSIONS_ERROR);
      let rgba = 0, heights = 0;
      let failed = false, failure;
      try {
        rgba = allocation(exports.raster_alloc_rgba(rgbaBytes), "RGBA");
        span(buffer(), rgba, rgbaBytes, 1);
        heights = allocation(exports.raster_alloc_heights(pixels), "height");
        const before = buffer();
        span(before, rgba, rgbaBytes, 1);
        span(before, heights, heightBytes, Float32Array.BYTES_PER_ELEMENT);
        if (rgba < heights + heightBytes && heights < rgba + rgbaBytes) {
          throw new Error("WASM raster allocations overlap");
        }
        // Both allocations may grow memory. Construct the view only after
        // them, and copy even an unaligned caller-owned RGBA subarray.
        new Uint8Array(before, rgba, rgbaBytes).set(data);
        const status = exports.raster_decode(rgba, rgbaBytes, size, size, heights, pixels);
        if (status !== 0) throw decodeError(status);
        // Decode may also grow memory. Never retain the pre-call buffer or
        // return a WASM view that would be freed or detached by a later call.
        const after = buffer();
        span(after, rgba, rgbaBytes, 1);
        span(after, heights, heightBytes, Float32Array.BYTES_PER_ELEMENT);
        const output = reuseInput && (data.byteOffset & 3) === 0 && data.buffer !== after && data.byteLength === heightBytes
          ? new Float32Array(data.buffer, data.byteOffset, pixels) : undefined;
        return copyRasterHeights(after, heights, pixels, LITTLE_ENDIAN, output);
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      } finally {
        const cleanup = [];
        for (const [pointer, length, free, kind] of [
          [heights, pixels, exports.raster_free_heights, "height"],
          [rgba, rgbaBytes, exports.raster_free_rgba, "RGBA"],
        ]) {
          if (pointer === 0) continue;
          try {
            const status = free(pointer, length);
            if (status !== 0) throw new Error(`WASM raster ${kind} release failed (${String(status)})`);
          } catch (error) { cleanup.push(error); }
        }
        if (cleanup.length > 0) {
          if (failed) throw new AggregateError([failure, ...cleanup], "WASM raster operation and cleanup failed", { cause: failure });
          throw new AggregateError(cleanup, "WASM raster cleanup failed");
        }
      }
    },
  };
}
