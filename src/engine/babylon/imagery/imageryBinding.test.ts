import { describe, expect, it } from "vitest";
import {
  buildPageLevels,
  IMAGERY_GUTTER,
  IMAGERY_MAX_SAMPLED_LOD,
  IMAGERY_PAGE_SIZE,
  IMAGERY_SLOT_SIZE,
  IMAGERY_TABLE_BLOCK,
  planAtlasLayout,
} from "./imageryAtlasLayout";
import { buildImageryDisplay, buildPatchTable, type DisplayLeaf } from "./imageryBinding";

const MiB = 1024 * 1024;

describe("imagery atlas layout", () => {
  it("fits each resource profile inside its estimated byte budget", () => {
    for (const maxBytes of [64 * MiB, 128 * MiB, 256 * MiB]) {
      const layout = planAtlasLayout({ maxBytes, maxTextureSize: 8192, powerOfTwo: false, maxPatches: 256 })!;
      expect(layout.estimatedBytes).toBeLessThanOrEqual(maxBytes);
      expect(layout.width).toBeLessThanOrEqual(8192);
      expect(layout.capacity).toBeGreaterThanOrEqual(100);
      // Slots stay aligned at every sampled level.
      expect(layout.width % (IMAGERY_SLOT_SIZE)).toBe(0);
      expect((IMAGERY_SLOT_SIZE >> IMAGERY_MAX_SAMPLED_LOD) << IMAGERY_MAX_SAMPLED_LOD).toBe(IMAGERY_SLOT_SIZE);
    }
  });

  it("uses a smaller power-of-two atlas where the backend needs one", () => {
    const layout = planAtlasLayout({ maxBytes: 128 * MiB, maxTextureSize: 4096, powerOfTwo: true, maxPatches: 256 })!;
    expect(layout.width).toBe(4096);
    expect(layout.height).toBe(4096);
    expect(layout.capacity).toBe(14 * 14);
  });

  it("refuses an atlas too small to hold root coverage and its replacements", () => {
    expect(planAtlasLayout({ maxBytes: 4 * MiB, maxTextureSize: 8192, powerOfTwo: false, maxPatches: 256 })).toBeNull();
  });
});

describe("page levels", () => {
  function image(width: number, height: number): Uint8Array {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x & 255; data[i + 1] = y & 255; data[i + 2] = (x >> 8) * 100 + (y >> 8) * 50; data[i + 3] = 255;
    }
    return data;
  }

  it("keeps orientation, repeats edges into gutters and takes real neighbours inside larger images", () => {
    const standard = buildPageLevels(image(256, 256), 256, 256, 0, 0);
    const at = (levels: Uint8Array[], x: number, y: number) => Array.from(levels[0].slice((y * IMAGERY_SLOT_SIZE + x) * 4, (y * IMAGERY_SLOT_SIZE + x) * 4 + 3));
    expect(at(standard, IMAGERY_GUTTER, IMAGERY_GUTTER)).toEqual([0, 0, 0]);
    expect(at(standard, IMAGERY_GUTTER + 10, IMAGERY_GUTTER + 20)).toEqual([10, 20, 0]);
    expect(at(standard, 0, 0)).toEqual([0, 0, 0]);
    expect(at(standard, IMAGERY_SLOT_SIZE - 1, IMAGERY_GUTTER)).toEqual([255, 0, 0]);
    // The lower-right page of a 512-pixel variant reads its left gutter from its neighbour.
    const quadrant = buildPageLevels(image(512, 512), 512, 512, IMAGERY_PAGE_SIZE, IMAGERY_PAGE_SIZE);
    expect(at(quadrant, IMAGERY_GUTTER, IMAGERY_GUTTER)).toEqual([0, 0, 150]);
    expect(at(quadrant, IMAGERY_GUTTER - 1, IMAGERY_GUTTER)).toEqual([255, 0, 50]);
  });

  it("builds each level from the page alone", () => {
    const flat = new Uint8Array(256 * 256 * 4).fill(200);
    const levels = buildPageLevels(flat, 256, 256, 0, 0);
    expect(levels).toHaveLength(IMAGERY_MAX_SAMPLED_LOD + 1);
    for (let level = 0; level < levels.length; level++) {
      expect(levels[level].length).toBe((IMAGERY_SLOT_SIZE >> level) ** 2 * 4);
      expect(levels[level].every(value => value === 200)).toBe(true);
    }
  });
});

