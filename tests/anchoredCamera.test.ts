import { GeospatialCamera, NullEngine, NullEngineOptions, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { HostCameraController } from "../fixtures/composition/runtimeHost.js";
import { clientRay, projectEcefToClient } from "../src/babylon/anchorPan.js";
import { rayToHeight, type CameraPose } from "../src/camera/anchoredMotion.js";
import { DEFAULT_CAMERA_LIMITS, type CameraLimits } from "../src/camera/cameraLimits.js";
import { RAD_TO_DEG, ecefToGeodetic, type EcefCoord } from "../src/camera/cameraMath.js";
import { length, scale, sub, type Vec3 } from "../src/camera/geographicFrames.js";
import type { GlobeViewState } from "../src/view.js";
import type { AnchoredMotionResult, NavigationAnchor } from "../src/input/navigationAnchors.js";

// The CameraController's anchored zoom and orbit, on the real globe camera's
// high-precision view and projection: proof that the rendered view keeps the
// point in place, not that some property moved (proposal: navigation-anchors.md,
// "Acceptance and verification").

const WIDTH = 1280, HEIGHT = 720;
const CENTRE = { x: WIDTH / 2, y: HEIGHT / 2 };

/** A canvas laid out at its drawing size, at the page's origin. */
function canvasStub(): HTMLCanvasElement {
  return { clientWidth: WIDTH, clientHeight: HEIGHT,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }) } as unknown as HTMLCanvasElement;
}

interface View {
  readonly name: string;
  readonly state: GlobeViewState;
  /** The orbit target's (and here the ground's) height, metres. */
  readonly heightMeters: number;
}

const VIEWS: readonly View[] = [
  { name: "a city block, tilted", state: { latDeg: 44.9778, lonDeg: -93.265, headingDeg: -14, pitchDeg: 50, zoomMeters: 600 }, heightMeters: 260 },
  { name: "a mountain valley, steep", state: { latDeg: 46.55, lonDeg: 8.0, headingDeg: 120, pitchDeg: 80, zoomMeters: 5000 }, heightMeters: 1800 },
  { name: "low and grazing", state: { latDeg: 37.75, lonDeg: -122.45, headingDeg: 250, pitchDeg: 12, zoomMeters: 900 }, heightMeters: 0 },
  { name: "the antimeridian", state: { latDeg: -17.5, lonDeg: 179.999, headingDeg: 45, pitchDeg: 35, zoomMeters: 20_000 }, heightMeters: 0 },
];
/** Off-centre pixels, all below the horizon in every view above. */
const PIXELS: ReadonlyArray<readonly [number, number]> = [[120, 650], [1210, 520], [300, 450], [980, 640]];

/** WebGPU's depth, as the app draws: 0 to 1, reversed, with the far plane at infinity. */
type Depth = "webgl" | "webgpu";

function rig(view: View, limits: CameraLimits = DEFAULT_CAMERA_LIMITS, depth: Depth = "webgl") {
  const engine = new NullEngine({ ...new NullEngineOptions(), renderWidth: WIDTH, renderHeight: HEIGHT, useHighPrecisionMatrix: true });
  if (depth === "webgpu") {
    engine.useReverseDepthBuffer = true;
    Object.defineProperty(engine, "isNDCHalfZRange", { value: true });
  }
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("anchored-controller", scene, { planetRadius: 6378137 });
  camera.fov = 0.8;
  if (depth === "webgpu") camera.maxZ = 0;
  let now = 1000;
  const controller = new HostCameraController(camera, () => now);
  controller.setLimits(limits);
  // As the app's globe camera starts: at its distance first, so Babylon clamps
  // the tilt `applyViewState` writes for this distance, not the default one.
  camera.radius = view.state.zoomMeters;
  controller.applyViewState(view.state, view.heightMeters);
  if (Math.abs(90 - camera.pitch * RAD_TO_DEG - view.state.pitchDeg) > 1e-6) throw new Error(`${view.name} starts at another tilt.`);
  const canvas = canvasStub();
  /** Where a world point is drawn now, client CSS pixels, through the camera's own matrices. */
  const pixel = (point: Vec3): { x: number; y: number } => {
    camera.getViewMatrix(true);
    const drawn = projectEcefToClient(new Vector3(...point), scene, camera, canvas);
    if (!drawn) throw new Error("The point is behind the camera.");
    return drawn;
  };
  /** The ground (at the view's height) drawn at a client pixel now. */
  const groundUnder = (x: number, y: number, heightMeters = view.heightMeters): Vec3 => {
    camera.getViewMatrix(true);
    const ray = clientRay(scene, camera, canvas, x, y);
    const hit = ray && rayToHeight([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z], heightMeters);
    if (!hit) throw new Error(`Pixel ${x}, ${y} misses the ground in ${view.name}.`);
    return hit;
  };
  const centre = (): Vec3 => [camera.center.x, camera.center.y, camera.center.z];
  const centreHeight = (): number => ecefToGeodetic(...centre()).altMeters;
  /** The tilt at the centre of the view, degrees, from the camera's own pitch: 0 level, 90 straight down. */
  const tilt = (): number => 90 - camera.pitch * RAD_TO_DEG;
  const eyeTo = (point: Vec3): number => length(sub(point, controller.getPose().eye));
  const dispose = (): void => { scene.dispose(); engine.dispose(); };
  return { engine, scene, camera, controller, canvas, pixel, groundUnder, centre, centreHeight, tilt, eyeTo, dispose,
    advance: (ms: number) => { now += ms; } };
}

