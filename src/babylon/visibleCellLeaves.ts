import type { TerrainTile } from "../terrain/terrainGrid.js";

/**
 * The records no finer record's tile is inside, from each level's records by
 * row * 2^z + column. A walk of the levels that stops at the first record
 * holding a point finds a leaf again for every point in the leaf's tile: no
 * finer level holds one there, and a coarser one would have held the first.
 */
export function visibleCellLeaves<T extends { tile: TerrainTile }>(levels: ReadonlyArray<{ z: number; n: number; cells: ReadonlyMap<number, T> }>): Set<T> {
  // Every record marks the cell it is in at each coarser level.
  const inner = levels.map(() => new Set<number>());
  for (const { z, cells } of levels) for (const { tile } of cells.values()) levels.forEach((coarser, j) => {
    if (coarser.z >= z) return;
    const scale = 2 ** (z - coarser.z);
    inner[j].add(Math.floor(tile.y / scale) * coarser.n + Math.floor(tile.x / scale));
  });
  const leaves = new Set<T>();
  levels.forEach(({ cells }, i) => { for (const [cell, record] of cells) if (!inner[i].has(cell)) leaves.add(record); });
  return leaves;
}
