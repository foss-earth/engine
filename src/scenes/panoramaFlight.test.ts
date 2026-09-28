import { describe, expect, it } from "vitest";
import { ComputeLookAtFromYawPitchToRef, Vector3 } from "@babylonjs/core";
import { coast, flightIn, flightOut, INSIDE_SHARE, levelUp, orbitAngles, orbitBasis, orbitHolding, orbitLook, poseView, type FlightPose, type GlobeHold } from "./panoramaFlight";
import { add, cross, dot, enuDirection, enuFrame, geodeticPoint, handoffReady, length, normalize, orbGeometry, scale, sub, type Vec3 } from "./panoramaMath";

const close = (a: Vec3, b: Vec3, digits = 9) => a.forEach((value, index) => expect(value).toBeCloseTo(b[index], digits));
const frame = enuFrame(-93.235, 44.974);
const marker = geodeticPoint(-93.235, 44.974, 262);
const toEcef = (enu: Vec3): Vec3 => add(add(scale(frame.east, enu[0]), scale(frame.north, enu[1])), scale(frame.up, enu[2]));
/** A pose looking at `headingDeg` and `pitchDeg`, rolled `rollDeg` clockwise, at `position`. */
function pose(position: Vec3, headingDeg: number, pitchDeg: number, rollDeg = 0, fovDeg = 60): FlightPose {
  const forward = toEcef(enuDirection(headingDeg, pitchDeg));
  const level = toEcef(enuDirection(headingDeg, pitchDeg + 90));
  const right = normalize(cross(forward, level));
  const roll = (rollDeg * Math.PI) / 180;
  return { position, forward, up: add(scale(level, Math.cos(roll)), scale(right, Math.sin(roll))), verticalFovRad: (fovDeg * Math.PI) / 180 };
}

describe("orbit angles", () => {
  it("follow the globe camera's convention, and invert", () => {
    for (const center of [marker, geodeticPoint(151.2, -33.9, 30), geodeticPoint(0, 0, 0)]) {
      for (const [yaw, pitch] of [[0, 0.3], [1.2, Math.PI / 2 - 0.01], [-2.5, 1.1], [3, 2.4]]) {
        const babylon = ComputeLookAtFromYawPitchToRef(yaw, pitch, new Vector3(...center), true, new Vector3());
        close(orbitLook(center, yaw, pitch), [babylon.x, babylon.y, babylon.z]);
        const angles = orbitAngles(center, orbitLook(center, yaw, pitch), 0);
        expect(angles.yaw).toBeCloseTo(yaw, 9);
        expect(angles.pitch).toBeCloseTo(pitch, 9);
      }
    }
    const { up, east, north } = orbitBasis(marker);
    expect(dot(east, frame.east)).toBeCloseTo(1, 9);
    expect(dot(up, north)).toBeCloseTo(0, 12);
  });

  it("hold a view level about the vertical given, and fall back when looking along it", () => {
    const forward = normalize([1, 1, 0]);
    close(levelUp(forward, [0, 0, 1], [1, 0, 0]), [0, 0, 1]);
    close(levelUp([0, 0, 1], [0, 0, 1], [0, 1, 0]), [0, 1, 0]);
  });
});

describe("the flight into an orb", () => {
  // 200 m south-west of the orb and 80 m above it, looking north and down, the orb off centre.
  const start = pose(add(marker, toEcef([-150, -130, 80])), 10, -25, 0.4);
  const radius = 6;
  const flight = flightIn(start, marker, radius)!;

  it("starts exactly at the camera's view", () => {
    const first = flight.pose(0);
    close(first.position, start.position, 6);
    close(first.forward, start.forward);
    close(first.up, start.up);
  });

  it("ends inside the sphere facing the marker, level about its vertical, where the image can take over", () => {
    const last = flight.pose(1);
    const rel = sub(marker, last.position);
    expect(length(rel)).toBeCloseTo(radius * INSIDE_SHARE, 6);
    close(last.forward, normalize(rel));
    close(last.up, levelUp(last.forward, normalize(marker), start.up));
    expect(handoffReady(orbGeometry(rel, radius), poseView(last, 1.6), Math.PI / 4)).toBe(true);
  });

  it("closes in by the same factor each step, so the orb grows at a steady rate", () => {
    const distance = (s: number) => length(sub(marker, flight.pose(s).position));
    const ratios = [0, 0.25, 0.5, 0.75].map(s => distance(s + 0.25) / distance(s));
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0], 9);
    expect(ratios[0]).toBeLessThan(1);
  });

  it("does not fly from inside the sphere", () => {
    expect(flightIn(pose(add(marker, toEcef([2, 0, 0])), 0, 0), marker, radius)).toBeNull();
  });
});

