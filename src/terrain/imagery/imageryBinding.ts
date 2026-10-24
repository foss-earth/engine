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

import { tileContains, tileKey, type TileId } from "./imageryGeometry.js";
import { encodeTableEntry, IMAGERY_TABLE_BLOCK, IMAGERY_TABLE_MAX_CELLS_LOG2 } from "./imageryAtlasLayout.js";

export interface DisplayLeaf {
  tile: TileId;
  imageKey: string;
  /** Pages per side of the chosen image: 1 for a standard tile, 2 for a 512-pixel variant. */
  pagesPerSide: number;
  /** Not requested, since the source lacks an ancestor's image: its stand-in is not loading. */
  presumedMissing?: boolean;
}

export interface ImageryDisplayInput {
  leaves: readonly DisplayLeaf[];
  /** Root tiles kept resident as fallback coverage. */
  coverage: readonly TileId[];
  /** Slots of a resident image in row-major page order, or null. A build may ask once for a key it needs several times. */
  slotsFor(imageKey: string): readonly number[] | null;
  /** The standard image key for a tile of the displayed source, depending on the tile alone. */
  standardKey(tile: TileId): string;
  /** True when the source has said it has no such image. Asked once for each selected leaf not resident. */
  isMissing?(imageKey: string): boolean;
}

type DisplayedPage = { slot: number; z: number };

export interface ImageryDisplay {
  /** Displayed page node "z/x/y" at the page's own level → slot and level. */
  readonly pages: ReadonlyMap<string, DisplayedPage>;
  /** Every strict ancestor of a displayed page node. */
  readonly ancestors: ReadonlySet<string>;
  /** Slots the display references; they must stay resident while published. */
  slots: Set<number>;
  /** Selected leaves shown by an ancestor while their own image loads; missing images do not count. */
  fallbackLeaves: number;
  /**
   * Source-image key for each slot this display adopted. A slot claimed by two
   * images is left out: a reused slot number is not an identity.
   */
  slotImages: Map<number, string>;
  /** Slots whose image key collided inside this display. */
  ambiguousSlots: Set<number>;
}

function addAncestors(ancestors: Set<string>, z: number, x: number, y: number): void {
  while (z > 0) {
    z -= 1; x >>= 1; y >>= 1;
    const key = `${z}/${x}/${y}`;
    if (ancestors.has(key)) return;
    ancestors.add(key);
  }
}

// The tree holds levels 0–30, so a node's x and y stay inside 32-bit shifts.
const TREE_LEVELS = 30;
// Node flags: a displayed page lies strictly below; a fallback search passed here.
const ANCESTOR = 1, SEARCHED = 2;

/** Whether a node is on the tree: an integer level 0–30 and integer coordinates on that level's grid. */
function inTree(z: number, x: number, y: number): boolean {
  return (z | 0) === z && z >= 0 && z <= TREE_LEVELS && (x | 0) === x && (y | 0) === y && x >= 0 && y >= 0 && x < 1 << z && y < 1 << z;
}

/**
 * The display's page nodes as a quadtree, so building and reading it make no
 * string keys. Node 0 is the root tile; nodes are made only on the way to a
 * displayed page or a searched leaf, so a node without a page or the
 * ancestor flag is the same as no node.
 */
class PageTree {
  /** Four child nodes per node, in (dy, dx) order; 0 is none, since the root is no node's child. */
  kids = new Int32Array(1024);
  flags = new Uint8Array(256);
  pages: Array<DisplayedPage | undefined> = [undefined];
  count = 1;

  private add(): number {
    const node = this.count++;
    if (node === this.flags.length) {
      const kids = new Int32Array(this.kids.length * 2), flags = new Uint8Array(this.flags.length * 2);
      kids.set(this.kids); flags.set(this.flags);
      this.kids = kids; this.flags = flags;
    }
    this.pages.push(undefined);
    return node;
  }

  /** The node at a tree position, made with its ancestors when absent; every node above it is flagged as an ancestor when `ancestors`. */
  make(z: number, x: number, y: number, ancestors: boolean): number {
    let node = 0;
    for (let level = z - 1; level >= 0; level--) {
      if (ancestors) this.flags[node] |= ANCESTOR;
      const at = node * 4 + (((y >> level) & 1) << 1 | ((x >> level) & 1));
      let next = this.kids[at];
      if (next === 0) { next = this.add(); this.kids[at] = next; }
      node = next;
    }
    return node;
  }

