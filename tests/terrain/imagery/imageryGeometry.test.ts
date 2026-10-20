import { describe, expect, it, vi } from "vitest";
import { isSphereBelowHorizon } from "../../../src/terrain/imagery/imageryGeometry.js";

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
