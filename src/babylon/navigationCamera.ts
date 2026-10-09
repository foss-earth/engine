import { Vector2, Vector3, ComputeYawPitchFromLookAtToRef, type GeospatialCamera, type Scene } from "@babylonjs/core";
import type { RenderScheduler } from "@foss-earth/renderer";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { CameraController } from "./cameraState.js";
import { ecefToGeodetic, RAD_TO_DEG } from "../camera/cameraMath.js";
import { withinTilt, orbitCenterOnSight, orbitGlideRates, type GlideVec3 } from "../camera/cameraGlide.js";
import { DEFAULT_INERTIA_DECAY_PER_FRAME, MAX_ZOOM_LOG_DELTA_PER_FRAME, type InertialCameraController } from "../input/inertialCameraController.js";
import type { CameraLimits } from "../camera/cameraLimits.js";
import type { InputHandback } from "../browser/createInputController.js";
import type { EcefVector, NavigationLease, NavigationPresentation, NavigationSnapshot, NavigationGlide } from "../navigation/navigationLease.js";

export interface NavigationCameraPorts {
  getCamera(): GeospatialCamera | null;
  getController(): CameraController | null;
  getInertia(): InertialCameraController<HTMLCanvasElement> | null;
  currentLease(): NavigationLease | null;
  unavailable(): boolean;
  scene: Pick<Scene, "useRightHandedSystem">;
  canvas: Pick<HTMLCanvasElement, "clientHeight" | "height">;
  renderer: Pick<RenderScheduler, "requestRender">;
  settings: Pick<SettingsRegistry, "get">;
  cameraLimits(): CameraLimits;
}