  /** Fills `into` with the nodes from the root down to a tree position's parent, by level, making them when absent. */
  ancestorsOf(z: number, x: number, y: number, into: Int32Array): void {
    let node = 0;
    for (let level = 0; level < z; level++) {
      into[level] = node;
      if (level === z - 1) break;
      const shift = z - level - 1;
      const at = node * 4 + (((y >> shift) & 1) << 1 | ((x >> shift) & 1));
      let next = this.kids[at];
      if (next === 0) { next = this.add(); this.kids[at] = next; }
      node = next;
    }
  }

  /** The node at a tree position, or -1. */
  find(z: number, x: number, y: number): number {
    let node = 0;
    for (let level = z - 1; level >= 0; level--) {
      node = this.kids[node * 4 + (((y >> level) & 1) << 1 | ((x >> level) & 1))];
      if (node === 0) return -1;
    }
    return node;
  }

  /** The deepest page on the way from the root to a tree position, the position's own included. */
  deepestPage(z: number, x: number, y: number): DisplayedPage | undefined {
    let node = 0, page = this.pages[0];
    for (let level = z - 1; level >= 0; level--) {
      node = this.kids[node * 4 + (((y >> level) & 1) << 1 | ((x >> level) & 1))];
      if (node === 0) break;
      page = this.pages[node] ?? page;
    }
    return page;
  }
}

class TreeDisplay implements ImageryDisplay {
  slots = new Set<number>();
  fallbackLeaves = 0;
  slotImages = new Map<number, string>();
  ambiguousSlots = new Set<number>();
  readonly tree = new PageTree();
  /** Pages off the tree's grid, which no real tile reaches; with any, queries take the string-keyed path. */
  offTree: Map<string, DisplayedPage> | null = null;
  /** Every displayed page in the order shown, and its x and y, for the string-keyed views. */
  readonly shown: DisplayedPage[] = [];
  readonly shownAt: number[] = [];
  private keyed: { pages: Map<string, DisplayedPage>; ancestors: Set<string> } | null = null;

  get pages(): ReadonlyMap<string, DisplayedPage> { return (this.keyed ??= this.keyedViews()).pages; }
  get ancestors(): ReadonlySet<string> { return (this.keyed ??= this.keyedViews()).ancestors; }

  /** The string-keyed maps, filled in the order the pages were shown, as a build without the tree fills them. */
  private keyedViews(): { pages: Map<string, DisplayedPage>; ancestors: Set<string> } {
    const pages = new Map<string, DisplayedPage>(), ancestors = new Set<string>();
    for (let index = 0; index < this.shown.length; index++) {
      const page = this.shown[index], x = this.shownAt[index * 2], y = this.shownAt[index * 2 + 1];
      pages.set(`${page.z}/${x}/${y}`, page);
      addAncestors(ancestors, page.z, x, y);
    }
    return { pages, ancestors };
  }
}

/** A display's tree when every page is on it; null sends a query down the string-keyed path. */
function treeOf(display: ImageryDisplay): PageTree | null {
  return display instanceof TreeDisplay && display.offTree === null ? display.tree : null;
}