describe("the flight out of an orb", () => {
  // The overview the panorama was entered from: 600 m out, 40° down from the horizon, a 45° view.
  const overview = { center: { x: 0, y: 0, z: 0 }, yaw: 0.3, pitch: Math.PI / 2 - (40 * Math.PI) / 180, radius: 600, fov: Math.PI / 4 };
  const start = pose(marker, 250, 12, 3, 75);
  const radius = 4;
  const flight = flightOut(start, marker, radius, overview)!;

  it("starts inside the sphere with the image's own view, so the orb can take over from it", () => {
    const first = flight.pose(0);
    const rel = sub(marker, first.position);
    expect(length(rel)).toBeCloseTo(radius * INSIDE_SHARE, 9);
    close(first.forward, start.forward);
    close(first.up, start.up);
    expect(first.verticalFovRad).toBeCloseTo(start.verticalFovRad, 12);
    expect(handoffReady(orbGeometry(rel, radius), poseView(first, 1.6), Math.PI / 4)).toBe(true);
  });

  it("backs away keeping the heading, always looking at the marker", () => {
    const heading = orbitAngles(marker, start.forward, 0).yaw;
    for (const s of [0.2, 0.5, 0.8, 1]) {
      const each = flight.pose(s);
      close(each.forward, normalize(sub(marker, each.position)));
      expect(orbitAngles(marker, each.forward, 0).yaw).toBeCloseTo(heading, 9);
    }
  });

  it("ends as the globe camera's own orbit view of the marker, at the overview's pitch, distance and field of view", () => {
    const last = flight.pose(1);
    const { camera } = flight.end;
    close([camera.center.x, camera.center.y, camera.center.z], marker);
    expect(camera).toMatchObject({ pitch: overview.pitch, radius: 600, fov: overview.fov });
    const look = orbitLook(marker, camera.yaw, camera.pitch);
    close(last.forward, look);
    close(last.position, sub(marker, scale(look, 600)), 6);
    close(last.up, levelUp(look, normalize(marker), start.up));
    expect(last.verticalFovRad).toBeCloseTo(overview.fov, 12);
    expect(flight.end.view).toMatchObject({ pitchDeg: expect.closeTo(40, 9), zoomMeters: 600 });
  });

  it("does not fly to a view inside the sphere", () => {
    expect(flightOut(start, marker, 700, overview)).toBeNull();
  });
});