const ecef = (point: Vec3): EcefCoord => ({ x: point[0], y: point[1], z: point[2] });
const gap = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const orbitTolerance = (distance: number): number => Math.max(0.001, distance * 1e-6);

function anchorAt(point: Vec3 | null, operation: "zoom" | "orbit"): NavigationAnchor {
  return { session: 1, owner: "globe", family: "mouse", operation, requested: point ? "pointer" : "target",
    source: point ? "ellipsoid" : "target", point: point ? ecef(point) : null, surfaceRevision: null, fallback: null };
}

function cameraFields(camera: GeospatialCamera): number[] {
  return [camera.center.x, camera.center.y, camera.center.z, camera.yaw, camera.pitch, camera.radius, camera.fov];
}

describe("picking through the camera's own matrices", () => {
  it("casts the ray from the eye with WebGPU's reversed, infinite depth as with WebGL's", () => {
    for (const view of VIEWS) {
      const gl = rig(view), gpu = rig(view, DEFAULT_CAMERA_LIMITS, "webgpu");
      try {
        for (const [x, y] of PIXELS) {
          const ray = clientRay(gpu.scene, gpu.camera, gpu.canvas, x, y)!;
          // From the eye, not from a point at some depth beyond the ground.
          expect(length(sub([ray.origin.x, ray.origin.y, ray.origin.z], gpu.controller.getPose().eye)), `${view.name} @${x},${y}: origin`).toBeLessThan(1e-3);
          const point = gpu.groundUnder(x, y);
          expect(gap(gpu.pixel(point), { x, y }), `${view.name} @${x},${y}: pick and projection agree`).toBeLessThan(1e-3);
          expect(length(sub(point, gl.groundUnder(x, y))), `${view.name} @${x},${y}: the same ground`).toBeLessThan(1e-3);
        }
      } finally { gl.dispose(); gpu.dispose(); }
    }
  });
});

