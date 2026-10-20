import { describe, expect, it } from "vitest";
import { visibleCellLeaves } from "../src/babylon/visibleCellLeaves.js";

describe("leaves of a tile index", () => {
  it("are the records no finer record's tile is inside, whatever order the levels come in", () => {
    let seed = 11;
    const random = () => (seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0) / 2 ** 32;
    for (let round = 0; round < 60; round++) {
      // Overlapping tiles at up to five levels between 0 and 26.
      const zs = [...new Set(Array.from({ length: 1 + Math.floor(random() * 5) }, () => Math.floor(random() * 27)))];
      const records = Array.from({ length: Math.floor(random() * 40) }, () => {
        const z = zs[Math.floor(random() * zs.length)], n = 2 ** z;
        // Near one corner, so that tiles of different levels nest.
        return { tile: { z, x: Math.floor(random() * Math.min(n, 4)), y: Math.floor(random() * Math.min(n, 4)) } };
      });
      const levels = (round % 2 ? zs.sort((a, b) => b - a) : zs).map(z => ({ z, n: 2 ** z, cells: new Map<number, (typeof records)[number]>() }));
      for (const record of records) {
        const level = levels.find(level => level.z === record.tile.z)!;
        level.cells.set(record.tile.y * level.n + record.tile.x, record);
      }
      const indexed = levels.flatMap(level => [...level.cells.values()]);
      const expected = indexed.filter(({ tile }) => !indexed.some(finer => finer.tile.z > tile.z
        && Math.floor(finer.tile.x / 2 ** (finer.tile.z - tile.z)) === tile.x && Math.floor(finer.tile.y / 2 ** (finer.tile.z - tile.z)) === tile.y));
      expect(new Set(visibleCellLeaves(levels))).toEqual(new Set(expected));
    }
  });
});