describe("imagery display and page tables", () => {
  const std = (tile: { z: number; x: number; y: number }) => `s/std/${tile.z}/${tile.x}/${tile.y}`;
  const roots = [0, 1, 2, 3].flatMap(y => [0, 1, 2, 3].map(x => ({ z: 2, x, y })));
  const leaf = (z: number, x: number, y: number, pagesPerSide = 1, variant = "std"): DisplayLeaf => ({ tile: { z, x, y }, imageKey: `s/${variant}/${z}/${x}/${y}`, pagesPerSide });

  function residentSlots(keys: Record<string, number[]>) {
    return (key: string) => keys[key] ?? null;
  }

  it("shows a resident leaf, and its nearest resident ancestor while it loads", () => {
    const slots: Record<string, number[]> = Object.fromEntries(roots.map((tile, index) => [std(tile), [index]]));
    slots[std({ z: 5, x: 8, y: 12 })] = [40];
    slots[std({ z: 6, x: 17, y: 24 })] = [41];
    const display = buildImageryDisplay({
      leaves: [leaf(6, 17, 24), leaf(6, 16, 24), leaf(7, 34, 50)],
      coverage: roots,
      slotsFor: residentSlots(slots),
      standardKey: std,
    });
    expect(display.pages.get("6/17/24")?.slot).toBe(41);
    expect(display.pages.get("5/8/12")?.slot).toBe(40);
    expect(display.fallbackLeaves).toBe(2);
    expect([...display.slots].sort((a, b) => a - b)).toEqual([...Array.from({ length: 16 }, (_, index) => index), 40, 41]);
  });

  it("shows an ancestor where the source has no image, without counting the leaf as loading", () => {
    const slots: Record<string, number[]> = Object.fromEntries(roots.map((tile, index) => [std(tile), [index]]));
    slots[std({ z: 5, x: 8, y: 12 })] = [40];
    const missing = std({ z: 6, x: 16, y: 24 });
    const display = buildImageryDisplay({
      leaves: [leaf(6, 16, 24), leaf(6, 17, 24)],
      coverage: roots,
      slotsFor: residentSlots(slots),
      standardKey: std,
      isMissing: key => key === missing,
    });
    expect(display.pages.get("5/8/12")?.slot).toBe(40);
    expect(display.fallbackLeaves).toBe(1);
  });

  it("never shows a finer cached page than the selection", () => {
    const slots: Record<string, number[]> = Object.fromEntries(roots.map((tile, index) => [std(tile), [index]]));
    slots[std({ z: 8, x: 64, y: 96 })] = [50];
    slots[std({ z: 7, x: 32, y: 48 })] = [51];
    const display = buildImageryDisplay({ leaves: [leaf(7, 32, 48)], coverage: roots, slotsFor: residentSlots(slots), standardKey: std });
    expect(display.pages.has("8/64/96")).toBe(false);
    expect(display.pages.get("7/32/48")?.slot).toBe(51);
  });

  it("splits a 512-pixel variant into four pages one level down", () => {
    const slots: Record<string, number[]> = Object.fromEntries(roots.map((tile, index) => [std(tile), [index]]));
    slots["s/2x/7/32/48"] = [60, 61, 62, 63];
    const display = buildImageryDisplay({ leaves: [leaf(7, 32, 48, 2, "2x")], coverage: roots, slotsFor: residentSlots(slots), standardKey: std });
    expect(display.pages.get("8/64/96")?.slot).toBe(60);
    expect(display.pages.get("8/65/96")?.slot).toBe(61);
    expect(display.pages.get("8/64/97")?.slot).toBe(62);
    expect(display.pages.get("8/65/97")?.slot).toBe(63);
  });

  it("points every cell of a patch at the deepest page covering it, finer and coarser than the patch", () => {
    const slots: Record<string, number[]> = Object.fromEntries(roots.map((tile, index) => [std(tile), [index]]));
    // A terrain patch at z6 under root 2/0/0, with one finer page inside it.
    slots[std({ z: 8, x: 1, y: 22 })] = [70];
    const display = buildImageryDisplay({ leaves: [leaf(8, 1, 22)], coverage: roots, slotsFor: residentSlots(slots), standardKey: std });
    const table = buildPatchTable(display, { z: 6, x: 0, y: 5 });
    expect(table.cellsLog2).toBe(2);
    const cell = (x: number, y: number) => Array.from(table.data.slice((y * IMAGERY_TABLE_BLOCK + x) * 4, (y * IMAGERY_TABLE_BLOCK + x) * 4 + 4));
    // z8 page (1, 22) is cell (1, 2) of the z6 patch (0, 5), whose cells are z8 tiles (0..3, 20..23).
    expect(cell(1, 2)).toEqual([70, 0, 8, 255]);
    // Everything else falls back to root 2/0/0, slot 0.
    expect(cell(0, 0)).toEqual([0, 0, 2, 255]);
    expect(cell(3, 3)).toEqual([0, 0, 2, 255]);
    // Cells beyond 2^k × 2^k stay empty.
    expect(cell(4, 0)).toEqual([0, 0, 0, 0]);
    expect(table.emptyCells).toBe(0);
  });

  it("uses one cell for a patch covered by a single coarser page", () => {
    const slots: Record<string, number[]> = Object.fromEntries(roots.map((tile, index) => [std(tile), [index]]));
    const display = buildImageryDisplay({ leaves: [], coverage: roots, slotsFor: residentSlots(slots), standardKey: std });
    const table = buildPatchTable(display, { z: 12, x: 1000, y: 1500 });
    expect(table.cellsLog2).toBe(0);
    expect(Array.from(table.data.slice(0, 4))).toEqual([4 * 0 + 0, 0, 2, 255].map((value, index) => index === 0 ? Math.floor(1500 / 1024) * 4 + Math.floor(1000 / 1024) : value));
  });

  it("caps pages deeper than the table and says so", () => {
    const slots: Record<string, number[]> = Object.fromEntries(roots.map((tile, index) => [std(tile), [index]]));
    slots[std({ z: 12, x: 0, y: 0 })] = [80];
    const display = buildImageryDisplay({ leaves: [leaf(12, 0, 0)], coverage: roots, slotsFor: residentSlots(slots), standardKey: std });
    const table = buildPatchTable(display, { z: 2, x: 0, y: 0 });
    // Ten levels below the patch is past the table's six; the root shows there.
    expect(table.capped).toBe(true);
    expect(Array.from(table.data.slice(0, 4))).toEqual([0, 0, 2, 255]);
  });

  it("marks cells with no page at all as empty", () => {
    const display = buildImageryDisplay({ leaves: [], coverage: roots, slotsFor: () => null, standardKey: std });
    expect(buildPatchTable(display, { z: 3, x: 0, y: 0 }).emptyCells).toBe(1);
  });
});
