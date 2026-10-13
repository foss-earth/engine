import { GeospatialCamera, NullEngine, NullEngineOptions, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { CameraController } from "../src/babylon/cameraState.js";
import { createNavigationCameraAdapter } from "../src/babylon/navigationCamera.js";
import { createNavigationOwner, type NavigationOwner } from "../src/navigation/navigationLease.js";
import { createInertialCameraController } from "../src/input/inertialCameraController.js";
import { DEFAULT_CAMERA_LIMITS } from "../src/camera/cameraLimits.js";
import { geodeticToEcef, DEG_TO_RAD } from "../src/camera/cameraMath.js";

function fixture() {
  const engine = new NullEngine({ ...new NullEngineOptions(), useHighPrecisionMatrix: true });
  const scene = new Scene(engine); scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("host-camera", scene, { planetRadius: 6378137 });
  const point = geodeticToEcef(44 * DEG_TO_RAD, -93 * DEG_TO_RAD, 200);
  camera.center = new Vector3(point.x, point.y, point.z); camera.radius = 200; camera.pitch = 1; camera.fov = 0.8;
  let now = 1000;
  let decay = 0.82;
  const controller = new CameraController(camera, { nowMs: () => now, hasPickablePointAt: () => false });
  const target = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
  const inertia = createInertialCameraController<HTMLCanvasElement>(target, { nowMs: () => now, decayPerFrame: () => decay });
  const requestRender = vi.fn();
  // All callbacks share this host's existing camera/clock/settings/frame authority.
  const owner: NavigationOwner<unknown, AbortSignal> = createNavigationOwner({ focusReturn: () => null,
    createAbortController: () => new AbortController(), abortReason: reason => new DOMException(reason, "AbortError"),
    unavailable: () => null, snapshot: () => adapter.captureNavigationSnapshot(),
    suspend: () => adapter.suspendCamera(), resume: () => adapter.restoreCameraLimits(), present() {},
    requestRender, beginContinuous() {}, endContinuous() {} });
  const adapter: ReturnType<typeof createNavigationCameraAdapter> = createNavigationCameraAdapter({ getCamera: () => camera, getController: () => controller,
    getInertia: () => inertia, currentLease: () => owner.current(), unavailable: () => false,
    scene, canvas: { clientHeight: 800, height: 800 }, renderer: { requestRender },
    settings: { get: <T = unknown>() => decay as T }, cameraLimits: () => DEFAULT_CAMERA_LIMITS });
  const acquired = owner.acquire({ owner: "fixture", inputContext: "placed-camera" });
  if (!acquired.ok) throw new Error(acquired.message);
  return { engine, camera, owner, adapter, lease: acquired.lease, inertia, target, requestRender,
    setTime: (value: number) => { now = value; }, setDecay: (value: number) => { decay = value; } };
}

describe("host-supplied navigation camera handover", () => {
  it("can place a view without asking for another frame", () => {
    const f = fixture();
    try {
      const pivot = f.lease.overview.camera.center;
      const position = { x: pivot.x + 40, y: pivot.y, z: pivot.z + 30 };
      const d = { x: pivot.x - position.x, y: pivot.y - position.y, z: pivot.z - position.z };
      const length = Math.hypot(d.x, d.y, d.z);
      const view = { position, forward: { x: d.x / length, y: d.y / length, z: d.z / length },
        up: { x: 0, y: 0, z: 1 }, verticalFovRad: 1 };
      f.requestRender.mockClear();
      expect(f.adapter.placeNavigationCamera(f.lease, view, { render: false })).toBe(true);
      expect(f.requestRender).not.toHaveBeenCalled();
      expect(f.adapter.placeNavigationCamera(f.lease, view)).toBe(true);
      expect(f.requestRender).toHaveBeenCalled();
    } finally { f.owner.dispose(); f.engine.dispose(); }
  });
  it("restores the exact saved ECEF center and refuses a foreign lease", () => {
    const f = fixture();
    try {
      const saved = f.lease.overview;
      const foreign = { ...f.lease };
      expect(f.adapter.restoreNavigationSnapshot(saved, foreign)).toBe(false);
      f.camera.center = new Vector3(6378137, 0, 0);
      expect(f.adapter.restoreNavigationSnapshot(saved, f.lease)).toBe(true);
      expect(f.camera.center.asArray()).toEqual([saved.camera.center.x, saved.camera.center.y, saved.camera.center.z]);
      expect(f.camera.fov).toBe(saved.camera.fov);
    } finally { f.owner.dispose(); f.engine.dispose(); }
  });
  it("carries momentum and the still-held person gesture into one globe inertia authority", () => {
    const f = fixture();
    try {
      const pivot = f.lease.overview.camera.center;
      const position = { x: pivot.x + 40, y: pivot.y, z: pivot.z + 30 };
      const d = { x: pivot.x - position.x, y: pivot.y - position.y, z: pivot.z - position.z };
      const length = Math.hypot(d.x, d.y, d.z);
      const view = { position, forward: { x: d.x / length, y: d.y / length, z: d.z / length },
        up: { x: 0, y: 0, z: 1 }, verticalFovRad: 1 };
      f.camera.checkCollisions = true;
      expect(f.adapter.placeNavigationCamera(f.lease, view)).toBe(true);
      expect(f.camera.checkCollisions).toBe(false);
      const press = { pointerId: 1, button: 0, clientX: 120, clientY: 200 };
      const touches = [{ identifier: 3, clientX: 100, clientY: 210 }, { identifier: 4, clientX: 180, clientY: 230 }];
      expect(f.adapter.glideNavigationCamera(f.lease, view, pivot, {
        velocity: { x: 0, y: 10, z: 0 }, turn: { x: 0, y: 0, z: 0 }, fovRad: 0.8, inputSince: 900, press, touches,
      })).toBe(true);
      expect(f.camera.checkCollisions).toBe(true);
      expect(f.adapter.takeInputHandback()).toEqual({ keepWheelSince: 900, press, touches });
      expect(f.adapter.takeInputHandback()).toBeNull();
      expect(f.inertia.isActive()).toBe(true);
      f.lease.release("cancelled");
      f.inertia.update();
      expect(f.target.panBy).toHaveBeenCalled();
      const initialFov = f.camera.fov;
      f.adapter.stepFovReturn(1000);
      expect(f.camera.fov).toBeCloseTo(0.8 + (initialFov - 0.8) * 0.82, 12);
      f.setDecay(0); f.adapter.stepFovReturn(1017);
      expect(f.camera.fov).toBe(0.8);
      expect(f.adapter.isFovReturning()).toBe(false);
      expect(f.adapter.placeNavigationCamera(f.lease, view)).toBe(false);
    } finally { f.owner.dispose(); f.engine.dispose(); }
  });
});
