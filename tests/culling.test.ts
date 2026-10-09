import { describe, expect, it, vi } from "vitest";
import { WGS84_A } from "../src/camera/cameraMath.js";
import { createHemisphereCulling } from "../src/perf/culling.js";

describe("createHemisphereCulling", () => {
  it("hides primitives on the far side of the globe", () => {
    let nearVisible = true;
    let farVisible = true;
    const culling = createHemisphereCulling(() => ({ x: WGS84_A + 600, y: 0, z: 0 }));

    culling.setCullables([
      {
        kind: "point",
        target: { setVisible: (visible) => { nearVisible = visible; } },
        getPosition: () => ({ x: WGS84_A, y: 0, z: 0 }),
      },
      {
        kind: "point",
        target: { setVisible: (visible) => { farVisible = visible; } },
        getPosition: () => ({ x: -WGS84_A, y: 0, z: 0 }),
      },
    ]);

    const stats = culling.update();

    expect(nearVisible).toBe(true);
    expect(farVisible).toBe(false);
    expect(stats).toEqual({ total: 2, visible: 1, hidden: 1 });
  });

  it("leaves cullables visible when no geospatial camera is active", () => {
    const setVisible = vi.fn();
    const culling = createHemisphereCulling(() => null);

    culling.setCullables([
      {
        kind: "point",
        target: { setVisible },
        getPosition: () => ({ x: -WGS84_A, y: 0, z: 0 }),
      },
    ]);
    const stats = culling.update();

    expect(setVisible).toHaveBeenLastCalledWith(true);
    expect(stats).toEqual({ total: 1, visible: 1, hidden: 0 });
  });
  it("reads the supplied horizon margin and still scans all polyline samples", () => {
    let margin=0;const show=vi.fn(),culling=createHemisphereCulling(()=>({x:WGS84_A+600,y:0,z:0}),{horizonMargin:()=>margin});
    culling.setCullables([{kind:"polyline",target:{setVisible:show},getSamplePositions:()=>[{x:-WGS84_A,y:0,z:0},{x:0,y:WGS84_A,z:0}]}]);
    expect(culling.update()).toEqual({total:1,visible:0,hidden:1});margin=1;expect(culling.update()).toEqual({total:1,visible:1,hidden:0});
    culling.destroy();expect(show).toHaveBeenLastCalledWith(true);expect(culling.getStats()).toEqual({total:0,visible:0,hidden:0});
  });
});
