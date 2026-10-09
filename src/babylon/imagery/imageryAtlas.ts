import { Constants, Texture, type InternalTexture, type Scene } from "@babylonjs/core";
import { finishOwnedCleanup } from "../ownedCleanup.js";
import {
  IMAGERY_MAX_SAMPLED_LOD,
  IMAGERY_SLOT_SIZE,
  IMAGERY_TABLE_BLOCK,
  planAtlasLayout,
  slotOrigin,
  type ImageryAtlasLayout,
} from "../../terrain/imagery/imageryAtlasLayout.js";
import type { PreparedRawTextureBatch, RawTextureBatchRequest, RawTextureBatchRegion, UploadTicket } from "@foss-earth/renderer/babylon";
import type { TextureTransferOutcome, TextureTransferRetirement } from "@foss-earth/renderer";
import type { ImageryPageStore, OwnedImageryNativeJob, OwnedImageryUploadJob, RetainedPreparedImage } from "../../terrain/imagery/imageryResidency.js";

/** Generic device operations are supplied by the host's one renderer backend. */
export interface ImageryAtlasDevicePorts {
  createRawTexture(options: {
    scene: Scene; data: Uint8Array | null; width: number; height: number;
    format: number; mipmaps: boolean; invertY: boolean; samplingMode: number; type: number;
  }): Texture;
  updateTextureData(texture: InternalTexture, data: ArrayBufferView, x: number, y: number,
    width: number, height: number, faceIndex?: number, lod?: number, generateMipMaps?: boolean): void;
  /** Actual additive Renderer capability; never adapted from updateTextureData:void. */
  prepareRawTextureBatch?(request: RawTextureBatchRequest): PreparedRawTextureBatch | null;
}

export interface ImageryAtlasGpuTicket extends UploadTicket { settle(): void }
/** Host binds every port to its one existing Images broker and Renderer device. */
export interface ManagedImageryAtlasResources {
  generation(): number;
  reserveGpu(bytes: number, label: string, options: { overlap: boolean }): ImageryAtlasGpuTicket | null;
  /** Persistent/candidate full patch-table RGBA8 buffers, before allocation. */
  reserveTable(bytes: number, label: string): UploadTicket | null;
  /** Actual Renderer private snapshot admission; throw on refusal, never return null. */
  reserveCopy(bytes: number, label: string): UploadTicket;
  /** Same pools.fits(uploadOutstanding, bytes) and fits(decoded, bytes + additionalDecodedBytes). */
  canUpload(bytes: number, additionalDecodedBytes?: number): boolean;
  subscribeAvailable(listener: () => void): () => void;
  /** Same pool limits/reserved totals; used to suppress self-generated availability wakes. */
  capacityKey(): string;
}
export interface ManagedImageryAtlasOptions extends ManagedImageryAtlasResources {
  overlap: boolean;
  requestRender(): void;
  onError(error: unknown): void;
}
export interface OwnedImageryTableJob extends OwnedImageryNativeJob { readonly block: number }
export interface ImageryAtlasDisposal { readonly cleanupError?: unknown }


export type ImageryBackend = "webgpu" | "webgl2" | "webgl";

export interface ImageryAtlas extends ImageryPageStore {
  readonly layout: ImageryAtlasLayout;
  readonly texture: Texture;
  readonly table: Texture;
  /** A page-table block for a terrain patch, or null when every block is taken. */
  allocateBlock(): number | null;
  releaseBlock(block: number): void;
  /** Texel origin of a block in the page table. */
  blockOrigin(block: number): { x: number; y: number };
  writeBlock(block: number, data: Uint8Array): void;
  /** A fresh unbound block only; full success/retirement precede material binding. */
  prepareOwnedTable?(block: number, data: Uint8Array, retainInput: () => () => void): OwnedImageryTableJob | null;
  /** Native jobs and textures/GPU grant have all retired; ordinary dispose is only a request. */
  readonly whenDisposed?: Promise<ImageryAtlasDisposal>;
  settleReplacement?(): void;
  freeSlots(): number;
  /** Drops every page and block, e.g. after the GPU context was restored. */
  clear(): void;
  /** Texture samples along steep views: `map.imagery.anisotropy`. */
  setAnisotropy(samples: number): void;
  dispose(): void;
}

