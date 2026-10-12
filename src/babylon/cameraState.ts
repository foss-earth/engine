import { ComputeLookAtFromYawPitchToRef, ComputeYawPitchFromLookAtToRef, Vector2, Vector3 } from "@babylonjs/core";
import type { GeospatialCamera } from "@babylonjs/core";
import type { GlobeViewState } from "../view.js";
import {
  ANCHOR_PAN_CHASE,
  clientToViewportCoords,
  computeScreenAnchorError,
  pickEllipsoidFromScreen,
  type ScreenAnchorError,
  type ScreenPickInput,
} from "./anchorPan.js";

import { DEFAULT_CAMERA_LIMITS, DEFAULT_GROUND_FOLLOW, type CameraLimits, type GroundFollow } from "../camera/cameraLimits.js";
import {
  geodeticToEcef,
  ecefToGeodetic,
  DEG_TO_RAD,
  RAD_TO_DEG,
  normalizeHeadingDeg,
  WGS84_A,
  type EcefCoord,
} from "../camera/cameraMath.js";
import { add, dot, length, normalize, scale, sub, type Vec3 } from "../camera/geographicFrames.js";
import { cameraAxes, lineOfSightTarget, orbitAbout, tiltAt, zoomAbout, type CameraPose } from "../camera/anchoredMotion.js";
import type { AnchoredMotionConstraint, AnchoredMotionResult, GlideMotion, NavigationAnchor } from "../input/navigationAnchors.js";
import type { GlideAnchors } from "../input/inertialCameraController.js";

// ─── Camera State Limits ────────────────────────────────────────────

export {
  DEFAULT_CAMERA_LIMITS,
  DEFAULT_GROUND_FOLLOW,
  MAX_PITCH_DEG,
  MAX_ZOOM_METERS,
  MIN_PITCH_DEG,
  MIN_ZOOM_METERS,
  type CameraLimits,
  type GroundFollow,
} from "../camera/cameraLimits.js";
const MAX_ORBIT_HEIGHT_SMOOTHING_DELTA_MS = 100;
/** Orbit steps smaller than this, degrees, are left out: inertia's tail below what can be seen. */
const ORBIT_DEADZONE_DEG = 0.02;
/** Babylon keeps the orbit centre this far from the poles, as the sine of its geocentric latitude. */
const POLE_SINE_LIMIT = 0.998749218;
/** How near straight down or up, degrees at the eye, one anchored tilt step may turn the look. */
const MAX_EYE_DIP_DEG = 89.9;

export interface OrbitTargetHeightOptions {
  resolveSurfaceHeightMeters: (latDeg: number, lonDeg: number) => number | null;
  initialOffsetMeters?: number;
}

// ─── Pitch Conversion ───────────────────────────────────────────────
//
// Public API convention (matches foss-earth / Cesium):
//   pitchDeg = 0   → looking at the horizon
//   pitchDeg = 90  → looking straight down at the surface
//
// Babylon GeospatialCamera convention:
//   pitch = 0      → looking straight down (toward planet centre)
//   pitch = π/2    → looking at the horizon
//
// Conversion: babylonPitch = (π/2) × (1 − pitchDeg / 90)

function babylonPitchToSurfacePitchDeg(babylonPitch: number): number {
  return 90 * (1 - babylonPitch / (Math.PI / 2));
}

function surfacePitchDegToBabylonPitch(pitchDeg: number): number {
  return (Math.PI / 2) * (1 - pitchDeg / 90);
}

// ─── Anchored motion ────────────────────────────────────────────────

export type { AnchoredMotionConstraint, AnchoredMotionResult } from "../input/navigationAnchors.js";

/** One frame of camera motion, for working out where it goes without moving the camera. */
export interface PlannedMotion {
  pan?: { screenDxPx: number; screenDyPx: number; canvasHeight: number };
  orbit?: { pitchDeltaDeg: number; headingDeltaDeg: number; about: EcefCoord | null };
  zoom?: { factor: number; about: EcefCoord | null };
}

/** The globe camera's own fields: what one write puts back. */
interface OrbitFields {
  center: Vec3;
  yaw: number;
  pitch: number;
  radius: number;
}

interface AnchoredPlan {
  fields: OrbitFields | null;
  constrained: AnchoredMotionConstraint | null;
}

type SetOrientation = (yaw: number, pitch: number, radius: number, center: Vector3) => void;

// ─── Camera Controller ───────────────────────────────────────────────

/**
 * State-driven camera controller wrapping a Babylon `GeospatialCamera`.
 *
 * Maintains a canonical `GlobeViewState` (lat / lon / heading / pitch / zoom)
 * and provides two-way sync with the underlying Babylon camera so that all
 * input handlers can work on the canonical state rather than raw pointer deltas.
 *
 * Zoom and orbit can also act about a picked or pinned point anywhere in view
 * (`zoomAbout`, `orbitAbout`). The camera's centre then stays its orbit
 * target: the point where its line of sight comes down to the orbit target's
 * height, so the compass stays at the centre of the view.
 */
export interface CameraControllerPorts {
  /** Shared monotonic host clock, milliseconds. */
  nowMs(): number;
  /** Host feature prevents globe grabbing over a pickable world point. */
  hasPickablePointAt(scene: ReturnType<GeospatialCamera["getScene"]>, x: number, y: number): boolean;
}

export class CameraController {
  private readonly camera: GeospatialCamera;
  private resolveSurfaceHeightMeters: ((latDeg: number, lonDeg: number) => number | null) | null = null;
  private orbitTargetOffsetMeters = 0;
  private smoothedSurfaceHeightMeters: number | null = null;
  private lastSurfaceHeightResolveMs: number | null = null;
  /** Fixed ellipsoid grab point from pointer down — the screen error segment starts here. */
  private anchorPanPoint: Vector3 | null = null;
  /** Client coords at pointer down — visual fallback when projection is stale. */
  private anchorPanDownClient: { x: number; y: number } | null = null;

