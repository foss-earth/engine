import { describe, expect, it, vi } from "vitest";
import { clipOutcode, hullSphere, isSphereBelowHorizon, lonLatToTileXY, outcode, projectedPixelFootprint, tileLatDeg, tileLonDeg, tilesTouch, toClip, type ImageryView, type SurfaceSample, type TileId } from "../../../src/terrain/imagery/imageryGeometry.js";

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

describe("clip outcodes", () => {
  it("gives the outcode of the clip point toClip makes, for any matrix, point and near plane, on the planes too", () => {
    let seed = 7;
    const random = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    const special = [0, -0, 1, -1, 1e-300, -1e300, Infinity, -Infinity, NaN, 6378137, 2 ** 53 + 1];
    const any = (): number => random() < 0.1 ? special[Math.floor(random() * special.length)] : (random() - 0.5) * 10 ** Math.floor(random() * 14 - 4);
    const codes = new Set<number>();
    let flips = 0;
    for (let round = 0; round < 20_000; round++) {
      const m = Array.from({ length: 16 }, any);
      const view = { nearPlane: { z: any(), w: any() } } as ImageryView;
      // Half the rounds put the point on a plane, where a last bit decides: a
      // column equal to w's or its negation, or a near plane z = w.
      const plane = Math.floor(random() * 10);
      if (plane < 2) for (const row of [0, 4, 8, 12]) m[row] = plane === 0 ? m[row + 3] : -m[row + 3];
      else if (plane < 4) for (const row of [1, 5, 9, 13]) m[row] = plane === 2 ? m[row + 2] : -m[row + 2];
      else if (plane === 4) { for (const row of [2, 6, 10, 14]) m[row] = m[row + 1]; view.nearPlane = { z: 1, w: -1 }; }
      const p = { x: any(), y: any(), z: any() };
      const expected = outcode(view, toClip(m, p));
      expect(clipOutcode(view, m, p)).toBe(expected);
      codes.add(expected);
      // How often w summed in another order would give another outcode here.
      const w = m[15] + p.x * m[3] + p.y * m[7] + p.z * m[11];
      if (outcode(view, { ...toClip(m, p), w }) !== expected) flips += 1;
    }
    for (const plane of [1, 2, 4, 8, 16]) expect([...codes].some(code => code === plane)).toBe(true);
    expect(codes.size).toBeGreaterThan(16);
    expect(flips).toBeGreaterThan(100);
  });
});

