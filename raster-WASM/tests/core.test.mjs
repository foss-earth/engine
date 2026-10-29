import assert from "node:assert/strict";
import test from "node:test";
import { copyRasterHeights, createRasterCore } from "../core.js";
import { rasterFixture } from "./fixture.mjs";

const pixel = () => new Uint8ClampedArray([129, 0, 64, 255]);

test("ABI mock preserves float32 colour values and frees both buffers after copying the result", () => {
  const fixture = rasterFixture();
  const core = createRasterCore(fixture.exports);
  const input = new Uint8ClampedArray([
    127, 255, 128, 255, 129, 0, 64, 255,
    0, 0, 0, 255, 255, 255, 255, 255,
  ]);
  const result = core.decodeTerrarium(input, 2);
  assert.deepEqual([...result], [-0.5, 256.25, -32768, Math.fround(32767.99609375)]);
  assert.notEqual(result.buffer, fixture.memory.buffer);
  assert.equal(fixture.owned.size, 0);
  assert.deepEqual(fixture.calls.map(call => call[0]), ["alloc_rgba", "alloc_heights", "decode", "free_heights", "free_rgba"]);
  assert.equal(fixture.calls.find(call => call[0] === "alloc_heights")[1], 4);
  assert.deepEqual([...core.decodeTerrarium(pixel(), 1)], [256.25]);
  assert.equal(fixture.owned.size, 0);
  assert.deepEqual([...result], [-0.5, 256.25, -32768, Math.fround(32767.99609375)]);
});

test("unaligned RGBA is copied from its exact subarray with no writes to the input", () => {
  const fixture = rasterFixture();
  const input = new Uint8ClampedArray([7, 129, 0, 64, 255, 9]);
  assert.deepEqual([...createRasterCore(fixture.exports).decodeTerrarium(input.subarray(1, 5), 1)], [256.25]);
  assert.deepEqual([...input], [7, 129, 0, 64, 255, 9]);
});

test("refreshes detached views after either allocation and decode grow memory", () => {
  for (const kind of ["rgba", "heights"]) {
    const fixture = rasterFixture({ growOnAllocation: kind, growOnDecode: true });
    const before = fixture.memory.buffer;
    assert.deepEqual([...createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1)], [256.25]);
    assert.equal(before.byteLength, 0);
    assert.equal(fixture.owned.size, 0);
  }
});

test("result ownership survives memory growth during release", () => {
  const fixture = rasterFixture({ free_heights({ memory, owned, pointer }) {
    owned.delete(pointer);
    memory.grow(1);
    return 0;
  } });
  assert.deepEqual([...createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1)], [256.25]);
  assert.equal(fixture.owned.size, 0);
});

test("copies WASM float32 values using explicit little-endian reads on other host byte orders", () => {
  const input = new ArrayBuffer(12), view = new DataView(input);
  for (const [index, value] of [-0.5, 256.25, -0].entries()) view.setFloat32(index * 4, value, true);
  const result = copyRasterHeights(input, 0, 3, false);
  assert.equal(Object.is(result[0], -0.5), true);
  assert.equal(Object.is(result[1], 256.25), true);
  assert.equal(Object.is(result[2], -0), true);
  assert.notEqual(result.buffer, input);
});

test("rejects malformed or unbounded dimensions before allocating", () => {
  const fixture = rasterFixture(), core = createRasterCore(fixture.exports);
  for (const [input, size] of [[pixel(), 0], [pixel(), -1], [pixel(), 1.5], [pixel(), NaN],
    [pixel(), Infinity], [pixel(), 4097], [pixel(), 2], [new Uint8Array(pixel()), 1], [null, 1]]) {
    assert.throws(() => core.decodeTerrarium(input, size), { message: "Invalid terrain image dimensions" });
  }
  assert.equal(fixture.calls.length, 0);
});

test("maps every decode status and alpha validation to visible failure while releasing allocations", () => {
  for (const [status, message] of [[1, "Invalid terrain image dimensions"], [2, "Invalid terrain image dimensions"],
    [3, "WASM raster output length does not match image dimensions"], [4, "Terrain image contains missing samples"],
    [5, "WASM raster allocation is unavailable or invalid"]]) {
    const fixture = rasterFixture({ decode: () => status });
    assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), { message });
    assert.equal(fixture.owned.size, 0);
  }
  for (const alpha of [0, 1, 254]) {
    const fixture = rasterFixture();
    assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(new Uint8ClampedArray([129, 0, 64, alpha]), 1),
      { message: "Terrain image contains missing samples" });
    assert.equal(fixture.owned.size, 0);
  }
});

test("unknown statuses are backend errors with no silently substituted JS result", () => {
  for (const status of [-1, 6, 0.5, NaN, undefined, "0", 0n]) {
    const fixture = rasterFixture({ decode: () => status });
    assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), /invalid status/);
    assert.equal(fixture.owned.size, 0);
  }
});

