import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { rasterFixture } from "./fixture.mjs";

afterEach(() => mock.restoreAll());
const bytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

test("import is inert; loadRasterCore lazily fetches the package asset once", async () => {
  const fixture = rasterFixture();
  const fetch = mock.method(globalThis, "fetch", async url => {
    assert.ok(url instanceof URL);
    assert.equal(url.pathname.endsWith("/single/raster.wasm"), true);
    return { ok: true, status: 200, arrayBuffer: async () => bytes().buffer };
  });
  const instantiate = mock.method(WebAssembly, "instantiate", async (_bytes, imports) => {
    assert.deepEqual(imports, {});
    return { instance: { exports: fixture.exports } };
  });
  const module = await import("../index.js?fixture=lazy");
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(instantiate.mock.callCount(), 0);
  const first = module.loadRasterCore(), second = module.loadRasterCore();
  assert.equal(first, second);
  const core = await first;
  assert.deepEqual([...core.decodeTerrarium(new Uint8ClampedArray([129, 0, 64, 255]), 1)], [256.25]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(instantiate.mock.callCount(), 1);
});

test("instantiateRasterCore copies only the supplied binary view and propagates backend rejection", async () => {
  const fixture = rasterFixture(), storage = new Uint8Array([99, ...bytes(), 88]);
  const instantiate = mock.method(WebAssembly, "instantiate", async source => {
    assert.deepEqual([...source], [...bytes()]);
    assert.notEqual(source.buffer, storage.buffer);
    return { instance: { exports: fixture.exports } };
  });
  const module = await import("../index.js?fixture=bytes");
  await module.instantiateRasterCore(storage.subarray(1, 9));
  await module.instantiateRasterCore(bytes().buffer);
  await assert.rejects(module.instantiateRasterCore(null), /ArrayBuffer or view/);
  assert.equal(instantiate.mock.callCount(), 2);
  const compileError = new WebAssembly.CompileError("fixture compile error");
  instantiate.mock.mockImplementation(async () => { throw compileError; });
  await assert.rejects(module.instantiateRasterCore(bytes()), error => error === compileError);
});

test("fetch and ABI failures remain visible instead of returning a JS backend", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  const missing = await import("../index.js?fixture=missing");
  await assert.rejects(missing.loadRasterCore(), /fetch failed \(404\)/);
  await assert.rejects(missing.loadRasterCore(), /fetch failed \(404\)/);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes().buffer }));
  mock.method(WebAssembly, "instantiate", async () => ({ instance: { exports: rasterFixture({ abi: 99 }).exports } }));
  const invalid = await import("../index.js?fixture=invalid-abi");
  await assert.rejects(invalid.loadRasterCore(), /Unsupported WASM raster ABI version/);
});
