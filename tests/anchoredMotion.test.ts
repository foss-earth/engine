import { GeospatialCamera, NullEngine, NullEngineOptions, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import {
  lineOfSightTarget, orbitAbout, orbitFieldsOf, pointInViewProblem, poseOfOrbit, rayToHeight, tiltAt, viewDirection, zoomAbout,
  type CameraPose, type OrbitFields,
} from "../src/camera/anchoredMotion.js";
import { clientRay, projectEcefToClient } from "../src/babylon/anchorPan.js";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef } from "../src/camera/cameraMath.js";
import { add, length, normalize, scale, sub, type Vec3 } from "../src/camera/geographicFrames.js";

/** A canvas drawn at `width` by `height` CSS pixels, its box at `left, top` and scaled on screen by `cssScale`. */
function canvasOf(width: number, height: number, left = 0, top = 0, cssScale = 1): HTMLCanvasElement {
  return { clientWidth: width, clientHeight: height,
    getBoundingClientRect: () => ({ left, top, width: width * cssScale, height: height * cssScale }) } as unknown as HTMLCanvasElement;
}

/** A real globe camera with high-precision matrices, as the runtime draws with. */
function realCamera(fov = 0.8, render = { width: 1280, height: 720 }, canvas = canvasOf(1280, 720)) {
  const engine = new NullEngine({ ...new NullEngineOptions(), renderWidth: render.width, renderHeight: render.height, useHighPrecisionMatrix: true });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("anchored", scene, { planetRadius: 6378137 });
  camera.limits.radiusMin = 0;
  camera.limits.radiusMax = Infinity;
  camera.fov = fov;
  // One write, as the runtime commits a pose: Babylon clamps each field against the others as they are.
  const place = (fields: OrbitFields): void => {
    (camera as unknown as { _setOrientation(yaw: number, pitch: number, radius: number, center: Vector3): void })
      ._setOrientation(fields.yaw, fields.pitch, fields.radius, new Vector3(...fields.center));
  };
  /** Where a world point is drawn, client pixels, through the camera's own matrices in float64. */
  const pixel = (point: Vec3): { x: number; y: number } => {
    const drawn = projectEcefToClient(new Vector3(...point), scene, camera, canvas);
    if (!drawn) throw new Error("The point is behind the camera.");
    return drawn;
  };
  const pose = (): CameraPose => {
    camera.getViewMatrix(true);
    const eye: Vec3 = [camera.position.x, camera.position.y, camera.position.z];
    const center: Vec3 = [camera.center.x, camera.center.y, camera.center.z];
    return { eye, forward: normalize(sub(center, eye)) };
  };
  return { engine, scene, camera, canvas, place, pixel, pose };
}

const ground = (latDeg: number, lonDeg: number, height = 0): Vec3 => {
  const p = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, height);
  return [p.x, p.y, p.z];
};

/** The camera's centre, yaw, pitch and radius from a geographic description of an orbit. */
function orbit(latDeg: number, lonDeg: number, heightMeters: number, headingDeg: number, tiltDeg: number, radius: number): OrbitFields {
  // Babylon pitch: 0 looks straight down, π/2 at the horizon; the globe's tilt is the other way round.
  return { center: ground(latDeg, lonDeg, heightMeters), yaw: headingDeg * DEG_TO_RAD, pitch: (90 - tiltDeg) * DEG_TO_RAD, radius };
}

/** The ground point drawn at client pixel `x, y`, through the real camera. */
function groundUnder(f: ReturnType<typeof realCamera>, x: number, y: number, height = 0): Vec3 {
  const ray = clientRay(f.scene, f.camera, f.canvas, x, y);
  const hit = ray && rayToHeight([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z], height);
  if (!hit) throw new Error("The test pixel misses the ground.");
  return hit;
}