test("preserves a WASM trap and releases both allocations", () => {
  const trap = new WebAssembly.RuntimeError("fixture trap");
  const fixture = rasterFixture({ decode() { throw trap; } });
  assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), error => error === trap);
  assert.equal(fixture.owned.size, 0);
});

test("frees RGBA when height allocation fails or traps; zero is never freed", () => {
  for (const allocate of [() => 0, () => { throw new WebAssembly.RuntimeError("allocator trap"); }]) {
    const fixture = rasterFixture({ alloc_heights: allocate });
    assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), /allocation failed|allocator trap/);
    assert.equal(fixture.owned.size, 0);
    assert.equal(fixture.calls.some(call => call[0] === "free_heights"), false);
    assert.equal(fixture.calls.filter(call => call[0] === "free_rgba").length, 1);
  }
  const fixture = rasterFixture({ alloc_rgba: () => 0 });
  assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), /allocation failed/);
  assert.deepEqual(fixture.calls, [["alloc_rgba", 4]]);
});

test("rejects pointer bounds, alignment and overlap before calling decode, with cleanup", () => {
  for (const pointer of [1, 65536]) {
    const fixture = rasterFixture({ alloc_heights: () => pointer });
    assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), error =>
      error instanceof AggregateError && /misaligned|outside linear memory/.test(error.errors[0].message));
    assert.equal(fixture.calls.some(call => call[0] === "decode"), false);
    assert.equal(fixture.calls.filter(call => call[0] === "free_heights").length, 1);
    assert.equal(fixture.calls.filter(call => call[0] === "free_rgba").length, 1);
  }
  const overlap = rasterFixture({ alloc_heights: () => 32 });
  assert.throws(() => createRasterCore(overlap.exports).decodeTerrarium(pixel(), 1), error =>
    error instanceof AggregateError && /overlap/.test(error.errors[0].message));
  assert.equal(overlap.calls.some(call => call[0] === "decode"), false);
  assert.equal(overlap.calls.filter(call => call[0].startsWith("free_")).length, 2);
  for (const pointer of [-1, NaN, 0x1_0000_0000, 1.5]) {
    const fixture = rasterFixture({ alloc_rgba: () => pointer });
    assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), /invalid pointer/);
  }
});

test("attempts the second free after the first fails, preserving the operation failure too", () => {
  const trap = new WebAssembly.RuntimeError("decode trap");
  const fixture = rasterFixture({ decode() { throw trap; }, free_heights: () => 5 });
  assert.throws(() => createRasterCore(fixture.exports).decodeTerrarium(pixel(), 1), error => {
    assert.equal(error.cause, trap);
    assert.equal(error.errors[0], trap);
    assert.match(error.errors[1].message, /height release failed/);
    return error instanceof AggregateError;
  });
  assert.equal(fixture.calls.filter(call => call[0] === "free_rgba").length, 1);
  const freeTrap = new WebAssembly.RuntimeError("free trap");
  const afterSuccess = rasterFixture({ free_heights() { throw freeTrap; } });
  assert.throws(() => createRasterCore(afterSuccess.exports).decodeTerrarium(pixel(), 1), error =>
    error instanceof AggregateError && error.errors[0] === freeTrap);
  assert.equal(afterSuccess.calls.filter(call => call[0] === "free_rgba").length, 1);
});

test("validates ABI version, every export and linear-memory shape/bounds", () => {
  for (const name of ["raster_abi_version", "raster_alloc_rgba", "raster_alloc_heights", "raster_free_rgba", "raster_free_heights", "raster_decode"]) {
    const fixture = rasterFixture();
    delete fixture.exports[name];
    assert.throws(() => createRasterCore(fixture.exports), /Invalid WASM raster ABI/);
  }
  assert.throws(() => createRasterCore(rasterFixture({ abi: 2 }).exports), /Unsupported WASM raster ABI version/);
  assert.throws(() => createRasterCore({ ...rasterFixture().exports, memory: { buffer: new ArrayBuffer(65536) } }), /ABI memory/);
  const empty = rasterFixture();
  empty.exports.memory = new WebAssembly.Memory({ initial: 0 });
  assert.throws(() => createRasterCore(empty.exports), /bound or is invalid/);
  const huge = rasterFixture();
  // A deliberately bad export fixture exercises the bound without reserving
  // hundreds of megabytes in this unit test process.
  const oversized = Object.create(ArrayBuffer.prototype, { byteLength: { value: 256 * 1024 * 1024 + 65536 } });
  Object.defineProperty(huge.memory, "buffer", { value: oversized });
  assert.throws(() => createRasterCore(huge.exports), /256 MiB bound/);
});
