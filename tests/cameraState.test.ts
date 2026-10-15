import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import type { GeospatialCamera } from "@babylonjs/core";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef } from "../src/camera/cameraMath.js";
import { CameraController, MIN_ZOOM_METERS } from "../src/babylon/cameraState.js";

function createCamera(latDeg: number, lonDeg: number, heightMeters: number, radius = 600): GeospatialCamera {
  const center = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, heightMeters);
  return {
    center: new Vector3(center.x, center.y, center.z),
    yaw: 0,
    pitch: 0,
    radius,
    fov: 0.8,
  } as GeospatialCamera;
}

function centerHeight(camera: GeospatialCamera): number {
  return ecefToGeodetic(camera.center.x, camera.center.y, camera.center.z).altMeters;
}

describe("CameraController orbit target height", () => {
  it("moves the camera orbit center to resolved surface height plus initial offset", () => {
    const camera = createCamera(44.977753, -93.265011, 0);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });

    controller.configureOrbitTargetHeight({
      resolveSurfaceHeightMeters: () => 264,
      initialOffsetMeters: 1_000,
    });

    expect(centerHeight(camera)).toBeCloseTo(1_264, 1);
  });

  it("lowers orbit target offset instead of zooming past the minimum radius", () => {
    const camera = createCamera(44.977753, -93.265011, 0, MIN_ZOOM_METERS);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({
      resolveSurfaceHeightMeters: () => 264,
      initialOffsetMeters: 1_000,
    });

    controller.zoomBy(0.5);

    expect(camera.radius).toBe(MIN_ZOOM_METERS);
    expect(centerHeight(camera)).toBeGreaterThan(264);
    expect(centerHeight(camera)).toBeLessThan(1_264);

    controller.zoomBy(0.5);
    controller.zoomBy(0.5);

    expect(camera.radius).toBe(MIN_ZOOM_METERS);
    expect(centerHeight(camera)).toBeCloseTo(264, 1);
  });

  it("lowers a raised target by camera.orbitTargetZoomStep for each e-fold of zoom", () => {
    const camera = createCamera(44.977753, -93.265011, 0, MIN_ZOOM_METERS);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => 264, initialOffsetMeters: 1_000 });
    controller.setGroundFollow({ ...controller.getGroundFollow(), zoomStepMeters: 100 });

    controller.zoomBy(0.5);
    expect(centerHeight(camera)).toBeCloseTo(1_264 - Math.LN2 * 100, 1);
  });

  it("preserves orbit center height while panning across changing city heights", () => {
    let surfaceHeightMeters = 264;
    const camera = createCamera(44.977753, -93.265011, 0, 80);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({
      resolveSurfaceHeightMeters: () => surfaceHeightMeters,
      initialOffsetMeters: 1_000,
    });
    const initialHeight = centerHeight(camera);

    surfaceHeightMeters = 420;
    controller.panBy(12, 8, 800);

    expect(centerHeight(camera)).toBeCloseTo(initialHeight, 1);
  });

  it("keeps a view set before its terrain arrived on the ground the map shows until it is moved", () => {
    let surface: number | null = null, now = 0;
    const camera = createCamera(44.977753, -93.265011, 0);
    const controller = new CameraController(camera, { nowMs: () => now, hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => surface, initialOffsetMeters: 3 });
    expect(centerHeight(camera)).toBeCloseTo(0, 1);
    expect(controller.settleOnGround(1)).toBe(false);

    // Placed before any ground was known: straight onto the first there is, a tile still flat.
    surface = 0;
    expect(controller.settleOnGround(2)).toBe(true);
    expect(centerHeight(camera)).toBeCloseTo(3, 1);
    // An unchanged surface is not looked up again.
    surface = 255;
    expect(controller.settleOnGround(2)).toBe(false);
    // Its terrain: at the ground following's speed, a frame at a time.
    now = 100;
    expect(controller.settleOnGround(3)).toBe(true);
    expect(centerHeight(camera)).toBeCloseTo(19, 1);
    for (let frame = 0; frame < 20; frame++) { now += 100; controller.settleOnGround(3); }
    expect(centerHeight(camera)).toBeCloseTo(258, 1);
    expect(controller.settleOnGround(3)).toBe(false);
    expect(camera.radius).toBe(600);

    // Moved, it is the person's view: the ground under it is followed as they move it, not at rest.
    controller.orbitBy(0, 5);
    surface = 300;
    expect(controller.settleOnGround(4)).toBe(false);
    expect(centerHeight(camera)).toBeLessThan(270);
  });

  it("puts a resting target straight onto ground that came up past the eye", () => {
    let surface = 0;
    const camera = createCamera(44.977753, -93.265011, 0, 200);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => surface });

    surface = 255;
    expect(controller.settleOnGround(2)).toBe(true);
    expect(centerHeight(camera)).toBeCloseTo(255, 1);
  });

  it("puts a target placed before any ground was known onto it once, even after the view was moved", () => {
    let surface: number | null = null;
    const camera = createCamera(44.977753, -93.265011, 0);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => surface });
    controller.orbitBy(0, 5);

    surface = 255;
    expect(controller.settleOnGround(1)).toBe(true);
    expect(centerHeight(camera)).toBeCloseTo(255, 1);
    surface = 300;
    expect(controller.settleOnGround(2)).toBe(false);
  });

  it("starts a view set over another point on the ground there", () => {
    let surface = 255;
    const camera = createCamera(44.977753, -93.265011, 0);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => surface });

    surface = 1_609;
    controller.setViewState({ latDeg: 39.7392, lonDeg: -104.9903 });
    expect(centerHeight(camera)).toBeCloseTo(1_609, 1);
  });

  it("leaves a tracked point's height to the point", () => {
    let surface: number | null = null;
    const camera = createCamera(44.977753, -93.265011, 0);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => surface });
    controller.setCenterFollowsGround(false);

    surface = 255;
    expect(controller.settleOnGround()).toBe(false);
    expect(centerHeight(camera)).toBeCloseTo(0, 1);
  });

  it("preserves orbit center height while orbiting", () => {
    let surfaceHeightMeters = 264;
    const camera = createCamera(44.977753, -93.265011, 0, 80);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.configureOrbitTargetHeight({
      resolveSurfaceHeightMeters: () => surfaceHeightMeters,
      initialOffsetMeters: 1_000,
    });
    const initialHeight = centerHeight(camera);

    surfaceHeightMeters = 420;
    controller.orbitBy(4, 7);

    expect(centerHeight(camera)).toBeCloseTo(initialHeight, 1);
  });
});
describe("CameraController after a view handed back nearer than the zoom limit", () => {
  function nearCamera(radius: number): GeospatialCamera {
    return Object.assign(createCamera(44.977753, -93.265011, 0, radius), { limits: { radiusMin: MIN_ZOOM_METERS, radiusMax: 1e8 } });
  }

  it("lets it come as near as allowed and no nearer, until it is out past the limit", () => {
    const camera = nearCamera(8);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.allowNearer(6);
    expect(controller.zoomMinMeters()).toBe(6);
    expect(camera.limits.radiusMin).toBe(6);
    controller.zoomBy(0.5);
    expect(camera.radius).toBe(6);
    controller.zoomBy(2);
    expect(camera.radius).toBe(12);
    // Back in again, still as near as allowed.
    controller.zoomBy(0.25);
    expect(camera.radius).toBe(6);
    // Out past the limit, the limit holds again.
    controller.zoomBy(10);
    expect(camera.radius).toBe(60);
    expect(controller.zoomMinMeters()).toBe(MIN_ZOOM_METERS);
    expect(camera.limits.radiusMin).toBe(MIN_ZOOM_METERS);
    controller.zoomBy(0.1);
    expect(camera.radius).toBe(MIN_ZOOM_METERS);
  });

  it("needs nothing for a view at or beyond the limit", () => {
    const camera = nearCamera(40);
    const controller = new CameraController(camera, { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    controller.allowNearer(30);
    expect(controller.zoomMinMeters()).toBe(MIN_ZOOM_METERS);
  });

  it("says where the orbit target sits over a point, once the ground there is known", () => {
    const controller = new CameraController(nearCamera(40), { nowMs: () => performance.now(), hasPickablePointAt: () => false });
    expect(controller.orbitTargetHeightAt(44.97, -93.26)).toBeNull();
    controller.configureOrbitTargetHeight({ resolveSurfaceHeightMeters: () => 264, initialOffsetMeters: 3 });
    expect(controller.orbitTargetHeightAt(44.97, -93.26)).toBe(267);
  });
});
