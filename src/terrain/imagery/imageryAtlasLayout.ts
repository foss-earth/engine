/**
 * The paged imagery atlas: fixed 256-pixel pages, each in a slot with a
 * 16-pixel gutter so bilinear and anisotropic taps never reach a neighbouring
 * page. Every page carries its own mip chain, built from the page alone, and
 * slots stay aligned at each level down to IMAGERY_MAX_SAMPLED_LOD, which the
 * shader never exceeds. Whole-atlas mip generation would bleed pages into
 * each other and is never used.
 */

export const IMAGERY_PAGE_SIZE = 256;
export const IMAGERY_GUTTER = 16;
export const IMAGERY_SLOT_SIZE = IMAGERY_PAGE_SIZE + 2 * IMAGERY_GUTTER;
/** Slot, page and gutter all stay whole pixels down to this level (288 → 18 px). */
export const IMAGERY_MAX_SAMPLED_LOD = 4;
/** Page-table cells per terrain patch side: up to 2^6 = 64 cells, one block per patch. */
export const IMAGERY_TABLE_BLOCK = 64;
export const IMAGERY_TABLE_MAX_CELLS_LOG2 = 6;
const BYTES_PER_TEXEL = 4;
/** A full mip chain adds a third to level 0. */
const MIP_CHAIN_FACTOR = 4 / 3;

export interface ImageryAtlasLayout {
  slotsPerRow: number;
  rows: number;
  /** Pages the atlas can hold. */
  capacity: number;
  width: number;
  height: number;
  /** Levels allocated on the GPU (the full chain the backend requires). */
  mipLevels: number;
  /** Side of the square page-table texture, in texels. */
  tableSize: number;
  /** Page-table blocks: one per displayed terrain patch. */
  tableBlocks: number;
  /** Estimated GPU bytes: atlas with mips plus the page table. */
  estimatedBytes: number;
  /** Bytes one page upload writes, all sampled levels included. */
  pageUploadBytes: number;
}

export interface AtlasLayoutRequest {
  /** Estimated GPU bytes the imagery may use, page table included. */
  maxBytes: number;
  maxTextureSize: number;
  /** WebGL 1 needs power-of-two textures for mipmaps. */
  powerOfTwo: boolean;
  /** Terrain patches that may need a page-table block at once. */
  maxPatches: number;
}

