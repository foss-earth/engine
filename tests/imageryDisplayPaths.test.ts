import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  buildImageryDisplay, buildPatchTable, patchTableDepth, shownPage,
  type DisplayLeaf,
} from "../src/terrain/imagery/imageryBinding.js";
import type { TileId } from "../src/terrain/imagery/imageryGeometry.js";

// Taken from the root-walking implementation before the path-prefix change.
const SHIPPED_DIGEST = "882897beeb4146e51b5344d8113fe99ec6e4d0f2c41cf1fd5dd58dcd46827f57";

it("keeps imagery pages, callback order and table bytes across shared and unrelated ancestor paths", () => {
  let seed = 0x9e3779b9;
  const random = (n: number): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  const key = (tile: TileId): string => `s/${tile.z}/${tile.x}/${tile.y}`;
  const digest = createHash("sha256");
  const record = (value: unknown): void => { digest.update(JSON.stringify(value)); digest.update("\n"); };
  for (let trial = 0; trial < 32; trial++) {
    const slots = new Map<string, number[]>();
    const leaves: DisplayLeaf[] = [];
    const missing = new Set<string>();
    let slot = 0;
    const add = (tile: TileId, pagesPerSide = 1): void => {
      const imageKey = `${key(tile)}@${pagesPerSide}`;
      leaves.push({ tile, imageKey, pagesPerSide });
      if (random(4) === 0) slots.set(imageKey, Array.from({ length: pagesPerSide ** 2 }, () => random(5) ? slot++ : random(8)));
      if (random(7) === 0) missing.add(imageKey);
      if (random(9) === 0) leaves.at(-1)!.presumedMissing = true;
      // Several possible fallback levels, distinct from the selected image.
      for (let z = tile.z - 1, x = tile.x >> 1, y = tile.y >> 1; z >= 0; z--, x >>= 1, y >>= 1) {
        if (random(9) === 0) slots.set(key({ z, x, y }), [slot++]);
      }
    };
    // Same path at different depths, siblings in both axes, opposite sides of
    // the globe, and levels 0 and 30 exercise the full integer-key range.
    for (const z of [30, 29, 30, 1, 0, 2, 15, 30, 3, 8, 7, 8]) {
      add({ z, x: 2 ** z - 1, y: 2 ** z - 1 });
      add({ z, x: 0, y: 0 });
      add({ z, x: 2 ** z - 1, y: 0 });
      add({ z, x: 0, y: 2 ** z - 1 });
    }
    const focus = { z: 24, x: random(2 ** 24), y: random(2 ** 24) };
    for (let i = 0; i < 160; i++) {
      const z = random(3) ? 20 + random(11) : random(31), scale = 2 ** (z - focus.z);
      const x = Math.min(2 ** z - 1, Math.floor(focus.x * scale) + (scale > 1 ? random(scale) : 0));
      const y = Math.min(2 ** z - 1, Math.floor(focus.y * scale) + (scale > 1 ? random(scale) : 0));
      add({ z, x, y }, random(4) ? 1 : 2);
    }
    // Creating pages (including variants) between searches must not invalidate
    // their node identities, even after the tree's typed arrays grow.
    const coverage = [{ z: 0, x: 0, y: 0 }];
    if (trial % 2) slots.set(key(coverage[0]), [slot++]);
    const calls: string[] = [];
    const display = buildImageryDisplay({
      leaves, coverage,
      standardKey: tile => { const result = key(tile); calls.push(`key:${result}`); return result; },
      slotsFor: imageKey => { calls.push(`slots:${imageKey}`); return slots.get(imageKey) ?? null; },
      isMissing: imageKey => { calls.push(`missing:${imageKey}`); return missing.has(imageKey); },
    });
    record(calls);
    record([display.fallbackLeaves, [...display.slots], [...display.slotImages], [...display.ambiguousSlots]]);
    const scratch = new Uint8Array(64 * 64 * 4);
    for (const tile of [...coverage, ...leaves.filter((_, index) => index % 4 === 0).map(leaf => leaf.tile)]) {
      const depth = patchTableDepth(display, tile);
      scratch.fill(71);
      const table = buildPatchTable(display, tile, scratch, depth);
      record([tile, shownPage(display, tile), depth, table.cellsLog2, table.emptyCells, table.capped]);
      digest.update(table.data);
    }
    record([...display.pages]);
    record([...display.ancestors]);
  }
  expect(digest.digest("hex")).toBe(SHIPPED_DIGEST);
});