/** Source camera handover binding; creates no camera, backend, scheduler or clock. */
export function createNavigationCameraAdapter(ports: NavigationCameraPorts) {
  const captureNavigationSnapshot = (): NavigationSnapshot | null => {
    const camera = ports.getCamera();
    const view = ports.getController()?.getViewState();
    if (ports.unavailable() || !camera || !view) return null;
    const { x, y, z } = camera.center;
    // A field of view on its way back is the one it returns to.
    return { version: 1, view, camera: { center: { x, y, z }, yaw: camera.yaw, pitch: camera.pitch, radius: camera.radius, fov: fovReturn?.target ?? camera.fov } };
  };
  const restoreNavigationSnapshot = (snapshot: NavigationSnapshot, lease?: NavigationLease): boolean => {
    const current = ports.currentLease();
    const camera = ports.getCamera();
    if ((current && current !== lease) || !camera || ports.unavailable()) return false;
    ports.getInertia()?.cancel();
    fovReturn = null;
    const { center, yaw, pitch, radius, fov } = snapshot.camera;
    // A view saved nearer than the zoom limit, after a handback, is kept as near.
    ports.getController()?.allowNearer(radius);
    // From a placed view, the camera reaches the orbit with collisions still
    // off: each of the steps below moves the eye, and the steps between are
    // not places it passes through.
    camera.center = new Vector3(center.x, center.y, center.z);
    camera.yaw = yaw;
    camera.pitch = pitch;
    camera.radius = radius;
    camera.fov = fov;
    restoreCameraLimits();
    ports.renderer.requestRender();
    return true;
  };
  // A placed camera's lifted limits and collisions, until a snapshot is restored or the lease ends.
  let liftedCameraLimits: { collisions: boolean; pitchMin: number; pitchMax: number } | null = null;
  function restoreCameraLimits(): void {
    const camera = ports.getCamera();
    if (!liftedCameraLimits || !camera) return;
    camera.checkCollisions = liftedCameraLimits.collisions;
    camera.limits.pitchMin = liftedCameraLimits.pitchMin;
    camera.limits.pitchMax = liftedCameraLimits.pitchMax;
    // The zoom limit may have changed meanwhile; its setting is the source.
    camera.limits.radiusMin = ports.getController()?.zoomMinMeters() ?? ports.cameraLimits().zoomMeters.min;
    liftedCameraLimits = null;
  }
  /** Metres from a placed eye to the orbit centre it turns about: any point on its line of sight. */
  const PLACED_REACH_METERS = 1;
  /** The frame `camera.inertiaDecay` is given per. */
  const GLIDE_FRAME_MS = 1000 / 60;
  /** A field of view within this of the globe's, radians, has returned to it. */
  const FOV_RETURNED_RAD = 1e-4;
  const placeNavigationCamera = (lease: NavigationLease, view: NavigationPresentation): boolean => {
    const camera = ports.getCamera();
    if (ports.currentLease() !== lease || lease.released || !camera || ports.unavailable()) return false;
    ports.getInertia()?.cancel();
    if (!liftedCameraLimits) {
      liftedCameraLimits = { collisions: camera.checkCollisions, pitchMin: camera.limits.pitchMin, pitchMax: camera.limits.pitchMax };
      camera.checkCollisions = false;
      camera.limits.radiusMin = 0;
      camera.limits.pitchMin = 0;
      camera.limits.pitchMax = Math.PI;
    }
    const forward = new Vector3(view.forward.x, view.forward.y, view.forward.z).normalize();
    const center = new Vector3(view.position.x, view.position.y, view.position.z).addInPlace(forward.scale(PLACED_REACH_METERS));
    const angles = ComputeYawPitchFromLookAtToRef(forward, center, ports.scene.useRightHandedSystem, camera.yaw, new Vector2());
    camera.center = center;
    camera.yaw = angles.x;
    // Straight up or down would wrap; stay just inside.
    camera.pitch = Math.min(Math.PI - 1e-6, Math.max(1e-6, angles.y));
    camera.radius = PLACED_REACH_METERS;
    camera.fov = view.verticalFovRad;
    // Babylon keeps its own up level; a placed view may roll. Set after the
    // orientation, before the view matrix is built from it again.
    camera.upVector.set(view.up.x, view.up.y, view.up.z);
    // A collision offset left from before could alias Babylon's scratch vectors; placed, there is none.
    camera.perFrameCollisionOffset = new Vector3();
    ports.renderer.requestRender();
    return true;
  };
  // A handed-back camera's field of view easing to the globe's, at the glide's rate.
  let fovReturn: { target: number; lastMs: number | null } | null = null;
  // Input already under way that goes on to the globe when the lease ends.
  let pendingHandback: InputHandback | null = null;
  function glideKeepPerFrame(): number {
    const decay = ports.settings.get("camera.inertiaDecay");
    return Math.max(0, Math.min(0.999, typeof decay === "number" ? decay : DEFAULT_INERTIA_DECAY_PER_FRAME));
  }
  function stepFovReturn(nowMs: number): void {
    const camera = ports.getCamera();
    if (!fovReturn || !camera || ports.currentLease()) return;
    const dt = fovReturn.lastMs === null ? GLIDE_FRAME_MS : Math.max(0, Math.min(100, nowMs - fovReturn.lastMs));
    fovReturn.lastMs = nowMs;
    camera.fov = fovReturn.target + (camera.fov - fovReturn.target) * Math.pow(glideKeepPerFrame(), dt / GLIDE_FRAME_MS);
    if (Math.abs(camera.fov - fovReturn.target) < FOV_RETURNED_RAD) {
      camera.fov = fovReturn.target;
      fovReturn = null;
    }
  }
  const glideNavigationCamera = (lease: NavigationLease, view: NavigationPresentation, pivot: EcefVector, motion: NavigationGlide): boolean => {
    const camera = ports.getCamera();
    const controller = ports.getController();
    if (ports.currentLease() !== lease || lease.released || !camera || !controller || ports.unavailable()) return false;
    ports.getInertia()?.cancel();
    const vector = (value: EcefVector): GlideVec3 => [value.x, value.y, value.z];
    const unit = (value: GlideVec3): GlideVec3 => { const size = Math.hypot(...value); return [value[0] / size, value[1] / size, value[2] / size]; };
    const eye = vector(view.position);
    const at = vector(pivot);
    const forward = withinTilt(unit(vector(view.forward)), unit(at), controller.getLimits().pitchDeg, vector(view.up));
    const place = ecefToGeodetic(pivot.x, pivot.y, pivot.z);
    const center = orbitCenterOnSight(eye, forward, at, controller.orbitTargetHeightAt(place.latRad * RAD_TO_DEG, place.lonRad * RAD_TO_DEG));
    const radius = Math.hypot(center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]);
    const anglesOf = (look: GlideVec3, about: GlideVec3): { yaw: number; pitch: number } => {
      const angles = ComputeYawPitchFromLookAtToRef(new Vector3(...look), new Vector3(...about), ports.scene.useRightHandedSystem, camera.yaw, new Vector2());
      return { yaw: angles.x, pitch: angles.y };
    };
    const angles = anglesOf(forward, center);
    const canvasHeightPx = Math.max(1, ports.canvas.clientHeight || ports.canvas.height || 1);
    const rates = orbitGlideRates({ center, forward, radius, verticalFovRad: view.verticalFovRad, canvasHeightPx }, vector(motion.velocity), vector(motion.turn), anglesOf);
    const frame = GLIDE_FRAME_MS / 1000;
    // As near as the glide's zoom takes it: each frame's step, capped as the glide caps it, summed as the glide slows.
    const zoomStep = Math.max(-MAX_ZOOM_LOG_DELTA_PER_FRAME, Math.min(MAX_ZOOM_LOG_DELTA_PER_FRAME, rates.zoomLog * frame));
    controller.allowNearer(radius * Math.exp(Math.min(0, zoomStep) / (1 - glideKeepPerFrame())));
    // Collisions are still off from the placement, so the steps below are not swept through the ground.
    camera.center = new Vector3(...center);
    camera.yaw = angles.yaw;
    camera.pitch = angles.pitch;
    camera.radius = radius;
    camera.fov = view.verticalFovRad;
    controller.followGroundFromHere();
    restoreCameraLimits();
    fovReturn = motion.fovRad !== view.verticalFovRad ? { target: motion.fovRad, lastMs: null } : null;
    pendingHandback = { keepWheelSince: motion.inputSince, press: motion.press ?? null };
    ports.getInertia()?.panBy(rates.panPx.x * frame, rates.panPx.y * frame, canvasHeightPx);
    ports.getInertia()?.orbitBy(rates.orbitDeg.pitch * frame, rates.orbitDeg.heading * frame);
    ports.getInertia()?.zoomBy(Math.exp(rates.zoomLog * frame));
    ports.renderer.requestRender();
    return true;
  };
  return { captureNavigationSnapshot, restoreNavigationSnapshot, placeNavigationCamera, glideNavigationCamera, stepFovReturn,
    restoreCameraLimits,
    /** Host calls before suspending its input/maps. */
    suspendCamera() {
      ports.getInertia()?.cancel();
      const camera = ports.getCamera();
      if (fovReturn && camera) camera.fov = fovReturn.target;
      fovReturn = null;
    },
    /** Host passes this exactly once to input.setSuspended(false, handback). */
    takeInputHandback(): InputHandback | null { const handback = pendingHandback; pendingHandback = null; return handback; },
    /** Tells the host's existing frame loop whether FOV still changes. */
    isFovReturning(): boolean { return fovReturn !== null; },
    /** A changed host FOV supersedes its pending return without cancelling motion. */
    cancelFovReturn(): void { fovReturn = null; },
  };
}