function floorPowerOfTwo(value: number): number {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

export function slotBytes(): number {
  return IMAGERY_SLOT_SIZE * IMAGERY_SLOT_SIZE * BYTES_PER_TEXEL * MIP_CHAIN_FACTOR;
}

/** Bytes one page writes: its slot at every sampled level. */
export function pageUploadBytes(): number {
  let total = 0;
  for (let level = 0; level <= IMAGERY_MAX_SAMPLED_LOD; level++) total += (IMAGERY_SLOT_SIZE >> level) ** 2 * BYTES_PER_TEXEL;
  return total;
}

/**
 * The largest atlas that fits the byte budget and the backend. Null when not
 * even the minimum useful atlas fits, which the runtime reports as a backend
 * limit rather than silently falling back.
 */
export function planAtlasLayout(request: AtlasLayoutRequest): ImageryAtlasLayout | null {
  const blocksPerRow = Math.ceil(Math.sqrt(Math.max(1, request.maxPatches)));
  const tableSize = Math.min(request.maxTextureSize, floorPowerOfTwo(blocksPerRow * IMAGERY_TABLE_BLOCK * 2 - 1));
  const tableBlocks = Math.floor(tableSize / IMAGERY_TABLE_BLOCK) ** 2;
  const tableBytes = tableSize * tableSize * BYTES_PER_TEXEL;
  const atlasBudget = request.maxBytes - tableBytes;
  const maxSide = request.maxTextureSize;
  let width: number;
  let height: number;
  let slotsPerRow: number;
  let rows: number;
  if (request.powerOfTwo) {
    const side = Math.min(floorPowerOfTwo(maxSide), floorPowerOfTwo(Math.sqrt(atlasBudget / (BYTES_PER_TEXEL * MIP_CHAIN_FACTOR))));
    width = height = side;
    slotsPerRow = rows = Math.floor(side / IMAGERY_SLOT_SIZE);
  } else {
    const pages = Math.floor(atlasBudget / slotBytes());
    const maxSlots = Math.floor(maxSide / IMAGERY_SLOT_SIZE);
    slotsPerRow = Math.min(maxSlots, Math.floor(Math.sqrt(pages)));
    rows = Math.min(maxSlots, Math.floor(pages / Math.max(1, slotsPerRow)));
    width = slotsPerRow * IMAGERY_SLOT_SIZE;
    height = rows * IMAGERY_SLOT_SIZE;
  }
  const capacity = slotsPerRow * rows;
  // The 16 root pages of coverage and a little room to replace them must fit.
  if (capacity < 24 || tableBlocks < 1) return null;
  const mipLevels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  return {
    slotsPerRow,
    rows,
    capacity,
    width,
    height,
    mipLevels,
    tableSize,
    tableBlocks,
    estimatedBytes: width * height * BYTES_PER_TEXEL * MIP_CHAIN_FACTOR + tableBytes,
    pageUploadBytes: pageUploadBytes(),
  };
}

/** Top-left pixel of a slot at level 0. */
export function slotOrigin(layout: Pick<ImageryAtlasLayout, "slotsPerRow">, slot: number): { x: number; y: number } {
  return { x: (slot % layout.slotsPerRow) * IMAGERY_SLOT_SIZE, y: Math.floor(slot / layout.slotsPerRow) * IMAGERY_SLOT_SIZE };
}

/**
 * Builds one page's slot at every sampled level from RGBA pixels: `source` is
 * a `sourceWidth`×`sourceHeight` image, and the page is the square region at
 * (`x`, `y`) of `IMAGERY_PAGE_SIZE` source pixels. Gutters take the image's
 * own neighbouring pixels where they exist and repeat the edge elsewhere, and
 * each level is a box filter of the level above, so no level ever reads
 * another page.
 */
export function buildPageLevels(
  source: Uint8ClampedArray | Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
): Uint8Array[] {
  const size = IMAGERY_SLOT_SIZE;
  const level0 = new Uint8Array(size * size * BYTES_PER_TEXEL);
  for (let row = 0; row < size; row++) {
    const sy = Math.max(0, Math.min(sourceHeight - 1, y + row - IMAGERY_GUTTER));
    for (let col = 0; col < size; col++) {
      const sx = Math.max(0, Math.min(sourceWidth - 1, x + col - IMAGERY_GUTTER));
      const from = (sy * sourceWidth + sx) * BYTES_PER_TEXEL;
      const to = (row * size + col) * BYTES_PER_TEXEL;
      level0[to] = source[from];
      level0[to + 1] = source[from + 1];
      level0[to + 2] = source[from + 2];
      level0[to + 3] = source[from + 3];
    }
  }
  const levels = [level0];
  for (let level = 1; level <= IMAGERY_MAX_SAMPLED_LOD; level++) {
    const above = levels[level - 1];
    const aboveSize = size >> (level - 1);
    const side = size >> level;
    const next = new Uint8Array(side * side * BYTES_PER_TEXEL);
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const a = ((row * 2) * aboveSize + col * 2) * BYTES_PER_TEXEL;
        const b = a + BYTES_PER_TEXEL;
        const c = a + aboveSize * BYTES_PER_TEXEL;
        const d = c + BYTES_PER_TEXEL;
        const to = (row * side + col) * BYTES_PER_TEXEL;
        for (let channel = 0; channel < BYTES_PER_TEXEL; channel++) {
          next[to + channel] = (above[a + channel] + above[b + channel] + above[c + channel] + above[d + channel] + 2) >> 2;
        }
      }
    }
    levels.push(next);
  }
  return levels;
}

/**
 * The page-table entry for a page: slot index in red and green, the page's
 * absolute level in blue, and 255 in alpha for a valid entry.
 */
export function encodeTableEntry(target: Uint8Array, offset: number, slot: number, level: number): void {
  target[offset] = slot & 255;
  target[offset + 1] = (slot >> 8) & 255;
  target[offset + 2] = level;
  target[offset + 3] = 255;
}
