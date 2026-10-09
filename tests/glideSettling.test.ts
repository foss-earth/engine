import { describe, expect, it } from "vitest";
import { glideSettling } from "../src/camera/glideSettling.js";

describe("the shared camera glide", () => {
  it("settles as the globe's glide does: keeping its share of speed each 60 Hz frame, and done when it has stopped", () => {
    const curve = glideSettling(0.82);
    const decay = -Math.log(0.82) / (1000 / 60);
    // What is left falls to 0.82 of itself each frame.
    const left = (ms: number) => 1 - curve.settled(ms);
    expect(left(1000 / 60) / left(0)).toBeCloseTo(0.82, 3);
    expect(curve.settled(Math.log(2) / decay)).toBeCloseTo(0.5, 2);
    expect(curve.settled(curve.durationMs)).toBe(1);
    expect(curve.settled(curve.durationMs - 1)).toBeLessThan(1);
    expect(curve.durationMs).toBeGreaterThan(300);
    expect(curve.durationMs).toBeLessThan(1000);
    // A glide that keeps nothing has already stopped.
    expect(glideSettling(0)).toMatchObject({ durationMs: 0 });
    expect(glideSettling(0).settled(0)).toBe(1);
  });
});
