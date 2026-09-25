/**
 * Which resident page each part of the terrain shows. The display follows the
 * current selection only: a selected leaf shows its own image once resident,
 * otherwise its nearest resident ancestor. Finer cached pages never override
 * a coarser selection, so coarsening takes effect in one publish, and a late
 * completion cannot promote itself by becoming resident.
 *
 * Each terrain patch gets a block of the page table: 2^k × 2^k cells, one
 * texel per cell, pointing at the deepest displayed page covering the cell.
 * The shader resolves any page level against patch-local coordinates, so
 * imagery boundaries need not match terrain triangles.
 */

import { tileKey, type TileId } from "../../../terrain/imagery/imageryGeometry";
import { encodeTableEntry, IMAGERY_TABLE_BLOCK, IMAGERY_TABLE_MAX_CELLS_LOG2 } from "./imageryAtlasLayout";

export interface DisplayLeaf {
  tile: TileId;
  imageKey: string;
  /** Pages per side of the chosen image: 1 for a standard tile, 2 for a 512-pixel variant. */
  pagesPerSide: number;
}

export interface ImageryDisplayInput {
  leaves: readonly DisplayLeaf[];
  /** Root tiles kept resident as fallback coverage. */
  coverage: readonly TileId[];
  /** Slots of a resident image in row-major page order, or null. */
  slotsFor(imageKey: string): readonly number[] | null;
  /** The standard image key for a tile of the displayed source. */
  standardKey(tile: TileId): string;
  /** True when the source has said it has no such image. */
  isMissing?(imageKey: string): boolean;
}

export interface ImageryDisplay {
  /** Displayed page node "z/x/y" at the page's own level → slot and level. */
  pages: Map<string, { slot: number; z: number }>;
  /** Every strict ancestor of a displayed page node. */
  ancestors: Set<string>;
  /** Slots the display references; they must stay resident while published. */
  slots: Set<number>;
  /** Selected leaves shown by an ancestor while their own image loads; missing images do not count. */
  fallbackLeaves: number;
}

function addAncestors(ancestors: Set<string>, z: number, x: number, y: number): void {
  while (z > 0) {
    z -= 1; x >>= 1; y >>= 1;
    const key = `${z}/${x}/${y}`;
    if (ancestors.has(key)) return;
    ancestors.add(key);
  }
}

export function buildImageryDisplay(input: ImageryDisplayInput): ImageryDisplay {
  const display: ImageryDisplay = { pages: new Map(), ancestors: new Set(), slots: new Set(), fallbackLeaves: 0 };
  const show = (z: number, x: number, y: number, slot: number): void => {
    const key = `${z}/${x}/${y}`;
    if (display.pages.has(key)) return;
    display.pages.set(key, { slot, z });
    display.slots.add(slot);
    addAncestors(display.ancestors, z, x, y);
  };
  const showImage = (tile: TileId, slots: readonly number[], pagesPerSide: number): void => {
    const shift = Math.round(Math.log2(pagesPerSide));
    for (let index = 0; index < slots.length; index++) {
      const px = index % pagesPerSide, py = Math.floor(index / pagesPerSide);
      show(tile.z + shift, (tile.x << shift) + px, (tile.y << shift) + py, slots[index]);
    }
  };
  for (const root of input.coverage) {
    const slots = input.slotsFor(input.standardKey(root));
    if (slots) showImage(root, slots, 1);
  }
  for (const leaf of input.leaves) {
    const own = input.slotsFor(leaf.imageKey);
    if (own) {
      showImage(leaf.tile, own, leaf.pagesPerSide);
      continue;
    }
    if (!input.isMissing?.(leaf.imageKey)) display.fallbackLeaves += 1;
    let { z, x, y } = leaf.tile;
    while (z > 0) {
      z -= 1; x >>= 1; y >>= 1;
      const ancestor = { z, x, y };
      const slots = input.slotsFor(input.standardKey(ancestor));
      if (slots) {
        showImage(ancestor, slots, 1);
        break;
      }
    }
  }
  return display;
}

/** The deepest displayed page containing a node, looking only at the node and its ancestors. */
function inheritedPage(display: ImageryDisplay, tile: TileId): { slot: number; z: number } | null {
  let { z, x, y } = tile;
  for (;;) {
    const page = display.pages.get(`${z}/${x}/${y}`);
    if (page) return page;
    if (z === 0) return null;
    z -= 1; x >>= 1; y >>= 1;
  }
}

/** How many levels below the patch its displayed pages go, capped at the table's depth. */
export function patchTableDepth(display: ImageryDisplay, patch: TileId): { cellsLog2: number; capped: boolean } {
  let deepest = 0;
  let capped = false;
  const visit = (z: number, x: number, y: number): void => {
    const depth = z - patch.z;
    if (display.pages.has(`${z}/${x}/${y}`)) deepest = Math.max(deepest, depth);
    if (!display.ancestors.has(`${z}/${x}/${y}`)) return;
    if (depth >= IMAGERY_TABLE_MAX_CELLS_LOG2) {
      capped = true;
      return;
    }
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) visit(z + 1, x * 2 + dx, y * 2 + dy);
  };
  visit(patch.z, patch.x, patch.y);
  return { cellsLog2: Math.min(IMAGERY_TABLE_MAX_CELLS_LOG2, deepest), capped };
}

export interface PatchTable {
  cellsLog2: number;
  /** A full IMAGERY_TABLE_BLOCK² RGBA block; cells outside 2^k × 2^k stay empty. */
  data: Uint8Array;
  /** Pages deeper than the table could address were shown by their ancestors. */
  capped: boolean;
  /** Cells with no displayed page at all. */
  emptyCells: number;
}

/**
 * Fills one terrain patch's page-table block from the display, into `into`
 * when given so a patch reuses one buffer across publishes.
 */
export function buildPatchTable(display: ImageryDisplay, patch: TileId, into?: Uint8Array): PatchTable {
  const { cellsLog2, capped } = patchTableDepth(display, patch);
  const data = into ?? new Uint8Array(IMAGERY_TABLE_BLOCK * IMAGERY_TABLE_BLOCK * 4);
  if (into) into.fill(0);
  const cellLevel = patch.z + cellsLog2;
  let emptyCells = 0;
  const fill = (z: number, x: number, y: number, page: { slot: number; z: number } | null): void => {
    const own = display.pages.get(`${z}/${x}/${y}`) ?? page;
    if (z < cellLevel && display.ancestors.has(`${z}/${x}/${y}`)) {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) fill(z + 1, x * 2 + dx, y * 2 + dy, own);
      return;
    }
    const span = 2 ** (cellLevel - z);
    const cellX = x * span - patch.x * 2 ** cellsLog2;
    const cellY = y * span - patch.y * 2 ** cellsLog2;
    for (let row = cellY; row < cellY + span; row++) {
      for (let col = cellX; col < cellX + span; col++) {
        if (own) encodeTableEntry(data, (row * IMAGERY_TABLE_BLOCK + col) * 4, own.slot, own.z);
        else emptyCells += 1;
      }
    }
  };
  fill(patch.z, patch.x, patch.y, inheritedPage(display, patch));
  return { cellsLog2, data, capped, emptyCells };
}

/** The key under which the display stores a page node. */
export function displayKey(tile: TileId): string {
  return tileKey(tile);
}
