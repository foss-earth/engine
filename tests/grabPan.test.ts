import { GeospatialCamera, NullEngine, NullEngineOptions, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { clientRay, projectEcefToClient } from "../src/babylon/anchorPan.js";
import { CameraController } from "../src/babylon/cameraState.js";
import { createGlobeInertia } from "../src/babylon/globeInertia.js";
import { rayToHeight } from "../src/camera/anchoredMotion.js";
import { RAD_TO_DEG, type EcefCoord } from "../src/camera/cameraMath.js";
import { length, sub, type Vec3 } from "../src/camera/geographicFrames.js";
import type { GlobeViewState } from "../src/view.js";

// A grab pan on the real globe camera's high-precision view and projection:
// the ground grabbed under the pointer is brought to the pointer, exactly or
// as a damped spring, with heading, tilt and distance kept, and a release
// glides on as the camera was moving.

const WIDTH = 1280, HEIGHT = 720;
const FRAME_MS = 1000 / 60;

function canvasStub(): HTMLCanvasElement {
  return { clientWidth: WIDTH, clientHeight: HEIGHT,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }) } as unknown as HTMLCanvasElement;
}

interface View {
  readonly name: string;
  readonly state: GlobeViewState;
  /** The ground's height, metres: what the displayed surface is in these views. */
  readonly heightMeters: number;
}

const VIEWS: readonly View[] = [
  { name: "a city block, tilted", state: { latDeg: 44.9778, lonDeg: -93.265, headingDeg: -14, pitchDeg: 50, zoomMeters: 600 }, heightMeters: 260 },
  { name: "a mountain valley, steep", state: { latDeg: 46.55, lonDeg: 8.0, headingDeg: 120, pitchDeg: 80, zoomMeters: 5000 }, heightMeters: 1800 },
  { name: "low and grazing", state: { latDeg: 37.75, lonDeg: -122.45, headingDeg: 250, pitchDeg: 12, zoomMeters: 900 }, heightMeters: 0 },
  { name: "the antimeridian", state: { latDeg: -17.5, lonDeg: 179.999, headingDeg: 45, pitchDeg: 35, zoomMeters: 20_000 }, heightMeters: 0 },
  { name: "the whole globe", state: { latDeg: 20, lonDeg: 10, headingDeg: 0, pitchDeg: 90, zoomMeters: 5_000_000 }, heightMeters: 0 },
];

/** A grab from one pixel to another: both below the horizon in every view above. */
const DRAGS: ReadonlyArray<readonly [readonly [number, number], readonly [number, number]]> = [
  [[300, 600], [700, 420]],
  [[1100, 650], [900, 500]],
  [[640, 500], [500, 690]],
];

interface RigOptions {
  /** The ground height the orbit target follows at a latitude and longitude; the view's own by default. */
  heightAt?: (latDeg: number, lonDeg: number) => number;
  /** Whether the host offers the displayed surface to grab; without it, the ellipsoid. */
  surface?: boolean;
  pickable?: boolean;
}

function rig(view: View, options: RigOptions = {}) {
  const engine = new NullEngine({ ...new NullEngineOptions(), renderWidth: WIDTH, renderHeight: HEIGHT, useHighPrecisionMatrix: true });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("grab", scene, { planetRadius: 6378137 });
  camera.fov = 0.8;
  const canvas = canvasStub();
  let now = 1000;
  // The displayed surface, flat at the view's height: where the camera's ray through a pixel comes down to it.
  const groundUnder = (x: number, y: number): Vec3 | null => {
    camera.getViewMatrix(true);
    const ray = clientRay(scene, camera, canvas, x, y);
    return ray && rayToHeight([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z], view.heightMeters);
  };
  const groundAt = vi.fn((client: { readonly x: number; readonly y: number }): EcefCoord | null => {
    const hit = groundUnder(client.x, client.y);
    return hit ? { x: hit[0], y: hit[1], z: hit[2] } : null;
  });
  const controller = new CameraController(camera, {
    nowMs: () => now, hasPickablePointAt: () => options.pickable ?? false,
    ...(options.surface === false ? {} : { groundAt }),
  });
  camera.radius = view.state.zoomMeters;
  controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: options.heightAt ?? (() => view.heightMeters) });
  controller.applyViewState(view.state, view.heightMeters);
  const pixel = (point: Vec3): { x: number; y: number } => {
    camera.getViewMatrix(true);
    const drawn = projectEcefToClient(new Vector3(...point), scene, camera, canvas);
    if (!drawn) throw new Error("The point is behind the camera.");
    return drawn;
  };
  const pick = (x: number, y: number) => ({ clientX: x, clientY: y, canvas });
  /** One frame: the clock moves on, and the grab steps. */
  const frame = (followMs: number, ms = FRAME_MS): boolean => { now += ms; return controller.stepAnchorPan(ms, followMs); };
  const shape = () => ({ yaw: camera.yaw, pitch: camera.pitch, radius: camera.radius });
  const dispose = (): void => { scene.dispose(); engine.dispose(); };
  return { scene, camera, canvas, controller, groundAt, groundUnder, pixel, pick, frame, shape, dispose,
    now: () => now, advance: (ms: number) => { now += ms; } };
}