  private limits: CameraLimits = DEFAULT_CAMERA_LIMITS;
  private groundFollow: GroundFollow = DEFAULT_GROUND_FOLLOW;
  /**
   * The nearest the camera may orbit after a view was handed back nearer
   * than the zoom limit, until it is out past the limit; null otherwise.
   */
  private zoomFloorMeters: number | null = null;
  /** The same past the far zoom limit: the farthest it may orbit until it is back inside. */
  private zoomCeilingMeters: number | null = null;
  /** Off while a tracked point is the centre (`setCenterFollowsGround`). */
  private centerFollowsGround = true;

  private readonly ports: CameraControllerPorts;

  constructor(camera: GeospatialCamera, ports: CameraControllerPorts) {
    this.ports = ports;
    this.camera = camera;
  }

  /** New limits apply at once: a view outside them moves inside. */
  setLimits(limits: CameraLimits): void {
    this.limits = {
      pitchDeg: { min: Math.min(limits.pitchDeg.min, limits.pitchDeg.max), max: Math.max(limits.pitchDeg.min, limits.pitchDeg.max) },
      zoomMeters: { min: Math.min(limits.zoomMeters.min, limits.zoomMeters.max), max: Math.max(limits.zoomMeters.min, limits.zoomMeters.max) },
    };
    if (this.zoomFloorMeters !== null && this.zoomFloorMeters >= this.limits.zoomMeters.min) this.zoomFloorMeters = null;
    if (this.zoomCeilingMeters !== null && this.zoomCeilingMeters <= this.limits.zoomMeters.max) this.zoomCeilingMeters = null;
    this.syncRadiusLimits();
    this.applyViewState(this.syncFromCamera(), this.getCurrentCenterHeightMeters());
  }

  /** The nearest the camera may orbit now: the zoom limit, or nearer after a view handed back nearer (`allowNearer`). */
  zoomMinMeters(): number {
    return this.zoomFloorMeters ?? this.limits.zoomMeters.min;
  }

  /** The farthest the camera may orbit now: the zoom limit, or farther after a view left farther (`allowFarther`). */
  zoomMaxMeters(): number {
    return this.zoomCeilingMeters ?? this.limits.zoomMeters.max;
  }

  /**
   * Lets a view handed back nearer its orbit target than the zoom limit stay
   * as near as `nearestMeters`: it comes no nearer, and the limit returns
   * once it is out past it.
   */
  allowNearer(nearestMeters: number): void {
    this.zoomFloorMeters = nearestMeters < this.limits.zoomMeters.min ? Math.max(0, nearestMeters) : null;
    this.syncRadiusLimits();
  }

  /** The far side of `allowNearer`: a view farther than the zoom limit stays, goes no farther, and the limit returns once it is back inside. */
  allowFarther(farthestMeters: number): void {
    this.zoomCeilingMeters = farthestMeters > this.limits.zoomMeters.max ? farthestMeters : null;
    this.syncRadiusLimits();
  }

  private syncRadiusLimits(): void {
    const limits = this.camera.limits;
    if (!limits) return;
    limits.radiusMin = this.zoomMinMeters();
    limits.radiusMax = this.zoomMaxMeters();
  }

  /** Where the orbit target sits over a point: the ground there and the target's offset, or null before the ground is known. */
  orbitTargetHeightAt(latDeg: number, lonDeg: number): number | null {
    const surface = this.resolveSurfaceHeightMeters?.(latDeg, lonDeg);
    return typeof surface === "number" ? surface + this.orbitTargetOffsetMeters : null;
  }

  /** Ground following starts from the orbit target's height now, rising or falling from there at its speed. */
  followGroundFromHere(): void {
    this.smoothedSurfaceHeightMeters = this.getCurrentCenterHeightMeters() - this.orbitTargetOffsetMeters;
    this.lastSurfaceHeightResolveMs = this.ports.nowMs();
  }

  getLimits(): CameraLimits {
    return this.limits;
  }

  /** How the orbit target follows the ground: from the next frame. */
  setGroundFollow(follow: GroundFollow): void {
    this.groundFollow = follow;
  }

  getGroundFollow(): GroundFollow {
    return this.groundFollow;
  }

  private clampPitchDeg(pitchDeg: number): number {
    return Math.max(this.limits.pitchDeg.min, Math.min(this.limits.pitchDeg.max, pitchDeg));
  }

  private clampZoomMeters(zoom: number): number {
    return Math.max(this.zoomMinMeters(), Math.min(this.zoomMaxMeters(), zoom));
  }

  /** Back inside the zoom limits, a view handed back near or left far is under them again. */
  private relaxZoomFloor(zoom: number): void {
    let changed = false;
    if (this.zoomFloorMeters !== null && zoom >= this.limits.zoomMeters.min) { this.zoomFloorMeters = null; changed = true; }
    if (this.zoomCeilingMeters !== null && zoom <= this.limits.zoomMeters.max) { this.zoomCeilingMeters = null; changed = true; }
    if (changed) this.syncRadiusLimits();
  }

  configureOrbitTargetHeight(options: OrbitTargetHeightOptions | null): void {
    this.resolveSurfaceHeightMeters = options?.resolveSurfaceHeightMeters ?? null;
    this.orbitTargetOffsetMeters = Math.max(0, options?.initialOffsetMeters ?? 0);
    this.smoothedSurfaceHeightMeters = null;
    this.lastSurfaceHeightResolveMs = null;
    this.applyViewState(this.syncFromCamera());
  }

