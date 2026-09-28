import { describe, expect, it } from "vitest";
import { ComputeLookAtFromYawPitchToRef, Vector3 } from "@babylonjs/core";
import { flightIn, flightOut, INSIDE_SHARE, levelUp, orbitAngles, orbitBasis, orbitLook, poseView, type FlightPose } from "./panoramaFlight";
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
