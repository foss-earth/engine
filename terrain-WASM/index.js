import { createTerrainCore, assertTerrainWorker } from "./core.js";
export { createTerrainCore, assertTerrainWorker } from "./core.js";

// sqrt, floor, round, min and max are computed in WebAssembly, bit for bit as Math does.
const MATH_NAMES = ["sin", "cos", "atan", "sinh", "pow"];

/** Load only when an owning worker explicitly requests this core. No JS fallback. */
export async function loadTerrainCore(options = {}) {
  assertTerrainWorker(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("WASM terrain has no fetch port");
  const response = await fetcher(options.wasmUrl ?? new URL("./single/terrain.wasm", import.meta.url));
  if (!response.ok) throw new Error(`Terrain WASM fetch failed (${response.status})`);
  return instantiateTerrainCore(await response.arrayBuffer(), options);
}

/** Math functions are captured from the executing worker realm, never from a page. */
export async function instantiateTerrainCore(source, options = {}) {
  assertTerrainWorker(options);
  const math = options.math ?? globalThis.Math, imports = {};
  for (const name of MATH_NAMES) {
    if (typeof math?.[name] !== "function") throw new Error(`WASM terrain Math.${name} import is missing`);
    // The function itself, not a bound copy: Math's functions ignore their receiver, and V8 calls an imported
    // Math function from WebAssembly faster than a bound copy of it.
    imports[name] = math[name];
  }
  let module;
  if (source instanceof WebAssembly.Module) module = source;
  else {
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source)
      : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : null;
    if (!bytes) throw new TypeError("WASM terrain needs a WASM module or byte buffer");
    module = await WebAssembly.compile(new Uint8Array(bytes));
  }
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.module !== "Math" || entry.kind !== "function" || !MATH_NAMES.includes(entry.name)) throw new Error("WASM terrain binary has unsupported imports");
  }
  const instance = await WebAssembly.instantiate(module, { Math: imports });
  return createTerrainCore(instance.exports, options);
}