describe("CameraController anchored zoom on the real globe camera", () => {
  it("keeps an off-centre point within 1 CSS px at every step, 20 steps in and back out", () => {
    for (const view of VIEWS) {
      for (const [x, y] of PIXELS) {
        const f = rig(view);
        try {
          const point = f.groundUnder(x, y);
          const start = f.pixel(point);
          expect(gap(start, { x, y }), `${view.name} @${x},${y}: pick and projection agree`).toBeLessThan(1e-3);
          const eye0 = f.controller.getPose().eye;
          const fov0 = f.camera.fov;
          const step = (factor: number): void => {
            const before = f.pixel(point), distance = f.eyeTo(point);
            const result = f.controller.zoomAbout(ecef(point), factor);
            expect(result, `${view.name} @${x},${y}`).toEqual({ moved: true, constrained: null });
            const after = f.pixel(point);
            expect(gap(after, before), `${view.name} @${x},${y}: per step`).toBeLessThan(1);
            expect(gap(after, start), `${view.name} @${x},${y}: across the gesture`).toBeLessThan(1);
            expect(f.eyeTo(point) / distance).toBeCloseTo(factor, 6);
            // The compass stays the camera's centre: on the line of sight, at the orbit target's height.
            expect(Math.abs(f.centreHeight() - view.heightMeters), `${view.name} @${x},${y}: centre height`).toBeLessThan(0.01);
            expect(gap(f.pixel(f.centre()), CENTRE), `${view.name} @${x},${y}: centre drawn at the middle`).toBeLessThan(1);
          };
          for (let i = 0; i < 20; i += 1) step(0.92);
          for (let i = 0; i < 20; i += 1) step(1 / 0.92);
          // Reversible: back where it began, with the same field of view.
          expect(gap(f.pixel(point), start)).toBeLessThan(1);
          expect(length(sub(f.controller.getPose().eye, eye0)), `${view.name} @${x},${y}: eye returns`).toBeLessThan(Math.max(0.01, f.eyeTo(point) * 1e-6));
          expect(f.camera.fov).toBe(fov0);
        } finally { f.dispose(); }
      }
    }
  });

  it("goes through zoomBy with an anchor's point, and about the orbit target without one", () => {
    const view = VIEWS[0];
    const anchored = rig(view), centred = rig(view);
    try {
      const point = anchored.groundUnder(...PIXELS[1]);
      const start = anchored.pixel(point);
      const result = anchored.controller.zoomBy(0.8, anchorAt(point, "zoom"));
      expect(result).toEqual({ moved: true, constrained: null });
      expect(gap(anchored.pixel(point), start)).toBeLessThan(1);
      // A compass-target anchor (no point) is the centred zoom, exactly.
      const legacy = rig(view);
      try {
        expect(centred.controller.zoomBy(0.8, anchorAt(null, "zoom"))).toBeUndefined();
        expect(legacy.controller.zoomBy(0.8)).toBeUndefined();
        expect(cameraFields(centred.camera)).toEqual(cameraFields(legacy.camera));
        expect(legacy.camera.radius).toBeCloseTo(view.state.zoomMeters * 0.8, 6);
      } finally { legacy.dispose(); }
    } finally { anchored.dispose(); centred.dispose(); }
  });

  it("does not move the view for a step of nothing about an off-centre point", () => {
    const f = rig(VIEWS[0]);
    try {
      const point = f.groundUnder(...PIXELS[0]);
      const landmark = f.groundUnder(...PIXELS[2]);
      const before = [f.pixel(point), f.pixel(landmark), f.pixel(f.centre())];
      expect(f.controller.zoomAbout(ecef(point), 1).moved).toBe(true);
      expect(f.controller.orbitZoomAbout(ecef(point), 0, 0, 1).moved).toBe(true);
      const after = [f.pixel(point), f.pixel(landmark)];
      expect(gap(after[0], before[0])).toBeLessThan(0.5);
      expect(gap(after[1], before[1])).toBeLessThan(0.5);
      // An orbit below the dead zone is no step at all.
      const fields = cameraFields(f.camera);
      expect(f.controller.orbitAbout(ecef(point), 0.001, -0.001)).toEqual({ moved: false, constrained: null });
      expect(cameraFields(f.camera)).toEqual(fields);
    } finally { f.dispose(); }
  });
});