/** Commits a pose to the real camera, centred where its line of sight meets the ellipsoid. */
function commit(f: ReturnType<typeof realCamera>, pose: CameraPose): void {
  const target = lineOfSightTarget(pose, () => 0, 0);
  if (!target) throw new Error("The pose looks above the horizon.");
  f.place(orbitFieldsOf(pose, target.point, f.camera.yaw));
}

const VIEWS: Array<[string, OrbitFields]> = [
  ["a city block, tilted", orbit(44.9778, -93.265, 260, -14, 50, 600)],
  ["a mountain valley, steep", orbit(46.55, 8.0, 1800, 120, 80, 5000)],
  ["low and grazing", orbit(37.75, -122.45, 0, 250, 12, 900)],
  ["the antimeridian", orbit(-17.5, 179.999, 0, 45, 35, 20_000)],
  ["near a pole", orbit(84.5, 30, 0, 200, 60, 150_000)],
  ["from orbit", orbit(10, -40, 0, 0, 89, 9_000_000)],
];
const PIXELS: Array<[number, number]> = [[640, 360], [120, 650], [1210, 520], [300, 410], [980, 640]];

describe("anchored camera motion, through the real globe camera's matrices", () => {
  it("places a point on screen as Babylon's view and projection do", () => {
    for (const fov of [0.3, 0.8, 1.6]) {
      const f = realCamera(fov);
      try {
        for (const [name, fields] of VIEWS) {
          f.place(fields);
          const pose = f.pose();
          for (const [px, py] of PIXELS) {
            let point: Vec3;
            try { point = groundUnder(f, px, py); } catch { continue; }
            const view = viewDirection(pose, point)!;
            const focal = 360 / Math.tan(fov / 2);
            const drawn = f.pixel(point);
            expect(Math.abs(640 + view.x * focal - drawn.x), `${name} fov ${fov}`).toBeLessThan(1e-6);
            expect(Math.abs(360 - view.y * focal - drawn.y), `${name} fov ${fov}`).toBeLessThan(1e-6);
            // The ray through that pixel comes back to it: a few millimetres at 9,000 km.
            expect(Math.hypot(drawn.x - px, drawn.y - py), `${name} fov ${fov}`).toBeLessThan(1e-5);
          }
        }
      } finally { f.engine.dispose(); }
    }
  });

  it("writes a pose down as the camera's fields and reads it back unchanged", () => {
    const f = realCamera();
    try {
      for (const [name, fields] of VIEWS) {
        f.place(fields);
        const drawn = f.pose();
        const computed = poseOfOrbit(fields);
        expect(length(sub(computed.eye, drawn.eye)), name).toBeLessThan(1e-6);
        expect(length(sub(computed.forward, drawn.forward)), name).toBeLessThan(1e-12);
        // Any centre on the line of sight writes the same view.
        const further = orbitFieldsOf(drawn, add(drawn.eye, scale(drawn.forward, fields.radius * 1.7)), f.camera.yaw);
        f.place(further);
        const again = f.pose();
        expect(length(sub(again.eye, drawn.eye)), name).toBeLessThan(1e-6);
        expect(length(sub(again.forward, drawn.forward)), name).toBeLessThan(1e-12);
      }
    } finally { f.engine.dispose(); }
  });

  it("zooms toward an off-centre point without moving it on screen, and back again", () => {
    const f = realCamera();
    try {
      for (const [name, fields] of VIEWS) {
        for (const [px, py] of PIXELS) {
          f.place(fields);
          let anchor: Vec3;
          try { anchor = groundUnder(f, px, py); } catch { continue; }
          const before = f.pixel(anchor);
          const start = f.pose();
          const startDistance = length(sub(anchor, start.eye));
          let pose = start;
          // A wheel's worth of steps in, then the same out: unconstrained, so reversible.
          for (const factor of [0.92, 0.92, 0.85, 0.7, 1 / 0.7, 1 / 0.85, 1 / 0.92, 1 / 0.92]) {
            const next = zoomAbout(pose, anchor, factor)!;
            expect(next, `${name} ${px},${py}`).not.toBeNull();
            expect(length(sub(anchor, next.eye)) / length(sub(anchor, pose.eye))).toBeCloseTo(factor, 9);
            commit(f, next);
            pose = f.pose();
            const drawn = f.pixel(anchor);
            expect(Math.hypot(drawn.x - before.x, drawn.y - before.y), `${name} ${px},${py}`).toBeLessThan(1e-6);
          }
          expect(length(sub(anchor, pose.eye)) / startDistance).toBeCloseTo(1, 9);
          expect(length(sub(pose.eye, start.eye)) / startDistance, `${name} ${px},${py}`).toBeLessThan(1e-6);
        }
      }
    } finally { f.engine.dispose(); }
  });

  it("orbits an off-centre point keeping its distance and its place on screen", () => {
    const f = realCamera();
    try {
      for (const [name, fields] of VIEWS) {
        for (const [px, py] of PIXELS) {
          f.place(fields);
          let pivot: Vec3;
          try { pivot = groundUnder(f, px, py); } catch { continue; }
          const before = f.pixel(pivot);
          let pose = f.pose();
          const distance = length(sub(pivot, pose.eye));
          for (const [pitch, heading] of [[0, 3], [0.5, 0], [-0.7, -2], [0.2, 9], [0, -9]]) {
            const next = orbitAbout(pose, pivot, pitch, heading);
            if (!next) continue;
            commit(f, next);
            pose = f.pose();
            const drawn = f.pixel(pivot);
            expect(Math.hypot(drawn.x - before.x, drawn.y - before.y), `${name} ${px},${py}`).toBeLessThan(1e-6);
            expect(Math.abs(length(sub(pivot, pose.eye)) - distance)).toBeLessThan(Math.max(0.001, distance * 1e-6));
          }
        }
      }
    } finally { f.engine.dispose(); }
  });

  it("turns as the globe's own orbit does when the pivot is the centre of the view", () => {
    const f = realCamera();
    try {
      const fields = orbit(44.9778, -93.265, 0, 30, 45, 2000);
      f.place(fields);
      const turned = orbitAbout(f.pose(), fields.center, 4, 10)!;
      const target = lineOfSightTarget(turned, () => 0, 0)!;
      const after = orbitFieldsOf(turned, target.point, f.camera.yaw);
      // Heading about the WGS84 vertical, not the geocentric one: within their angle apart, about 0.19° here.
      expect(after.yaw / DEG_TO_RAD).toBeCloseTo(40, 0);
      expect(90 - after.pitch / DEG_TO_RAD).toBeCloseTo(49, 0);
      expect(length(sub(target.point, fields.center))).toBeLessThan(15);
    } finally { f.engine.dispose(); }
  });

  it("measures tilt as the globe does, and finds where the line of sight lands", () => {
    const f = realCamera();
    try {
      const fields = orbit(44.9778, -93.265, 250, 0, 37, 3000);
      f.place(fields);
      const pose = f.pose();
      expect(tiltAt(fields.center, pose.forward)).toBeCloseTo(37, 9);
      const landing = lineOfSightTarget(pose, () => 250, 0)!;
      expect(landing.heightMeters).toBeCloseTo(250, 2);
      expect(length(sub(landing.point, fields.center))).toBeLessThan(0.05);
      // A height that changes where the line lands is followed there.
      const stepped = lineOfSightTarget(pose, latDeg => (latDeg > 44.98 ? 400 : 250), 0)!;
      expect(stepped.heightMeters).toBeGreaterThan(249);
      // Looking down from below the height, it never comes down to it.
      expect(lineOfSightTarget(pose, () => 9000, 9000)).toBeNull();
    } finally { f.engine.dispose(); }
  });

  it("says why a pinned point cannot be used from here", () => {
    const f = realCamera();
    try {
      f.place(orbit(44.9778, -93.265, 0, 0, 45, 5000));
      const pose = f.pose();
      expect(pointInViewProblem(pose, ground(44.9778, -93.265))).toBeNull();
      // Off screen to the side but ahead: usable.
      expect(pointInViewProblem(pose, ground(44.9778, -92.9))).toBeNull();
      expect(pointInViewProblem(pose, ground(44.6, -93.265))).toBe("behind");
      expect(pointInViewProblem(pose, ground(-44.9778, 86.735))).toBe("beyond-horizon");
      expect(pointInViewProblem(pose, pose.eye)).toBe("too-near");
      expect(pointInViewProblem(pose, [Number.NaN, 0, 0])).toBe("not-finite");
      // Ground below the ellipsoid in front of the camera is on this side.
      expect(pointInViewProblem(pose, ground(44.9778, -93.265, -80))).toBeNull();
      // Over the horizon from a high, level look.
      f.place(orbit(0, 0, 0, 90, 5, 400_000));
      const high = f.pose();
      const farAhead = ground(0, 30);
      expect(pointInViewProblem(high, farAhead)).toBe("beyond-horizon");
      // The line of sight lands on the orbit's centre, on the ellipsoid.
      const landing = ecefToGeodetic(...(lineOfSightTarget(high, () => 0, 0)!.point));
      expect(Math.abs(landing.lonRad / DEG_TO_RAD)).toBeLessThan(1e-6);
    } finally { f.engine.dispose(); }
  });

  it("picks and projects reciprocally on an offset, scaled, high-DPR or resized canvas at any field of view", () => {
    const cases: Array<[string, { width: number; height: number }, HTMLCanvasElement, number]> = [
      ["plain", { width: 1280, height: 720 }, canvasOf(1280, 720), 0.8],
      ["offset in the page", { width: 1280, height: 720 }, canvasOf(1280, 720, 37.5, 91.25), 0.8],
      ["scaled by CSS", { width: 1280, height: 720 }, canvasOf(1280, 720, 12, 8, 0.5), 0.8],
      ["device pixel ratio 2", { width: 2560, height: 1440 }, canvasOf(1280, 720), 0.8],
      ["a lower render resolution", { width: 853, height: 480 }, canvasOf(1280, 720), 0.8],
      ["resized to portrait", { width: 390, height: 844 }, canvasOf(390, 844), 0.8],
      ["a narrow field of view", { width: 1280, height: 720 }, canvasOf(1280, 720), 0.25],
      ["a wide field of view", { width: 1280, height: 720 }, canvasOf(1280, 720, 5, 5, 1.5), 1.9],
    ];
    for (const [name, render, canvas, fov] of cases) {
      const f = realCamera(fov, render, canvas);
      try {
        f.place(orbit(44.9778, -93.265, 260, -14, 50, 600));
        const rect = canvas.getBoundingClientRect();
        for (const [sx, sy] of [[0.5, 0.5], [0.1, 0.9], [0.95, 0.7], [0.3, 0.55]]) {
          const x = rect.left + sx * rect.width, y = rect.top + sy * rect.height;
          const point = groundUnder(f, x, y);
          const drawn = f.pixel(point);
          expect(Math.hypot(drawn.x - x, drawn.y - y), name).toBeLessThan(1e-6);
          // The share of the canvas a point is drawn at follows the camera frame, whatever the units.
          const view = viewDirection(f.pose(), point)!;
          // Babylon fixes the vertical field of view; the render's own aspect sets the horizontal.
          const tan = Math.tan(fov / 2), aspect = render.width / render.height;
          expect(Math.abs(rect.left + rect.width / 2 + view.x * (rect.width / 2) / (tan * aspect) - x), name).toBeLessThan(1e-6);
          expect(Math.abs(rect.top + rect.height / 2 - view.y * (rect.height / 2) / tan - y), name).toBeLessThan(1e-6);
        }
      } finally { f.engine.dispose(); }
    }
  });
});
