import { NullEngine, Scene, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEarthAreaOverlay } from "../src/babylon/earthAreaOverlay.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function scene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

const triangle = {
  points: [{ latDeg: 0, lonDeg: 0 }, { latDeg: 0, lonDeg: 0.02 }, { latDeg: 0.02, lonDeg: 0 }],
};

describe("the drawn area", () => {
  it("draws the footprint and the walls under the world, and never where a click would land", () => {
    const target = scene();
    const world = new TransformNode("world", target);
    world.position.set(5, 0, 0);
    const requestRender = vi.fn();
    const overlay = createEarthAreaOverlay(target, { parent: world, requestRender });
    overlay.show([]);
    expect(target.getMeshByName("earth-area-lines-0")).toBeNull();
    expect(requestRender).not.toHaveBeenCalled();

    overlay.show([{ area: triangle, groundMeters: [20, 20, 20], active: true }]);
    const lines = target.getMeshByName("earth-area-lines-0");
    expect(lines).not.toBeNull();
    expect(lines!.isPickable).toBe(false);
    expect(target.getMeshByName("earth-area-walls-0")).toBeNull();
    expect(lines!.parent?.parent?.parent).toBe(world);
    expect((lines!.parent as TransformNode).position.length()).toBeGreaterThan(6_000_000);
    expect(requestRender).toHaveBeenCalledTimes(1);

    overlay.show([{ area: { ...triangle, heightMeters: 80 }, groundMeters: [20, 20, 20], active: true }]);
    const walls = target.getMeshByName("earth-area-walls-0");
    expect(walls).not.toBeNull();
    expect(walls!.isPickable).toBe(false);
    expect(walls!.metadata?.mapSurface).toBeUndefined();

    overlay.show([]);
    expect(target.getMeshByName("earth-area-lines-0")).toBeNull();
    expect(target.getMeshByName("earth-area-walls-0")).toBeNull();
    overlay.dispose();
    expect(target.getTransformNodeByName("earth-area-overlay")).toBeNull();
  });
});