describe("CameraController anchored orbit on the real globe camera", () => {
  it("keeps an off-centre pivot within 1 CSS px and its distance through a drag", () => {
    for (const view of VIEWS) {
      for (const [x, y] of PIXELS) {
        const f = rig(view);
        try {
          const point = f.groundUnder(x, y);
          const start = f.pixel(point);
          const distance0 = f.eyeTo(point);
          // Tilt away from the nearer limit, turning clockwise.
          const pitchStep = view.state.pitchDeg > 45 ? -1 : 1;
          for (let i = 0; i < 12; i += 1) {
            const before = f.pixel(point), distance = f.eyeTo(point);
            const result = f.controller.orbitAbout(ecef(point), pitchStep, 4);
            expect(result, `${view.name} @${x},${y} step ${i}`).toEqual({ moved: true, constrained: null });
            expect(gap(f.pixel(point), before), `${view.name} @${x},${y}: per step`).toBeLessThan(1);
            expect(gap(f.pixel(point), start), `${view.name} @${x},${y}: across the drag`).toBeLessThan(1);
            expect(Math.abs(f.eyeTo(point) - distance), `${view.name} @${x},${y}: eye-to-pivot per step`).toBeLessThanOrEqual(orbitTolerance(distance));
            expect(Math.abs(f.centreHeight() - view.heightMeters), `${view.name} @${x},${y}: centre height`).toBeLessThan(0.01);
            expect(gap(f.pixel(f.centre()), CENTRE), `${view.name} @${x},${y}: centre drawn at the middle`).toBeLessThan(1);
          }
          expect(Math.abs(f.eyeTo(point) - distance0), `${view.name} @${x},${y}: eye-to-pivot across the drag`).toBeLessThanOrEqual(orbitTolerance(distance0));
        } finally { f.dispose(); }
      }
    }
  });

  it("turns the heading about the pivot's vertical as the centred orbit turns it", () => {
    const view = VIEWS[0];
    const anchored = rig(view), centred = rig(view);
    try {
      const point = anchored.groundUnder(...PIXELS[3]);
      anchored.controller.orbitAbout(ecef(point), 0, 10);
      centred.controller.orbitBy(0, 10);
      // Both turn the look clockwise by about the same heading; only the anchored one keeps the off-centre point.
      const turned = (state: GlobeViewState) => ((state.headingDeg - view.state.headingDeg + 540) % 360) - 180;
      expect(turned(anchored.controller.getViewState())).toBeCloseTo(turned(centred.controller.getViewState()), 0);
      expect(turned(centred.controller.getViewState())).toBeCloseTo(10, 6);
    } finally { anchored.dispose(); centred.dispose(); }
  });

  it("orbits and zooms about one shared point in one step, keeping it in place", () => {
    const f = rig(VIEWS[0]);
    try {
      const point = f.groundUnder(...PIXELS[1]);
      const start = f.pixel(point);
      for (let i = 0; i < 10; i += 1) {
        const distance = f.eyeTo(point);
        expect(f.controller.orbitZoomAbout(ecef(point), 1, 3, 0.95)).toEqual({ moved: true, constrained: null });
        expect(gap(f.pixel(point), start)).toBeLessThan(1);
        expect(f.eyeTo(point) / distance).toBeCloseTo(0.95, 6);
      }
      // The anchor-port spelling is the same step.
      const g = rig(VIEWS[0]);
      try {
        g.controller.orbitZoomBy(1, 3, 0.95, anchorAt(point, "orbit"));
        const h = rig(VIEWS[0]);
        try {
          h.controller.orbitZoomAbout(ecef(point), 1, 3, 0.95);
          expect(cameraFields(g.camera)).toEqual(cameraFields(h.camera));
        } finally { h.dispose(); }
      } finally { g.dispose(); }
    } finally { f.dispose(); }
  });
});