describe("a flight cut short", () => {
  const overview = { center: { x: 0, y: 0, z: 0 }, yaw: 0.3, pitch: Math.PI / 2 - (40 * Math.PI) / 180, radius: 600, fov: Math.PI / 4 };
  // The image looked 20° above the horizon, rolled 3°, with a wider view than the globe's.
  const out = flightOut(pose(marker, 250, 20, 3, 75), marker, 4, overview)!;
  const into = flightIn(pose(add(marker, toEcef([-150, -130, 80])), 10, -25, 0.4), marker, 6)!;
  const hold: GlobeHold = { verticalFovRad: overview.fov, pitchDeg: { min: 1, max: 89 }, zoomMinMeters: 25, glideKeepPerFrame: 0.82 };
  const decay = -Math.log(0.82) / (1000 / 60);
  const tiltDeg = (forward: Vec3) => (Math.asin(-dot(forward, normalize(marker))) * 180) / Math.PI;
  const rollDeg = (each: FlightPose) => (Math.atan2(dot(cross(levelUp(each.forward, normalize(marker), each.up), each.up), each.forward), dot(levelUp(each.forward, normalize(marker), each.up), each.up)) * 180) / Math.PI;

  it("goes on from where it got to, at the speed it had, along its own path", () => {
    const glide = coast(out, 0.2, 0.0015, marker, hold, 0);
    const first = glide.pose(0);
    const path = out.pose(0.2);
    close(first.position, path.position, 9);
    close(first.forward, path.forward);
    close(first.up, path.up);
    expect(first.verticalFovRad).toBeCloseTo(path.verticalFovRad, 12);
    expect((glide.progress(1e-3) - 0.2) / 1e-3).toBeCloseTo(0.0015, 6);
    for (const ms of [30, 90, 200]) close(glide.pose(ms).position, out.pose(glide.progress(ms)).position, 6);
  });

  it("brakes as the globe camera's glide does, and comes to rest", () => {
    const glide = coast(out, 0.2, 0.0015, marker, hold, 0);
    // The speed falls to 0.82 of itself every 60 Hz frame: the distance left halves as the speed does.
    const left = (ms: number) => glide.progress(glide.durationMs) - glide.progress(ms);
    expect(left(1000 / 60) / left(0)).toBeCloseTo(0.82, 3);
    expect(glide.progress(glide.durationMs) - 0.2).toBeCloseTo(0.0015 / decay, 3);
    expect(glide.settled(glide.durationMs)).toBe(1);
    expect(glide.durationMs).toBeGreaterThan(300);
    expect(glide.durationMs).toBeLessThan(1000);
  });

  it("turns meanwhile to what the globe camera holds: its field of view, level, tilted within its limits", () => {
    const glide = coast(out, 0.05, 0.0015, marker, hold, 0);
    expect(tiltDeg(glide.pose(0).forward)).toBeLessThan(-1);
    expect(Math.abs(rollDeg(glide.pose(0)))).toBeGreaterThan(1);
    const last = glide.pose(glide.durationMs);
    expect(tiltDeg(last.forward)).toBeCloseTo(1, 9);
    expect(rollDeg(last)).toBeCloseTo(0, 9);
    expect(last.verticalFovRad).toBeCloseTo(overview.fov, 12);
    // Half way through the braking, half way there.
    const half = Math.log(2) / decay;
    expect(glide.settled(half)).toBeCloseTo(0.5, 2);
    const along = out.pose(glide.progress(half)).verticalFovRad;
    expect(glide.pose(half).verticalFovRad).toBeCloseTo(along + (overview.fov - along) * glide.settled(half), 12);
  });

  it("ends as the globe camera's orbit holding the eye where it stopped, no nearer than its zoom limit", () => {
    for (const glide of [coast(out, 0.05, 0.0015, marker, hold, 0), coast(into, 0.7, 0.001, marker, hold, 0)]) {
      const last = glide.pose(glide.durationMs);
      const { camera, view } = glide.end;
      const center: Vec3 = [camera.center.x, camera.center.y, camera.center.z];
      const look = orbitLook(center, camera.yaw, camera.pitch);
      close(sub(center, scale(look, camera.radius)), last.position, 6);
      close(look, last.forward, 9);
      expect(camera.radius).toBeGreaterThanOrEqual(25);
      expect(camera.fov).toBe(overview.fov);
      expect(view.zoomMeters).toBe(camera.radius);
      expect(view.pitchDeg).toBeGreaterThanOrEqual(1 - 1e-3);
    }
  });

  it("stops at once, turned to what the globe camera holds, when its glide keeps nothing", () => {
    const glide = coast(into, 0.7, 0.001, marker, { ...hold, glideKeepPerFrame: 0 }, 0);
    expect(glide.durationMs).toBe(0);
    close(glide.pose(0).position, into.pose(0.7).position, 9);
    expect(rollDeg(glide.pose(0))).toBeCloseTo(0, 9);
  });

  it("orbits the marker when the eye looks at it from beyond the zoom limit, and a point past it when nearer", () => {
    const far = out.pose(0.9);
    const held = orbitHolding(far, marker, hold, 0).camera;
    close([held.center.x, held.center.y, held.center.z], marker, 6);
    expect(held.radius).toBeCloseTo(length(sub(marker, far.position)), 6);
    const near = out.pose(0.1);
    expect(length(sub(marker, near.position))).toBeLessThan(25);
    const closer = orbitHolding(near, marker, hold, 0).camera;
    expect(closer.radius).toBe(25);
    close([closer.center.x, closer.center.y, closer.center.z], add(near.position, scale(near.forward, 25)), 6);
  });
});
