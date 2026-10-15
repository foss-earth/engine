import { ComputeLookAtFromYawPitchToRef, ComputeYawPitchFromLookAtToRef, Vector2, Vector3 } from "@babylonjs/core";
import type { GeospatialCamera } from "@babylonjs/core";
import type { GlobeViewState } from "../view.js";
import {
  clientRay,
  clientToViewportCoords,
  computeScreenAnchorError,
  pickEllipsoidFromScreen,
  type ScreenAnchorError,
  type ScreenPickInput,
} from "./anchorPan.js";

import { DEFAULT_CAMERA_LIMITS, DEFAULT_EYE_CONTACT, DEFAULT_GROUND_FOLLOW, type CameraLimits, type EyeContact, type GroundFollow } from "../camera/cameraLimits.js";
import {
  geodeticToEcef,
  ecefToGeodetic,
  DEG_TO_RAD,
  RAD_TO_DEG,
  normalizeHeadingDeg,
  WGS84_A,
  type EcefCoord,
} from "../camera/cameraMath.js";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../camera/geographicFrames.js";
import { orbitAngles, turnLook } from "../camera/orbitMath.js";
import { cameraAxes, lineOfSightTarget, orbitAbout, tiltAt, viewDirection, zoomAbout, type CameraPose, type ViewDirection } from "../camera/anchoredMotion.js";
import type { AnchoredMotionConstraint, AnchoredMotionResult, GlideMotion, NavigationAnchor } from "../input/navigationAnchors.js";
import { ORBIT_GLIDE_REST_DEG, type GlideAnchors } from "../input/inertialCameraController.js";
import { worldViewportHeight } from "../browser/worldViewport.js";

// ─── Camera State Limits ────────────────────────────────────────────

export {
  DEFAULT_CAMERA_LIMITS,
  DEFAULT_EYE_CONTACT,
  DEFAULT_GROUND_FOLLOW,
  MAX_PITCH_DEG,
  MAX_ZOOM_METERS,
  MIN_PITCH_DEG,
  MIN_ZOOM_METERS,
  type CameraLimits,
  type EyeContact,
  type GroundFollow,
} from "../camera/cameraLimits.js";
const MAX_ORBIT_HEIGHT_SMOOTHING_DELTA_MS = 100;
/** Penetration, metres, at which eye contact reaches its full acceleration. Shallower pushes are softer. */
const EYE_CONTACT_SPRING_METERS = 4;
/** A stalled frame does not integrate a long push. */
const EYE_CONTACT_MAX_STEP_MS = 100;
const EYE_CONTACT_FRAME_MS = 1000 / 60;
/** Upward speed slower than this has stopped, so the runtime can skip another frame. */
const EYE_CONTACT_REST_MPS = 0.05;
/** Orbit steps smaller than the glide's rest, degrees. A faster turn coasts until then, on the same decay as a pan or a zoom. */
const ORBIT_DEADZONE_DEG = ORBIT_GLIDE_REST_DEG;
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

/** The same pose to well under what can be seen: a millimetre, and angles to their rounding. */
function sameOrbitFields(a: OrbitFields, b: OrbitFields): boolean {
  return Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]) < 1e-3
    && Math.abs(a.yaw - b.yaw) < 1e-9 && Math.abs(a.pitch - b.pitch) < 1e-9 && Math.abs(a.radius - b.radius) < 1e-6;
}

interface AnchoredPlan {
  fields: OrbitFields | null;
  constrained: AnchoredMotionConstraint | null;
}

type SetOrientation = (yaw: number, pitch: number, radius: number, center: Vector3) => void;

interface GrabPan {
  /** The ground point held, ECEF metres, copied when grabbed. */
  readonly point: Vec3;
  readonly down: { x: number; y: number };
  client: { x: number; y: number };
  canvas: HTMLCanvasElement;
  /** The orbit target's velocity over the ground, ECEF metres a second. */
  velocity: Vec3;
  moving: boolean;
}

/** The longest frame a grab pan steps at once, ms: a stall does not fling the camera. */
const MAX_GRAB_STEP_MS = 100;
/** With no follow time, how long the velocity a release glides with is averaged over, ms. */
const GRAB_VELOCITY_SMOOTHING_MS = 40;
/** A grab pan is at rest within this many pixels of the pointer, moving slower than the next per second. */
const GRAB_REST_PX = 0.01;
const GRAB_REST_PX_PER_S = 0.5;
/** Newton steps for a grab, and the miss on screen it stops at, as a share of the distance ahead: far below a pixel. */
const GRAB_SOLVE_ITERATIONS = 8;
const GRAB_SOLVE_TOLERANCE = 1e-10;

function vector3ToEcefOrNull(point: Vector3 | null): EcefCoord | null {
  return point ? { x: point.x, y: point.y, z: point.z } : null;
}