/**
 * The atlas and page-table textures. Both are raw RGBA8 without sRGB
 * conversion, matching how the tile textures were sampled before. The atlas
 * is allocated with its full mip chain; pages write their own levels into
 * their slots and the shader never samples past IMAGERY_MAX_SAMPLED_LOD.
 */
export function createImageryAtlas(scene: Scene, layout: ImageryAtlasLayout, anisotropy: number, device: ImageryAtlasDevicePorts, managed?: ManagedImageryAtlasOptions): ImageryAtlas {
  const allocationGeneration = managed?.generation();
  let gpu: ImageryAtlasGpuTicket | null = null;
  if (managed) {
    if (typeof device.prepareRawTextureBatch !== "function") throw new Error("Managed Atlas requires the actual Renderer whole-batch capability.");
    gpu = managed.reserveGpu(Math.ceil(layout.estimatedBytes), "imagery atlas and transactional page tables", { overlap: managed.overlap });
    if (!gpu) throw new Error("Shared GPU admission refused the imagery atlas and page tables.");
    if (managed.generation() !== allocationGeneration) { gpu.release(); throw new Error("Atlas generation changed during GPU admission."); }
  }
  let texture!: Texture;
  try { texture = device.createRawTexture({ scene, data: null, width: layout.width, height: layout.height, format: Constants.TEXTUREFORMAT_RGBA, mipmaps: true, invertY: false, samplingMode: Texture.TRILINEAR_SAMPLINGMODE, type: Constants.TEXTURETYPE_UNSIGNED_BYTE }); }
  catch (error) {
    // An opaque native factory failure cannot prove that any partial storage
    // was retired. Its complete managed GPU grant remains quarantined.
    throw error;
  }
  let table!: Texture;
  try {
  texture.name = "imagery-atlas";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = anisotropy;
  // Managed blocks are completely initialized before binding. No full initial
  // zero CPU table copy is allocated; its full native storage is GPU-admitted.
  const tableData = managed ? null : new Uint8Array(layout.tableSize * layout.tableSize * 4);
  table = device.createRawTexture({ scene, data: tableData, width: layout.tableSize, height: layout.tableSize, format: Constants.TEXTUREFORMAT_RGBA, mipmaps: false, invertY: false, samplingMode: Texture.NEAREST_SAMPLINGMODE, type: Constants.TEXTURETYPE_UNSIGNED_BYTE });
  table.name = "imagery-page-table";
  table.wrapU = Texture.CLAMP_ADDRESSMODE;
  table.wrapV = Texture.CLAMP_ADDRESSMODE;

  const freeSlotList: number[] = [];
  const freeBlockList: number[] = [];
  const blocksPerRow = Math.floor(layout.tableSize / IMAGERY_TABLE_BLOCK);
  type Owner = {
    epoch: number; slots: readonly number[]; blocks: readonly number[];
    batch: PreparedRawTextureBatch | null; retired: boolean; releaseWanted: boolean;
    resolveSettled(outcome: TextureTransferOutcome): void; resolveRetired(retirement: TextureTransferRetirement): void;
  };
  const slotOwners = new Map<number, Owner>(), blockOwners = new Map<number, Owner>(), jobs = new Set<Owner>();
  const allocatedSlots = new Set<number>(), allocatedBlocks = new Set<number>();
  let epoch = 0;
  const reset = (): void => {
    freeSlotList.length = 0;
    for (let slot = layout.capacity - 1; slot >= 0; slot--) if (!allocatedSlots.has(slot)) freeSlotList.push(slot);
    freeBlockList.length = 0;
    for (let block = layout.tableBlocks - 1; block >= 0; block--) if (!allocatedBlocks.has(block)) freeBlockList.push(block);
  };
  reset();
  let disposed = false, cleaned = false;
  let resolveDisposal!: (result: ImageryAtlasDisposal) => void;
  const whenDisposed = new Promise<ImageryAtlasDisposal>(resolve => { resolveDisposal = resolve; });
  const report = (error: unknown): void => { try { managed?.onError(error); } catch { /* The sole host error channel was attempted. */ } };
  const wake = (): void => { if (!disposed) try { managed?.requestRender(); } catch (error) { report(error); } };
  const cleanup = (): void => {
    if (!disposed || cleaned || jobs.size) return;
    cleaned = true;
    const errors: unknown[] = [];
    for (const action of [() => texture.dispose(), () => table.dispose()]) try { action(); } catch (error) { errors.push(error); }
    // A thrown native disposal does not prove storage retirement. Keep the
    // managed GPU charge quarantined, while attempting every texture cleanup.
    if (!errors.length) try { gpu?.release(); } catch (error) { errors.push(error); }
    const cleanupError = errors.length === 1 ? errors[0] : errors.length ? new AggregateError(errors, "Imagery managed atlas cleanup failed.") : undefined;
    resolveDisposal(cleanupError === undefined ? {} : { cleanupError });
    if (cleanupError !== undefined) throw cleanupError;
  };
  const releaseOwner = (owner: Owner): void => {
    if (!owner.retired || !owner.releaseWanted) return;
    // Captured identity owns each coordinate. A stale generic release cannot
    // return a coordinate now owned by another native/storage generation.
    for (const slot of owner.slots) if (slotOwners.get(slot) === owner) { slotOwners.delete(slot); allocatedSlots.delete(slot); }
    for (const block of owner.blocks) if (blockOwners.get(block) === owner) { blockOwners.delete(block); allocatedBlocks.delete(block); }
    if (!disposed) reset();
  };
  const current = (owner: Owner): boolean => !disposed && owner.epoch === epoch && (!managed || managed.generation() === allocationGeneration)
    && owner.slots.every(slot => slotOwners.get(slot) === owner) && owner.blocks.every(block => blockOwners.get(block) === owner);
  const prepare = (slots: readonly number[], blocks: readonly number[], regions: readonly RawTextureBatchRegion[], retainInput: () => () => void, label: string): OwnedImageryNativeJob | null => {
    if (!managed || !device.prepareRawTextureBatch || disposed || managed.generation() !== allocationGeneration) throw new Error("The managed Atlas native generation is unavailable.");
    let resolveSettled!: (outcome: TextureTransferOutcome) => void, resolveRetired!: (retirement: TextureTransferRetirement) => void;
    const settled = new Promise<TextureTransferOutcome>(resolve => { resolveSettled = resolve; });
    const retired = new Promise<TextureTransferRetirement>(resolve => { resolveRetired = resolve; });
    const owner: Owner = { epoch, slots, blocks, batch: null, retired: false, releaseWanted: false, resolveSettled, resolveRetired };
    // Entire coordinate ownership is registered before a supplied admission or
    // retention callback may reenter reset/disposal. No native call occurs here.
    jobs.add(owner); for (const slot of slots) slotOwners.set(slot, owner); for (const block of blocks) blockOwners.set(block, owner);
    const retire = (value: TextureTransferRetirement, notify = true): void => {
      if (owner.retired) return;
      if (value?.status !== "completed" && value?.status !== "device-lost") { report(new Error("Atlas native retirement did not prove completion/loss.")); return; }
      owner.retired = true; jobs.delete(owner); releaseOwner(owner); resolveRetired(value);
      if (value.cleanupError !== undefined) report(value.cleanupError);
      try { cleanup(); } catch (error) { report(error); }
      if (notify) wake();
    };
    try {
      const batch = device.prepareRawTextureBatch({ regions, label, retainInput, reserveCopy: (bytes, name) => managed.reserveCopy(bytes, name) }); owner.batch = batch;
      if (!batch) {
        owner.releaseWanted = true; resolveSettled({ status: "failed", error: new Error("Shared native upload admission refused Atlas work.") }); retire({ status: "completed" }, false); return null;
      }
      void batch.settled.then(value => {
        if (value?.status !== "uploaded" && value?.status !== "failed" && value?.status !== "device-lost") { resolveSettled({ status: "failed", error: new Error("Atlas native outcome is malformed.") }); return; }
        resolveSettled(value);
      }, error => { resolveSettled({ status: "failed", error }); report(error); });
      void batch.retired.then(value => retire(value), error => { resolveSettled({ status: "failed", error }); report(error); /* No proof: retain coordinates/GPU grant. */ });
      if (!batch.active || !current(owner)) {
        owner.releaseWanted = true; batch.cancel(new Error("Atlas admission became inactive/stale before submission."));
        return null;
      }
      return { bytes: batch.bytes, settled, retired, isCurrent: () => current(owner),
        submit() { if (!current(owner)) { owner.releaseWanted = true; batch.cancel(new Error("Atlas native generation changed before submission.")); return; } batch.submit(); },
        cancel(reason) { batch.cancel(reason); },
        release() { if (owner.releaseWanted) return; owner.releaseWanted = true; releaseOwner(owner); },
      };
    } catch (error) {
      // Renderer preparation throws only before submission. Its own admitted
      // snapshots/holds are cancelled by that public port before rethrowing.
      owner.releaseWanted = true; resolveSettled({ status: "failed", error }); retire({ status: "completed" }, false); throw error;
    }
  };

  return {
    layout,
    texture,
    table,
    capacity: layout.capacity,
    allocate() { const slot = disposed ? undefined : freeSlotList.pop(); if (slot === undefined) return null; allocatedSlots.add(slot); return slot; },
    release(slot) {
      const owner = slotOwners.get(slot);
      if (owner) { owner.releaseWanted = true; releaseOwner(owner); return; }
      if (disposed) return;
      if (slot >= 0 && slot < layout.capacity && !freeSlotList.includes(slot)) { allocatedSlots.delete(slot); freeSlotList.push(slot); }
    },
    upload(slot, levels) {
      const internal = texture.getInternalTexture();
      if (!internal) return;
      const origin = slotOrigin(layout, slot);
      for (let level = 0; level <= IMAGERY_MAX_SAMPLED_LOD && level < levels.length; level++) {
        const size = IMAGERY_SLOT_SIZE >> level;
        device.updateTextureData(internal, levels[level], origin.x >> level, origin.y >> level, size, size, 0, level, false);
      }
    },
    allocateBlock() { const block = disposed ? undefined : freeBlockList.pop(); if (block === undefined) return null; allocatedBlocks.add(block); return block; },
    releaseBlock(block) {
      const owner = blockOwners.get(block);
      if (owner) { owner.releaseWanted = true; releaseOwner(owner); return; }
      if (disposed) return;
      if (block >= 0 && block < layout.tableBlocks && !freeBlockList.includes(block)) { allocatedBlocks.delete(block); freeBlockList.push(block); }
    },
    blockOrigin: block => ({ x: (block % blocksPerRow) * IMAGERY_TABLE_BLOCK, y: Math.floor(block / blocksPerRow) * IMAGERY_TABLE_BLOCK }),
    writeBlock(block, data) {
      const internal = table.getInternalTexture();
      if (!internal) return;
      const x = (block % blocksPerRow) * IMAGERY_TABLE_BLOCK;
      const y = Math.floor(block / blocksPerRow) * IMAGERY_TABLE_BLOCK;
      device.updateTextureData(internal, data, x, y, IMAGERY_TABLE_BLOCK, IMAGERY_TABLE_BLOCK, 0, 0, false);
    },
    freeSlots: () => freeSlotList.length,
    ...(managed ? {
      whenDisposed,
      settleReplacement() { gpu?.settle(); },
      prepareOwnedUpload(image: RetainedPreparedImage): OwnedImageryUploadJob | null {
        if (!image.isCurrent()) throw new Error("Stale prepared Atlas image.");
        const pages = image.pages;
        if (!pages.length || pages.length !== (image.width / 256) * (image.height / 256)) throw new Error("Atlas image has an invalid complete page structure.");
        if (!managed.canUpload(pages.length * layout.pageUploadBytes)) return null;
        if (freeSlotList.length < pages.length) return null;
        const internal = texture.getInternalTexture(); if (!internal) throw new Error("Atlas native storage is unavailable.");
        const slots = Object.freeze(freeSlotList.splice(freeSlotList.length - pages.length).reverse());
        for (const slot of slots) allocatedSlots.add(slot);
        const regions: RawTextureBatchRegion[] = [];
        try {
          pages.forEach((levels, index) => {
            if (levels.length !== IMAGERY_MAX_SAMPLED_LOD + 1) throw new Error("Atlas page requires every sampled mip level.");
            const origin = slotOrigin(layout, slots[index]);
            for (let level = 0; level <= IMAGERY_MAX_SAMPLED_LOD; level++) {
              const size = IMAGERY_SLOT_SIZE >> level;
              if (!(levels[level] instanceof Uint8Array) || levels[level].byteLength !== size * size * 4) throw new Error("Atlas page mip bytes do not match their RGBA8 dimensions.");
              regions.push({ texture: internal, data: levels[level], x: origin.x >> level, y: origin.y >> level, width: size, height: size, faceIndex: 0, lod: level, generateMipMaps: false });
            }
          });
          const job = prepare(slots, [], regions, () => image.retain(), "imagery Atlas complete pages");
          return job ? { ...job, slots } : null;
        } catch (error) { for (const slot of slots) if (!slotOwners.has(slot) && !freeSlotList.includes(slot)) { allocatedSlots.delete(slot); freeSlotList.push(slot); } throw error; }
      },
      prepareOwnedTable(block: number, data: Uint8Array, retainInput: () => () => void): OwnedImageryTableJob | null {
        if (!Number.isSafeInteger(block) || block < 0 || block >= layout.tableBlocks || freeBlockList.includes(block) || blockOwners.has(block)) throw new Error("A managed table update needs a fresh allocated unbound block.");
        if (!(data instanceof Uint8Array) || data.byteLength !== IMAGERY_TABLE_BLOCK ** 2 * 4) throw new Error("Managed table input must be one complete RGBA8 block.");
        if (!managed.canUpload(data.byteLength)) return null;
        const internal = table.getInternalTexture(); if (!internal) throw new Error("Page-table native storage is unavailable.");
        const origin = { x: (block % blocksPerRow) * IMAGERY_TABLE_BLOCK, y: Math.floor(block / blocksPerRow) * IMAGERY_TABLE_BLOCK };
        const job = prepare([], Object.freeze([block]), [{ texture: internal, data, ...origin, width: IMAGERY_TABLE_BLOCK, height: IMAGERY_TABLE_BLOCK, faceIndex: 0, lod: 0, generateMipMaps: false }], retainInput, "imagery page-table complete block");
        return job ? { ...job, block } : null;
      },
    } : {}),
    clear() {
      epoch += 1;
      for (const owner of new Set([...slotOwners.values(), ...blockOwners.values()])) {
        owner.releaseWanted = true; releaseOwner(owner);
        if (!owner.retired) try { owner.batch?.cancel(new Error("Atlas reset retired this native generation.")); } catch (error) { report(error); }
      }
      for (const slot of [...allocatedSlots]) if (!slotOwners.has(slot)) allocatedSlots.delete(slot);
      for (const block of [...allocatedBlocks]) if (!blockOwners.has(block)) allocatedBlocks.delete(block);
      reset();
    },
    setAnisotropy(samples) {
      texture.anisotropicFilteringLevel = samples;
    },
    dispose() {
      if (disposed) return;
      disposed = true; epoch += 1;
      const errors: unknown[] = [];
      for (const owner of [...jobs]) {
        owner.releaseWanted = true;
        try { owner.batch?.cancel(new Error("Atlas disposal requested native retirement.")); } catch (error) { errors.push(error); }
      }
      try { cleanup(); } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Imagery atlas disposal failed.");
    },
  };
  } catch (error) {
    if (!managed) { finishOwnedCleanup([() => texture.dispose(), () => table?.dispose()], "Imagery atlas allocation and cleanup failed.", [error]); throw error; }
    const errors: unknown[] = [error];
    for (const action of [() => texture.dispose(), () => table?.dispose()]) try { action(); } catch (cleanup) { errors.push(cleanup); }
    // A failed native factory may own unreturned partial table storage. Even
    // successful cleanup of returned handles cannot prove that storage gone.
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Imagery managed allocation and cleanup failed; unproven storage stays charged.");
  }
}

export interface AtlasCapabilities {
  backend: ImageryBackend;
  maxTextureSize: number;
  /** The shader can clamp detail with explicit gradients. */
  explicitGradients: boolean;
}

/** The atlas for a byte budget on this backend, or null when none fits. */
export function planAtlasForBackend(capabilities: AtlasCapabilities, maxBytes: number, maxPatches: number): ImageryAtlasLayout | null {
  // The renderer's own texture limit bounds the atlas; WebGL 1 is kept small
  // and power-of-two. The byte budget, a parameter, decides within it.
  const maxTextureSize = capabilities.backend === "webgl"
    ? Math.min(4096, capabilities.maxTextureSize)
    : capabilities.maxTextureSize;
  return planAtlasLayout({ maxBytes, maxTextureSize, powerOfTwo: capabilities.backend === "webgl", maxPatches });
}
