import { describe, expect, it } from "vitest";
import { orbitCenterOnSight, orbitGlideRates, withinTilt, type GlideVec3 } from "./cameraGlide";
import { orbitAngles, orbitLook } from "../scenes/panoramaFlight";
import { add, cross, dot, enuDirection, enuFrame, geodeticPoint, length, normalize, pointGeodetic, scale, sub, type Vec3 } from "../scenes/panoramaMath";

const close = (a: GlideVec3, b: GlideVec3, digits: number) => a.forEach((value, index) => expect(value).toBeCloseTo(b[index], digits));
const frame = enuFrame(-93.235, 44.974);
const toEcef = (enu: Vec3): Vec3 => add(add(scale(frame.east, enu[0]), scale(frame.north, enu[1])), scale(frame.up, enu[2]));
// An orb 2 m above ground at 250 m.
const pivot = geodeticPoint(-93.235, 44.974, 252);

describe("the orbit a camera is handed back into", () => {
  it("is about where its line of sight comes down to the orbit target's height", () => {
    const eye = geodeticPoint(-93.235, 44.974 - 20 / 111_111, 262);
    const forward = toEcef(enuDirection(0, -30));
    const center = orbitCenterOnSight(eye, forward, pivot, 250);
    expect(pointGeodetic(center as Vec3).heightMeters).toBeCloseTo(250, 1);
    expect(length(cross(sub(center as Vec3, eye), forward))).toBeCloseTo(0, 6);
    expect(length(sub(center as Vec3, eye))).toBeCloseTo(24, 0);
  });

  it("is the line's nearest point to the pivot when the line never comes down to that height", () => {
    const eye = geodeticPoint(-93.235, 44.974 - 20 / 111_111, 252);
    const up = toEcef(enuDirection(0, 10));
    close(orbitCenterOnSight(eye, up, pivot, 250), add(eye, scale(up, dot(sub(pivot, eye), up))), 6);
    // Below the target's height, too.
    close(orbitCenterOnSight(eye, toEcef(enuDirection(0, -10)), pivot, 400), add(eye, scale(toEcef(enuDirection(0, -10)), Math.max(1, dot(sub(pivot, eye), toEcef(enuDirection(0, -10)))))), 6);
  });

  it("tilts a look beyond the globe's limits to the nearest inside, and leaves one inside alone", () => {
    // About the geocentric up, the globe camera's own.
    const up = normalize(pivot);
    const looking = toEcef(enuDirection(40, 20));
    const tilted = withinTilt(looking, up, { min: 1, max: 89 }, up);
    expect(orbitAngles(pivot, tilted as Vec3, 0).pitch).toBeCloseTo(Math.PI / 2 - Math.PI / 180, 9);
    expect(orbitAngles(pivot, tilted as Vec3, 0).yaw).toBeCloseTo(orbitAngles(pivot, looking, 0).yaw, 9);
    const inside = toEcef(enuDirection(40, -30));
    expect(withinTilt(inside, up, { min: 1, max: 89 }, up)).toBe(inside);
  });
});

describe("the glide a moving camera is handed back with", () => {
  const anglesOf = (forward: GlideVec3, center: GlideVec3) => orbitAngles(center as Vec3, forward as Vec3, 0);
  const canvasHeightPx = 800;
  const verticalFovRad = 0.8;

  /** Moves an orbit on by the rates for `dt` seconds, as the globe's pan, orbit and zoom do. */
  function applied(center: Vec3, forward: Vec3, radius: number, velocity: Vec3, turn: Vec3, dt: number) {
    const rates = orbitGlideRates({ center, forward, radius, verticalFovRad, canvasHeightPx }, velocity, turn, anglesOf);
    const up = normalize(center);
    const ahead = normalize(sub(forward, scale(up, dot(forward, up))));
    const right = cross(ahead, up);
    const metresPerPixel = (2 * radius * Math.tan(verticalFovRad / 2)) / canvasHeightPx;
    const moved = add(center, scale(sub(scale(right, rates.panPx.x), scale(ahead, rates.panPx.y)), metresPerPixel * dt));
    const { yaw, pitch } = anglesOf(forward, center);
    const look = orbitLook(moved, yaw + (rates.orbitDeg.heading * Math.PI / 180) * dt, pitch - (rates.orbitDeg.pitch * Math.PI / 180) * dt);
    const distance = radius * Math.exp(rates.zoomLog * dt);
    return { eye: sub(moved, scale(look, distance)), look, rates };
  }

  it("moves the eye and turns the look as the flight did, whatever the motion", () => {
    const eye = geodeticPoint(-93.235, 44.974 - 20 / 111_111, 262);
    const forward = toEcef(enuDirection(0, -30));
    const center = orbitCenterOnSight(eye, forward, pivot, 250) as Vec3;
    const radius = length(sub(center, eye));
    const right = normalize(cross(forward, frame.up));
    const cases: [Vec3, Vec3][] = [
      // Backing away up the line of sight while tilting down: a flight out.
      [scale(forward, -40), scale(cross(right, forward), -0.4)],
      // Closing in while turning toward the orb: a flight in.
      [add(scale(forward, 30), scale(frame.east, 5)), scale(right, 0.3)],
      // Sideways and straight up, turning to the right.
      [add(scale(frame.east, 12), scale(frame.up, 6)), scale(right, -0.2)],
    ];
    const dt = 1e-4;
    for (const [velocity, turn] of cases) {
      const { eye: next, look } = applied(center, forward, radius, velocity, turn, dt);
      close(next, add(eye, scale(velocity, dt)), 5);
      close(look, normalize(add(forward, scale(turn, dt))), 8);
    }
  });

  it("gives the globe's own units: backing away zooms out, closing in zooms in, turning down tilts down", () => {
    const eye = geodeticPoint(-93.235, 44.974 - 20 / 111_111, 262);
    const forward = toEcef(enuDirection(0, -30));
    const center = orbitCenterOnSight(eye, forward, pivot, 250) as Vec3;
    const radius = length(sub(center, eye));
    const zero: Vec3 = [0, 0, 0];
    const rates = (velocity: Vec3, turn: Vec3) => orbitGlideRates({ center, forward, radius, verticalFovRad, canvasHeightPx }, velocity, turn, anglesOf);
    expect(rates(scale(forward, -10), zero).zoomLog).toBeCloseTo(10 / radius, 9);
    expect(rates(scale(forward, 10), zero).zoomLog).toBeCloseTo(-10 / radius, 9);
    const down = normalize(cross(normalize(cross(forward, frame.up)), forward));
    expect(rates(zero, scale(down, -0.5)).orbitDeg.pitch).toBeGreaterThan(0);
    const still = rates(zero, zero);
    for (const value of [still.panPx.x, still.panPx.y, still.orbitDeg.pitch, still.orbitDeg.heading, still.zoomLog]) expect(value).toBeCloseTo(0, 12);
  });
});