const gap = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: readonly [number, number], b: readonly [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

describe("grab pan at two frame rates", () => {
  /** A steady drag at one hand speed, then the glide after letting go. */
  function drag(dtMs: number, pxPerSecond: number) {
    const f = rig(VIEWS[0]);
    const inertia = createGlobeInertia(f.controller, { nowMs: f.now, decayPerFrame: () => 0.82, renderer: { requestRender: vi.fn() }, grabFollowMs: () => 0 });
    const frames = Math.round(400 / dtMs);
    try {
      inertia.beginAnchorPan!(f.pick(300, 500));
      const point = f.groundUnder(300, 500)!;
      let x = 300;
      let lag = 0;
      for (let i = 0; i < frames; i += 1) {
        x += pxPerSecond * dtMs / 1000;
        inertia.panAnchorTo!(f.pick(x, 500));
        f.advance(dtMs);
        inertia.update(f.now());
        lag = gap(f.pixel(point), { x, y: 500 });
      }
      const atRelease = f.camera.center.clone();
      const releasePixel = f.pixel(point);
      inertia.endAnchorPan!();
      f.advance(dtMs);
      inertia.update(f.now());
      const first = gap(f.pixel(point), releasePixel);
      for (let i = 0; i < Math.round(2500 / dtMs) && inertia.isActive(); i += 1) { f.advance(dtMs); inertia.update(f.now()); }
      return { lag, first, meters: f.camera.center.subtract(atRelease).length() };
    } finally { f.dispose(); }
  }

  it("holds the ground on the pointer, and a 120 Hz display does not fling it further than a 60 Hz one", () => {
    const slow60 = drag(1000 / 60, 200);
    const slow120 = drag(1000 / 120, 200);
    const fast60 = drag(1000 / 60, 1200);
    const fast120 = drag(1000 / 120, 1200);
    for (const run of [slow60, slow120, fast60, fast120]) expect(run.lag).toBeLessThan(0.01);
    // The same hand speed covers about the same ground after release. The first frame scales with the frame time.
    for (const [at60, at120] of [[slow60, slow120], [fast60, fast120]] as const) {
      expect(at120.meters / at60.meters).toBeGreaterThan(0.9);
      expect(at120.meters / at60.meters).toBeLessThan(1.1);
      expect(at120.first).toBeGreaterThan(at60.first * 0.4);
      expect(at120.first).toBeLessThan(at60.first * 0.6);
    }
  });
});

describe("CameraController grab pan on the real globe camera", () => {
  it("holds the grabbed ground exactly under the pointer with no follow time, keeping heading, tilt and distance", () => {
    for (const view of VIEWS) {
      for (const [from, to] of DRAGS) {
        const f = rig(view);
        try {
          expect(f.controller.beginAnchorPan(f.pick(...from)), view.name).toBe(true);
          const point = f.groundUnder(...from)!;
          const before = f.shape();
          for (let i = 1; i <= 12; i += 1) {
            const [x, y] = lerp(from, to, i / 12);
            f.controller.panAnchorTo(f.pick(x, y));
            f.frame(0);
            expect(gap(f.pixel(point), { x, y }), `${view.name} ${from}→${to}, move ${i}`).toBeLessThan(1e-3);
          }
          const after = f.shape();
          expect(after.yaw, view.name).toBeCloseTo(before.yaw, 9);
          expect(after.pitch, view.name).toBeCloseTo(before.pitch, 9);
          expect(after.radius / before.radius, view.name).toBeCloseTo(1, 9);
        } finally { f.dispose(); }
      }
    }
  });

  it("grabs the displayed surface under the pointer, not the ellipsoid under it", () => {
    const valley = VIEWS[1];
    const f = rig(valley), bare = rig(valley, { surface: false });
    try {
      const [from, to] = DRAGS[0];
      for (const g of [f, bare]) {
        expect(g.controller.beginAnchorPan(g.pick(...from))).toBe(true);
        g.controller.panAnchorTo(g.pick(...to));
        g.frame(0);
      }
      expect(f.groundAt).toHaveBeenCalledWith({ x: from[0], y: from[1] });
      // 1800 m up, the ground under the pointer is not the ellipsoid point behind it: only the surface grab keeps it there.
      expect(gap(f.pixel(f.groundUnder(...to)!), { x: to[0], y: to[1] })).toBeLessThan(0.5);
      // The ellipsoid grab holds a point 1800 m below the ground drawn there, so its camera ends elsewhere.
      expect(length(sub(f.controller.getPose().eye, bare.controller.getPose().eye))).toBeGreaterThan(10);
    } finally { f.dispose(); bare.dispose(); }
  });

  it("grabs nothing over a pickable world point or where there is no ground", () => {
    const view = VIEWS[2];
    const f = rig(view, { pickable: true }), sky = rig(view);
    try {
      expect(f.controller.beginAnchorPan(f.pick(640, 600))).toBe(false);
      expect(f.controller.isAnchorPanActive()).toBe(false);
      // Low and grazing, the top of the view is sky.
      expect(sky.groundUnder(640, 2)).toBeNull();
      expect(sky.controller.beginAnchorPan(sky.pick(640, 2))).toBe(false);
      expect(sky.controller.panAnchorTo(sky.pick(600, 2))).toBe(false);
      expect(sky.controller.endAnchorPan()).toBeNull();
    } finally { f.dispose(); sky.dispose(); }
  });

  it("brings the ground to the pointer as a critically damped spring: nearer every frame, never past it, there within a few follow times", () => {
    for (const view of VIEWS) {
      const f = rig(view);
      try {
        const [from, to] = DRAGS[0];
        f.controller.beginAnchorPan(f.pick(...from));
        const point = f.groundUnder(...from)!;
        f.controller.panAnchorTo(f.pick(...to));
        const target = { x: to[0], y: to[1] };
        const start = gap(f.pixel(point), target);
        let last = start;
        // Half a second at 60 Hz: some seventeen time constants of 30 ms.
        for (let i = 0; i < 30; i += 1) {
          f.frame(30);
          const now = gap(f.pixel(point), target);
          expect(now, `${view.name}, frame ${i}`).toBeLessThanOrEqual(last + 1e-6);
          last = now;
        }
        expect(last, view.name).toBeLessThan(0.05);
        // Part of the way after one frame: smooth, not a jump.
        const f2 = rig(view);
        try {
          f2.controller.beginAnchorPan(f2.pick(...from));
          f2.controller.panAnchorTo(f2.pick(...to));
          f2.frame(30);
          const afterOne = gap(f2.pixel(point), target);
          // A 30 ms spring, one 16.7 ms frame on: (1 + ωt)e^(-ωt) ≈ 0.89 of the way still to go.
          expect(afterOne, view.name).toBeGreaterThan(0.75 * start);
          expect(afterOne, view.name).toBeLessThan(0.97 * start);
        } finally { f2.dispose(); }
        expect(f.frame(30), `${view.name}: at rest`).toBe(false);
      } finally { f.dispose(); }
    }
  });

  it("glides on as the camera was moving when let go, and not when it had come to rest", () => {
    const view = VIEWS[0];
    for (const followMs of [0, 30]) {
      const f = rig(view);
      try {
        f.controller.beginAnchorPan(f.pick(400, 500));
        // Six pixels a frame to the right, for a third of a second.
        for (let i = 1; i <= 20; i += 1) {
          f.controller.panAnchorTo(f.pick(400 + 6 * i, 500));
          f.frame(followMs);
        }
        const fling = f.controller.endAnchorPan();
        expect(fling, `follow ${followMs}`).not.toBeNull();
        // The ground went right, so the centre glides left: the pan glide's pixels are the centre's.
        expect(fling!.screenDxPx, `follow ${followMs}`).toBeLessThan(-4);
        expect(fling!.screenDxPx, `follow ${followMs}`).toBeGreaterThan(-8);
        expect(Math.abs(fling!.screenDyPx), `follow ${followMs}`).toBeLessThan(1.5);
        expect(fling!.canvasHeight).toBe(HEIGHT);
        expect(f.controller.isAnchorPanActive()).toBe(false);

        // Held still before letting go: nothing to glide with.
        f.controller.beginAnchorPan(f.pick(400, 500));
        for (let i = 1; i <= 10; i += 1) { f.controller.panAnchorTo(f.pick(400 + 6 * i, 500)); f.frame(followMs); }
        for (let i = 0; i < 60; i += 1) f.frame(followMs);
        expect(f.controller.isAnchorPanMoving(), `follow ${followMs}`).toBe(false);
        expect(f.controller.endAnchorPan(), `follow ${followMs}`).toBeNull();
      } finally { f.dispose(); }
    }
  });

  it("stops short of the horizon, moving nothing to non-finite values, when the pointer goes up into the sky", () => {
    const view = VIEWS[2];
    const f = rig(view);
    try {
      f.controller.beginAnchorPan(f.pick(640, 600));
      const point = f.groundUnder(640, 600)!;
      const before = f.shape();
      f.controller.panAnchorTo(f.pick(640, 1));
      for (let i = 0; i < 30; i += 1) f.frame(0);
      const fields = [f.camera.center.x, f.camera.center.y, f.camera.center.z, f.camera.yaw, f.camera.pitch, f.camera.radius];
      expect(fields.every(Number.isFinite)).toBe(true);
      expect(f.camera.pitch).toBeCloseTo(before.pitch, 9);
      // As far up the view as it goes: nearer the pointer than it started.
      expect(f.pixel(point).y).toBeLessThan(600);
    } finally { f.dispose(); }
  });

  it("settles the grabbed ground back under the pointer as the orbit target climbs onto higher ground", () => {
    const view = VIEWS[0];
    // A bluff 120 m above the river, east of the start.
    const f = rig(view, { heightAt: (_lat, lon) => (lon > view.state.lonDeg + 0.0005 ? view.heightMeters + 120 : view.heightMeters) });
    try {
      const [from] = DRAGS[0];
      f.controller.beginAnchorPan(f.pick(...from));
      const point = f.groundUnder(...from)!;
      // Drag the view west, so the centre travels east, onto the bluff.
      const to: [number, number] = [from[0] - 500, from[1] - 40];
      f.controller.panAnchorTo(f.pick(...to));
      for (let i = 0; i < 600; i += 1) f.frame(0);
      expect(gap(f.pixel(point), { x: to[0], y: to[1] })).toBeLessThan(0.01);
    } finally { f.dispose(); }
  });
});

describe("createGlobeInertia grab pan", () => {
  it("steps the grab each frame, keeps frames coming while it moves, glides on after release, and cancels without a glide", () => {
    const view = VIEWS[0];
    const f = rig(view);
    const requestRender = vi.fn();
    const inertia = createGlobeInertia(f.controller, { nowMs: f.now, decayPerFrame: () => 0.82, renderer: { requestRender }, grabFollowMs: () => 30 });
    try {
      expect(inertia.beginAnchorPan!(f.pick(400, 500))).toBe(true);
      const point = f.groundUnder(400, 500)!;
      expect(inertia.panAnchorTo!(f.pick(460, 500))).toBe(true);
      expect(requestRender).toHaveBeenCalled();
      expect(inertia.isActive()).toBe(true);
      for (let i = 0; i < 3; i += 1) { f.advance(FRAME_MS); inertia.update(f.now()); }
      // On its way, smoothly.
      const partway = f.pixel(point).x;
      expect(partway).toBeGreaterThan(400);
      expect(partway).toBeLessThan(460);

      const centreBefore = f.camera.center.clone();
      inertia.endAnchorPan!();
      expect(f.controller.isAnchorPanActive()).toBe(false);
      expect(inertia.isActive()).toBe(true);
      f.advance(FRAME_MS); inertia.update(f.now());
      // Still moving the same way: the ground carries on to the right.
      expect(f.pixel(point).x).toBeGreaterThan(partway);
      expect(f.camera.center.subtract(centreBefore).length()).toBeGreaterThan(0);
      for (let i = 0; i < 200 && inertia.isActive(); i += 1) { f.advance(FRAME_MS); inertia.update(f.now()); }
      expect(inertia.isActive()).toBe(false);

      // Cancelled mid-grab: no grab, and no glide from it.
      inertia.beginAnchorPan!(f.pick(400, 500));
      inertia.panAnchorTo!(f.pick(500, 500));
      for (let i = 0; i < 3; i += 1) { f.advance(FRAME_MS); inertia.update(f.now()); }
      inertia.cancel();
      expect(f.controller.isAnchorPanActive()).toBe(false);
      expect(inertia.isActive()).toBe(false);
    } finally { f.dispose(); }
  });

  it("reports the grabbed point from the press, through the drag and the glide, and drops it at rest, on a click and on cancel", () => {
    const view = VIEWS[0];
    const f = rig(view);
    const inertia = createGlobeInertia(f.controller, { nowMs: f.now, decayPerFrame: () => 0.82, renderer: { requestRender: vi.fn() }, grabFollowMs: () => 0 });
    const press = (): { x: number; y: number; z: number } => {
      expect(inertia.beginAnchorPan!(f.pick(400, 500))).toBe(true);
      const point = f.groundUnder(400, 500)!;
      const grabbed = { x: point[0], y: point[1], z: point[2] };
      expect(inertia.anchors().pan).toEqual(grabbed);
      return grabbed;
    };
    /** The pointer keeps moving, so the release still has speed to glide with. */
    const sweep = (grabbed: { x: number; y: number; z: number }): void => {
      for (let i = 1; i <= 8; i += 1) {
        inertia.panAnchorTo!(f.pick(400 + 10 * i, 500));
        f.advance(FRAME_MS);
        inertia.update(f.now());
        expect(inertia.anchors().pan).toEqual(grabbed);
        expect(inertia.anchors().panHeld).toBe(true);
      }
    };
    try {
      expect(inertia.anchors().pan).toBeUndefined();
      // A press that never moves shows the ground, and letting go removes it: there is no glide.
      press();
      inertia.endAnchorPan!();
      expect(inertia.anchors().pan).toBeUndefined();
      expect(inertia.isActive()).toBe(false);

      const dragged = press();
      sweep(dragged);
      inertia.endAnchorPan!();
      expect(inertia.isActive()).toBe(true);
      expect(inertia.anchors().panHeld).toBe(false);
      expect(inertia.anchors().pan).toEqual(dragged);
      f.advance(FRAME_MS); inertia.update(f.now());
      expect(inertia.anchors().pan).toEqual(dragged);
      for (let i = 0; i < 400 && inertia.anchors().pan; i += 1) { f.advance(FRAME_MS); inertia.update(f.now()); }
      expect(inertia.anchors().pan).toBeUndefined();
      expect(inertia.isActive()).toBe(false);

      // Cancelled mid-drag: the point goes with the grab, and nothing glides.
      const cancelled = press();
      inertia.panAnchorTo!(f.pick(520, 500));
      f.advance(FRAME_MS); inertia.update(f.now());
      expect(inertia.anchors().pan).toEqual(cancelled);
      inertia.cancel();
      expect(inertia.anchors().pan).toBeUndefined();
      expect(f.controller.isAnchorPanActive()).toBe(false);
      expect(inertia.isActive()).toBe(false);

      // Stopping the glide under a grab still held keeps the point; stopping the glide after release drops it.
      const held = press();
      inertia.cancelInertial!();
      expect(f.controller.isAnchorPanActive()).toBe(true);
      expect(inertia.anchors().pan).toEqual(held);
      sweep(held);
      inertia.endAnchorPan!();
      expect(inertia.anchors().pan).toEqual(held);
      inertia.cancelInertial!();
      expect(inertia.anchors().pan).toBeUndefined();
      expect(inertia.isActive()).toBe(false);

      // Another pan, turn or zoom during the glide drops the point. The grab is no longer what holds it.
      for (const again of [
        () => inertia.panBy(2, 0, HEIGHT),
        () => inertia.orbitBy(0.4, 0),
        () => inertia.zoomBy(0.98),
      ]) {
        const gliding = press();
        sweep(gliding);
        inertia.endAnchorPan!();
        expect(inertia.anchors().pan).toEqual(gliding);
        again();
        expect(inertia.anchors().pan).toBeUndefined();
        inertia.cancel();
      }

      // Held still after a drag: the point stays until release, and a settled release does not glide.
      const settled = press();
      inertia.panAnchorTo!(f.pick(470, 500));
      for (let i = 0; i < 90; i += 1) { f.advance(FRAME_MS); inertia.update(f.now()); }
      expect(f.controller.isAnchorPanMoving()).toBe(false);
      expect(inertia.anchors().pan).toEqual(settled);
      inertia.endAnchorPan!();
      expect(inertia.anchors().pan).toBeUndefined();
      expect(inertia.isActive()).toBe(false);
    } finally { f.dispose(); }
  });

  it("keeps feeding a released grab for about as long as a swipe's wheel events", () => {
    const view = VIEWS[0];
    const f = rig(view);
    const inertia = createGlobeInertia(f.controller, { nowMs: f.now, decayPerFrame: () => 0.82, renderer: { requestRender: vi.fn() }, grabFollowMs: () => 0 });
    try {
      inertia.beginAnchorPan!(f.pick(300, 500));
      let x = 300;
      for (let i = 0; i < 20; i += 1) {
        x += 8;
        inertia.panAnchorTo!(f.pick(x, 500));
        f.advance(FRAME_MS);
        inertia.update(f.now());
      }
      const atRelease = f.camera.center.clone();
      expect(inertia.anchors().panHeld).toBe(true);
      expect(f.controller.isAnchorPanActive()).toBe(true);
      inertia.endAnchorPan!();
      // The finger is up, so the grab no longer holds the camera. The point stays for the glide.
      expect(f.controller.isAnchorPanActive()).toBe(false);
      expect(inertia.anchors().panHeld).toBe(false);
      expect(inertia.anchors().pan).toBeDefined();
      // Forty-two frames is about 700 ms. Decay alone, 0.82^42, would have stopped it.
      for (let i = 0; i < 42; i += 1) { f.advance(FRAME_MS); inertia.update(f.now()); }
      expect(inertia.isActive()).toBe(true);
      expect(f.camera.center.subtract(atRelease).length()).toBeGreaterThan(20);
      for (let i = 0; i < 200 && inertia.isActive(); i += 1) { f.advance(FRAME_MS); inertia.update(f.now()); }
      expect(inertia.isActive()).toBe(false);
      expect(inertia.anchors().pan).toBeUndefined();
    } finally { f.dispose(); }
  });

  it("reads the follow time at each frame, holding the ground exactly at 0", () => {
    const view = VIEWS[1];
    const f = rig(view);
    let followMs = 0;
    const inertia = createGlobeInertia(f.controller, { nowMs: f.now, decayPerFrame: () => 0.82, renderer: { requestRender: vi.fn() }, grabFollowMs: () => followMs });
    try {
      inertia.beginAnchorPan!(f.pick(300, 600));
      const point = f.groundUnder(300, 600)!;
      inertia.panAnchorTo!(f.pick(600, 450));
      f.advance(FRAME_MS); inertia.update(f.now());
      expect(gap(f.pixel(point), { x: 600, y: 450 })).toBeLessThan(1e-3);
      followMs = 100;
      inertia.panAnchorTo!(f.pick(700, 450));
      f.advance(FRAME_MS); inertia.update(f.now());
      expect(gap(f.pixel(point), { x: 700, y: 450 })).toBeGreaterThan(10);
      expect(90 - f.camera.pitch * RAD_TO_DEG).toBeCloseTo(view.state.pitchDeg, 6);
    } finally { f.dispose(); }
  });
});