export function buildImageryDisplay(input: ImageryDisplayInput): ImageryDisplay {
  const display = new TreeDisplay();
  const tree = display.tree;
  const remember = (slot: number, imageKey: string): void => {
    if (display.ambiguousSlots.has(slot)) return;
    const existing = display.slotImages.get(slot);
    if (existing === undefined) display.slotImages.set(slot, imageKey);
    else if (existing !== imageKey) {
      display.slotImages.delete(slot);
      display.ambiguousSlots.add(slot);
    }
  };
  const show = (z: number, x: number, y: number, slot: number): void => {
    let page: DisplayedPage;
    if (inTree(z, x, y)) {
      const node = tree.make(z, x, y, true);
      if (tree.pages[node] !== undefined) return;
      tree.pages[node] = page = { slot, z };
    } else {
      const key = `${z}/${x}/${y}`;
      if (display.offTree?.has(key)) return;
      (display.offTree ??= new Map()).set(key, page = { slot, z });
    }
    display.shown.push(page); display.shownAt.push(x, y);
    display.slots.add(slot);
  };
  const showImage = (tile: TileId, slots: readonly number[], pagesPerSide: number, imageKey: string): void => {
    const shift = Math.round(Math.log2(pagesPerSide));
    for (let index = 0; index < slots.length; index++) {
      const px = index % pagesPerSide, py = Math.floor(index / pagesPerSide);
      remember(slots[index], imageKey);
      show(tile.z + shift, (tile.x << shift) + px, (tile.y << shift) + py, slots[index]);
    }
  };
  for (const root of input.coverage) {
    const key = input.standardKey(root);
    const slots = input.slotsFor(key);
    if (slots) showImage(root, slots, 1, key);
  }
  const path = new Int32Array(TREE_LEVELS);
  for (const leaf of input.leaves) {
    const own = input.slotsFor(leaf.imageKey);
    if (own) {
      showImage(leaf.tile, own, leaf.pagesPerSide, leaf.imageKey);
      continue;
    }
    if (!leaf.presumedMissing && !input.isMissing?.(leaf.imageKey)) display.fallbackLeaves += 1;
    let { z, x, y } = leaf.tile;
    if (inTree(z, x, y)) {
      // Search up from the parent for the nearest resident ancestor. A search
      // reaching a node an earlier leaf searched stops there: the rest of its
      // path, and the page it would show again, are the same.
      tree.ancestorsOf(z, x, y, path);
      for (let level = z - 1; level >= 0; level--) {
        const node = path[level];
        if (tree.flags[node] & SEARCHED) break;
        tree.flags[node] |= SEARCHED;
        const ancestor = { z: level, x: x >> (z - level), y: y >> (z - level) };
        const key = input.standardKey(ancestor);
        const slots = input.slotsFor(key);
        if (slots) {
          showImage(ancestor, slots, 1, key);
          break;
        }
      }
      continue;
    }
    while (z > 0) {
      z -= 1; x >>= 1; y >>= 1;
      const ancestor = { z, x, y };
      const slots = input.slotsFor(input.standardKey(ancestor));
      if (slots) {
        showImage(ancestor, slots, 1, input.standardKey(ancestor));
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

/** The page shown over a node: its own, else its nearest displayed ancestor's. */
export function shownPage(display: ImageryDisplay, tile: TileId): DisplayedPage | undefined {
  let { z, x, y } = tile;
  const tree = treeOf(display);
  if (tree && inTree(z, x, y)) return tree.deepestPage(z, x, y);
  while (z >= 0) {
    const page = display.pages.get(`${z}/${x}/${y}`);
    if (page) return page;
    if (z === 0) break;
    z -= 1; x >>= 1; y >>= 1;
  }
  return undefined;
}

/** How many levels below the patch its displayed pages go, capped at the table's depth. */
export function patchTableDepth(display: ImageryDisplay, patch: TileId): { cellsLog2: number; capped: boolean } {
  let deepest = 0;
  let capped = false;
  const tree = treeOf(display);
  if (tree && inTree(patch.z, patch.x, patch.y)) {
    const { kids, flags, pages } = tree;
    const visitNode = (node: number, depth: number): void => {
      // As below: neither result changes once both bounds are known.
      if (capped && deepest === IMAGERY_TABLE_MAX_CELLS_LOG2) return;
      if (pages[node] !== undefined) deepest = Math.max(deepest, depth);
      if ((flags[node] & ANCESTOR) === 0) return;
      if (depth >= IMAGERY_TABLE_MAX_CELLS_LOG2) {
        capped = true;
        return;
      }
      for (let at = node * 4; at < node * 4 + 4; at++) if (kids[at] !== 0) visitNode(kids[at], depth + 1);
    };
    const node = tree.find(patch.z, patch.x, patch.y);
    if (node >= 0) visitNode(node, 0);
    return { cellsLog2: Math.min(IMAGERY_TABLE_MAX_CELLS_LOG2, deepest), capped };
  }
  const visit = (z: number, x: number, y: number): void => {
    // Neither result can change once a page reaches the table's last level
    // and a descendant beyond that level has been found.
    if (capped && deepest === IMAGERY_TABLE_MAX_CELLS_LOG2) return;
    const depth = z - patch.z;
    const key = `${z}/${x}/${y}`;
    if (display.pages.has(key)) deepest = Math.max(deepest, depth);
    if (!display.ancestors.has(key)) return;
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

/** A visible region measured in render pixels per pixel of its reference page. */
export interface LoadedImageryRegion {
  tile: TileId;
  referenceLevel: number;
  footprintPx: number;
  screenArea: number;
}

/** What a terrain material actually samples, including table-budget fallback. */
export interface LoadedImageryBinding {
  tile: TileId;
  table: Pick<PatchTable, "cellsLog2" | "data"> | null;
  directLevel: number | null;
  /**
   * Source-image key for each atlas slot at the moment this material adopted
   * the table. Copied then, so a later reuse of the slot number is ignored.
   * Absent when identity was not recorded.
   */
  imagesBySlot?: ReadonlyMap<number, string>;
  /**
   * Image key of a table-less binding. Null when the patch shows no page.
   * Absent when a page is shown but its image could not be named.
   */
  directImage?: string | null;
}

/** A classified imagery population before it is wrapped as a delivery snapshot. */
export interface ImageryDistributionDraft {
  status: "measured" | "empty" | "unavailable";
  reason?: string;
  samples: Array<{ value: number; count: number }>;
  tileCount: number;
  unknownCount: number;
  incomplete: boolean;
}

/**
 * Visible-area estimate in binary detail offsets: zero is one render pixel
 * per imagery pixel. Average logarithmic sampling density, rather than tile
 * counts or residency percentages. Within a selected region, table cells
 * share its estimated screen area in proportion to their Mercator area.
 * Missing bound coverage makes the estimate unavailable.
 */
export function measureLoadedImagery(regions: readonly LoadedImageryRegion[], bindings: readonly LoadedImageryBinding[], normalTargetPx = 1): number | null {
  const patches = new Map(bindings.map(binding => [tileKey(binding.tile), binding]));
  const ancestors = new Set<string>();
  for (const binding of bindings) addAncestors(ancestors, binding.tile.z, binding.tile.x, binding.tile.y);
  let weighted = 0, area = 0;
  let missing = false;
  for (const region of regions) {
    if (!(region.screenArea > 0)) continue;
    // A region crossing the near plane can have unbounded projected size.
    // Its bound imagery is real but beyond the coarse end of the rail.
    if (!(region.footprintPx > 0)) { missing = true; continue; }
    const base = Math.log2(normalTargetPx / region.footprintPx) - region.referenceLevel;
    const add = (level: number | null, fraction: number): void => {
      if (level === null) { missing = true; return; }
      const weight = region.screenArea * fraction;
      weighted += weight * (base + level);
      area += weight;
    };
    const sample = (binding: LoadedImageryBinding, intersection: TileId): void => {
      const fraction = 4 ** (region.tile.z - intersection.z);
      if (!binding.table) { add(binding.directLevel, fraction); return; }
      const { cellsLog2, data } = binding.table;
      const cellLevel = binding.tile.z + cellsLog2;
      const count = 2 ** Math.max(0, cellLevel - intersection.z);
      const scale = 2 ** (cellLevel - intersection.z);
      const startX = Math.floor(intersection.x * scale) - binding.tile.x * 2 ** cellsLog2;
      const startY = Math.floor(intersection.y * scale) - binding.tile.y * 2 ** cellsLog2;
      for (let y = startY; y < startY + count; y++) for (let x = startX; x < startX + count; x++) {
        const index = (y * IMAGERY_TABLE_BLOCK + x) * 4;
        add(data[index + 3] === 255 ? data[index + 2] : null, fraction / (count * count));
      }
    };
    let { z, x, y } = region.tile;
    let covering: LoadedImageryBinding | undefined;
    for (;;) {
      covering = patches.get(`${z}/${x}/${y}`);
      if (covering || z === 0) break;
      z--; x >>= 1; y >>= 1;
    }
    if (covering) { sample(covering, region.tile); continue; }
    const descend = (tile: TileId): void => {
      const key = tileKey(tile);
      const patch = patches.get(key);
      if (patch) { sample(patch, tile); return; }
      if (!ancestors.has(key)) { missing = true; return; }
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) descend({ z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy });
    };
    descend(region.tile);
  }
  return !missing && area > 0 ? weighted / area : null;
}

function tableSlot(data: Uint8Array, index: number): number {
  return data[index] + data[index + 1] * 256;
}

function pageAt(tile: TileId, level: number): TileId {
  const shift = tile.z - level;
  if (shift >= 0) return { z: level, x: tile.x >> shift, y: tile.y >> shift };
  return { z: level, x: tile.x << -shift, y: tile.y << -shift };
}

/** Each table column's last page in rows above, as level and page row; level −1 for none. */
const pagesAbove = new Int32Array(IMAGERY_TABLE_BLOCK * 2);

/**
 * Page tiles sampled by adopted bindings. The distribution measures these,
 * not the requested plan's leaves, so a new request cannot move a bar by
 * repartitioning before different imagery is bound.
 */
export function loadedImageryPages(bindings: readonly LoadedImageryBinding[]): TileId[] {
  const pages = new Map<string, TileId>();
  const add = (tile: TileId): void => { pages.set(tileKey(tile), tile); };
  for (const binding of bindings) {
    if (!binding.table) {
      if (binding.directLevel !== null) add(pageAt(binding.tile, binding.directLevel));
      continue;
    }
    const { cellsLog2, data } = binding.table;
    const side = 2 ** cellsLog2;
    const cellLevel = binding.tile.z + cellsLog2;
    // A page already added adds nothing new, so a cell showing the last page
    // left of it or above it builds no key. At one level, the cells of a row
    // share a page row and the cells of a column a page column.
    pagesAbove.fill(-1);
    for (let y = 0; y < side; y++) {
      let leftLevel = -1, leftX = 0;
      for (let x = 0; x < side; x++) {
        const index = (y * IMAGERY_TABLE_BLOCK + x) * 4;
        if (data[index + 3] !== 255) continue;
        // `pageAt` of the cell.
        const level = data[index + 2], shift = cellLevel - level;
        const cellX = binding.tile.x * side + x, cellY = binding.tile.y * side + y;
        const pageX = shift >= 0 ? cellX >> shift : cellX << -shift, pageY = shift >= 0 ? cellY >> shift : cellY << -shift;
        const above = x < IMAGERY_TABLE_BLOCK ? x * 2 : -1;
        if (!(level === leftLevel && pageX === leftX) && !(above >= 0 && level === pagesAbove[above] && pageY === pagesAbove[above + 1])) {
          add({ z: level, x: pageX, y: pageY });
        }
        leftLevel = level; leftX = pageX;
        if (above >= 0) { pagesAbove[above] = level; pagesAbove[above + 1] = pageY; }
      }
    }
  }
  return [...pages.values()];
}

/**
 * One count per source image sampled by the bindings. A 512 px image spread
 * across four pages, and one image repeated across cells or patches, counts
 * once. Its position is the visible-area-weighted mean of
 * `log2(normalTargetPx / footprintPx) + boundPageLevel − referenceLevel`
 * inside that image. A bad projection makes the whole image unknown. Missing
 * coverage sets `incomplete` and does not invent a tile. If a sampled page
 * has no image identity, the result is unavailable rather than a guessed total.
 */
export function measureLoadedImageryDistribution(
  regions: readonly LoadedImageryRegion[],
  bindings: readonly LoadedImageryBinding[],
  normalTargetPx = 1,
): ImageryDistributionDraft {
  const unavailable = (reason: string): ImageryDistributionDraft => ({ status: "unavailable", reason, samples: [], tileCount: 0, unknownCount: 0, incomplete: false });
  const patches = new Map(bindings.map(binding => [tileKey(binding.tile), binding]));
  const ancestors = new Set<string>();
  for (const binding of bindings) addAncestors(ancestors, binding.tile.z, binding.tile.x, binding.tile.y);
  const groups = new Map<string, { weighted: number; weight: number; unknown: boolean }>();
  let incomplete = false;
  let identityFailed = false;
  let usableFootprint = false, logarithm = 0;
  const note = (image: string | null | undefined, level: number | null, fraction: number, region: LoadedImageryRegion): void => {
    if (!(fraction > 0) || !(region.screenArea > 0)) return;
    if (level === null || image === null) { incomplete = true; return; }
    if (image === undefined) { identityFailed = true; return; }
    let group = groups.get(image);
    if (!group) groups.set(image, group = { weighted: 0, weight: 0, unknown: false });
    if (!usableFootprint) { group.unknown = true; return; }
    const value = logarithm + level - region.referenceLevel;
    const weight = region.screenArea * fraction;
    group.weighted += weight * value;
    group.weight += weight;
  };
  const sample = (binding: LoadedImageryBinding, intersection: TileId, region: LoadedImageryRegion): void => {
    const fraction = 4 ** (region.tile.z - intersection.z);
    if (!binding.table) {
      note(binding.directLevel === null ? null : binding.directImage, binding.directLevel, fraction, region);
      return;
    }
    if (!binding.imagesBySlot) { identityFailed = true; return; }
    const { cellsLog2, data } = binding.table;
    const cellLevel = binding.tile.z + cellsLog2;
    const count = 2 ** Math.max(0, cellLevel - intersection.z);
    const scale = 2 ** (cellLevel - intersection.z);
    const startX = Math.floor(intersection.x * scale) - binding.tile.x * 2 ** cellsLog2;
    const startY = Math.floor(intersection.y * scale) - binding.tile.y * 2 ** cellsLog2;
    const cellFraction = fraction / (count * count);
    for (let y = startY; y < startY + count; y++) for (let x = startX; x < startX + count; x++) {
      const index = (y * IMAGERY_TABLE_BLOCK + x) * 4;
      if (data[index + 3] !== 255) { note(null, null, cellFraction, region); continue; }
      const slot = tableSlot(data, index);
      note(binding.imagesBySlot.get(slot), data[index + 2], cellFraction, region);
    }
  };
  for (const region of regions) {
    if (!(region.screenArea > 0)) continue;
    // Every cell sampled for this region uses the same projected footprint.
    const footprint = region.footprintPx;
    usableFootprint = footprint === Infinity || (Number.isFinite(footprint) && footprint > 0);
    logarithm = usableFootprint ? Math.log2(normalTargetPx / footprint) : 0;
    let { z, x, y } = region.tile;
    let covering: LoadedImageryBinding | undefined;
    for (;;) {
      covering = patches.get(`${z}/${x}/${y}`);
      if (covering || z === 0) break;
      z -= 1; x >>= 1; y >>= 1;
    }
    if (covering) { sample(covering, region.tile, region); continue; }
    const descend = (tile: TileId): void => {
      const key = tileKey(tile);
      const patch = patches.get(key);
      if (patch) { sample(patch, tile, region); return; }
      if (!ancestors.has(key)) { incomplete = true; return; }
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) descend({ z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy });
    };
    descend(region.tile);
  }
  if (identityFailed) return unavailable("Imagery identity could not be recovered, so tiles were not counted.");
  const samples: Array<{ value: number; count: number }> = [];
  let unknownCount = 0;
  for (const group of groups.values()) {
    if (group.unknown || !(group.weight > 0)) { unknownCount += 1; continue; }
    const value = group.weighted / group.weight;
    if (value !== Infinity && value !== -Infinity && !Number.isFinite(value)) { unknownCount += 1; continue; }
    samples.push({ value, count: 1 });
  }
  const tileCount = samples.reduce((sum, sample) => sum + sample.count, 0) + unknownCount;
  if (tileCount === 0 && unknownCount === 0 && !incomplete) return { status: "empty", samples: [], tileCount: 0, unknownCount: 0, incomplete: false };
  return { status: "measured", samples, tileCount, unknownCount, incomplete };
}

/**
 * The page level materials sample for a region, read from the published
 * bindings rather than the display, so table exhaustion and depth caps
 * count: at the region's centre in the bound patch containing it, or else the
 * coarsest level in the bound patches it contains. Null where no bound patch
 * covers it or a covering cell has no page.
 */
export function createBoundLevels(bindings: readonly LoadedImageryBinding[]): (tile: TileId) => number | null {
  const patches = new Map(bindings.map(binding => [tileKey(binding.tile), binding]));
  const levelAt = (binding: LoadedImageryBinding, tile: TileId): number | null => {
    if (!binding.table) return binding.directLevel;
    const { cellsLog2, data } = binding.table;
    const scale = 2 ** (binding.tile.z + cellsLog2 - tile.z);
    const x = Math.floor((tile.x + 0.5) * scale) - binding.tile.x * 2 ** cellsLog2;
    const y = Math.floor((tile.y + 0.5) * scale) - binding.tile.y * 2 ** cellsLog2;
    const index = (y * IMAGERY_TABLE_BLOCK + x) * 4;
    return data[index + 3] === 255 ? data[index + 2] : null;
  };
  return tile => {
    let { z, x, y } = tile;
    for (;;) {
      const binding = patches.get(`${z}/${x}/${y}`);
      if (binding) return levelAt(binding, tile);
      if (z === 0) break;
      z -= 1; x >>= 1; y >>= 1;
    }
    let coarsest: number | null = null;
    for (const binding of bindings) {
      if (!tileContains(tile, binding.tile)) continue;
      const level = levelAt(binding, binding.tile);
      if (level === null) return null;
      coarsest = coarsest === null ? level : Math.min(coarsest, level);
    }
    return coarsest;
  };
}

/**
 * Fills one terrain patch's page-table block from the display, into `into`
 * when given so a patch reuses one buffer across publishes. `depth` is the
 * patch's patchTableDepth, when the caller has it already.
 */
export function buildPatchTable(display: ImageryDisplay, patch: TileId, into?: Uint8Array, depth = patchTableDepth(display, patch)): PatchTable {
  const { cellsLog2, capped } = depth;
  const data = into ?? new Uint8Array(IMAGERY_TABLE_BLOCK * IMAGERY_TABLE_BLOCK * 4);
  if (into) into.fill(0);
  const cellLevel = patch.z + cellsLog2;
  let emptyCells = 0;
  /** Points every cell under a node at its page. */
  const cover = (z: number, x: number, y: number, own: { slot: number; z: number } | null | undefined): void => {
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
  const tree = treeOf(display);
  if (tree && inTree(patch.z, patch.x, patch.y)) {
    const { kids, flags, pages } = tree;
    // `node` is -1 where the tree has no node, which holds no page.
    const fillNode = (node: number, z: number, x: number, y: number, page: DisplayedPage | undefined): void => {
      const own = (node < 0 ? undefined : pages[node]) ?? page;
      if (z < cellLevel && node >= 0 && (flags[node] & ANCESTOR) !== 0) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) fillNode(kids[node * 4 + dy * 2 + dx] || -1, z + 1, x * 2 + dx, y * 2 + dy, own);
        return;
      }
      cover(z, x, y, own);
    };
    fillNode(tree.find(patch.z, patch.x, patch.y), patch.z, patch.x, patch.y, tree.deepestPage(patch.z, patch.x, patch.y));
    return { cellsLog2, data, capped, emptyCells };
  }
  const fill = (z: number, x: number, y: number, page: { slot: number; z: number } | null): void => {
    const own = display.pages.get(`${z}/${x}/${y}`) ?? page;
    if (z < cellLevel && display.ancestors.has(`${z}/${x}/${y}`)) {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) fill(z + 1, x * 2 + dx, y * 2 + dy, own);
      return;
    }
    cover(z, x, y, own);
  };
  fill(patch.z, patch.x, patch.y, inheritedPage(display, patch));
  return { cellsLog2, data, capped, emptyCells };
}

/**
 * Whether two tables buildPatchTable filled at the same `cellsLog2` are equal.
 * Both are empty outside their 2^k × 2^k used cells, so only those are read.
 * The comparison is exact: a hash of the cells can collide, and a collision
 * would leave a stale table bound.
 */
export function samePatchTableCells(a: Uint8Array, b: Uint8Array, cellsLog2: number): boolean {
  const rowBytes = 4 * 2 ** cellsLog2;
  for (let start = 0, end = IMAGERY_TABLE_BLOCK * 4 * 2 ** cellsLog2; start < end; start += IMAGERY_TABLE_BLOCK * 4) {
    for (let index = start; index < start + rowBytes; index++) if (a[index] !== b[index]) return false;
  }
  return true;
}

/** The key under which the display stores a page node. */
export function displayKey(tile: TileId): string {
  return tileKey(tile);
}