  private smoothSurfaceHeightMeters(targetHeightMeters: number): number {
    const now = this.ports.nowMs();
    if (this.smoothedSurfaceHeightMeters === null || this.lastSurfaceHeightResolveMs === null) {
      this.smoothedSurfaceHeightMeters = targetHeightMeters;
      this.lastSurfaceHeightResolveMs = now;
      return targetHeightMeters;
    }

    const deltaMs = Math.max(0, Math.min(MAX_ORBIT_HEIGHT_SMOOTHING_DELTA_MS, now - this.lastSurfaceHeightResolveMs));
    this.lastSurfaceHeightResolveMs = now;
    const maxStep = this.groundFollow.speedMetersPerSecond * (deltaMs / 1000);
    const delta = targetHeightMeters - this.smoothedSurfaceHeightMeters;
    if (Math.abs(delta) <= maxStep) {
      this.smoothedSurfaceHeightMeters = targetHeightMeters;
      return this.smoothedSurfaceHeightMeters;
    }

    this.smoothedSurfaceHeightMeters += Math.sign(delta) * maxStep;
    return this.smoothedSurfaceHeightMeters;
  }

  private resolveOrbitTargetHeightMeters(latDeg: number, lonDeg: number): number {
    const surfaceHeightMeters = this.smoothSurfaceHeightMeters(this.resolveSurfaceHeightMeters?.(latDeg, lonDeg) ?? 0);
    return surfaceHeightMeters + this.orbitTargetOffsetMeters;
  }

  /**
   * The orbit target's height once it has moved across the ground: the ground
   * and its offset there, reached at the ground following's bounded speed.
   * Where no ground is known yet it keeps the height it has.
   */
  private followedOrbitTargetHeightMeters(latDeg: number, lonDeg: number): number {
    if (this.resolveSurfaceHeightMeters === null) return this.getCurrentCenterHeightMeters();
    const surface = this.resolveSurfaceHeightMeters(latDeg, lonDeg);
    const current = this.getCurrentCenterHeightMeters() - this.orbitTargetOffsetMeters;
    // Start from where the target is: an anchored move or a handback may have left it off the smoothed height.
    if (this.smoothedSurfaceHeightMeters === null) this.smoothedSurfaceHeightMeters = current;
    return this.smoothSurfaceHeightMeters(typeof surface === "number" ? surface : current) + this.orbitTargetOffsetMeters;
  }

  private getCurrentCenterHeightMeters(): number {
    return ecefToGeodetic(this.camera.center.x, this.camera.center.y, this.camera.center.z).altMeters;
  }

  /**
   * Read the current `GlobeViewState` from the live camera properties.
   * This is the single source of truth — call this before every state mutation.
   */
  syncFromCamera(): GlobeViewState {
    return this.viewStateOf({ center: [this.camera.center.x, this.camera.center.y, this.camera.center.z],
      yaw: this.camera.yaw, pitch: this.camera.pitch, radius: this.camera.radius });
  }

  private viewStateOf(fields: OrbitFields): GlobeViewState {
    const { latRad, lonRad } = ecefToGeodetic(fields.center[0], fields.center[1], fields.center[2]);
    return {
      latDeg: latRad * RAD_TO_DEG,
      lonDeg: lonRad * RAD_TO_DEG,
      headingDeg: normalizeHeadingDeg(fields.yaw * RAD_TO_DEG),
      pitchDeg: this.clampPitchDeg(babylonPitchToSurfacePitchDeg(fields.pitch)),
      zoomMeters: this.clampZoomMeters(fields.radius),
    };
  }

  /** Return the current view state (reads from live camera). */
  getViewState(): GlobeViewState {
    return this.syncFromCamera();
  }

  /**
   * Merge partial overrides into the current camera state and apply.
   * Only the supplied fields change; everything else is preserved.
   */
  setViewState(partial: Partial<GlobeViewState>): void {
    const next: GlobeViewState = { ...this.syncFromCamera(), ...partial };
    this.applyViewState(next);
  }

  /**
   * Write a complete `GlobeViewState` to the camera.
   * Clamps pitch and zoom to safe limits before applying.
   */
  applyViewState(state: GlobeViewState, targetHeightOverrideMeters?: number): void {
    const targetHeightMeters = targetHeightOverrideMeters
      ?? this.resolveOrbitTargetHeightMeters(state.latDeg, state.lonDeg);
    const fields = this.fieldsOfViewState(state, targetHeightMeters);
    // Field by field, as it always has: Babylon clamps the tilt for the
    // distance the camera is at when the tilt is written. Anchored moves,
    // which change both together, write them as one (`commit`).
    this.camera.center = new Vector3(fields.center[0], fields.center[1], fields.center[2]);
    this.camera.yaw = fields.yaw;
    this.camera.pitch = fields.pitch;
    this.camera.radius = fields.radius;
    this.relaxZoomFloor(fields.radius);
  }

  private fieldsOfViewState(state: GlobeViewState, targetHeightMeters: number): OrbitFields {
    const { x, y, z } = geodeticToEcef(state.latDeg * DEG_TO_RAD, state.lonDeg * DEG_TO_RAD, targetHeightMeters);
    return {
      center: [x, y, z],
      yaw: normalizeHeadingDeg(state.headingDeg) * DEG_TO_RAD,
      pitch: surfacePitchDegToBabylonPitch(this.clampPitchDeg(state.pitchDeg)),
      radius: this.clampZoomMeters(state.zoomMeters),
    };
  }

  /**
   * Writes the camera's centre, yaw, pitch and radius as one: Babylon clamps
   * and sweeps for collisions once, from the pose before to the pose after,
   * and never sees a mix of the two.
   */
  private commit(fields: OrbitFields): void {
    const setOrientation = (this.camera as unknown as { _setOrientation?: SetOrientation })._setOrientation;
    const center = new Vector3(fields.center[0], fields.center[1], fields.center[2]);
    if (typeof setOrientation === "function") {
      setOrientation.call(this.camera, fields.yaw, fields.pitch, fields.radius, center);
      return;
    }
    this.camera.center = center;
    this.camera.yaw = fields.yaw;
    this.camera.pitch = fields.pitch;
    this.camera.radius = fields.radius;
  }