describe("projected pixel footprints", () => {
  // The shipped function, which made the clip point and each Jacobian column as objects.
  // `regrouped` takes each column's inverse as 1 / (w * (w * pixels)), so the test can show it would tell.
  const shipped = (view: ImageryView, sample: SurfaceSample, imageWidth: number, imageHeight: number, viewportWidth: number, viewportHeight: number, regrouped = false): number | null => {
    const m = view.ecefToClip, p = sample.position;
    const c = { x: p.x * m[0] + p.y * m[4] + p.z * m[8] + m[12], y: p.x * m[1] + p.y * m[5] + p.z * m[9] + m[13],
      z: p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14], w: p.x * m[3] + p.y * m[7] + p.z * m[11] + m[15] };
    if (c.z * view.nearPlane.z + c.w * view.nearPlane.w < 0 || c.w <= 0) return null;
    const jacobianColumn = (t: { x: number; y: number; z: number }, pixels: number): [number, number] => {
      const dx = t.x * m[0] + t.y * m[4] + t.z * m[8];
      const dy = t.x * m[1] + t.y * m[5] + t.z * m[9];
      const dw = t.x * m[3] + t.y * m[7] + t.z * m[11];
      const inv = regrouped ? 1 / (c.w * (c.w * pixels)) : 1 / (c.w * c.w * pixels);
      return [(viewportWidth / 2) * (dx * c.w - c.x * dw) * inv, (viewportHeight / 2) * (dy * c.w - c.y * dw) * inv];
    };
    const [a, cc] = jacobianColumn(sample.du, imageWidth);
    const [b, d] = jacobianColumn(sample.dv, imageHeight);
    const sum = a * a + b * b + cc * cc + d * d;
    const det = a * d - b * cc;
    return Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2);
  };

  it("are the shipped function's, bit for bit, for any matrix, sample, image and viewport", () => {
    let seed = 13;
    const random = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    const special = [0, -0, 1, -1, 1e-300, -1e300, Infinity, -Infinity, NaN, 6378137, 2 ** 53 + 1];
    const any = (): number => random() < 0.05 ? special[Math.floor(random() * special.length)] : (random() - 0.5) * 10 ** Math.floor(random() * 14 - 4);
    const vector = () => ({ x: any(), y: any(), z: any() });
    const pixels = (): number => random() < 0.8 ? [256, 512, 255, 1][Math.floor(random() * 4)] : random() * 1000;
    let finite = 0, behindNear = 0, behindEye = 0, regrouped = 0, oneInverse = 0;
    for (let round = 0; round < 100_000; round++) {
      const m = Array.from({ length: 16 }, any);
      // A fifth of the views has a near plane that passes any w, so w alone decides.
      const nearPlane = random() < 0.2 ? { z: 0, w: 0 } : { z: any(), w: any() };
      const view = { ecefToClip: m, nearPlane } as unknown as ImageryView;
      const sample = { position: vector(), du: vector(), dv: vector(), latDeg: 0, lonDeg: 0 };
      const imageWidth = pixels(), imageHeight = random() < 0.5 ? imageWidth : pixels();
      const viewportWidth = pixels(), viewportHeight = pixels();
      const expected = shipped(view, sample, imageWidth, imageHeight, viewportWidth, viewportHeight);
      expect(Object.is(projectedPixelFootprint(view, sample, imageWidth, imageHeight, viewportWidth, viewportHeight), expected)).toBe(true);
      const p = sample.position;
      const w = p.x * m[3] + p.y * m[7] + p.z * m[11] + m[15], z = p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14];
      if (z * nearPlane.z + w * nearPlane.w < 0) behindNear += 1;
      else if (!(w > 0)) behindEye += 1;
      else if (Number.isFinite(expected)) {
        finite += 1;
        // How often an inverse grouped another way, or the width's inverse for both columns, would give another footprint here.
        if (!Object.is(shipped(view, sample, imageWidth, imageHeight, viewportWidth, viewportHeight, true), expected)) regrouped += 1;
        if (!Object.is(shipped(view, sample, imageWidth, imageWidth, viewportWidth, viewportHeight), expected)) oneInverse += 1;
      }
    }
    expect(finite).toBeGreaterThan(20_000);
    expect(behindNear).toBeGreaterThan(20_000);
    expect(behindEye).toBeGreaterThan(5_000);
    expect(regrouped).toBeGreaterThan(1000);
    expect(oneInverse).toBeGreaterThan(1000);
  });
});

describe("hull spheres", () => {
  it("are the mean and the farthest distance times 1.1, summed in the hull's order, bit for bit", () => {
    let seed = 11;
    const random = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    let reordered = 0;
    for (let round = 0; round < 2000; round++) {
      // A tile's hull: twenty points around the globe's surface, metres apart or continents apart.
      const spread = 10 ** Math.floor(random() * 7);
      const base = { x: (random() - 0.5) * 12_000_000, y: (random() - 0.5) * 12_000_000, z: (random() - 0.5) * 12_000_000 };
      const hull = Array.from({ length: 20 }, () => ({ x: base.x + (random() - 0.5) * spread, y: base.y + (random() - 0.5) * spread, z: base.z + (random() - 0.5) * spread }));
      const center = hull.reduce((sum, p) => ({ x: sum.x + p.x / hull.length, y: sum.y + p.y / hull.length, z: sum.z + p.z / hull.length }), { x: 0, y: 0, z: 0 });
      const radius = Math.max(...hull.map(p => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z))) * 1.1;
      const sphere = hullSphere(hull);
      for (const axis of ["x", "y", "z"] as const) expect(Object.is(sphere.center[axis], center[axis])).toBe(true);
      expect(Object.is(sphere.radius, radius)).toBe(true);
      // Summed in another order the mean would differ, so the test can tell.
      const reversed = [...hull].reverse().reduce((sum, p) => sum + p.x / hull.length, 0);
      if (!Object.is(reversed, center.x)) reordered += 1;
    }
    expect(reordered).toBeGreaterThan(50);
    expect(hullSphere([{ x: NaN, y: 0, z: 0 }, { x: 1, y: 2, z: 3 }]).radius).toBeNaN();
  });
});
