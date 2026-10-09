import { decodeGeoidGrid, type GeoidGridId, type GeoidModel } from "../terrain/geoid.js";
export interface GeoidReadPorts { gunzip(bytes: Uint8Array): Promise<Uint8Array> }
/** Host decompression avoids core DOM stream constructors. */
export async function readGeoidGrid(bytes: Uint8Array, ports: GeoidReadPorts): Promise<GeoidModel> {
  return decodeGeoidGrid(bytes[0] === 0x1f && bytes[1] === 0x8b ? await ports.gunzip(bytes) : bytes);
}
export interface GeoidLoaderPorts extends GeoidReadPorts {
  fetch(url: URL): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}
const GRID_URLS: Record<GeoidGridId, () => URL> = {
  "60": () => new URL("../../assets/geoid/egm2008-60.bin", import.meta.url),
  "30": () => new URL("../../assets/geoid/egm2008-30.bin", import.meta.url),
  "15": () => new URL("../../assets/geoid/egm2008-15.bin", import.meta.url),
};
/** One explicit host session cache, retaining source one-failure-per-session behavior. */
export function createGeoidLoader(ports: GeoidLoaderPorts) {
  const loaded = new Map<GeoidGridId, Promise<GeoidModel>>();
  function loadGeoid(grid: GeoidGridId): Promise<GeoidModel> {
    let model = loaded.get(grid);
    if (!model) {
      model = ports.fetch(GRID_URLS[grid]()).then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readGeoidGrid(new Uint8Array(await response.arrayBuffer()), ports);
      });
      loaded.set(grid, model);
    }
    return model;
  }
  return { loadGeoid };
}
