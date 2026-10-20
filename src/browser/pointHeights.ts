/** Heights kept by exact coordinate pair, open-addressed in typed arrays so
 * that looking a point up boxes neither coordinate. -0 and 0 are one key, as
 * they are for a Map. Origins are small positive codes; 0 marks an empty slot. */
export interface PointHeights { keys: Float64Array; heights: Float64Array; origins: Uint8Array; size: number }

export function createPointHeights(capacity = 16): PointHeights {
  return { keys: new Float64Array(capacity * 2), heights: new Float64Array(capacity), origins: new Uint8Array(capacity), size: 0 };
}
const bits = new Float64Array(2), words = new Uint32Array(bits.buffer);
/** The slot keeping the point, or the empty slot it would be kept in. No NaN
 * is ever found: it equals no key. */
export function pointSlot(table: PointHeights, x: number, y: number): number {
  // -0 hashes as 0 does, and === finds either for the other.
  bits[0] = x === 0 ? 0 : x; bits[1] = y === 0 ? 0 : y;
  let hash = Math.imul(words[0] ^ Math.imul(words[1], 0x9e3779b1), 0x85ebca6b) ^ Math.imul(words[2] ^ Math.imul(words[3], 0x27d4eb2f), 0xc2b2ae35);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16;
  const { keys, origins } = table, mask = origins.length - 1;
  let slot = hash & mask;
  while (origins[slot] && (keys[slot * 2] !== x || keys[slot * 2 + 1] !== y)) slot = (slot + 1) & mask;
  return slot;
}
/** Keep a point in the empty slot pointSlot gave it. At most half the slots
 * are ever filled, so every probe ends. */
export function keepPoint(table: PointHeights, slot: number, x: number, y: number, height: number, origin: number): void {
  table.keys[slot * 2] = x; table.keys[slot * 2 + 1] = y; table.heights[slot] = height; table.origins[slot] = origin;
  if (++table.size * 2 <= table.origins.length) return;
  const { keys, heights, origins } = table, grown = createPointHeights(origins.length * 2);
  table.keys = grown.keys; table.heights = grown.heights; table.origins = grown.origins;
  for (let i = 0; i < origins.length; i++) if (origins[i]) {
    const next = pointSlot(table, keys[i * 2], keys[i * 2 + 1]);
    table.keys[next * 2] = keys[i * 2]; table.keys[next * 2 + 1] = keys[i * 2 + 1];
    table.heights[next] = heights[i]; table.origins[next] = origins[i];
  }
}