/** The WGS84 ellipsoid's outward normal at a latitude and longitude, radians. */
function geodeticUp(latRad: number, lonRad: number): Vec3 {
  return [Math.cos(latRad) * Math.cos(lonRad), Math.cos(latRad) * Math.sin(lonRad), Math.sin(latRad)];
}

// ─── Camera Controller ───────────────────────────────────────────────

/**
 * State-driven camera controller wrapping a Babylon `GeospatialCamera`.
 *
 * Maintains a canonical `GlobeViewState` (lat / lon / heading / pitch / zoom)
 * and provides two-way sync with the underlying Babylon camera so that all
 * input handlers can work on the canonical state rather than raw pointer deltas.
 *
 * A turn is about the compass, the camera's centre, so tilting does not carry
 * it out to the horizon. Zoom moves toward a picked or pinned point
 * (`zoomAbout`) and the centre stays where the look meets the orbit target's
 * height, or toward the compass when zoom is centred on the view.
 */
export interface CameraControllerPorts {
  /** Shared monotonic host clock, milliseconds. */
  nowMs(): number;
  /** Host feature prevents globe grabbing over a pickable world point. */
  hasPickablePointAt(scene: ReturnType<GeospatialCamera["getScene"]>, x: number, y: number): boolean;
  /**
   * The ground under a client point a grab pan holds: the displayed surface,
   * else the ellipsoid; null for sky. Without it, the ellipsoid alone.
   */
  groundAt?(client: { readonly x: number; readonly y: number }): Readonly<EcefCoord> | null;
}

export class CameraController {
  private readonly camera: GeospatialCamera;
  private resolveSurfaceHeightMeters: ((latDeg: number, lonDeg: number) => number | null) | null = null;
  private orbitTargetOffsetMeters = 0;
  private smoothedSurfaceHeightMeters: number | null = null;
  private lastSurfaceHeightResolveMs: number | null = null;
  /** The orbit target was placed before the ground under it was known: `settleOnGround` puts it there once it is. */
  private groundPending = false;
  /**
   * Where a view set over a point was left: while the camera is still there,
   * `settleOnGround` keeps its target on the ground the map shows, which
   * rises as terrain arrives and refines. Null once anything else moves it.
   */
  private restingPose: OrbitFields | null = null;
  /** The surface the resting target's ground was last looked up on: unchanged, it is not looked up again. */
  private restingRevision: number | null = null;
  /** The ground the resting target is on its way to, null once it is there. */
  private restingGroundMeters: number | null = null;
  /** A grab pan under way: the ground point held, where it was grabbed and where the pointer is, and the centre's velocity. */
  private grab: GrabPan | null = null;

  private limits: CameraLimits = DEFAULT_CAMERA_LIMITS;
  private groundFollow: GroundFollow = DEFAULT_GROUND_FOLLOW;
  /** Experimental. Off, the orbit point follows the ground. On, altitude is a velocity the ground can only push up. */
  private eyeContact: EyeContact = DEFAULT_EYE_CONTACT;
  /** Upward speed from eye contact, m/s. Never downward: the ground does not pull. */
  private verticalVelocityMps = 0;
  private lastEyeContactMs: number | null = null;
  /** Zoom toward the compass, the centre of the view, instead of the ground anchor. */
  private zoomAboutViewCenter = false;
  /** A turn keeps the eye where it is. Off, a turn is about the compass. */
  private orbitInPlace = false;
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

  /**
   * Experimental eye contact, from the next frame. Turning it off drops the
   * upward speed and starts ground following again from the height the camera
   * has now. Tuning it while it is on keeps that speed.
   */
  setEyeContact(contact: EyeContact): void {
    const was = this.eyeContact.enabled;
    const finite = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
    const keep = contact.glideKeepPerFrame;
    this.eyeContact = {
      enabled: contact.enabled === true,
      maxAccelerationMetersPerSecondSquared: Math.max(0, finite(contact.maxAccelerationMetersPerSecondSquared, DEFAULT_EYE_CONTACT.maxAccelerationMetersPerSecondSquared)),
      clearanceMeters: Math.max(0, finite(contact.clearanceMeters, DEFAULT_EYE_CONTACT.clearanceMeters)),
      glideKeepPerFrame: Math.min(0.999, Math.max(0, finite(keep, DEFAULT_EYE_CONTACT.glideKeepPerFrame))),
    };
    if (!this.eyeContact.enabled) {
      this.verticalVelocityMps = 0;
      this.lastEyeContactMs = null;
      if (was) this.followGroundFromHere();
      return;
    }
    if (!was) {
      this.verticalVelocityMps = 0;
      this.lastEyeContactMs = this.ports.nowMs();
    }
  }

