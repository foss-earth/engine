import { createRasterCore } from "./core.js";

let loading;

/** No fetch or compilation occurs until a caller explicitly requests the core. */
export function loadRasterCore() {
  loading ??= (async () => {
    const response = await fetch(new URL("./single/raster.wasm", import.meta.url));
    if (!response.ok) throw new Error(`Native raster WASM fetch failed (${response.status})`);
    return instantiateRasterCore(await response.arrayBuffer());
  })();
  return loading;
}

export async function instantiateRasterCore(bytes) {
  let view;
  if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
  else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else throw new TypeError("Native raster WASM bytes must be an ArrayBuffer or view");
  // Own the binary input too: a subarray or shared caller buffer must not
  // change while asynchronous compilation is reading it.
  const { instance } = await WebAssembly.instantiate(new Uint8Array(view), {});
  return createRasterCore(instance.exports);
}