  /**
   * Reset the camera to north-up orientation.
   * Preserves current lat / lon / zoom / pitch — only heading changes.
   */
  resetNorthUp(): void {
    this.setViewState({ headingDeg: 0 });
  }

  /**
   * Pan the camera by a screen-space pixel delta.
   * Translates the lat/lon anchor point while preserving heading, pitch, and zoom.
   * The orbit target follows the ground it moves over at the ground following's speed.
   * @param screenDxPx Positive = right (east when heading=0)
   * @param screenDyPx Positive = down (south when heading=0)
   * @param canvasHeight Canvas height in CSS pixels
   */
  panBy(screenDxPx: number, screenDyPx: number, canvasHeight: number): void {
    const state = this.pannedViewState(this.syncFromCamera(), screenDxPx, screenDyPx, canvasHeight);
    this.applyViewState(state, this.movedOrbitTargetHeightMeters(state.latDeg, state.lonDeg));
  }

  /**
   * The orbit target's height after a pan or orbit has moved it: following
   * the ground, or, while a tracked point is the centre, where it is.
   */
  private movedOrbitTargetHeightMeters(latDeg: number, lonDeg: number): number {
    return this.centerFollowsGround ? this.followedOrbitTargetHeightMeters(latDeg, lonDeg) : this.getCurrentCenterHeightMeters();
  }

  /**
   * Whether a pan or orbit moves the orbit target with the ground under it.
   * Off while a tracked point is the centre: its own height is the target's.
   */
  setCenterFollowsGround(follows: boolean): void {
    this.centerFollowsGround = follows;
    if (follows) this.followGroundFromHere();
  }

  private pannedViewState(state: GlobeViewState, screenDxPx: number, screenDyPx: number, canvasHeight: number): GlobeViewState {
    // camera.fov is the vertical FOV in radians (inherited from Babylon Camera, default 0.8)
    const fovY = (this.camera as unknown as { fov: number }).fov ?? 0.8;
    const metersPerPixel = (2 * state.zoomMeters * Math.tan(fovY * 0.5)) / Math.max(canvasHeight, 1);

    const headingRad = state.headingDeg * DEG_TO_RAD;
    const latRad = state.latDeg * DEG_TO_RAD;
    const forwardM = -screenDyPx * metersPerPixel;
    const rightM = screenDxPx * metersPerPixel;
    const cosH = Math.cos(headingRad);
    const sinH = Math.sin(headingRad);
    const northM = forwardM * cosH - rightM * sinH;
    const eastM = forwardM * sinH + rightM * cosH;

    const cosLat = Math.max(Math.cos(latRad), 0.01);
    const latDeltaDeg = (northM / WGS84_A) * RAD_TO_DEG;
    const lonDeltaDeg = (eastM / (WGS84_A * cosLat)) * RAD_TO_DEG;

    const newLatDeg = Math.max(-89.999, Math.min(89.999, state.latDeg + latDeltaDeg));
    const newLonDeg = ((state.lonDeg + lonDeltaDeg + 180) % 360 + 360) % 360 - 180;
    return { ...state, latDeg: newLatDeg, lonDeg: newLonDeg };
  }

  /**
   * Begin an anchor-based pan gesture by picking the globe point under the pointer.
   * Returns false when the ray misses the ellipsoid (sky / off-globe).
   */
  beginAnchorPan(pick: ScreenPickInput): boolean {
    const scene = this.camera.getScene();
    if (!scene) {
      this.anchorPanPoint = null;
      this.anchorPanDownClient = null;
      return false;
    }
    const { x, y } = clientToViewportCoords(pick.canvas, scene, pick.clientX, pick.clientY);
    if (this.ports.hasPickablePointAt(scene, x, y)) {
      this.anchorPanPoint = null;
      this.anchorPanDownClient = null;
      return false;
    }
    const hit = pickEllipsoidFromScreen(scene, this.camera, pick.canvas, pick.clientX, pick.clientY);
    if (!hit) {
      this.anchorPanPoint = null;
      this.anchorPanDownClient = null;
      return false;
    }
    this.anchorPanPoint = hit.clone();
    this.anchorPanDownClient = { x: pick.clientX, y: pick.clientY };
    return true;
  }

  /**
   * Continue an anchor-based pan: move orbit center lat/lon only (heading/pitch/zoom
   * unchanged) to shrink the screen-space line from the grab point to the cursor.
   */
  panAnchorTo(pick: ScreenPickInput, sensitivity = 1): boolean {
    if (!this.anchorPanPoint) {
      return false;
    }

    const scene = this.camera.getScene();
    if (!scene) {
      return false;
    }

    const error = computeScreenAnchorError(
      this.anchorPanPoint,
      pick.clientX,
      pick.clientY,
      scene,
      this.camera,
      pick.canvas,
      this.anchorPanDownClient ?? undefined,
    );
    if (!error || error.lengthPx < ANCHOR_PAN_CHASE.donePx) {
      return error !== null;
    }

    // Screen error is already in CSS pixels — apply directly to panBy (not the
    // legacy 0.1 movement gain used for inertial frame deltas).
    const chase = Math.min(
      ANCHOR_PAN_CHASE.maxFactor,
      Math.max(ANCHOR_PAN_CHASE.minFactor, error.lengthPx / ANCHOR_PAN_CHASE.fullChasePx),
    );
    const factor = sensitivity * chase;
    this.panBy(-error.dx * factor, -error.dy * factor, pick.canvas.clientHeight);
    return true;
  }

  /** End an anchor-based pan gesture. */
  endAnchorPan(): void {
    this.anchorPanPoint = null;
    this.anchorPanDownClient = null;
  }

  /** True while an anchor pan gesture is active. */
  isAnchorPanActive(): boolean {
    return this.anchorPanPoint !== null;
  }