describe("CameraController anchored motion at limits and with bad input", () => {
  it("measures the zoom limits to the point and says when it clamps", () => {
    const view = VIEWS[0];
    const f = rig(view, { ...DEFAULT_CAMERA_LIMITS, zoomMeters: { min: 200, max: 3000 } });
    try {
      const point = f.groundUnder(...PIXELS[1]);
      const start = f.pixel(point);
      const distance = f.eyeTo(point);
      expect(distance).toBeGreaterThan(400);
      // Far in: stops at the near limit, measured to the point.
      const inward = f.controller.zoomAbout(ecef(point), 0.1);
      expect(inward).toEqual({ moved: true, constrained: "distance-limit" });
      expect(f.eyeTo(point)).toBeCloseTo(200, 3);
      expect(gap(f.pixel(point), start)).toBeLessThan(1);
      // Pushing on at the limit goes no nearer and accumulates nothing.
      for (let i = 0; i < 5; i += 1) expect(f.controller.zoomAbout(ecef(point), 0.5).constrained).toBe("distance-limit");
      expect(f.eyeTo(point)).toBeCloseTo(200, 3);
      expect(f.controller.zoomAbout(ecef(point), 1.5)).toEqual({ moved: true, constrained: null });
      expect(f.eyeTo(point)).toBeCloseTo(300, 3);
      // Far out: stops at the far limit.
      expect(f.controller.zoomAbout(ecef(point), 100)).toEqual({ moved: true, constrained: "distance-limit" });
      expect(f.eyeTo(point)).toBeCloseTo(3000, 2);
      expect(gap(f.pixel(point), start)).toBeLessThan(1);
    } finally { f.dispose(); }
  });

  it("lets a point acquired nearer than the near limit be left, not approached, and never snaps out", () => {
    const view = VIEWS[0];
    const probe = rig(view);
    // The foreground at the bottom of a tilted view is nearer the eye than the orbit target.
    const near = probe.groundUnder(640, 710);
    const distance = probe.eyeTo(near);
    probe.dispose();
    expect(distance).toBeLessThan(view.state.zoomMeters - 50);
    const min = (distance + view.state.zoomMeters) / 2;
    const f = rig(view, { ...DEFAULT_CAMERA_LIMITS, zoomMeters: { min, max: DEFAULT_CAMERA_LIMITS.zoomMeters.max } });
    try {
      expect(f.camera.radius).toBeCloseTo(view.state.zoomMeters, 6);
      const start = f.pixel(near);
      const eye0 = f.controller.getPose().eye;
      // Further inside the near limit: blocked where it is.
      expect(f.controller.zoomAbout(ecef(near), 0.9).constrained).toBe("distance-limit");
      expect(length(sub(f.controller.getPose().eye, eye0))).toBeLessThan(1e-3);
      expect(f.eyeTo(near)).toBeCloseTo(distance, 3);
      // Back toward the legal range: allowed, and nothing snaps to the limit.
      expect(f.controller.zoomAbout(ecef(near), 1.1)).toEqual({ moved: true, constrained: null });
      expect(f.eyeTo(near)).toBeCloseTo(distance * 1.1, 3);
      expect(gap(f.pixel(near), start)).toBeLessThan(1);
    } finally { f.dispose(); }
  });

  it("does not let the orbit target's distance clamp an anchored zoom to the point", () => {
    const view = VIEWS[0];
    const f = rig(view);
    try {
      const near = f.groundUnder(640, 710);
      const start = f.pixel(near);
      // To the near limit, 25 m from the point: the orbit target, further along the sight line, ends nearer than 25 m to nothing.
      expect(f.controller.zoomAbout(ecef(near), 0.001)).toEqual({ moved: true, constrained: "distance-limit" });
      expect(f.eyeTo(near)).toBeCloseTo(DEFAULT_CAMERA_LIMITS.zoomMeters.min, 3);
      expect(gap(f.pixel(near), start)).toBeLessThan(1);
      // Babylon's own radius limits were relaxed for the orbit target the move left nearer than them.
      expect(f.camera.limits.radiusMin).toBeLessThanOrEqual(f.camera.radius);
      // The next frame drawn keeps that pose: Babylon clamps nothing back.
      const eye = f.controller.getPose().eye;
      f.camera.getViewMatrix(true);
      expect(length(sub(f.controller.getPose().eye, eye))).toBeLessThan(1e-6);
    } finally { f.dispose(); }
  });

  it("holds tilt to its limits at the centre of the view and says so", () => {
    const view = VIEWS[0];
    for (const [pitch, bound] of [[60, DEFAULT_CAMERA_LIMITS.pitchDeg.max], [-70, DEFAULT_CAMERA_LIMITS.pitchDeg.min]] as const) {
      const f = rig(view);
      try {
        const point = f.groundUnder(...PIXELS[2]);
        const start = f.pixel(point);
        const result: AnchoredMotionResult = f.controller.orbitAbout(ecef(point), pitch, 0);
        expect(result, `tilt ${pitch}`).toEqual({ moved: true, constrained: "tilt-limit" });
        if (pitch > 0) expect(f.tilt()).toBeLessThanOrEqual(bound + 1e-6);
        else expect(f.tilt()).toBeGreaterThanOrEqual(bound - 1e-6);
        expect(Math.abs(f.tilt() - bound), `tilt ${pitch} reaches its limit`).toBeLessThan(0.5);
        // The limit turns back about the pivot, which keeps its place.
        expect(gap(f.pixel(point), start), `tilt ${pitch}`).toBeLessThan(1);
      } finally { f.dispose(); }
    }
  });

  it("refuses non-finite or non-positive requests and points behind the eye, leaving the camera as it was", () => {
    const f = rig(VIEWS[0]);
    try {
      const point = ecef(f.groundUnder(...PIXELS[0]));
      const fields = cameraFields(f.camera);
      for (const factor of [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.5]) {
        expect(f.controller.zoomAbout(point, factor), `factor ${factor}`).toEqual({ moved: false, constrained: "invalid" });
      }
      const nowhere = { x: Number.NaN, y: point.y, z: point.z };
      expect(f.controller.zoomAbout(nowhere, 0.9)).toEqual({ moved: false, constrained: "invalid" });
      expect(f.controller.orbitAbout({ ...point, z: Number.POSITIVE_INFINITY }, 2, 2)).toEqual({ moved: false, constrained: "invalid" });
      expect(f.controller.orbitZoomAbout(nowhere, 2, 2, 0.9)).toEqual({ moved: false, constrained: "invalid" });
      const pose: CameraPose = f.controller.getPose();
      const behind: Vec3 = sub(pose.eye, scale(pose.forward, 1000));
      expect(f.controller.zoomAbout(ecef(behind), 0.9)).toEqual({ moved: false, constrained: "not-ahead" });
      expect(f.controller.orbitAbout(ecef(behind), 2, 2)).toEqual({ moved: false, constrained: "not-ahead" });
      expect(cameraFields(f.camera)).toEqual(fields);
      // The port's legacy signature: a factor it cannot use does nothing, as before anchors.
      expect(f.controller.zoomBy(Number.NaN, anchorAt([point.x, point.y, point.z], "zoom"))).toBeUndefined();
      expect(cameraFields(f.camera)).toEqual(fields);
    } finally { f.dispose(); }
  });
});

