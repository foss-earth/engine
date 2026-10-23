import type { EcefCoord } from "../camera/cameraMath.js";
import {
  sameAnchorPoint,
  type AnchorAcquisition,
  type AnchoredMotionResult,
  type AnchorRequest,
  type GlideMotion,
  type NavigationAnchor,
} from "./navigationAnchors.js";
import { trackpadMomentumFraction } from "./trackpadMomentum.js";
import { WHEEL_GESTURE_IDLE_MS } from "./wheelGesture.js";

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
  /**
   * True while the finger still holds that ground. False while the point only
   * stays up for the glide: the marker is not pulling the camera.
   */
  readonly panHeld?: boolean;
  /**
   * True while a zoom's own events are still arriving. False while its point
   * only stays up for the glide.
   */
  readonly zoomHeld?: boolean;
  /**
   * Present while the orbit under way turns the view about the compass target:
   * its anchor is the target itself, not a point of the ground. 1 while the
   * input still arrives, then the share of that speed the glide has left, so
   * it falls from the release to 0 as the orbit stops. Absent otherwise.
   */
  readonly compass?: number;
}

export interface CameraInputTarget<TCanvas = unknown> {
  /** Integrate an additive keyboard force (change in nominal-frame velocity per second). Keyboard braking never removes pointer momentum. */
  applyNavigationForce?(force: GlideMotion, dtSeconds: number): void;
  /** Remove only the keyboard contribution on focus loss, disposal or completion. */
  clearNavigationForce?(): void;
  panBy(screenDxPx: number, screenDyPx: number, canvasHeight: number): void;
  /**
   * Turn and tilt the view about the compass. An anchor rides with the gesture;
   * its point is not the pivot. A target may say what the step did.
   */
  orbitBy(pitchDeltaDeg: number, headingDeltaDeg: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult;
  /** Zoom by `factor` of the distance: toward the anchor's point, or the compass when zoom is centred on the view or there is no point. */
  zoomBy(factor: number, anchor?: NavigationAnchor | null): void | AnchoredMotionResult;
  /** Turn about the compass and zoom about the anchor's point in one step. Without a point, both about the compass. */
  orbitZoomBy?(pitchDeltaDeg: number, headingDeltaDeg: number, factor: number, anchor: NavigationAnchor): void | AnchoredMotionResult;
  /**
   * Resolves where a gesture's zoom acts, once, when it starts
   * (`input.*.zoomAnchor`). Rotation is about the compass. A target without
   * this moves about its orbit target: the gesture's anchors are then unsupported, not missed.
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
  /**
   * This orbit, zoom or pointer pan will not keep arriving from the trackpad
   * after the fingers lift. A swipe is not armed: the trackpad already feeds it.
   */
  armReleaseMomentum?(channel: "orbit" | "zoom" | "pan"): void;
  /** The armed gesture's fingers have lifted. A pinch can omit this; its events stopping is the lift. */
  releaseMomentum?(channel: "orbit" | "zoom" | "pan"): void;
  /** Stop inertial velocity without ending an active anchor-pan grab. */
  cancelInertial?(): void;
  cancel?(): void;
  beginAnchorPan?(pick: AnchorPanPick<TCanvas>): boolean;
  panAnchorTo?(pick: AnchorPanPick<TCanvas>, sensitivity?: number): boolean;
  getAnchorPanScreenError?(pick: AnchorPanPick<TCanvas>): AnchorPanScreenError | null;
  /**
   * The fingers of a grab pan twist and spread: turn by `headingDeltaDeg` about
   * the grabbed point's vertical and zoom to `factor` of the distance toward
   * it, the point kept where it is on screen. Letting go glides on about it.
   */
  twistAnchorPan?(headingDeltaDeg: number, factor: number): void | AnchoredMotionResult;
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
  armReleaseMomentum(channel: "orbit" | "zoom" | "pan"): void;
  releaseMomentum(channel: "orbit" | "zoom" | "pan"): void;
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
/** How long after its last event an orbit still counts as held, ms: a few frames, so a pointer between events is. */
const ORBIT_HELD_MS = 100;
/** How much velocity a 60 Hz frame keeps: `camera.inertiaDecay`'s default. */
export const DEFAULT_INERTIA_DECAY_PER_FRAME = 0.82;
/** `camera.grabFollowMs`: how long a grabbed point takes to catch up with the pointer, as a spring's time constant. */
export const GRAB_FOLLOW_ID = "camera.grabFollowMs";
/** Its default, ms. 0 holds the ground on the pointer; a longer time is the spring that trails it. */
export const DEFAULT_GRAB_FOLLOW_MS = 0;
const STOP_EPSILON_PX = 0.01;
/** A turn slower than this, degrees a frame, has settled. The same multiple of a pan's or a zoom's rest takes the same number of frames. */
export const ORBIT_GLIDE_REST_DEG = 0.002;
const STOP_EPSILON_DEG = ORBIT_GLIDE_REST_DEG;
const STOP_EPSILON_ZOOM_LOG = 0.00005;
/** Recent input kept for the release rate of a turn or a pinch. */
const MOMENTUM_WINDOW_MS = 120;
/** A pinch this quiet has ended. Shorter than a trackpad event gap, so a live pinch is not cut in two. */
const PINCH_RELEASE_GAP_MS = 48;
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

/**
 * A step a target refused: its channel stops, and keeps no anchor.
 * A step it did not take and did not refuse, such as a turn below its rest,
 * leaves the speed to decay with the others.
 */
function blocked(result: void | AnchoredMotionResult): boolean {
  return typeof result === "object" && result !== null && !result.moved && result.constrained !== null;
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
  // A turn, a pinch or a pointer pan the trackpad will not keep feeding, and the tail that feeds it after the lift.
  let orbitArmed = false;
  let zoomArmed = false;
  let panArmed = false;
  let recentOrbit: { t: number; pitch: number; heading: number }[] = [];
  const keyboardVelocity = { pan: { x: 0, y: 0, canvasHeight: 1 }, orbit: { pitch: 0, heading: 0, anchor: null as NavigationAnchor | null }, zoom: { log: 0, anchor: null as NavigationAnchor | null } };
  let keyboardMotion: typeof keyboardVelocity | null = null;
  let recentZoom: { t: number; log: number }[] = [];
  let recentPan: { t: number; x: number; y: number }[] = [];
  let lastOrbit: { t: number; pitch: number; heading: number } | null = null;
  let lastZoom: { t: number; log: number } | null = null;
  let lastPan: { t: number; x: number; y: number } | null = null;
  let orbitTail: { pitchPerMs: number; headingPerMs: number; startedMs: number } | null = null;
  let zoomTail: { logPerMs: number; startedMs: number } | null = null;
  let panTail: { xPerMs: number; yPerMs: number; startedMs: number } | null = null;

  const panMoving = (): boolean => Math.abs(panVelocityX) > STOP_EPSILON_PX || Math.abs(panVelocityY) > STOP_EPSILON_PX;
  /** The orbit's speed, degrees per frame, when its input last arrived: what the glide after the release is measured against. */
  let orbitHeldSpeed = 0;
  /** The share of that speed left since the release, never rising: a release tail's feed can lift the speed a little. */
  let orbitFade = 1;
  const orbitHeld = (): boolean => orbitTail === null && lastOrbit !== null && options.nowMs() - lastOrbit.t <= ORBIT_HELD_MS;
  const orbitSpeed = (): number => Math.hypot(orbitVelocityPitch, orbitVelocityHeading);
  const orbitMoving = (): boolean => Math.abs(orbitVelocityPitch) > STOP_EPSILON_DEG || Math.abs(orbitVelocityHeading) > STOP_EPSILON_DEG;
  const zoomMoving = (): boolean => Math.abs(zoomLogVelocity) > STOP_EPSILON_ZOOM_LOG;

  function cancel(): void {
    keyboardMotion = null;
    panVelocityX = 0;
    panVelocityY = 0;
    orbitVelocityPitch = 0;
    orbitVelocityHeading = 0;
    zoomLogVelocity = 0;
    orbitAnchor = null;
    zoomAnchor = null;
    orbitArmed = false;
    zoomArmed = false;
    panArmed = false;
    recentOrbit = [];
    recentZoom = [];
    recentPan = [];
    lastOrbit = null;
    lastZoom = null;
    lastPan = null;
    orbitTail = null;
    zoomTail = null;
    panTail = null;
  }

  function remember<T extends { t: number }>(samples: T[], sample: T, now: number): T[] {
    const kept = samples.filter(item => item.t >= now - MOMENTUM_WINDOW_MS);
    kept.push(sample);
    return kept;
  }

  function beginOrbitTail(now: number): void {
    orbitArmed = false;
    let pitch = 0;
    let heading = 0;
    for (const sample of recentOrbit) { pitch += sample.pitch; heading += sample.heading; }
    const span = recentOrbit.length === 0 ? 0 : Math.max(FRAME_MS, recentOrbit[recentOrbit.length - 1].t - recentOrbit[0].t);
    recentOrbit = [];
    if (!(span > 0) || (pitch === 0 && heading === 0)) return;
    orbitTail = { pitchPerMs: pitch / span, headingPerMs: heading / span, startedMs: now };
  }

  function beginZoomTail(now: number): void {
    zoomArmed = false;
    let log = 0;
    for (const sample of recentZoom) log += sample.log;
    const span = recentZoom.length === 0 ? 0 : Math.max(FRAME_MS, recentZoom[recentZoom.length - 1].t - recentZoom[0].t);
    recentZoom = [];
    if (!(span > 0) || log === 0) return;
    zoomTail = { logPerMs: log / span, startedMs: now };
  }

  function beginPanTail(now: number): void {
    panArmed = false;
    let x = 0;
    let y = 0;
    for (const sample of recentPan) { x += sample.x; y += sample.y; }
    const span = recentPan.length === 0 ? 0 : Math.max(FRAME_MS, recentPan[recentPan.length - 1].t - recentPan[0].t);
    recentPan = [];
    if (!(span > 0) || (x === 0 && y === 0)) return;
    panTail = { xPerMs: x / span, yPerMs: y / span, startedMs: now };
  }

  function armReleaseMomentum(channel: "orbit" | "zoom" | "pan"): void {
    const now = options.nowMs();
    if (channel === "orbit") {
      if (!orbitArmed && lastOrbit && now - lastOrbit.t <= FRAME_MS * 2) recentOrbit = remember(recentOrbit, lastOrbit, now);
      orbitArmed = true;
      return;
    }
    if (channel === "pan") {
      if (!panArmed && lastPan && now - lastPan.t <= FRAME_MS * 2) recentPan = remember(recentPan, lastPan, now);
      panArmed = true;
      return;
    }
    if (!zoomArmed && lastZoom && now - lastZoom.t <= FRAME_MS * 2) recentZoom = remember(recentZoom, lastZoom, now);
    zoomArmed = true;
  }

  function releaseMomentum(channel: "orbit" | "zoom" | "pan"): void {
    const now = options.nowMs();
    if (channel === "orbit") {
      if (!orbitArmed) return;
      beginOrbitTail(now);
      return;
    }
    if (channel === "pan") {
      if (!panArmed) return;
      beginPanTail(now);
      return;
    }
    if (!zoomArmed) return;
    beginZoomTail(now);
  }

  function feedRelease(now: number, deltaMs: number): void {
    if (zoomArmed && lastZoom && now - lastZoom.t >= PINCH_RELEASE_GAP_MS) beginZoomTail(now);
    if (orbitTail) {
      const fraction = trackpadMomentumFraction(now - orbitTail.startedMs);
      if (fraction === 0) orbitTail = null;
      else {
        orbitVelocityPitch = clamp(orbitVelocityPitch + orbitTail.pitchPerMs * deltaMs * fraction, -MAX_ORBIT_DELTA_PER_FRAME_DEG, MAX_ORBIT_DELTA_PER_FRAME_DEG);
        orbitVelocityHeading = clamp(orbitVelocityHeading + orbitTail.headingPerMs * deltaMs * fraction, -MAX_ORBIT_DELTA_PER_FRAME_DEG, MAX_ORBIT_DELTA_PER_FRAME_DEG);
      }
    }
    if (zoomTail) {
      const fraction = trackpadMomentumFraction(now - zoomTail.startedMs);
      if (fraction === 0) zoomTail = null;
      else zoomLogVelocity = clamp(zoomLogVelocity + zoomTail.logPerMs * deltaMs * fraction, -MAX_ZOOM_LOG_DELTA_PER_FRAME, MAX_ZOOM_LOG_DELTA_PER_FRAME);
    }
    if (panTail) {
      const fraction = trackpadMomentumFraction(now - panTail.startedMs);
      if (fraction === 0) panTail = null;
      else {
        panVelocityX = clamp(panVelocityX + panTail.xPerMs * deltaMs * fraction, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
        panVelocityY = clamp(panVelocityY + panTail.yPerMs * deltaMs * fraction, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
      }
    }
  }

  function motion(): GlideMotion {
    return {
      pan: { x: panVelocityX + (keyboardMotion?.pan.x ?? 0), y: panVelocityY + (keyboardMotion?.pan.y ?? 0), canvasHeight: keyboardMotion?.pan.canvasHeight ?? panCanvasHeight },
      orbit: { pitch: orbitVelocityPitch + (keyboardMotion?.orbit.pitch ?? 0), heading: orbitVelocityHeading + (keyboardMotion?.orbit.heading ?? 0), anchor: keyboardMotion && (keyboardMotion.orbit.pitch || keyboardMotion.orbit.heading) ? keyboardMotion.orbit.anchor : orbitAnchor },
      zoom: { log: zoomLogVelocity + (keyboardMotion?.zoom.log ?? 0), anchor: keyboardMotion?.zoom.log ? keyboardMotion.zoom.anchor : zoomAnchor },
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
      const rebased = target.rebaseMotion?.({ pan: { x: panVelocityX, y: panVelocityY, canvasHeight: panCanvasHeight }, orbit: { pitch: orbitVelocityPitch, heading: orbitVelocityHeading, anchor: orbitAnchor }, zoom: { log: zoomLogVelocity, anchor: zoomAnchor } }, next);
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
    panTail = null;
    const sample = { t: options.nowMs(), x: screenDxPx, y: screenDyPx };
    lastPan = sample;
    if (panArmed) recentPan = remember(recentPan, sample, sample.t);
    panVelocityX = clamp(panVelocityX + screenDxPx, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
    panVelocityY = clamp(panVelocityY + screenDyPx, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
  }

  function orbitBy(pitchDeltaDeg: number, headingDeltaDeg: number, anchor: NavigationAnchor | null = null): void {
    if (!sameAnchorPoint(orbitAnchor, anchor)) switchAnchors({ orbit: anchor, zoom: zoomAnchor });
    else orbitAnchor = anchor;
    orbitTail = null;
    const sample = { t: options.nowMs(), pitch: pitchDeltaDeg, heading: headingDeltaDeg };
    lastOrbit = sample;
    if (orbitArmed) recentOrbit = remember(recentOrbit, sample, sample.t);
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
    zoomTail = null;
    const sample = { t: options.nowMs(), log: Math.log(factor) };
    lastZoom = sample;
    if (zoomArmed) recentZoom = remember(recentZoom, sample, sample.t);
    zoomLogVelocity = clamp(
      zoomLogVelocity + sample.log,
      -MAX_ZOOM_LOG_DELTA_PER_FRAME,
      MAX_ZOOM_LOG_DELTA_PER_FRAME,
    );
  }

  function applyNavigationForce(force: GlideMotion, dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const dt = Math.min(0.1, dtSeconds);
    if (!keyboardMotion) {
      keyboardVelocity.pan.x = keyboardVelocity.pan.y = keyboardVelocity.orbit.pitch = keyboardVelocity.orbit.heading = keyboardVelocity.zoom.log = 0;
      keyboardMotion = keyboardVelocity;
    }
    keyboardMotion.pan.x += force.pan.x * dt; keyboardMotion.pan.y += force.pan.y * dt;
    keyboardMotion.pan.canvasHeight = force.pan.canvasHeight;
    keyboardMotion.orbit.pitch += force.orbit.pitch * dt; keyboardMotion.orbit.heading += force.orbit.heading * dt;
    keyboardMotion.orbit.anchor = force.orbit.anchor;
    keyboardMotion.zoom.log += force.zoom.log * dt; keyboardMotion.zoom.anchor = force.zoom.anchor;
  }

  function update(nowMs = options.nowMs()): void {
    const deltaMs = lastUpdateMs === null ? FRAME_MS : Math.max(0, Math.min(100, nowMs - lastUpdateMs));
    lastUpdateMs = nowMs;
    feedRelease(nowMs, deltaMs || FRAME_MS);
    const step = deltaMs / FRAME_MS;
    // Force-integrated keyboard velocity and pointer impulses add before the camera moves.
    // The keyboard's own braking force supplies its slowdown; pointer momentum keeps its glide.
    const key = keyboardMotion;
    const px = clamp(panVelocityX + (key?.pan.x ?? 0) * step, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
    const py = clamp(panVelocityY + (key?.pan.y ?? 0) * step, -MAX_PAN_DELTA_PER_FRAME_PX, MAX_PAN_DELTA_PER_FRAME_PX);
    const pitch = clamp(orbitVelocityPitch + (key?.orbit.pitch ?? 0) * step, -MAX_ORBIT_DELTA_PER_FRAME_DEG, MAX_ORBIT_DELTA_PER_FRAME_DEG);
    const heading = clamp(orbitVelocityHeading + (key?.orbit.heading ?? 0) * step, -MAX_ORBIT_DELTA_PER_FRAME_DEG, MAX_ORBIT_DELTA_PER_FRAME_DEG);
    const zoomLog = clamp(zoomLogVelocity + (key?.zoom.log ?? 0) * step, -MAX_ZOOM_LOG_DELTA_PER_FRAME, MAX_ZOOM_LOG_DELTA_PER_FRAME);
    const turnAnchor = key && (key.orbit.pitch || key.orbit.heading) ? key.orbit.anchor : orbitAnchor;
    const scaleAnchor = key?.zoom.log ? key.zoom.anchor : zoomAnchor;

    // Pan, then orbit, then zoom, once a frame.
    if ((key && (key.pan.x || key.pan.y)) || Math.abs(px) > STOP_EPSILON_PX || Math.abs(py) > STOP_EPSILON_PX) {
      target.panBy(px, py, key && (key.pan.x || key.pan.y) ? key.pan.canvasHeight : panCanvasHeight);
    }

    const orbiting = !!(key && (key.orbit.pitch || key.orbit.heading)) || Math.abs(pitch) > STOP_EPSILON_DEG || Math.abs(heading) > STOP_EPSILON_DEG;
    const zooming = !!key?.zoom.log || Math.abs(zoomLog) > STOP_EPSILON_ZOOM_LOG;
    if (orbiting && zooming && turnAnchor?.point && sameAnchorPoint(turnAnchor, scaleAnchor) && target.orbitZoomBy) {
      // One point for both: one step keeps it where it is.
      if (blocked(target.orbitZoomBy(pitch, heading, Math.exp(zoomLog), turnAnchor))) {
        orbitVelocityPitch = 0; orbitVelocityHeading = 0; zoomLogVelocity = 0;
      }
    } else {
      if (orbiting && blocked(orbitWith(target, pitch, heading, turnAnchor))) {
        orbitVelocityPitch = 0; orbitVelocityHeading = 0;
      }
      if (zooming && blocked(zoomWith(target, Math.exp(zoomLog), scaleAnchor))) {
        zoomLogVelocity = 0;
      }
    }

    if (orbitHeld()) orbitHeldSpeed = orbitSpeed();
    const decay = decayForDeltaTime(deltaMs || FRAME_MS);
    panVelocityX *= decay;
    panVelocityY *= decay;
    orbitVelocityPitch *= decay;
    orbitVelocityHeading *= decay;
    zoomLogVelocity *= decay;
    orbitFade = orbitHeld() || orbitHeldSpeed <= 0 ? 1 : Math.min(orbitFade, orbitSpeed() / orbitHeldSpeed);
    // A channel at rest lets go of its anchor: the next input acquires afresh.
    if (!orbitMoving()) orbitAnchor = null;
    if (!zoomMoving()) zoomAnchor = null;
  }

  function isActive(): boolean {
    return (keyboardMotion !== null && (Math.abs(keyboardMotion.pan.x) > 1e-10 || Math.abs(keyboardMotion.pan.y) > 1e-10 || Math.abs(keyboardMotion.orbit.pitch) > 1e-10 || Math.abs(keyboardMotion.orbit.heading) > 1e-10 || Math.abs(keyboardMotion.zoom.log) > 1e-10)) || panMoving() || orbitMoving() || zoomMoving() || orbitTail !== null || zoomTail !== null || panTail !== null || zoomArmed;
  }

  return {
    panBy, orbitBy, zoomBy, applyNavigationForce, clearNavigationForce: () => { keyboardMotion = null; }, update, cancel,
    cancelInertial() { const key = keyboardMotion; cancel(); keyboardMotion = key; }, isActive, motion, armReleaseMomentum, releaseMomentum,
    anchors: () => {
      const now = options.nowMs();
      const zoom = keyboardMotion?.zoom.log ? keyboardMotion.zoom.anchor : zoomMoving() ? zoomAnchor : null;
      const keyOrbit = keyboardMotion && (keyboardMotion.orbit.pitch || keyboardMotion.orbit.heading);
      // Armed while a pinch is still in the fingers. A wheel zoom stays live for
      // the gesture's own idle, and a tail means the fingers have already left.
      const zoomHeld = zoom !== null && (zoomArmed || (zoomTail === null && lastZoom !== null && now - lastZoom.t <= WHEEL_GESTURE_IDLE_MS));
      return {
        orbit: keyOrbit ? keyboardMotion!.orbit.anchor : orbitMoving() ? orbitAnchor : null, zoom, ...(zoomHeld ? { zoomHeld: true } : {}),
        ...((keyOrbit || orbitMoving()) && !(keyOrbit ? keyboardMotion!.orbit.anchor : orbitAnchor)?.point
          ? { compass: keyOrbit || orbitHeld() ? 1 : orbitFade } : {}),
      };
    },
    rebaseTo: switchAnchors,
    ...(target.acquireAnchors ? { acquireAnchors: (request: AnchorRequest<TCanvas>) => target.acquireAnchors!(request) } : {}),
    ...(target.holdAnchors ? { holdAnchors: (acquisition: AnchorAcquisition) => target.holdAnchors!(acquisition) } : {}),
    ...(target.releaseAnchors ? { releaseAnchors: (acquisition: AnchorAcquisition) => target.releaseAnchors!(acquisition) } : {}),
  };
}