  /** Screen-space error segment for the active grab point (debug / HUD). */
  getAnchorPanScreenError(pick: ScreenPickInput): ScreenAnchorError | null {
    if (!this.anchorPanPoint) {
      return null;
    }
    const scene = this.camera.getScene();
    if (!scene) {
      return null;
    }
    return computeScreenAnchorError(
      this.anchorPanPoint,
      pick.clientX,
      pick.clientY,
      scene,
      this.camera,
      pick.canvas,
      this.anchorPanDownClient ?? undefined,
    );
  }

  /**
   * Orbit the camera by a heading/pitch delta.
   * Moves around the current anchor point without changing lat/lon or zoom;
   * the orbit target goes on following the ground under it.
   * @param pitchDeltaDeg Positive = look more downward (toward surface)
   * @param headingDeltaDeg Positive = rotate clockwise (eastward)
   */
  orbitBy(pitchDeltaDeg: number, headingDeltaDeg: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult {
    if (anchor?.point) return this.orbitAbout(anchor.point, pitchDeltaDeg, headingDeltaDeg);
    const ep = Math.abs(pitchDeltaDeg) >= ORBIT_DEADZONE_DEG ? pitchDeltaDeg : 0;
    const eh = Math.abs(headingDeltaDeg) >= ORBIT_DEADZONE_DEG ? headingDeltaDeg : 0;
    if (ep === 0 && eh === 0) return;
    const state = this.syncFromCamera();
    this.applyViewState(
      {
        ...state,
        pitchDeg: this.clampPitchDeg(state.pitchDeg + ep),
        headingDeg: normalizeHeadingDeg(state.headingDeg + eh),
      },
      this.movedOrbitTargetHeightMeters(state.latDeg, state.lonDeg),
    );
  }

  /**
   * Zoom by multiplying the orbit radius by `factor`.
   * factor < 1 = zoom in (move closer), factor > 1 = zoom out (move farther).
   * With an `anchor` that has a point, toward or away from that point instead.
   */
  zoomBy(factor: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult {
    if (!Number.isFinite(factor) || factor <= 0) {
      return;
    }
    if (anchor?.point) return this.zoomAbout(anchor.point, factor);

    const state = this.syncFromCamera();
    const requestedZoomMeters = state.zoomMeters * factor;

    if (requestedZoomMeters >= this.zoomMinMeters() || factor >= 1 || this.orbitTargetOffsetMeters <= 0) {
      this.setViewState({ zoomMeters: this.clampZoomMeters(requestedZoomMeters) });
      return;
    }

    const offsetStepMeters = Math.max(1, Math.abs(Math.log(factor)) * this.groundFollow.zoomStepMeters);
    this.orbitTargetOffsetMeters = Math.max(0, this.orbitTargetOffsetMeters - offsetStepMeters);
    this.applyViewState({ ...state, zoomMeters: this.zoomMinMeters() });
  }

  // ─── Anchored zoom and orbit ───────────────────────────────────────

  /**
   * The pose the camera draws now: its eye and look. A collision correction
   * Babylon has worked out but not yet applied is applied first, as the next
   * drawn frame would.
   */
  getPose(): CameraPose {
    (this.camera as unknown as { getViewMatrix?: () => unknown }).getViewMatrix?.();
    return this.poseOf(this.currentFields());
  }

  private currentFields(): OrbitFields {
    const { x, y, z } = this.camera.center;
    return { center: [x, y, z], yaw: this.camera.yaw, pitch: this.camera.pitch, radius: this.camera.radius };
  }

  private rightHanded(): boolean {
    return (this.camera as unknown as { getScene?: () => { useRightHandedSystem?: boolean } | null }).getScene?.()?.useRightHandedSystem ?? true;
  }

  private poseOf(fields: OrbitFields): CameraPose {
    const look = ComputeLookAtFromYawPitchToRef(fields.yaw, fields.pitch, new Vector3(...fields.center), this.rightHanded(), new Vector3());
    const forward: Vec3 = [look.x, look.y, look.z];
    return { eye: sub(fields.center, scale(forward, fields.radius)), forward };
  }

  private fieldsOf(pose: CameraPose, center: Vec3, fallbackYaw: number): OrbitFields {
    const angles = ComputeYawPitchFromLookAtToRef(new Vector3(...pose.forward), new Vector3(...center), this.rightHanded(), fallbackYaw, new Vector2());
    return { center, yaw: angles.x, pitch: angles.y, radius: length(sub(center, pose.eye)) };
  }

  /**
   * Zoom toward a picked or pinned point: the eye moves along its line to the
   * point to `factor` of its distance, and the point keeps its place on
   * screen. Within the zoom limits, which here measure the distance to the
   * point; a point picked nearer or farther than they allow may be left
   * toward them but not further away from them.
   */
  zoomAbout(point: EcefCoord, factor: number): AnchoredMotionResult {
    return this.commitPlan(this.planAnchored(this.currentFieldsSettled(), point, { pitchDeltaDeg: 0, headingDeltaDeg: 0, factor }));
  }

  /**
   * Orbit a picked or pinned point: heading about its WGS84 vertical, tilt
   * about the camera's right, keeping the eye's distance to it and its place
   * on screen. The tilt limits hold at the centre of the view, as for the
   * globe's own orbit.
   */
  orbitAbout(point: EcefCoord, pitchDeltaDeg: number, headingDeltaDeg: number): AnchoredMotionResult {
    const ep = Math.abs(pitchDeltaDeg) >= ORBIT_DEADZONE_DEG ? pitchDeltaDeg : 0;
    const eh = Math.abs(headingDeltaDeg) >= ORBIT_DEADZONE_DEG ? headingDeltaDeg : 0;
    if (ep === 0 && eh === 0) return { moved: false, constrained: null };
    return this.commitPlan(this.planAnchored(this.currentFieldsSettled(), point, { pitchDeltaDeg: ep, headingDeltaDeg: eh, factor: 1 }));
  }

  /** Orbit and zoom about one point in one step, so both keep it where it is. */
  orbitZoomAbout(point: EcefCoord, pitchDeltaDeg: number, headingDeltaDeg: number, factor: number): AnchoredMotionResult {
    const ep = Math.abs(pitchDeltaDeg) >= ORBIT_DEADZONE_DEG ? pitchDeltaDeg : 0;
    const eh = Math.abs(headingDeltaDeg) >= ORBIT_DEADZONE_DEG ? headingDeltaDeg : 0;
    return this.commitPlan(this.planAnchored(this.currentFieldsSettled(), point, { pitchDeltaDeg: ep, headingDeltaDeg: eh, factor }));
  }

  /** `orbitZoomAbout` for an anchor; about the orbit target, an orbit then a zoom. */
  orbitZoomBy(pitchDeltaDeg: number, headingDeltaDeg: number, factor: number, anchor: NavigationAnchor): void | AnchoredMotionResult {
    if (anchor.point) return this.orbitZoomAbout(anchor.point, pitchDeltaDeg, headingDeltaDeg, factor);
    this.orbitBy(pitchDeltaDeg, headingDeltaDeg);
    this.zoomBy(factor);
  }

  /**
   * A frame of glide written about other anchors, keeping what it does to
   * the camera now: the eye's velocity and the look's turn. Each motion's
   * rate is measured at this pose, the old one as given and the new pan,
   * orbit and zoom one at a time, and the new rates are the ones whose sum
   * matches the old. Null when no such rates exist here.
   */
  rebaseMotion(motion: GlideMotion, anchors: GlideAnchors): GlideMotion | null {
    const start = this.predictPose({});
    const axes = start && cameraAxes(start);
    if (!start || !axes) return null;
    const canvasHeight = Math.max(1, motion.pan.canvasHeight);
    // Turning the look by a radian sweeps the view by about the distance to what is seen: weigh turn and travel alike.
    const weight = Math.max(1, this.camera.radius);
    const measure = (pose: CameraPose | null): number[] | null => {
      if (!pose) return null;
      const turn = sub(pose.forward, start.forward);
      return [...sub(pose.eye, start.eye), dot(turn, axes.right) * weight, dot(turn, axes.up) * weight];
    };
    const plan = (rates: readonly number[], orbitAbout: EcefCoord | null, zoomAbout: EcefCoord | null): PlannedMotion => ({
      pan: { screenDxPx: rates[0], screenDyPx: rates[1], canvasHeight },
      orbit: { pitchDeltaDeg: rates[2], headingDeltaDeg: rates[3], about: orbitAbout },
      zoom: { factor: Math.exp(rates[4]), about: zoomAbout },
    });
    // The rate of change a motion causes here: central differences over a small share of it.
    const rateOf = (rates: readonly number[], orbitAbout: EcefCoord | null, zoomAbout: EcefCoord | null, share: number): number[] | null => {
      const ahead = measure(this.predictPose(plan(rates.map(value => value * share), orbitAbout, zoomAbout)));
      const back = measure(this.predictPose(plan(rates.map(value => -value * share), orbitAbout, zoomAbout)));
      return ahead && back ? ahead.map((value, index) => (value - back[index]) / (2 * share)) : null;
    };
    const old = [motion.pan.x, motion.pan.y, motion.orbit.pitch, motion.orbit.heading, motion.zoom.log];
    const wanted = rateOf(old, motion.orbit.anchor?.point ?? null, motion.zoom.anchor?.point ?? null, 1e-3);
    if (!wanted || !wanted.every(Number.isFinite)) return null;
    // A pixel of pan, a hundredth of a degree of orbit, and a ten-thousandth of zoom: each about its new anchor.
    const units = [1, 1, 0.01, 0.01, 1e-4];
    const columns: number[][] = [];
    for (let k = 0; k < units.length; k += 1) {
      const unit = units.map((value, index) => (index === k ? value : 0));
      const column = rateOf(unit, anchors.orbit?.point ?? null, anchors.zoom?.point ?? null, 1);
      if (!column || !column.every(Number.isFinite)) return null;
      columns.push(column.map(value => value / units[k]));
    }
    const rates = solveLinear(columns, wanted);
    if (!rates || !rates.every(Number.isFinite)) return null;
    return {
      pan: { x: rates[0], y: rates[1], canvasHeight },
      orbit: { pitch: rates[2], heading: rates[3], anchor: anchors.orbit },
      zoom: { log: rates[4], anchor: anchors.zoom },
    };
  }

  /**
   * Where a frame of motion would put the camera, without moving it: pan,
   * then orbit, then zoom, each about its point or the orbit target, as the
   * glide applies them. Null when a step cannot be taken from where it is.
   */
  predictPose(motion: PlannedMotion): CameraPose | null {
    let fields = this.currentFieldsSettled();
    if (motion.pan && (motion.pan.screenDxPx !== 0 || motion.pan.screenDyPx !== 0)) {
      const state = this.pannedViewState(this.viewStateOf(fields), motion.pan.screenDxPx, motion.pan.screenDyPx, motion.pan.canvasHeight);
      fields = this.fieldsOfViewState(state, ecefToGeodetic(...fields.center).altMeters);
    }
    if (motion.orbit && (motion.orbit.pitchDeltaDeg !== 0 || motion.orbit.headingDeltaDeg !== 0)) {
      const { pitchDeltaDeg, headingDeltaDeg, about } = motion.orbit;
      if (about) {
        const plan = this.planAnchored(fields, about, { pitchDeltaDeg, headingDeltaDeg, factor: 1 });
        if (plan.fields) fields = plan.fields;
      } else {
        const state = this.viewStateOf(fields);
        fields = this.fieldsOfViewState({ ...state, pitchDeg: this.clampPitchDeg(state.pitchDeg + pitchDeltaDeg),
          headingDeg: normalizeHeadingDeg(state.headingDeg + headingDeltaDeg) }, ecefToGeodetic(...fields.center).altMeters);
      }
    }
    if (motion.zoom && motion.zoom.factor !== 1 && motion.zoom.factor > 0) {
      const { factor, about } = motion.zoom;
      if (about) {
        const plan = this.planAnchored(fields, about, { pitchDeltaDeg: 0, headingDeltaDeg: 0, factor });
        if (plan.fields) fields = plan.fields;
      } else {
        const state = this.viewStateOf(fields);
        fields = this.fieldsOfViewState({ ...state, zoomMeters: this.clampZoomMeters(state.zoomMeters * factor) }, ecefToGeodetic(...fields.center).altMeters);
      }
    }
    const pose = this.poseOf(fields);
    return pose.eye.every(Number.isFinite) && pose.forward.every(Number.isFinite) ? pose : null;
  }

  private currentFieldsSettled(): OrbitFields {
    (this.camera as unknown as { getViewMatrix?: () => unknown }).getViewMatrix?.();
    return this.currentFields();
  }

  private commitPlan(plan: AnchoredPlan): AnchoredMotionResult {
    if (!plan.fields) return { moved: false, constrained: plan.constrained ?? "invalid" };
    // The orbit target's distance is what it is: the zoom limits measured the distance to the point.
    if (plan.fields.radius < this.limits.zoomMeters.min) this.allowNearer(Math.min(plan.fields.radius, this.zoomMinMeters()));
    if (plan.fields.radius > this.limits.zoomMeters.max) this.allowFarther(Math.max(plan.fields.radius, this.zoomMaxMeters()));
    this.commit(plan.fields);
    this.relaxZoomFloor(plan.fields.radius);
    this.followGroundFromHere();
    return { moved: true, constrained: plan.constrained };
  }

  /**
   * One anchored step from `fields`: orbit, then zoom, about `point`, written
   * as the camera's fields with its centre on the new line of sight. A step a
   * limit or the pole would not allow is shortened to the most it allows.
   */
  private planAnchored(fields: OrbitFields, point: EcefCoord, step: { pitchDeltaDeg: number; headingDeltaDeg: number; factor: number }): AnchoredPlan {
    const anchor: Vec3 = [point.x, point.y, point.z];
    if (!anchor.every(Number.isFinite) || !(step.factor > 0) || !Number.isFinite(step.factor)
      || !Number.isFinite(step.pitchDeltaDeg) || !Number.isFinite(step.headingDeltaDeg)) {
      return { fields: null, constrained: "invalid" };
    }
    const before = this.poseOf(fields);
    const distance = length(sub(anchor, before.eye));
    // The zoom limits, measured to the point: never further outside them than the eye is now.
    const nearest = Math.min(this.limits.zoomMeters.min, distance);
    const farthest = Math.max(this.limits.zoomMeters.max, distance);
    const wanted = distance * step.factor;
    const allowed = Math.max(nearest, Math.min(farthest, wanted));
    let constrained: AnchoredMotionConstraint | null = allowed !== wanted ? "distance-limit" : null;
    const factor = distance > 0 ? allowed / distance : 1;
    // The tilt limits at the centre of the view, bent to where the tilt is now.
    const tiltNow = tiltAt(fields.center, before.forward);
    // A tilt past straight down or up at the eye would turn the view over the
    // top: it stops short of that, and the tilt limits turn it back from there.
    const dip = tiltAt(before.eye, before.forward);
    const pitchDeltaDeg = Math.max(-MAX_EYE_DIP_DEG - dip, Math.min(MAX_EYE_DIP_DEG - dip, step.pitchDeltaDeg));
    if (pitchDeltaDeg !== step.pitchDeltaDeg) constrained = "tilt-limit";
    const attempt = (share: number): AnchoredPlan => {
      let pose: CameraPose | null = before;
      if (pitchDeltaDeg !== 0 || step.headingDeltaDeg !== 0) {
        pose = orbitAbout(pose, anchor, pitchDeltaDeg * share, step.headingDeltaDeg * share);
      }
      if (pose && factor !== 1) pose = zoomAbout(pose, anchor, Math.pow(factor, share));
      if (!pose) return { fields: null, constrained: "not-ahead" };
      return this.settle(pose, anchor, fields, tiltNow);
    };
    const full = attempt(1);
    if (full.fields) return { fields: full.fields, constrained: full.constrained ?? constrained };
    if (full.constrained === "not-ahead" && !(step.factor !== 1 || step.pitchDeltaDeg !== 0 || step.headingDeltaDeg !== 0)) return full;
    // Shorten the step to the most that is allowed.
    let low = 0, high = 1, best: AnchoredPlan | null = null;
    for (let i = 0; i < 12; i += 1) {
      const middle = (low + high) / 2;
      const tried = attempt(middle);
      if (tried.fields) { low = middle; best = tried; } else high = middle;
    }
    constrained = full.constrained ?? constrained;
    if (!best?.fields || low < 1e-6) return { fields: null, constrained };
    return { fields: best.fields, constrained };
  }

  /**
   * The camera's fields for a pose: the centre where the line of sight comes
   * down to the orbit target's height, with the tilt there inside its limits.
   * A tilt past them, beyond where it was (`tiltBefore`), turns back about the
   * anchor, which keeps its place on screen. Null where the pole stops it.
   */
  private settle(pose: CameraPose, anchor: Vec3, before: OrbitFields, tiltBefore: number): AnchoredPlan {
    let current = pose;
    let constrained: AnchoredMotionConstraint | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const center = this.centerOnSight(current, anchor, before);
      const radius = length(sub(center, current.eye));
      const tilt = tiltAt(center, current.forward);
      const { soft, hard } = this.tiltLimitsAt(radius);
      // The globe's limits bend to a tilt already past them; Babylon's own clamp every write, so they never bend.
      let min = Math.max(hard.min, Math.min(soft.min, tiltBefore)), max = Math.min(hard.max, Math.max(soft.max, tiltBefore));
      if (min > max) ({ min, max } = hard);
      const excess = tilt > max ? tilt - max : tilt < min ? tilt - min : 0;
      if (excess === 0) {
        if (Math.abs(normalize(center)[2]) > POLE_SINE_LIMIT) return { fields: null, constrained: "pole" };
        const fields = this.fieldsOf(current, center, before.yaw);
        if (![fields.yaw, fields.pitch, fields.radius, ...fields.center].every(Number.isFinite) || !(fields.radius > 0)) {
          return { fields: null, constrained: "invalid" };
        }
        return { fields, constrained };
      }
      constrained = "tilt-limit";
      // Turn back past the limit by a hair, so the next look lands inside it.
      const turned = orbitAbout(current, anchor, -(excess + Math.sign(excess) * 1e-9), 0);
      if (!turned) return { fields: null, constrained };
      current = turned;
    }
    return { fields: null, constrained };
  }

  /**
   * Where the camera's centre goes on a pose's line of sight: where it comes
   * down to the orbit target's height, the ground and the target's offset
   * there. When it never does, as when the eye is below a raised target, the
   * ground itself, or failing that the anchor's distance along the look.
   */
  private centerOnSight(pose: CameraPose, anchor: Vec3, before: OrbitFields): Vec3 {
    const startHeight = ecefToGeodetic(...before.center).altMeters;
    const target = lineOfSightTarget(pose, (latDeg, lonDeg) => this.orbitTargetHeightAt(latDeg, lonDeg), startHeight);
    if (target) return target.point;
    if (this.orbitTargetOffsetMeters > 0) {
      const ground = lineOfSightTarget(pose, (latDeg, lonDeg) => this.resolveSurfaceHeightMeters?.(latDeg, lonDeg) ?? null,
        startHeight - this.orbitTargetOffsetMeters);
      if (ground) return ground.point;
    }
    const along = Math.max(1, sub(anchor, pose.eye).reduce((sum, value, index) => sum + value * pose.forward[index], 0));
    return add(pose.eye, scale(pose.forward, along));
  }

  /**
   * The tilt limits at the centre of the view, degrees: the globe's
   * `camera.pitchLimits` (soft), and Babylon's own (hard), which allow less
   * tilt far out and which every write is clamped to.
   */
  private tiltLimitsAt(radius: number): { soft: { min: number; max: number }; hard: { min: number; max: number } } {
    const hard = { min: 0, max: 90 };
    const limits = this.camera.limits as unknown as { pitchMin?: number; getEffectivePitchMax?: (radius: number) => number } | undefined;
    if (typeof limits?.getEffectivePitchMax === "function") hard.min = babylonPitchToSurfacePitchDeg(limits.getEffectivePitchMax(radius));
    if (typeof limits?.pitchMin === "number") hard.max = babylonPitchToSurfacePitchDeg(limits.pitchMin);
    return { soft: this.limits.pitchDeg, hard };
  }
}

/**
 * Solves `columns · x = wanted` for a square system given by its columns,
 * by elimination with partial pivoting; a nearly singular one is solved in
 * the least-squares sense, lightly damped. Null when nothing fits.
 */
function solveLinear(columns: readonly (readonly number[])[], wanted: readonly number[]): number[] | null {
  const n = columns.length;
  const norms = columns.map(column => Math.hypot(...column));
  if (norms.some(norm => !(norm > 0))) return dampedLeastSquares(columns, wanted);
  // Each column scaled to unit length, so one pivot threshold fits all.
  const rows = wanted.map((value, i) => [...columns.map((column, k) => column[i] / norms[k]), value]);
  for (let k = 0; k < n; k += 1) {
    let pivot = k;
    for (let i = k + 1; i < n; i += 1) if (Math.abs(rows[i][k]) > Math.abs(rows[pivot][k])) pivot = i;
    if (Math.abs(rows[pivot][k]) < 1e-9) return dampedLeastSquares(columns, wanted);
    [rows[k], rows[pivot]] = [rows[pivot], rows[k]];
    for (let i = k + 1; i < n; i += 1) {
      const f = rows[i][k] / rows[k][k];
      for (let j = k; j <= n; j += 1) rows[i][j] -= f * rows[k][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let k = n - 1; k >= 0; k -= 1) {
    let sum = rows[k][n];
    for (let j = k + 1; j < n; j += 1) sum -= rows[k][j] * x[j];
    x[k] = sum / rows[k][k];
  }
  return x.map((value, k) => value / norms[k]);
}

function dampedLeastSquares(columns: readonly (readonly number[])[], wanted: readonly number[]): number[] | null {
  const n = columns.length;
  const scaleOf = columns.map(column => Math.hypot(...column) || 1);
  const a = columns.map((ci, i) => columns.map((cj, j) => ci.reduce((sum, value, r) => sum + value * cj[r], 0) / (scaleOf[i] * scaleOf[j]) + (i === j ? 1e-9 : 0)));
  const b = columns.map((ci, i) => ci.reduce((sum, value, r) => sum + value * wanted[r], 0) / scaleOf[i]);
  for (let k = 0; k < n; k += 1) {
    let pivot = k;
    for (let i = k + 1; i < n; i += 1) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    if (!(Math.abs(a[pivot][k]) > 0)) return null;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    [b[k], b[pivot]] = [b[pivot], b[k]];
    for (let i = k + 1; i < n; i += 1) {
      const f = a[i][k] / a[k][k];
      for (let j = k; j < n; j += 1) a[i][j] -= f * a[k][j];
      b[i] -= f * b[k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let k = n - 1; k >= 0; k -= 1) {
    let sum = b[k];
    for (let j = k + 1; j < n; j += 1) sum -= a[k][j] * x[j];
    x[k] = sum / a[k][k];
  }
  return x.map((value, k) => value / scaleOf[k]);
}
