import { describe, expect, it } from "vitest";
import { cssRectToClip, intersectBoxes } from "../src/babylon/uiCover.js";

const canvas = { x: 0, y: 0, width: 100, height: 100 };

describe("cssRectToClip", () => {
  it("turns a box covering the canvas into a full clip quad", () => {
    expect(cssRectToClip(canvas, canvas)).toEqual({ x: -1, y: -1, w: 2, h: 2 });
  });

  it("puts a top band near the top of clip space", () => {
    const clip = cssRectToClip({ x: 0, y: 0, width: 100, height: 40 }, canvas);
    expect(clip).not.toBeNull();
    expect(clip!.x).toBe(-1);
    expect(clip!.y).toBeCloseTo(0.2);
    expect(clip!.w).toBe(2);
    expect(clip!.h).toBeCloseTo(0.8);
  });

  it("keeps only the part that lies on the canvas", () => {
    const clip = cssRectToClip({ x: 0, y: 0, width: 50, height: 50 }, { x: 10, y: 20, width: 100, height: 100 });
    expect(clip).not.toBeNull();
    expect(clip!.x).toBe(-1);
    expect(clip!.y).toBeCloseTo(0.4);
    expect(clip!.w).toBeCloseTo(0.8);
    expect(clip!.h).toBeCloseTo(0.6);
  });

  it("ignores a box that misses the canvas and an empty canvas", () => {
    expect(cssRectToClip({ x: 200, y: 200, width: 10, height: 10 }, canvas)).toBeNull();
    expect(cssRectToClip(canvas, { x: 0, y: 0, width: 0, height: 100 })).toBeNull();
    expect(intersectBoxes({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 })).toBeNull();
  });
});
