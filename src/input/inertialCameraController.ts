import type { EcefCoord } from "../camera/cameraMath.js";
import {
  sameAnchorPoint,
  type AnchorAcquisition,
  type AnchoredMotionResult,
  type AnchorRequest,
  type GlideMotion,
  type NavigationAnchor,
} from "./navigationAnchors.js";

export interface AnchorPanPick<TCanvas = unknown> {
  clientX: number;
  clientY: number;
  canvas: TCanvas;
}

export interface AnchorPanScreenError {
  anchorClientX: number;
  anchorClientY: number;
  dx: number;
  dy: number;
  lengthPx: number;
}

/** The anchors each motion channel carries: null is the compass target. */
export interface GlideAnchors {
  readonly orbit: NavigationAnchor | null;
  readonly zoom: NavigationAnchor | null;
  /**
   * The ground a grab holds, ECEF metres, while the grab is down and while
   * the pan it set going still glides. Absent when nothing is grabbed.
   */
  readonly pan?: Readonly<EcefCoord> | null;
}

export interface CameraInputTarget<TCanvas = unknown> {
  panBy(screenDxPx: number, screenDyPx: number, canvasHeight: number): void;
  /**
   * Turn and tilt the view. With an `anchor` that has a point, about that
   * point, which keeps its place on screen; without one, about the orbit
   * target, as before anchors. A target may say what the step did.
   */
  orbitBy(pitchDeltaDeg: number, headingDeltaDeg: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult;
  /** Zoom by `factor` of the distance: toward or away from the anchor's point, or the orbit target without one. */
  zoomBy(factor: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult;
  /** Orbit and zoom about one point in one step, so both keep it in place. Without it, orbit then zoom. */
  orbitZoomBy?(pitchDeltaDeg: number, headingDeltaDeg: number, factor: number, anchor: NavigationAnchor): void | AnchoredMotionResult;
  /**
   * Resolves where a gesture's zoom and rotation act, once, when it starts
   * (`input.*.zoomAnchor`, `input.*.orbitPivot`). A target without it moves
   * about its orbit target: the gesture's anchors are then unsupported, not missed.
   */
  acquireAnchors?(request: AnchorRequest<TCanvas>): AnchorAcquisition;
  /** A candidate gesture's anchors are in use now: a press has become a drag, or fingers have begun to move. */
  holdAnchors?(acquisition: AnchorAcquisition): void;
  /** The gesture that acquired these has ended; what it set moving glides on about them. */
  releaseAnchors?(acquisition: AnchorAcquisition): void;
  /**
   * The same frame of motion written about other anchors: the eye's velocity
   * and the look's turn kept, with pan making up what the new anchors cannot.
   * Null when it cannot be written so.
   */
  rebaseMotion?(motion: GlideMotion, anchors: GlideAnchors): GlideMotion | null;
  /** Stop inertial velocity without ending an active anchor-pan grab. */
  cancelInertial?(): void;
  cancel?(): void;
  beginAnchorPan?(pick: AnchorPanPick<TCanvas>): boolean;
  panAnchorTo?(pick: AnchorPanPick<TCanvas>, sensitivity?: number): boolean;
  getAnchorPanScreenError?(pick: AnchorPanPick<TCanvas>): AnchorPanScreenError | null;
  endAnchorPan?(): void;
}

export interface InertialCameraController<TCanvas = unknown> extends CameraInputTarget<TCanvas> {
  update(nowMs?: number): void;
  cancel(): void;
  /** True while any velocity component is above its stop epsilon. */
  isActive(): boolean;
  /** The anchors the moving channels carry: what the markers show. A channel at rest carries none. */
  anchors(): GlideAnchors;
  /** The motion one frame applies now, with its anchors. */
  motion(): GlideMotion;
  /**
   * Carries the motion under way onto other anchors, keeping the eye's
   * velocity and the look's turn, as when following a point begins or ends.
   */
  rebaseTo(anchors: GlideAnchors): void;
}

/** Turns `target` about `anchor`, or as a target from before anchors is called, without one. */
export function orbitWith<TCanvas>(target: CameraInputTarget<TCanvas>, pitchDeltaDeg: number, headingDeltaDeg: number, anchor: NavigationAnchor | null | undefined): void | AnchoredMotionResult {
  return anchor ? target.orbitBy(pitchDeltaDeg, headingDeltaDeg, anchor) : target.orbitBy(pitchDeltaDeg, headingDeltaDeg);
}

/** Zooms `target` about `anchor`, or as a target from before anchors is called, without one. */
export function zoomWith<TCanvas>(target: CameraInputTarget<TCanvas>, factor: number, anchor: NavigationAnchor | null | undefined): void | AnchoredMotionResult {
  return anchor ? target.zoomBy(factor, anchor) : target.zoomBy(factor);
}

const FRAME_MS = 1000 / 60;
/** How much velocity a 60 Hz frame keeps: `camera.inertiaDecay`'s default. */
export const DEFAULT_INERTIA_DECAY_PER_FRAME = 0.82;
/** `camera.grabFollowMs`: how long a grabbed point takes to catch up with the pointer, as a spring's time constant. */
export const GRAB_FOLLOW_ID = "camera.grabFollowMs";
/** Its default, ms. 0 holds the ground on the pointer; a longer time is the spring that trails it. */
export const DEFAULT_GRAB_FOLLOW_MS = 0;
const STOP_EPSILON_PX = 0.01;
const STOP_EPSILON_DEG = 0.002;
const STOP_EPSILON_ZOOM_LOG = 0.00005;
const MAX_PAN_DELTA_PER_FRAME_PX = 80;
const MAX_ORBIT_DELTA_PER_FRAME_DEG = 12;
/** The most a 60 Hz frame of glide may zoom, as a natural log of the distance. */
export const MAX_ZOOM_LOG_DELTA_PER_FRAME = 0.14;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface InertialCameraOptions {
  /** Host monotonic milliseconds; the same clock used by input and navigation handover. */
  nowMs(): number;
  /** The share of velocity a 60 Hz frame keeps, read each update: `camera.inertiaDecay`. */
  decayPerFrame?: () => number;
}

/** A step a target says it could not take at all: its channel stops, and keeps no anchor. */
function blocked(result: void | AnchoredMotionResult): boolean {
  return typeof result === "object" && result !== null && !result.moved;
}

export function createInertialCameraController<TCanvas = unknown>(target: CameraInputTarget<TCanvas>, options: InertialCameraOptions): InertialCameraController<TCanvas> {
  const decayForDeltaTime = (deltaMs: number): number => {
    const decay = options.decayPerFrame?.() ?? DEFAULT_INERTIA_DECAY_PER_FRAME;
    return Math.pow(clamp(Number.isFinite(decay) ? decay : DEFAULT_INERTIA_DECAY_PER_FRAME, 0, 0.999), deltaMs / FRAME_MS);
  };
  let lastUpdateMs: number | null = null;
  let panVelocityX = 0;
  let panVelocityY = 0;
  let panCanvasHeight = 1;
  let orbitVelocityPitch = 0;
  let orbitVelocityHeading = 0;
  let zoomLogVelocity = 0;
  // Each channel's anchor, from the input that set it moving until it settles.
  let orbitAnchor: NavigationAnchor | null = null;
  let zoomAnchor: NavigationAnchor | null = null;

  const panMoving = (): boolean => Math.abs(panVelocityX) > STOP_EPSILON_PX || Math.abs(panVelocityY) > STOP_EPSILON_PX;
  const orbitMoving = (): boolean => Math.abs(orbitVelocityPitch) > STOP_EPSILON_DEG || Math.abs(orbitVelocityHeading) > STOP_EPSILON_DEG;
  const zoomMoving = (): boolean => Math.abs(zoomLogVelocity) > STOP_EPSILON_ZOOM_LOG;

  function cancel(): void {
    panVelocityX = 0;
    panVelocityY = 0;
    orbitVelocityPitch = 0;
    orbitVelocityHeading = 0;
    zoomLogVelocity = 0;
    orbitAnchor = null;
    zoomAnchor = null;
  }

  function motion(): GlideMotion {
    return {
      pan: { x: panVelocityX, y: panVelocityY, canvasHeight: panCanvasHeight },
      orbit: { pitch: orbitVelocityPitch, heading: orbitVelocityHeading, anchor: orbitAnchor },
      zoom: { log: zoomLogVelocity, anchor: zoomAnchor },
    };
  }

  /**
   * Puts the channels on `next`'s anchors. Motion under way about other
   * points is written about the new ones first, so the eye goes on as it
   * was going; a channel whose motion cannot be carried over stops rather
   * than turning its old rate about a point it was not meant for.
   */
  function switchAnchors(next: GlideAnchors): void {
    const orbitChanges = !sameAnchorPoint(orbitAnchor, next.orbit);
    const zoomChanges = !sameAnchorPoint(zoomAnchor, next.zoom);
    if ((orbitChanges || zoomChanges) && (panMoving() || orbitMoving() || zoomMoving())) {
      const rebased = target.rebaseMotion?.(motion(), next);
      if (rebased) {
        panCanvasHeight = Math.max(1, rebased.pan.canvasHeight);
        panVelocityX = clamp(rebased.pan.x, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
        panVelocityY = clamp(rebased.pan.y, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
        orbitVelocityPitch = clamp(rebased.orbit.pitch, -MAX_ORBIT_DELTA_PER_FRAME_DEG, MAX_ORBIT_DELTA_PER_FRAME_DEG);
        orbitVelocityHeading = clamp(rebased.orbit.heading, -MAX_ORBIT_DELTA_PER_FRAME_DEG, MAX_ORBIT_DELTA_PER_FRAME_DEG);
        zoomLogVelocity = clamp(rebased.zoom.log, -MAX_ZOOM_LOG_DELTA_PER_FRAME, MAX_ZOOM_LOG_DELTA_PER_FRAME);
      } else if (target.rebaseMotion) {
        if (orbitChanges) { orbitVelocityPitch = 0; orbitVelocityHeading = 0; }
        if (zoomChanges) zoomLogVelocity = 0;
      }
      // A target that moves only about its orbit target has nothing to carry over.
    }
    orbitAnchor = next.orbit;
    zoomAnchor = next.zoom;
  }

  function panBy(screenDxPx: number, screenDyPx: number, canvasHeight: number): void {
    panCanvasHeight = Math.max(1, canvasHeight);
    panVelocityX = clamp(panVelocityX + screenDxPx, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
    panVelocityY = clamp(panVelocityY + screenDyPx, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
  }

  function orbitBy(pitchDeltaDeg: number, headingDeltaDeg: number, anchor: NavigationAnchor | null = null): void {
    if (!sameAnchorPoint(orbitAnchor, anchor)) switchAnchors({ orbit: anchor, zoom: zoomAnchor });
    else orbitAnchor = anchor;
    orbitVelocityPitch = clamp(
      orbitVelocityPitch + pitchDeltaDeg,
      -MAX_ORBIT_DELTA_PER_FRAME_DEG,
      MAX_ORBIT_DELTA_PER_FRAME_DEG,
    );
    orbitVelocityHeading = clamp(
      orbitVelocityHeading + headingDeltaDeg,
      -MAX_ORBIT_DELTA_PER_FRAME_DEG,
      MAX_ORBIT_DELTA_PER_FRAME_DEG,
    );
  }

  function zoomBy(factor: number, anchor: NavigationAnchor | null = null): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      return;
    }
    if (!sameAnchorPoint(zoomAnchor, anchor)) switchAnchors({ orbit: orbitAnchor, zoom: anchor });
    else zoomAnchor = anchor;
    zoomLogVelocity = clamp(
      zoomLogVelocity + Math.log(factor),
      -MAX_ZOOM_LOG_DELTA_PER_FRAME,
      MAX_ZOOM_LOG_DELTA_PER_FRAME,
    );
  }

  function update(nowMs = options.nowMs()): void {
    const deltaMs = lastUpdateMs === null ? FRAME_MS : Math.max(0, Math.min(100, nowMs - lastUpdateMs));
    lastUpdateMs = nowMs;

    // Pan, then orbit, then zoom, once a frame.
    if (panMoving()) {
      target.panBy(panVelocityX, panVelocityY, panCanvasHeight);
    }

    const orbiting = orbitMoving();
    const zooming = zoomMoving();
    if (orbiting && zooming && orbitAnchor?.point && sameAnchorPoint(orbitAnchor, zoomAnchor) && target.orbitZoomBy) {
      // One point for both: one step keeps it where it is.
      if (blocked(target.orbitZoomBy(orbitVelocityPitch, orbitVelocityHeading, Math.exp(zoomLogVelocity), orbitAnchor))) {
        orbitVelocityPitch = 0; orbitVelocityHeading = 0; zoomLogVelocity = 0;
      }
    } else {
      if (orbiting && blocked(orbitWith(target, orbitVelocityPitch, orbitVelocityHeading, orbitAnchor))) {
        orbitVelocityPitch = 0; orbitVelocityHeading = 0;
      }
      if (zooming && blocked(zoomWith(target, Math.exp(zoomLogVelocity), zoomAnchor))) {
        zoomLogVelocity = 0;
      }
    }

    const decay = decayForDeltaTime(deltaMs || FRAME_MS);
    panVelocityX *= decay;
    panVelocityY *= decay;
    orbitVelocityPitch *= decay;
    orbitVelocityHeading *= decay;
    zoomLogVelocity *= decay;
    // A channel at rest lets go of its anchor: the next input acquires afresh.
    if (!orbitMoving()) orbitAnchor = null;
    if (!zoomMoving()) zoomAnchor = null;
  }

  function isActive(): boolean {
    return panMoving() || orbitMoving() || zoomMoving();
  }

  return {
    panBy, orbitBy, zoomBy, update, cancel, isActive, motion,
    anchors: () => ({ orbit: orbitMoving() ? orbitAnchor : null, zoom: zoomMoving() ? zoomAnchor : null }),
    rebaseTo: switchAnchors,
    ...(target.acquireAnchors ? { acquireAnchors: (request: AnchorRequest<TCanvas>) => target.acquireAnchors!(request) } : {}),
    ...(target.holdAnchors ? { holdAnchors: (acquisition: AnchorAcquisition) => target.holdAnchors!(acquisition) } : {}),
    ...(target.releaseAnchors ? { releaseAnchors: (acquisition: AnchorAcquisition) => target.releaseAnchors!(acquisition) } : {}),
  };
}
