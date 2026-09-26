import { Constants, RawTexture, Texture, type InternalTexture, type Scene } from "@babylonjs/core";
import {
  IMAGERY_MAX_SAMPLED_LOD,
  IMAGERY_SLOT_SIZE,
  IMAGERY_TABLE_BLOCK,
  planAtlasLayout,
  slotOrigin,
  type ImageryAtlasLayout,
} from "./imageryAtlasLayout";
import type { ImageryPageStore } from "./imageryResidency";

interface TextureUpdater {
  updateTextureData(texture: InternalTexture, data: ArrayBufferView, x: number, y: number, width: number, height: number, faceIndex?: number, lod?: number, generateMipMaps?: boolean): void;
}

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
export function createImageryAtlas(scene: Scene, layout: ImageryAtlasLayout, anisotropy: number): ImageryAtlas {
  const engine = scene.getEngine() as unknown as TextureUpdater;
  const texture = new RawTexture(null, layout.width, layout.height, Constants.TEXTUREFORMAT_RGBA, scene, true, false,
    Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  texture.name = "imagery-atlas";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = anisotropy;
  const tableData = new Uint8Array(layout.tableSize * layout.tableSize * 4);
  const table = new RawTexture(tableData, layout.tableSize, layout.tableSize, Constants.TEXTUREFORMAT_RGBA, scene, false, false,
    Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  table.name = "imagery-page-table";
  table.wrapU = Texture.CLAMP_ADDRESSMODE;
  table.wrapV = Texture.CLAMP_ADDRESSMODE;

  const freeSlotList: number[] = [];
  const freeBlockList: number[] = [];
  const blocksPerRow = Math.floor(layout.tableSize / IMAGERY_TABLE_BLOCK);
  const reset = (): void => {
    freeSlotList.length = 0;
    for (let slot = layout.capacity - 1; slot >= 0; slot--) freeSlotList.push(slot);
    freeBlockList.length = 0;
    for (let block = layout.tableBlocks - 1; block >= 0; block--) freeBlockList.push(block);
  };
  reset();

  return {
    layout,
    texture,
    table,
    capacity: layout.capacity,
    allocate: () => freeSlotList.pop() ?? null,
    release(slot) {
      if (slot >= 0 && slot < layout.capacity && !freeSlotList.includes(slot)) freeSlotList.push(slot);
    },
    upload(slot, levels) {
      const internal = texture.getInternalTexture();
      if (!internal) return;
      const origin = slotOrigin(layout, slot);
      for (let level = 0; level <= IMAGERY_MAX_SAMPLED_LOD && level < levels.length; level++) {
        const size = IMAGERY_SLOT_SIZE >> level;
        engine.updateTextureData(internal, levels[level], origin.x >> level, origin.y >> level, size, size, 0, level, false);
      }
    },
    allocateBlock: () => freeBlockList.pop() ?? null,
    releaseBlock(block) {
      if (block >= 0 && block < layout.tableBlocks && !freeBlockList.includes(block)) freeBlockList.push(block);
    },
    blockOrigin: block => ({ x: (block % blocksPerRow) * IMAGERY_TABLE_BLOCK, y: Math.floor(block / blocksPerRow) * IMAGERY_TABLE_BLOCK }),
    writeBlock(block, data) {
      const internal = table.getInternalTexture();
      if (!internal) return;
      const x = (block % blocksPerRow) * IMAGERY_TABLE_BLOCK;
      const y = Math.floor(block / blocksPerRow) * IMAGERY_TABLE_BLOCK;
      engine.updateTextureData(internal, data, x, y, IMAGERY_TABLE_BLOCK, IMAGERY_TABLE_BLOCK, 0, 0, false);
    },
    freeSlots: () => freeSlotList.length,
    clear: reset,
    setAnisotropy(samples) {
      texture.anisotropicFilteringLevel = samples;
    },
    dispose() {
      texture.dispose();
      table.dispose();
    },
  };
}

export interface AtlasCapabilities {
  backend: ImageryBackend;
  maxTextureSize: number;
  /** The shader can clamp detail with explicit gradients. */
  explicitGradients: boolean;
}

/** What the running engine can do for the atlas. */
export function readAtlasCapabilities(scene: Scene): AtlasCapabilities {
  const engine = scene.getEngine() as unknown as {
    isWebGPU?: boolean;
    webGLVersion?: number;
    getCaps(): { maxTextureSize: number; textureLOD?: boolean; standardDerivatives?: boolean };
  };
  const caps = engine.getCaps();
  const backend: ImageryBackend = engine.isWebGPU ? "webgpu" : engine.webGLVersion === 1 ? "webgl" : "webgl2";
  return {
    backend,
    maxTextureSize: caps.maxTextureSize,
    explicitGradients: backend !== "webgl" || Boolean(caps.textureLOD && caps.standardDerivatives),
  };
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
