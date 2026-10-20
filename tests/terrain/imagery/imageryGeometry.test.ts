import { describe, expect, it, vi } from "vitest";
import { isSphereBelowHorizon, lonLatToTileXY, tileLatDeg, tileLonDeg, tilesTouch, type TileId } from "../../../src/terrain/imagery/imageryGeometry.js";

describe("conservative sphere horizon", () => {
  // Keep the original order as an oracle, including strict inequalities at
  // the grazing and angular boundaries.
  const original = (camera: { x: number; y: number; z: number }, center: { x: number; y: number; z: number }, radius: number, occluder: number): boolean => {
    const distance = Math.hypot(camera.x, camera.y, camera.z);
    if (distance <= occluder) return false;
    const x = center.x - camera.x, y = center.y - camera.y, z = center.z - camera.z;
    const toCenter = Math.hypot(x, y, z);
    if (toCenter <= radius) return false;
    const axis = Math.acos(Math.max(-1, Math.min(1, -(x * camera.x + y * camera.y + z * camera.z) / (toCenter * distance))));
    const sphere = Math.asin(Math.min(1, radius / toCenter));
    const cone = Math.asin(occluder / distance);
    return axis + sphere < cone && toCenter - radius > Math.sqrt(distance * distance - occluder * occluder);
  };

  it("returns before angular work when the sphere cannot lie past the grazing distance", () => {
    const acos = vi.spyOn(Math, "acos");
    try {
      expect(isSphereBelowHorizon({ x: 10, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, 0, 6)).toBe(false);
      expect(acos).not.toHaveBeenCalled();
    } finally { acos.mockRestore(); }
  });

  it("preserves both strict boundaries and matches the original across globe scales", () => {
    const camera = { x: 10, y: 0, z: 0 };
    for (const delta of [-1e-12, 0, 1e-12]) {
      const center = { x: 2 + delta, y: 0, z: 0 };
      expect(isSphereBelowHorizon(camera, center, 0, 6)).toBe(original(camera, center, 0, 6));
      const angle = Math.asin(0.6) + delta;
      const tangent = { x: 10 - Math.cos(angle) * 9, y: Math.sin(angle) * 9, z: 0 };
      expect(isSphereBelowHorizon(camera, tangent, 0, 6)).toBe(original(camera, tangent, 0, 6));
    }
    let seed = 321;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 2000; trial++) {
      const scale = trial % 2 ? 1 : 6_378_137;
      const eye = { x: scale * (1 + random()), y: scale * random(), z: scale * random() };
      const center = { x: scale * (random() * 2 - 1), y: scale * (random() * 2 - 1), z: scale * (random() * 2 - 1) };
      const radius = scale * random() * 0.2;
      expect(isSphereBelowHorizon(eye, center, radius, scale)).toBe(original(eye, center, radius, scale));
    }
  });
});

describe("touching tiles", () => {
  let seed = 11;
  const random = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  /** A tile at a corner, an edge or anywhere of its level. */
  const anyTile = (maxZ: number): TileId => {
    const z = Math.floor(random() * (maxZ + 1)), n = 2 ** z;
    const at = (): number => [0, n - 1, Math.floor(random() * n)][Math.floor(random() * 3)];
    return { z, x: at(), y: at() };
  };

  it("touches each tile a point of the other lands in through latitude and longitude, both ways round", () => {
    let landed = 0;
    for (let round = 0; round < 600; round++) {
      const a = anyTile(24), z = Math.floor(random() * 25);
      for (const u of [0, 1e-13, 0.5, 1 - 1e-13, 1]) for (const v of [0, 1e-13, 0.5, 1 - 1e-13, 1]) {
        const at = lonLatToTileXY(tileLonDeg(a.z, a.x + u), tileLatDeg(a.z, a.y + v), z);
        const b = { z, x: Math.floor(at.x), y: Math.floor(at.y) };
        if (b.x < 0 || b.x >= 2 ** z || b.y < 0 || b.y >= 2 ** z) continue;
        expect(tilesTouch(a, b), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(true);
        expect(tilesTouch(b, a)).toBe(true);
        landed += 1;
      }
    }
    expect(landed).toBeGreaterThan(10_000);
  });

  it("is true exactly when one tile's cells, grown by a cell and wrapped east to west, meet the other's", () => {
    let touching = 0, apart = 0;
    for (let round = 0; round < 3000; round++) {
      const a = anyTile(6), b = anyTile(6);
      const z = Math.max(a.z, b.z), n = 2 ** z;
      const cells = (tile: TileId, grow: number): Set<string> => {
        const s = 2 ** (z - tile.z), out = new Set<string>();
        for (let x = tile.x * s - grow; x < (tile.x + 1) * s + grow; x++) for (let y = tile.y * s - grow; y < (tile.y + 1) * s + grow; y++) {
          if (y >= 0 && y < n) out.add(`${((x % n) + n) % n}/${y}`);
        }
        return out;
      };
      const grown = cells(a, 1);
      const expected = [...cells(b, 0)].some(cell => grown.has(cell));
      expect(tilesTouch(a, b), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(expected);
      expect(tilesTouch(b, a)).toBe(expected);
      if (expected) touching += 1; else apart += 1;
    }
    expect(touching).toBeGreaterThan(300);
    expect(apart).toBeGreaterThan(300);
  });

  it("joins the world's east edge to its west edge, and nothing else across it", () => {
    expect(tilesTouch({ z: 3, x: 7, y: 2 }, { z: 3, x: 0, y: 2 })).toBe(true);
    expect(tilesTouch({ z: 3, x: 7, y: 2 }, { z: 5, x: 0, y: 12 })).toBe(true);
    expect(tilesTouch({ z: 3, x: 7, y: 2 }, { z: 5, x: 0, y: 13 })).toBe(false);
    expect(tilesTouch({ z: 3, x: 6, y: 2 }, { z: 3, x: 0, y: 2 })).toBe(false);
    expect(tilesTouch({ z: 3, x: 7, y: 2 }, { z: 3, x: 1, y: 2 })).toBe(false);
    expect(tilesTouch({ z: 0, x: 0, y: 0 }, { z: 9, x: 300, y: 17 })).toBe(true);
  });
});
