import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeTerrarium } from "@foss-earth/engine/raster-TS";
import { instantiateRasterCore } from "../index.js";

const bytes = readFileSync(new URL("../single/raster.wasm", import.meta.url));
const core = await instantiateRasterCore(bytes);
const sha = value => createHash("sha256").update(value).digest("hex");
let comparedPixels = 0, cases = 0;
function compare(data, size) {
  const input = Buffer.from(data), expected = decodeTerrarium(data, size), actual = core.decodeTerrarium(data, size);
  if (!(actual instanceof Float32Array) || actual.length !== expected.length
    || !Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))) throw new Error("raster-WASM differs from raster-TS height bytes");
  if (!Buffer.from(data).equals(input)) throw new Error("WASM decoder changed the caller's input");
  for (const decode of [decodeTerrarium, core.decodeTerrarium]) {
    const owned = new Uint8ClampedArray(new ArrayBuffer(data.byteOffset + data.byteLength), data.byteOffset, data.length);
    owned.set(data);
    const reused = decode(owned, size, true);
    if (!Buffer.from(reused.buffer, reused.byteOffset, reused.byteLength).equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))) throw new Error("Consumed RGBA decode differs from reference heights");
    if ((reused.buffer === owned.buffer) !== ((owned.byteOffset & 3) === 0)) throw new Error("Consumed RGBA decode did not honor storage alignment");
    if ((owned.byteOffset & 3) !== 0 && !Buffer.from(owned).equals(input)) throw new Error("Unaligned RGBA fallback changed input");
  }
  comparedPixels += expected.length; cases++;
}
// All 2^24 RGB colours, in bounded 256x256 batches rather than giant buffers.
for (let block = 0; block < 256; block++) {
  const data = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < 65536; i++) data.set([block, i >>> 8, i & 255, 255], i * 4);
  compare(data, 256);
}
for (const offset of [0, 1, 2, 3]) {
  const backing = new ArrayBuffer(17 * 17 * 4 + offset), data = new Uint8ClampedArray(backing, offset);
  for (let i = 0; i < data.length; i += 4) data.set([(i * 13) & 255, (i * 7) & 255, i & 255, 255], i);
  compare(data, 17);
}
for (const size of [1, 16, 1024]) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([128, 0, 0, 255], i);
  compare(data, size);
}
let failures = 0;
for (const alpha of [0, 1, 127, 254]) {
  const data = new Uint8ClampedArray([128, 0, 0, alpha]);
  const errors = [decodeTerrarium, core.decodeTerrarium].map(fn => { try { fn(data, 1); } catch (error) { return { name: error.name, message: error.message }; } });
  if (!errors[0] || JSON.stringify(errors[0]) !== JSON.stringify(errors[1])) throw new Error("WASM alpha failure differs from TypeScript");
  failures++;
}
const result = { implementation: "raster-WASM (Rust) versus raster-TS, the built @foss-earth/engine/raster-TS", wasmSha256: sha(bytes), cases, comparedPixels,
  alphaFailureCases: failures, outputBytes: "identical", inputOwnership: "unchanged by default; aligned consume mode identical in both twins", performanceClaim: false };
mkdirSync(new URL("../../build/raster-WASM/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../build/raster-WASM/raster-parity.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
