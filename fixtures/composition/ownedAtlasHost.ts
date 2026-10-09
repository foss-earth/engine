/** CPU boundaries around actual public Images/Renderer ports; never a GPU qualification. */
import { Constants, type InternalTexture, type Scene, type Texture } from "@babylonjs/core";
import { createImageSessionBroker, ResourceCapacityError } from "@foss-earth/images";
import { createTextureDevicePorts, createTextureTransferTracker } from "@foss-earth/renderer/babylon";
import { createImageryAtlas, type ManagedImageryAtlasResources } from "../../src/babylon/imagery/imageryAtlas.js";
import { planAtlasLayout, pageUploadBytes } from "../../src/terrain/imagery/imageryAtlasLayout.js";
import { preparePages } from "../../src/terrain/imagery/imageryPagePreparation.js";
import type { RetainedPreparedImage } from "../../src/terrain/imagery/imageryResidency.js";

export async function flushOwnedAtlas(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }
// The retained planner requires 24 slots. 8 MiB fits only a 4x4 page grid;
// 12 MiB admits a 5x5 grid plus physical table blocks without changing admission.
export const OWNED_ATLAS_GPU_BUDGET = 12 * 2 ** 20;
export function ownedAtlasHost() {
  const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { sourceGpu: 128 * 2 ** 20, overlap: 64 * 2 ** 20, decoded: 32 * 2 ** 20, encoded: 1000, uploadOutstanding: 16 * 2 ** 20 } });
  const native: { resolve(): void; reject(error: unknown): void; table: boolean }[] = [], writes: { data: Uint8Array; lod: number; x: number; y: number; width: number }[] = [];
  const errors: unknown[] = [], disposals: string[] = [];
  let writeHook: ((index: number) => void) | undefined, copyHook: (() => void) | undefined, renders = 0;
  const engine = { isWebGPU: true, getCaps: () => ({ maxTextureSize: 8192 }),
    _device: { queue: { onSubmittedWorkDone: () => new Promise<void>((resolve, reject) => native.push({ resolve, reject, table: writes.at(-1)?.width === 64 })) } },
    updateTextureData(_texture: InternalTexture, data: Uint8Array, x: number, y: number, width: number, _height: number, _face: number, lod: number) { writes.push({ data, x, y, width, lod }); writeHook?.(writes.length); },
  };
  const nativeScene = { getEngine: () => engine } as unknown as Scene;
  const reserve = (pool: "sourceGpu" | "decoded" | "uploadOutstanding", bytes: number, label: string, options = {}) => {
    const admitted = broker.pools.reserve(pool, bytes, label, options); return admitted.ok ? admitted.reservation : null;
  };
  const resources: ManagedImageryAtlasResources = {
    generation: () => broker.generation(),
    reserveGpu: (bytes, label, options) => reserve("sourceGpu", bytes, label, options),
    reserveTable: (bytes, label) => reserve("decoded", bytes, label),
    reserveCopy(bytes, label) { copyHook?.(); const granted = broker.pools.reserve("decoded", bytes, label); if (!granted.ok) throw new ResourceCapacityError(granted.pool, granted.reason); return granted.reservation; },
    canUpload: (bytes, extra = 0) => broker.pools.fits("uploadOutstanding", bytes) && broker.pools.fits("decoded", bytes + extra),
    subscribeAvailable: listener => broker.pools.subscribeAvailable(listener),
    capacityKey: () => JSON.stringify(Object.entries(broker.pools.stats()).map(([pool, value]) => [pool, value.limit, value.reserved])),
  };
  const tracker = createTextureTransferTracker({ scene: nativeScene, admit: (bytes, label) => reserve("uploadOutstanding", bytes, label), requestRender: () => { renders += 1; } });
  const device = createTextureDevicePorts({ scene: nativeScene, transfer: tracker.transfer, tryAdmit: tracker.tryAdmit });
  device.createRawTexture = options => {
    const internal = { getEngine: () => engine, isCube: false, width: options.width, height: options.height, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE } as unknown as InternalTexture;
    const owned = { name: "", getInternalTexture: () => internal, dispose() { disposals.push(owned.name); } };
    return owned as unknown as Texture;
  };
  const layout = planAtlasLayout({ maxBytes: OWNED_ATLAS_GPU_BUDGET, maxTextureSize: 8192, powerOfTwo: false, maxPatches: 2 })!;
  const atlas = createImageryAtlas(nativeScene, layout, 1, device, { ...resources, overlap: false, requestRender: () => { renders += 1; }, onError: error => { errors.push(error); } });
  const image = (width = 256, height = 256): RetainedPreparedImage => {
    const granted = reserve("decoded", width / 256 * (height / 256) * pageUploadBytes(), "fixture exact prepared Atlas pages"); if (!granted) throw new Error("Fixture prepared capacity refused.");
    const generation = broker.generation(), pixels = new Uint8Array(width * height * 4).fill(37), pages = preparePages(pixels, width, height);
    let closing = false;
    return { width, height, pages, compressedBytes: 1, isCurrent: () => !closing && broker.generation() === generation,
      close() { if (closing) return; closing = true; granted.release(); }, retain() { if (closing) throw new Error("Closing image."); return granted.retain(); } };
  };
  return { broker, native, writes, errors, disposals, resources, tracker, device, atlas, layout, image,
    get renders() { return renders; }, onWrite(hook: (index: number) => void) { writeHook = hook; }, onCopy(hook: () => void) { copyHook = hook; },
    dispose() { tracker.deviceLost(); atlas.dispose(); tracker.dispose(); broker.dispose(); } };
}
