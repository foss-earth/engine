/** Real retained-grid WASM ABI versus the engine's Float64 reference, as built in dist/. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sampleTerrainGrid } from "@foss-earth/engine";
import { collectTerrainHeightPixels, packTerrainHeightPixels, sampleTerrainHeightPixels, unpackTerrainHeightPixels } from "../../dist/src/browser/terrainHeightPixels.js";
import { instantiateTerrainCore } from "../index.js";
const binary = new URL("../single/terrain.wasm", import.meta.url);
const bytes = readFileSync(binary);
const core = await instantiateTerrainCore(bytes, { workerRealm: true });
let cases = 0, coordinatesChecked = 0;
function grid(z, x, y, size, seed = 0) {
  return { z, x, y, size, heights: Float32Array.from({ length: size * size }, (_, i) => ((i * 13 + seed * 17) % 65521 - 32760) / 256) };
}
function compare(input, coordinates, label) {
  const expected = Float64Array.from({ length: coordinates.length / 2 }, (_, i) => sampleTerrainGrid(input, coordinates[i * 2], coordinates[i * 2 + 1]));
  const compact = collectTerrainHeightPixels(input, coordinates);
  for (let i = 0; i < expected.length; i++) assert.ok(Object.is(sampleTerrainHeightPixels(compact, coordinates[i * 2], coordinates[i * 2 + 1]), expected[i]), `${label} sparse TS[${i}] differs`);
  // The page's packed request leaves unread neighbours out.
  const pack = packTerrainHeightPixels();
  pack.add(1, input, coordinates, coordinates.length / 2, Infinity);
  const packed = unpackTerrainHeightPixels(pack.finish())[0].grid;
  for (const [arm, source] of [["dense", input], ["sparse", compact], ["packed", packed]]) {
    const sampler = core.createHeightSampler(source);
    try {
      const result = sampler.sample(coordinates);
      assert.equal(result.length, expected.length);
      for (let i = 0; i < result.length; i++) assert.ok(Object.is(result[i], expected[i]), `${label}/${arm}[${i}] ${coordinates[i * 2]},${coordinates[i * 2 + 1]}: ${result[i]} differs from ${expected[i]}`);
      const saved = result.slice();
      sampler.sample(coordinates.slice(0, 2));
      assert.deepEqual(result, saved);
      cases++; coordinatesChecked += expected.length;
    } finally { sampler.dispose(); sampler.dispose(); }
    assert.throws(() => sampler.sample(new Float64Array([0, 0])), /disposed/);
  }
}
for (const tile of [{ z: 0, x: 0, y: 0 }, { z: 1, x: 1, y: 0 }, { z: 4, x: 5, y: 7 }, { z: 30, x: 1073741823, y: 1073741823 }]) {
  for (const size of [1, 2, 3, 17, 256]) for (const neighbors of [undefined, [], [grid(0, 0, 0, 3, 3)], [grid(tile.z, (tile.x + 1) % 2 ** tile.z, tile.y, 7, 1), grid(0, 0, 0, 2, 7)]]) {
    const input = { ...grid(tile.z, tile.x, tile.y, size), ...(neighbors ? { neighbors } : {}) };
    const values = [-0, 0, Number.EPSILON, 0.5 / size, 0.5, 1 - 0.5 / size, 1, 1 + Number.EPSILON, -1, 2];
    const coordinates = Float64Array.from(values.flatMap(x => values.flatMap(y => [tile.x + x, tile.y + y])));
    compare(input, coordinates, `z${tile.z}/size${size}/neighbors${neighbors?.length ?? "none"}`);
  }
}
for (const special of [-0, 0, NaN, Infinity, -Infinity, 1.401298464324817e-45]) {
  const input = grid(0, 0, 0, 2); input.heights.fill(special);
  compare(input, new Float64Array([-0, -0, 0.5, 0.5, 1, 1]), `special ${String(special)}`);
}
const maximum = grid(4, 3, 5, 17); maximum.neighbors = [grid(0, 0, 0, 3)];
for (const count of [1, 65536]) {
  const coordinates = Float64Array.from({ length: count * 2 }, (_, i) => (i % 2 ? maximum.y : maximum.x) + ((i * 101) % 65521) / 65521);
  compare(maximum, coordinates, `batch${count}`);
}
// A grid published in shared memory, as decode workers publish heights, samples the same.
const shared = { ...maximum, heights: new Float32Array(new SharedArrayBuffer(maximum.heights.byteLength)) };
shared.heights.set(maximum.heights);
compare(shared, Float64Array.from({ length: 2048 }, (_, i) => (i % 2 ? maximum.y : maximum.x) + ((i * 37) % 4093) / 4093), "shared heights");
const missingInput = grid(0, 0, 0, 17);
const missingPixels = collectTerrainHeightPixels(missingInput, new Float64Array([0.25, 0.25, 0.75, 0.75]));
const incomplete = { ...missingPixels, indices: missingPixels.indices.slice(1), heights: missingPixels.heights.slice(1) };
const missingSampler = core.createHeightSampler(incomplete);
assert.throws(() => missingSampler.sample(new Float64Array([0.25, 0.25])), /WASM height batch failed/);
missingSampler.dispose();
assert.throws(() => core.createHeightSampler({ ...missingPixels, indices: Uint32Array.from(missingPixels.indices, () => 0) }), /Invalid height-batch grid/);
const input = grid(0, 0, 0, 2);
const sampler = core.createHeightSampler(input);
const expected = sampler.sample(new Float64Array([0.5, 0.5]));
input.heights.fill(9999);
assert.deepEqual(sampler.sample(new Float64Array([0.5, 0.5])), expected);
for (const invalid of [new Float64Array(), new Float64Array(3), new Float64Array(131074), new Float64Array([NaN, 0]), new Float64Array([Infinity, 0])]) assert.throws(() => sampler.sample(invalid), /finite x\/y/);
core.dispose(); assert.throws(() => sampler.sample(new Float64Array([0, 0])), /disposed/);
const implementations = [binary, new URL("../heightSampler.js", import.meta.url), new URL("../core.js", import.meta.url), new URL("../crates/earth-terrain/src/lib.rs", import.meta.url), new URL("../../dist/src/terrain/terrainGrid.js", import.meta.url), new URL("../../dist/src/browser/terrainHeightPixels.js", import.meta.url)];
const report = { parity: "same", cases, denseCases: cases / 3, sparseCases: cases / 3, packedCases: cases / 3, coordinatesChecked, ownership: "source snapshot/output ownership and sampler/core disposal passed", binarySha256: createHash("sha256").update(bytes).digest("hex"),
  receipts: Object.fromEntries(implementations.map(url => [url.pathname, createHash("sha256").update(readFileSync(url)).digest("hex")])) };
mkdirSync(new URL("../../build/terrain-WASM/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../build/terrain-WASM/height-batch-parity.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
