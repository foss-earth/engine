import { describe, expect, it } from "vitest";
import { createNavigationSpeedAxis, navigationCurveShare } from "../src/input/navigationSpeedCurve.js";
const curve = { accelerationMs: 1000, accelerationPower: 2, slowdownMs: 500, slowdownPower: 2 };
describe("keyboard speed curves", () => {
  it("reaches full speed and stops exactly, retargeting from current speed", () => {
    const axis = createNavigationSpeedAxis();
    expect(axis.step(1, 500, curve)).toBeCloseTo(0.25);
    expect(axis.step(1, 500, curve)).toBe(1);
    expect(axis.step(0, 250, curve)).toBeCloseTo(0.25);
    expect(axis.step(-1, 0, curve)).toBeCloseTo(0.25);
    expect(axis.step(-1, 500, curve)).toBeCloseTo(-0.0625);
    expect(axis.step(0, 500, curve)).toBe(0);
  });
  it("has the same ramp and coast at 30, 60 and 120 Hz", () => {
    const samples = [30, 60, 120].map(fps => {
      const axis = createNavigationSpeedAxis();
      for (let i = 0; i < fps / 2; i++) axis.step(1, 1000 / fps, curve);
      return axis.step(0, 250, curve);
    });
    samples.forEach(speed => expect(speed).toBeCloseTo(0.0625, 8));
  });
  it("supports immediate response and smooth S curves and shaped variants", () => {
    const axis = createNavigationSpeedAxis();
    expect(axis.step(1, 1, { ...curve, accelerationMs: 0 })).toBe(1);
    expect(axis.step(0, 1, { ...curve, slowdownMs: 0 })).toBe(0);
    expect(navigationCurveShare(0.5, 1, false)).toBe(0.5);
    expect(navigationCurveShare(0.1, 1, false)).toBeLessThan(0.01);
    expect(navigationCurveShare(0.9, 1, false)).toBeGreaterThan(0.99);
    expect(navigationCurveShare(0.5, 2, false)).toBe(0.25);
    expect(navigationCurveShare(0.5, 2, true)).toBe(0.25);
  });
});