describe("CameraController anchored motion and the orbit target's height", () => {
  it("keeps a raised orbit target's height and offset while zooming about a ground point", () => {
    const view = VIEWS[0];
    const f = rig(view);
    try {
      f.controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => view.heightMeters, initialOffsetMeters: 300 });
      const raised = view.heightMeters + 300;
      expect(f.centreHeight()).toBeCloseTo(raised, 3);
      const point = f.groundUnder(...PIXELS[1], view.heightMeters);
      const start = f.pixel(point);
      for (let i = 0; i < 5; i += 1) {
        expect(f.controller.zoomAbout(ecef(point), 0.9).moved).toBe(true);
        expect(gap(f.pixel(point), start)).toBeLessThan(1);
        // The compass target stays at its configured height; the picked point is not raised.
        expect(Math.abs(f.centreHeight() - raised)).toBeLessThan(0.01);
        expect(gap(f.pixel(f.centre()), CENTRE)).toBeLessThan(1);
      }
      const { latDeg, lonDeg } = f.controller.getViewState();
      expect(f.controller.orbitTargetHeightAt(latDeg, lonDeg)).toBeCloseTo(raised, 6);
    } finally { f.dispose(); }
  });

  it("lowers a raised target at the near limit only for a compass-target zoom", () => {
    const view = { ...VIEWS[0], state: { ...VIEWS[0].state, zoomMeters: 30 } };
    const anchored = rig(view), centred = rig(view);
    try {
      for (const f of [anchored, centred]) f.controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => view.heightMeters, initialOffsetMeters: 300 });
      const raised = view.heightMeters + 300;
      // A point at the raised target's height just off the centre, about 30 m away: zooming hard about it reaches the near limit.
      const point = anchored.groundUnder(660, 380, raised);
      expect(anchored.controller.zoomAbout(ecef(point), 0.1).constrained).toBe("distance-limit");
      const { latDeg, lonDeg } = anchored.controller.getViewState();
      expect(anchored.controller.orbitTargetHeightAt(latDeg, lonDeg)).toBeCloseTo(raised, 6);
      // The centred zoom at the limit lowers the raised target, as it always has.
      centred.controller.zoomBy(0.1);
      expect(centred.camera.radius).toBeCloseTo(DEFAULT_CAMERA_LIMITS.zoomMeters.min, 6);
      expect(centred.centreHeight()).toBeLessThan(raised - 1);
    } finally { anchored.dispose(); centred.dispose(); }
  });
});

describe("CameraController pose", () => {
  it("reports the eye and look the real camera draws", () => {
    const f = rig(VIEWS[0]);
    try {
      const pose = f.controller.getPose();
      f.camera.getViewMatrix(true);
      const position: Vec3 = [f.camera.position.x, f.camera.position.y, f.camera.position.z];
      expect(length(sub(pose.eye, position))).toBeLessThan(1e-6);
      expect(length(pose.forward)).toBeCloseTo(1, 12);
      // The look runs from the eye through the camera's centre.
      const toCentre = sub(f.centre(), pose.eye);
      const across = length(sub(toCentre, scale(pose.forward, length(toCentre))));
      expect(across).toBeLessThan(1e-6);
    } finally { f.dispose(); }
  });
});