  getEyeContact(): EyeContact {
    return this.eyeContact;
  }

  /** Zoom toward the compass instead of the ground point a gesture picked. Turning is unaffected. */
  setZoomAboutViewCenter(enabled: boolean): void {
    this.zoomAboutViewCenter = enabled;
  }

  /** Turn where the camera is, instead of about the compass. From the next turn. */
  setOrbitInPlace(enabled: boolean): void {
    this.orbitInPlace = enabled;
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
    this.rest();
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

  /**
   * The orbit target's height for a view set over a point: the ground there
   * and the offset. Before that ground is known the target keeps the height
   * it has, and `settleOnGround` puts it on the ground once it is.
   */
  private resolveOrbitTargetHeightMeters(latDeg: number, lonDeg: number): number {
    const surface = this.resolveSurfaceHeightMeters?.(latDeg, lonDeg);
    if (this.resolveSurfaceHeightMeters !== null && typeof surface !== "number") {
      this.groundPending = true;
      return this.getCurrentCenterHeightMeters();
    }
    return this.landedOrbitTargetHeightMeters(surface ?? 0);
  }

  /** The ground and offset, at the following's speed; straight onto it when the target was placed before the ground was known. */
  private landedOrbitTargetHeightMeters(surfaceHeightMeters: number): number {
    if (this.groundPending) this.smoothedSurfaceHeightMeters = null;
    this.groundPending = false;
    return this.smoothSurfaceHeightMeters(surfaceHeightMeters) + this.orbitTargetOffsetMeters;
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
    return typeof surface === "number" ? this.landedOrbitTargetHeightMeters(surface) : this.smoothSurfaceHeightMeters(current) + this.orbitTargetOffsetMeters;
  }

  /** A view set over a point rests where it was left, its target on the ground the map shows there. */
  private rest(): void {
    this.restingPose = this.currentFields();
    this.restingRevision = null;
    this.restingGroundMeters = null;
  }

  /**
   * Keeps the orbit target on the ground the map shows under it, as the map's
   * tiles arrive flat and take their terrain: the view keeps its turn, tilt
   * and distance and rises or sinks with the target. A view set over a point
   * follows its ground this way until something moves it, at the ground
   * following's speed. A target placed before any ground was known goes
   * straight onto it once it is, even after the view has moved, and so does
   * one whose ground came up past the eye. True while the camera moves, so
   * the runtime draws another frame. The runtime asks before each frame it
   * draws, with the displayed surface's revision: an unchanged surface under
   * a resting view is not looked up again.
   */
  settleOnGround(surfaceRevision?: number): boolean {
    // Eye contact replaces this kinematic lift: the eye is pushed only while it is inside the ground.
    if (this.eyeContact.enabled) return false;
    if (!this.centerFollowsGround || this.resolveSurfaceHeightMeters === null) return false;
    if (this.restingPose && !sameOrbitFields(this.currentFields(), this.restingPose)) {
      this.restingPose = null;
      this.restingGroundMeters = null;
    }
    const lookUp = this.groundPending
      || (this.restingPose !== null && (surfaceRevision === undefined || surfaceRevision !== this.restingRevision));
    if (!lookUp && this.restingGroundMeters === null) return false;
    const fields = this.currentFields();
    const { latRad, lonRad, altMeters } = ecefToGeodetic(...fields.center);
    const surface = lookUp ? this.resolveSurfaceHeightMeters(latRad * RAD_TO_DEG, lonRad * RAD_TO_DEG) : null;
    if (typeof surface === "number") {
      this.restingRevision = surfaceRevision ?? null;
      this.restingGroundMeters = surface;
    }
    const ground = this.restingGroundMeters;
    if (ground === null) return false;
    const eyeMeters = ecefToGeodetic(...this.poseOf(fields).eye).altMeters;
    let groundMeters = ground;
    if (this.groundPending || eyeMeters < ground) {
      this.smoothedSurfaceHeightMeters = ground;
      this.lastSurfaceHeightResolveMs = this.ports.nowMs();
    } else {
      this.smoothedSurfaceHeightMeters = altMeters - this.orbitTargetOffsetMeters;
      this.lastSurfaceHeightResolveMs ??= this.ports.nowMs();
      groundMeters = this.smoothSurfaceHeightMeters(ground);
    }
    this.groundPending = false;
    if (groundMeters === ground) this.restingGroundMeters = null;
    const heightMeters = groundMeters + this.orbitTargetOffsetMeters;
    if (Math.abs(heightMeters - altMeters) >= 0.01) {
      const { x, y, z } = geodeticToEcef(latRad, lonRad, heightMeters);
      // A placement, not a motion: Babylon's collision sweep would hold an eye under the ground there.
      const collisions = this.camera.checkCollisions;
      this.camera.checkCollisions = false;
      try { this.camera.center = new Vector3(x, y, z); } finally { this.camera.checkCollisions = collisions; }
    }
    if (this.restingPose) this.restingPose = this.currentFields();
    return this.restingGroundMeters !== null || Math.abs(heightMeters - altMeters) >= 0.01;
  }

  private getCurrentCenterHeightMeters(): number {
    return ecefToGeodetic(this.camera.center.x, this.camera.center.y, this.camera.center.z).altMeters;
  }

  /**
   * One step of experimental eye contact. Samples the ground under the eye.
   * While the eye is inside `clearanceMeters` of that ground, a spring pushes
   * it up, capped at the contact acceleration. Clear of the ground, the upward
   * speed slows by `camera.inertiaDecay` and nothing pulls the eye down.
   * True while the eye is still being pushed or is still coasting, so the
   * runtime draws another frame. False while Eye contact is off.
   */
  stepEyeContact(): boolean {
    if (!this.eyeContact.enabled) return false;
    const now = this.ports.nowMs();
    const previous = this.lastEyeContactMs;
    this.lastEyeContactMs = now;
    if (previous === null) return false;
    const dtMs = Math.max(0, Math.min(EYE_CONTACT_MAX_STEP_MS, now - previous));
    if (!(dtMs > 0)) return Math.abs(this.verticalVelocityMps) > EYE_CONTACT_REST_MPS;

    const dt = dtMs / 1000;
    const eye = ecefToGeodetic(...this.poseOf(this.currentFields()).eye);
    const ground = this.resolveSurfaceHeightMeters?.(eye.latRad * RAD_TO_DEG, eye.lonRad * RAD_TO_DEG);
    const penetration = typeof ground === "number" ? ground + this.eyeContact.clearanceMeters - eye.altMeters : 0;
    const maxAccel = this.eyeContact.maxAccelerationMetersPerSecondSquared;
    const inContact = penetration > 0 && maxAccel > 0;
    if (inContact) {
      const stiffness = maxAccel / EYE_CONTACT_SPRING_METERS;
      const damping = 2 * Math.sqrt(stiffness);
      const accel = Math.max(-maxAccel, Math.min(maxAccel, stiffness * penetration - damping * this.verticalVelocityMps));
      this.verticalVelocityMps = Math.max(0, this.verticalVelocityMps + accel * dt);
    } else {
      this.verticalVelocityMps *= this.eyeContact.glideKeepPerFrame ** (dtMs / EYE_CONTACT_FRAME_MS);
      if (Math.abs(this.verticalVelocityMps) < EYE_CONTACT_REST_MPS) this.verticalVelocityMps = 0;
    }
    const rise = this.verticalVelocityMps * dt;
    if (rise >= 1e-4) this.addCenterHeightMeters(rise);
    return inContact || this.verticalVelocityMps > EYE_CONTACT_REST_MPS;
  }

  /** Raises the orbit point, and with it the eye, by `meters` along the local up. */
  private addCenterHeightMeters(meters: number): void {
    const { latRad, lonRad, altMeters } = ecefToGeodetic(this.camera.center.x, this.camera.center.y, this.camera.center.z);
    const { x, y, z } = geodeticToEcef(latRad, lonRad, altMeters + meters);
    this.withoutMeshSweep(() => { this.camera.center = new Vector3(x, y, z); });
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
    // A view set over another point starts on the ground there, not from the last point's, and rests on it.
    const moved = partial.latDeg !== undefined || partial.lonDeg !== undefined;
    if (moved) this.smoothedSurfaceHeightMeters = null;
    this.applyViewState(next);
    if (moved) this.rest();
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
    this.withoutMeshSweep(() => {
      this.camera.center = new Vector3(fields.center[0], fields.center[1], fields.center[2]);
      this.camera.yaw = fields.yaw;
      this.camera.pitch = fields.pitch;
      this.camera.radius = fields.radius;
    });
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
    this.withoutMeshSweep(() => {
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
    });
  }

  /**
   * Eye contact is the only vertical response to the mesh, so a pose write
   * does not also let Babylon's collision sweep slide the eye.
   */
  private withoutMeshSweep(write: () => void): void {
    if (!this.eyeContact.enabled) {
      write();
      return;
    }
    const collisions = this.camera.checkCollisions;
    this.camera.checkCollisions = false;
    try {
      write();
    } finally {
      this.camera.checkCollisions = collisions;
    }
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
   * With Eye contact off, the orbit target follows the ground it moves over at the ground following's speed.
   * With Eye contact on, the altitude stays: the ground can only push the eye up (`stepEyeContact`).
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
    if (this.eyeContact.enabled) return this.getCurrentCenterHeightMeters();
    return this.centerFollowsGround ? this.followedOrbitTargetHeightMeters(latDeg, lonDeg) : this.getCurrentCenterHeightMeters();
  }

  /**
   * Whether a pan or orbit moves the orbit target with the ground under it.
   * Off while a tracked point is the centre: its own height is the target's.
   */
  setCenterFollowsGround(follows: boolean): void {
    this.centerFollowsGround = follows;
    // The tracked point's height is a known one.
    this.groundPending = false;
    this.restingPose = null;
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
   * Grab the ground under the pointer for a pan: the displayed surface there,
   * or else the ellipsoid (`CameraControllerPorts.groundAt`), copied once.
   * From here `stepAnchorPan` brings that point to the pointer. False, and no
   * grab, over a point of interest or where there is no ground (sky). The
   * displayed ground is not a point of interest.
   */
  beginAnchorPan(pick: ScreenPickInput): boolean {
    this.grab = null;
    const scene = this.camera.getScene();
    if (!scene) return false;
    const { x, y } = clientToViewportCoords(pick.canvas, scene, pick.clientX, pick.clientY);
    if (this.ports.hasPickablePointAt(scene, x, y)) return false;
    const client = { x: pick.clientX, y: pick.clientY };
    const ground = this.ports.groundAt
      ? this.ports.groundAt(client)
      : vector3ToEcefOrNull(pickEllipsoidFromScreen(scene, this.camera, pick.canvas, pick.clientX, pick.clientY));
    if (!ground || ![ground.x, ground.y, ground.z].every(Number.isFinite)) return false;
    this.grab = { point: [ground.x, ground.y, ground.z], down: client, client, canvas: pick.canvas, velocity: [0, 0, 0], moving: false };
    return true;
  }

  /**
   * The pointer of a grab pan has moved to `pick`. The camera does not move
   * here: each frame's `stepAnchorPan` carries the grabbed point toward it.
   */
  panAnchorTo(pick: ScreenPickInput): boolean {
    if (!this.grab) return false;
    this.grab.client = { x: pick.clientX, y: pick.clientY };
    this.grab.canvas = pick.canvas;
    this.grab.moving = true;
    return true;
  }

  /**
   * One frame of a grab pan, `dtMs` long: the centre moves over the ground,
   * heading, tilt and distance kept, toward where the grabbed point is under
   * the pointer. With `followMs` 0 it is there each frame; otherwise it gets
   * there as a critically damped spring with that time constant, a mass
   * pulled to the pointer that neither overshoots nor stops dead. True while
   * it is still moving.
   */
  stepAnchorPan(dtMs: number, followMs: number): boolean {
    const grab = this.grab;
    if (!grab) return false;
    const dt = Math.max(0, Math.min(MAX_GRAB_STEP_MS, dtMs)) / 1000;
    if (!(dt > 0)) return grab.moving;
    const fields = this.currentFieldsSettled();
    const at = fields.center;
    const wanted = this.clientViewDirection(grab.client, grab.canvas);
    // Where nothing puts the point under the pointer, the centre is left to come to rest.
    const goal = (wanted && this.grabbedCenter(fields, grab.point, wanted)) ?? at;
    const up = normalize(at);
    let next: Vec3;
    if (!(followMs > 0)) {
      next = goal;
      const measured = scale(sub(goal, at), 1 / dt);
      grab.velocity = add(grab.velocity, scale(sub(measured, grab.velocity), 1 - Math.exp(-dt * 1000 / GRAB_VELOCITY_SMOOTHING_MS)));
    } else {
      const omega = 1000 / followMs;
      const offset = sub(at, goal);
      const k = add(grab.velocity, scale(offset, omega));
      const decay = Math.exp(-omega * dt);
      next = add(goal, scale(add(offset, scale(k, dt)), decay));
      grab.velocity = scale(sub(grab.velocity, scale(k, omega * dt)), decay);
    }
    // The centre moves over the ground: what it gains in height the ground following decides, unless Eye contact keeps the altitude.
    grab.velocity = sub(grab.velocity, scale(up, dot(grab.velocity, up)));
    const stepMeters = length(sub(next, at));
    if (stepMeters > 0) {
      const place = ecefToGeodetic(next[0], next[1], next[2]);
      const latDeg = place.latRad * RAD_TO_DEG, lonDeg = place.lonRad * RAD_TO_DEG;
      this.applyViewState({ ...this.viewStateOf(fields), latDeg, lonDeg }, this.movedOrbitTargetHeightMeters(latDeg, lonDeg));
    }
    const metersPerPixel = this.metersPerPixel(fields.radius, worldViewportHeight(grab.canvas));
    grab.moving = stepMeters > GRAB_REST_PX * metersPerPixel || length(grab.velocity) > GRAB_REST_PX_PER_S * metersPerPixel;
    return grab.moving;
  }

  /**
   * End a grab pan. What the camera was doing as it let go comes back as a
   * pan glide, one 60 Hz frame of it in the glide's screen pixels, for the
   * glide to carry on; null when it was at rest, or for no grab.
   */
  endAnchorPan(): { screenDxPx: number; screenDyPx: number; canvasHeight: number } | null {
    const grab = this.grab;
    this.grab = null;
    if (!grab) return null;
    const state = this.syncFromCamera();
    const lat = state.latDeg * DEG_TO_RAD, lon = state.lonDeg * DEG_TO_RAD, heading = state.headingDeg * DEG_TO_RAD;
    const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
    const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
    const perFrame = scale(grab.velocity, 1 / 60);
    const eastM = dot(perFrame, east), northM = dot(perFrame, north);
    // pannedViewState's ground directions, turned back into the screen's.
    const forwardM = northM * Math.cos(heading) + eastM * Math.sin(heading);
    const rightM = -northM * Math.sin(heading) + eastM * Math.cos(heading);
    const canvasHeight = Math.max(1, worldViewportHeight(grab.canvas));
    const metersPerPixel = this.metersPerPixel(state.zoomMeters, canvasHeight);
    const screenDxPx = rightM / metersPerPixel, screenDyPx = -forwardM / metersPerPixel;
    if (!Number.isFinite(screenDxPx) || !Number.isFinite(screenDyPx) || Math.hypot(screenDxPx, screenDyPx) < GRAB_REST_PX) return null;
    return { screenDxPx, screenDyPx, canvasHeight };
  }

  /** Drop a grab pan without a glide: the view was replaced, or input cancelled. */
  cancelAnchorPan(): void {
    this.grab = null;
  }

  /** True while a grab pan holds a point. */
  isAnchorPanActive(): boolean {
    return this.grab !== null;
  }

  /** The ground a grab pan holds, ECEF metres, copied; null when none is held. */
  grabbedPoint(): Readonly<EcefCoord> | null {
    const point = this.grab?.point;
    return point ? Object.freeze({ x: point[0], y: point[1], z: point[2] }) : null;
  }

  /** True while a grab pan's camera is still on its way to the pointer, or moving. */
  isAnchorPanMoving(): boolean {
    return this.grab?.moving ?? false;
  }

  /** Screen-space segment from the grabbed point to `pick` (debug / HUD). */
  getAnchorPanScreenError(pick: ScreenPickInput): ScreenAnchorError | null {
    const grab = this.grab;
    const scene = this.camera.getScene();
    if (!grab || !scene) return null;
    return computeScreenAnchorError(new Vector3(...grab.point), pick.clientX, pick.clientY, scene, this.camera, pick.canvas, grab.down);
  }

  /** The ground a pixel spans at the orbit target, metres: as `pannedViewState` measures a pan. */
  private metersPerPixel(radius: number, canvasHeight: number): number {
    const fovY = (this.camera as unknown as { fov: number }).fov ?? 0.8;
    return (2 * radius * Math.tan(fovY * 0.5)) / Math.max(canvasHeight, 1);
  }

  /** Where a client point is on screen, as `viewDirection` writes it; null outside the view ahead. */
  private clientViewDirection(client: { x: number; y: number }, canvas: HTMLCanvasElement): ViewDirection | null {
    const scene = this.camera.getScene();
    const ray = scene && clientRay(scene, this.camera, canvas, client.x, client.y);
    const axes = cameraAxes(this.getPose());
    if (!ray || !axes) return null;
    const direction: Vec3 = [ray.direction.x, ray.direction.y, ray.direction.z];
    const ahead = dot(direction, axes.forward);
    if (!(ahead > 0)) return null;
    return { x: dot(direction, axes.right) / ahead, y: dot(direction, axes.up) / ahead };
  }

  /**
   * The centre, at the height it has now, that puts `point` at `wanted` on
   * screen with this heading, tilt and distance: Newton's method over the
   * ground's east and north, each step halved until it brings the point
   * nearer. Where no centre puts it there exactly, as past the horizon, the
   * nearest one found; null when the point is not in view at all.
   */
  private grabbedCenter(fields: OrbitFields, point: Vec3, wanted: ViewDirection): Vec3 | null {
    const start = fields.center;
    const place = ecefToGeodetic(start[0], start[1], start[2]);
    const up = geodeticUp(place.latRad, place.lonRad);
    const across = cross([0, 0, 1], up);
    const east = length(across) > 1e-9 ? normalize(across) : [0, 1, 0] as Vec3;
    const north = cross(up, east);
    const centerAt = (a: number, b: number): Vec3 => {
      const moved = add(start, add(scale(east, a), scale(north, b)));
      const there = ecefToGeodetic(moved[0], moved[1], moved[2]);
      const { x, y, z } = geodeticToEcef(there.latRad, there.lonRad, place.altMeters);
      return [x, y, z];
    };
    const miss = (a: number, b: number): [number, number] | null => {
      const seen = viewDirection(this.poseOf({ ...fields, center: centerAt(a, b) }), point);
      return seen ? [seen.x - wanted.x, seen.y - wanted.y] : null;
    };
    let a = 0, b = 0;
    let residual = miss(0, 0);
    if (!residual) return null;
    const size = (r: readonly number[]): number => Math.hypot(r[0], r[1]);
    // Central differences over a micrometre per metre of distance: far below a pixel, far above rounding.
    const delta = Math.max(0.01, fields.radius * 1e-6);
    for (let iteration = 0; iteration < GRAB_SOLVE_ITERATIONS && size(residual) > GRAB_SOLVE_TOLERANCE; iteration += 1) {
      const ahead = miss(a + delta, b), behind = miss(a - delta, b), left = miss(a, b + delta), right = miss(a, b - delta);
      if (!ahead || !behind || !left || !right) break;
      const j00 = (ahead[0] - behind[0]) / (2 * delta), j10 = (ahead[1] - behind[1]) / (2 * delta);
      const j01 = (left[0] - right[0]) / (2 * delta), j11 = (left[1] - right[1]) / (2 * delta);
      const det = j00 * j11 - j01 * j10;
      if (!(Math.abs(det) > 0) || !Number.isFinite(det)) break;
      const da = -(j11 * residual[0] - j01 * residual[1]) / det;
      const db = -(-j10 * residual[0] + j00 * residual[1]) / det;
      let improved = false;
      for (let share = 1; share >= 1 / 256; share /= 2) {
        const tried = miss(a + share * da, b + share * db);
        if (tried && size(tried) < size(residual)) {
          a += share * da; b += share * db; residual = tried; improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    return centerAt(a, b);
  }

  /**
   * Orbit the camera by a heading/pitch delta.
   * Moves around the current anchor point without changing lat/lon or zoom;
   * the orbit target goes on following the ground under it.
   * @param pitchDeltaDeg Positive = look more downward (toward surface)
   * @param headingDeltaDeg Positive = rotate clockwise (eastward)
   */
  orbitBy(pitchDeltaDeg: number, headingDeltaDeg: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult {
    if (anchor?.point && !this.orbitInPlace) return this.orbitAbout(anchor.point, pitchDeltaDeg, headingDeltaDeg);
    const ep = Math.abs(pitchDeltaDeg) >= ORBIT_DEADZONE_DEG ? pitchDeltaDeg : 0;
    const eh = Math.abs(headingDeltaDeg) >= ORBIT_DEADZONE_DEG ? headingDeltaDeg : 0;
    if (ep === 0 && eh === 0) return;
    if (this.orbitInPlace) {
      this.turnWhereItIs(ep, eh);
      return;
    }
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

  /** A turn about the eye: the compass swings, the eye stays. */
  private turnWhereItIs(pitchDownDeg: number, headingDeg: number): void {
    const fields = this.currentFields();
    const pose = this.poseOf(fields);
    const turned = turnLook(pose.eye, pose.forward, headingDeg, pitchDownDeg, fields.yaw);
    const center = add(pose.eye, scale(turned, fields.radius));
    const place = ecefToGeodetic(center[0], center[1], center[2]);
    const angles = orbitAngles(center, turned, fields.yaw);
    const latDeg = place.latRad * RAD_TO_DEG;
    const lonDeg = ((place.lonRad * RAD_TO_DEG + 180) % 360 + 360) % 360 - 180;
    this.applyViewState({
      latDeg, lonDeg,
      headingDeg: normalizeHeadingDeg(angles.yaw * RAD_TO_DEG),
      pitchDeg: this.clampPitchDeg(babylonPitchToSurfacePitchDeg(angles.pitch)),
      zoomMeters: fields.radius,
    }, place.altMeters);
  }

  /**
   * Zoom by multiplying the orbit radius by `factor`.
   * factor < 1 = zoom in (move closer), factor > 1 = zoom out (move farther).
   * With an `anchor` that has a point, toward or away from that point, unless
   * zoom is centred on the view: then toward the compass, as without a point.
   */
  zoomBy(factor: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult {
    if (!Number.isFinite(factor) || factor <= 0) {
      return;
    }
    if (anchor?.point) return this.zoomAbout(anchor.point, factor);

    const state = this.syncFromCamera();
    const requestedZoomMeters = state.zoomMeters * factor;

    if (this.eyeContact.enabled || requestedZoomMeters >= this.zoomMinMeters() || factor >= 1 || this.orbitTargetOffsetMeters <= 0) {
      const zoomMeters = this.clampZoomMeters(requestedZoomMeters);
      // Zoom changes distance. It does not drop or lift the camera onto the ground under it.
      if (this.eyeContact.enabled) this.applyViewState({ ...state, zoomMeters }, this.getCurrentCenterHeightMeters());
      else this.setViewState({ zoomMeters });
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
   * toward them but not further away from them. When zoom is centred on the
   * view, the compass is that point and it stays where it is.
   */
  zoomAbout(point: EcefCoord, factor: number): AnchoredMotionResult {
    return this.commitPlan(this.planAnchored(this.currentFieldsSettled(), point, { pitchDeltaDeg: 0, headingDeltaDeg: 0, factor }));
  }

  /**
   * Turn about the compass. Heading about its vertical, tilt about the
   * camera's right, keeping the eye's distance to it. `point` is the gesture's
   * anchor and is not the pivot, so a tilt leaves the compass where it is
   * instead of carrying it out to the horizon. The tilt limits hold at the
   * centre of the view. A non-finite point is refused.
   */
  orbitAbout(point: EcefCoord, pitchDeltaDeg: number, headingDeltaDeg: number): AnchoredMotionResult {
    const ep = Math.abs(pitchDeltaDeg) >= ORBIT_DEADZONE_DEG ? pitchDeltaDeg : 0;
    const eh = Math.abs(headingDeltaDeg) >= ORBIT_DEADZONE_DEG ? headingDeltaDeg : 0;
    if (ep === 0 && eh === 0) return { moved: false, constrained: null };
    return this.commitPlan(this.planAnchored(this.currentFieldsSettled(), point, { pitchDeltaDeg: ep, headingDeltaDeg: eh, factor: 1 }));
  }

  /** Turn about the compass and zoom about `point` in one step. */
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
   * One step from `fields`: turn about the compass, then zoom about the ground
   * point, or about the compass when zoom is centred on the view. A turn leaves
   * the centre where it is. A zoom about a ground point puts the centre where
   * the new look meets the orbit target's height, so that point stays on
   * screen. A step a limit or the pole would not allow is shortened to the
   * most it allows.
   */
  private planAnchored(fields: OrbitFields, point: EcefCoord, step: { pitchDeltaDeg: number; headingDeltaDeg: number; factor: number }): AnchoredPlan {
    const orbitPivot: Vec3 = fields.center;
    const ground: Vec3 = [point.x, point.y, point.z];
    if (!orbitPivot.every(Number.isFinite) || !ground.every(Number.isFinite) || !(step.factor > 0) || !Number.isFinite(step.factor)
      || !Number.isFinite(step.pitchDeltaDeg) || !Number.isFinite(step.headingDeltaDeg)) {
      return { fields: null, constrained: "invalid" };
    }
    const zoomPivot: Vec3 = this.zoomAboutViewCenter ? orbitPivot : ground;
    const before = this.poseOf(fields);
    // The zoom limits, measured to the point zoom moves toward: never further outside them than the eye is now.
    const distance = length(sub(step.factor === 1 ? orbitPivot : zoomPivot, before.eye));
    const nearest = Math.min(this.limits.zoomMeters.min, distance);
    const farthest = Math.max(this.limits.zoomMeters.max, distance);
    const wanted = distance * step.factor;
    const allowed = Math.max(nearest, Math.min(farthest, wanted));
    let constrained: AnchoredMotionConstraint | null = allowed !== wanted ? "distance-limit" : null;
    const factor = distance > 0 ? allowed / distance : 1;
    // A zoom that the limits reduced to nothing is a turn: the compass stays.
    const keepCenter = factor === 1 || this.zoomAboutViewCenter;
    const correctionPivot: Vec3 = keepCenter ? orbitPivot : zoomPivot;
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
        pose = orbitAbout(pose, orbitPivot, pitchDeltaDeg * share, step.headingDeltaDeg * share);
      }
      if (pose && factor !== 1) pose = zoomAbout(pose, zoomPivot, Math.pow(factor, share));
      if (!pose) return { fields: null, constrained: "not-ahead" };
      return this.settle(pose, correctionPivot, fields, tiltNow, keepCenter);
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
   * The camera's fields for a pose. A turn keeps the centre where it was.
   * A zoom about a ground point puts it where the line of sight comes down to
   * the orbit target's height. A tilt past the limits, beyond where it was
   * (`tiltBefore`), turns back about `anchor`. Null where the pole stops it.
   */
  private settle(pose: CameraPose, anchor: Vec3, before: OrbitFields, tiltBefore: number, keepCenter: boolean): AnchoredPlan {
    let current = pose;
    let constrained: AnchoredMotionConstraint | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const center = keepCenter ? before.center : this.sightCenter(current, anchor, before);
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

  private sightCenter(pose: CameraPose, anchor: Vec3, before: OrbitFields): Vec3 {
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
