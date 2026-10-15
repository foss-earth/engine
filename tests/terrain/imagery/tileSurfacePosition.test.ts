import { describe, expect, it } from "vitest";
import { sampleTileSurface, tileSurfacePosition, positionOnTileBasis, tileSurfaceBasis, type TileId } from "../../../src/terrain/imagery/imageryGeometry.js";

const tiles: TileId[] = [
  { z: 0, x: 0, y: 0 },
  { z: 2, x: 0, y: 0 },
  { z: 2, x: 3, y: 1 },
  { z: 8, x: 128, y: 90 },
  { z: 15, x: 0, y: 0 },
  { z: 15, x: 32767, y: 32767 },
];

describe("tile surface position", () => {
  it("matches sampleTileSurface's position at every bit, including with slopes", () => {
    const out = { x: 1, y: 2, z: 3 };
    for (const tile of tiles) for (const u of [0, 0.08, 0.5, 0.999, 1]) for (const v of [0, 0.5, 1]) for (const height of [-400, 0, 8848]) {
      const full = sampleTileSurface(tile, u, v, height, 40, -25).position;
      const only = tileSurfacePosition(tile, u, v, height);
      expect([only.x, only.y, only.z], `${tile.z}/${tile.x}/${tile.y} ${u},${v}`).toEqual([full.x, full.y, full.z]);
      expect(only.x).toBe(full.x);
      expect(only.y).toBe(full.y);
      expect(only.z).toBe(full.z);
      expect(tileSurfacePosition(tile, u, v, height, out)).toBe(out);
      expect(out.x).toBe(full.x);
      expect(out.y).toBe(full.y);
      expect(out.z).toBe(full.z);
      const fromBasis = positionOnTileBasis(tileSurfaceBasis(tile, u, v), height);
      expect(fromBasis.x).toBe(full.x);
      expect(fromBasis.y).toBe(full.y);
      expect(fromBasis.z).toBe(full.z);
    }
  });
});
