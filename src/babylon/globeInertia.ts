import type { RenderScheduler } from "@foss-earth/renderer";
import type { EcefCoord } from "../camera/cameraMath.js";
import {
  createInertialCameraController,
  DEFAULT_INERTIA_DECAY_PER_FRAME,
  MAX_ZOOM_LOG_DELTA_PER_FRAME,
  ORBIT_GLIDE_REST_DEG,
  type InertialCameraController,
} from "../input/inertialCameraController.js";
import { trackpadMomentumFraction } from "../input/trackpadMomentum.js";
import type { NavigationAnchor } from "../input/navigationAnchors.js";
import type { CameraController } from "./cameraState.js";
import type { NavigationAnchorService } from "./navigationAnchorService.js";
export interface GlobeInertiaPorts {
  nowMs(): number;
  /** One live camera.inertiaDecay; no additional handover or gesture decay. */
  decayPerFrame(): number;
  renderer: Pick<RenderScheduler, "requestRender">;
  /** Where gestures zoom and turn about; without it, about the orbit target. */
  anchors?: Pick<NavigationAnchorService, "acquire" | "hold" | "release" | "isCurrent">;
  /** How long a grabbed point takes to catch up with the pointer, ms (`camera.grabFollowMs`); 0 or none: at once. */
  grabFollowMs?(): number;
  /** `camera.unifiedInertia`. Off, every push is at strength 1. */
  unified?(): boolean;
  /** `camera.panForce`, `camera.orbitForce` and `camera.zoomForce`. They scale a push; they do not change where it acts. */
  forces?(): { pan: number; orbit: number; zoom: number };
}
/** A pan glide slower than this, in pixels a frame, has stopped: the same rest as the inertial controller. */
const PAN_REST_PX = 0.01;
const FRAME_MS = 1000 / 60;
/** The longest a grab's step or its glide's step waits, matching the inertial controller. */
const MAX_STEP_MS = 100;
/** The inertial pan's cap for one 60 Hz frame. A grab's fling is capped the same way, then kept as a speed. */
const MAX_PAN_PX_PER_FRAME = 80;
/** The inertial turn's cap for one 60 Hz frame, degrees. A twist's fling is capped the same way. */
const MAX_TWIST_DEG_PER_FRAME = 12;
/** A zoom slower than this, natural log a 60 Hz frame, has stopped: the same rest as the inertial controller. */
const TWIST_REST_LOG = 0.00005;
/** Recent twist kept for its release speed, as the inertial controller keeps a turn's or a pinch's. */
const TWIST_WINDOW_MS = 120;

/**
 * The grab's release, in screen pixels per second, so a faster display does not
 * fling it further. `releaseX` and `releaseY` are that speed at the moment of
 * letting go: the feed holds the glide there, then shrinks it.
 */
interface GrabGlide {
  x: number;
  y: number;
  height: number;
  releaseX: number;
  releaseY: number;
  startedMs: number;
}

/**
 * A twist's release: the turn about the grabbed point, degrees per second,
 * and the zoom toward it, natural log of the distance per second. As with a
 * grab's glide, the release speeds feed it, then shrink.
 */
interface TwistGlide {
  point: Readonly<EcefCoord>;
  heading: number;
  log: number;
  releaseHeading: number;
  releaseLog: number;
  startedMs: number;
}

/** Source request-on-input wrapper; target and renderer are supplied, no animation loop is created. */
export function createGlobeInertia(controller: CameraController, ports: GlobeInertiaPorts): InertialCameraController<HTMLCanvasElement> {
  const base = createInertialCameraController<HTMLCanvasElement>(controller, ports);
  let unifiedOn = false;
  const strength = (kind: "pan" | "orbit" | "zoom"): number => {
    if (!(ports.unified?.() ?? false)) return 1;
    const value = ports.forces?.()[kind];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : value === 0 ? 0 : 1;
  };
  /** Flipping the setting lets go of the glide under way, so the two strengths never mix in one coast. */
  const syncUnified = (): void => {
    const on = ports.unified?.() ?? false;
    if (on === unifiedOn) return;
    base.cancel();
    grabGlide = null;
    grabGlideSteppedMs = null;
    endTwistGlide();
    unifiedOn = on;
  };
  const anchors = ports.anchors;
  // A gesture's anchor from before its context was cleared (the view replaced, navigation leased) is the orbit target's.
  const current = (anchor?: NavigationAnchor | null): NavigationAnchor | null => (anchor && anchors && !anchors.isCurrent(anchor) ? null : anchor ?? null);
  // The last frame a grab pan stepped at: its steps are as long as the frames between them.
  let grabSteppedMs: number | null = null;
  // The ground held from the press, through the drag, and through the pan glide the release starts.
  let grabbed: Readonly<EcefCoord> | null = null;
  // The release glide, in px/s. It is not the shared pan channel: that one applies a 60 Hz frame once per update.
  let grabGlide: GrabGlide | null = null;
  let grabGlideSteppedMs: number | null = null;
  // A held grab's twist, kept for its release speed, and the glide letting go starts about the grabbed point.
  let twistSamples: { t: number; heading: number; log: number }[] = [];
  let twistGlide: TwistGlide | null = null;
  let twistGlideSteppedMs: number | null = null;
  function endTwistGlide(): void {
    twistSamples = [];
    twistGlide = null;
    twistGlideSteppedMs = null;
  }
  const rememberGrab = (): void => {
    const point = controller.grabbedPoint();
    grabbed = point ? Object.freeze({ x: point.x, y: point.y, z: point.z }) : null;
  };
  const panGliding = (): boolean => {
    const pan = base.motion().pan;
    return Math.abs(pan.x) > PAN_REST_PX || Math.abs(pan.y) > PAN_REST_PX;
  };
  /**
   * A twist let go at speed glides on about the grabbed point at that speed,
   * fed and slowed as a grab's glide is. What moved in the last moments is
   * that speed: fingers held still before they lift leave none.
   */
  const startTwistGlide = (point: Readonly<EcefCoord> | null, nowMs: number, steppedMs: number | null): void => {
    const samples = twistSamples.filter(sample => sample.t >= nowMs - TWIST_WINDOW_MS);
    endTwistGlide();
    // Each sample is the twist since the one before, so the first only marks when the span starts.
    if (!point || samples.length < 2) return;
    const span = Math.max(FRAME_MS, Math.max(nowMs, samples[samples.length - 1].t) - samples[0].t);
    let heading = 0, log = 0;
    for (const sample of samples.slice(1)) { heading += sample.heading; log += sample.log; }
    const cap = (value: number, perFrame: number): number => Math.max(-perFrame * 60, Math.min(perFrame * 60, value));
    heading = cap(heading / span * 1000 * strength("orbit"), MAX_TWIST_DEG_PER_FRAME);
    log = cap(log / span * 1000 * strength("zoom"), MAX_ZOOM_LOG_DELTA_PER_FRAME);
    if (!Number.isFinite(heading) || !Number.isFinite(log) || twistResting(heading, log)) return;
    twistGlide = { point, heading, log, releaseHeading: heading, releaseLog: log, startedMs: nowMs };
    twistGlideSteppedMs = steppedMs;
  };
  const twistResting = (heading: number, log: number): boolean => Math.abs(heading) / 60 <= ORBIT_GLIDE_REST_DEG && Math.abs(log) / 60 <= TWIST_REST_LOG;
  const stepTwistGlide = (nowMs: number): void => {
    const glide = twistGlide;
    if (!glide) return;
    const dtMs = twistGlideSteppedMs === null ? FRAME_MS : Math.max(0, Math.min(MAX_STEP_MS, nowMs - twistGlideSteppedMs));
    twistGlideSteppedMs = nowMs;
    if (dtMs > 0) {
      // The grab glide's feed and friction, for a turn and a zoom.
      const share = decayShare(dtMs);
      const fraction = trackpadMomentumFraction(nowMs - glide.startedMs);
      glide.heading = glide.heading * share + glide.releaseHeading * (1 - share) * fraction;
      glide.log = glide.log * share + glide.releaseLog * (1 - share) * fraction;
      const step = controller.twistAbout(glide.point, glide.heading * dtMs / 1000, Math.exp(glide.log * dtMs / 1000));
      // Stopped where a limit or the pole lets it go no further.
      if (!step.moved && step.constrained) { endTwistGlide(); return; }
    }
    if (trackpadMomentumFraction(nowMs - glide.startedMs) === 0 && twistResting(glide.heading, glide.log)) endTwistGlide();
  };
  /** A released grab's marker ends when other input arrives. A grab still held keeps its point. */
  const endRememberedGrab = (): void => {
    if (!controller.isAnchorPanActive()) grabbed = null;
  };
  const decayShare = (dtMs: number): number => {
    const decay = ports.decayPerFrame();
    const perFrame = Number.isFinite(decay) ? Math.min(0.999, Math.max(0, decay)) : DEFAULT_INERTIA_DECAY_PER_FRAME;
    return perFrame ** (dtMs / FRAME_MS);
  };
  /** Hands the grab's remaining speed to the shared pan, one 60 Hz frame of it, and ends the grab's own glide. */
  const foldGrabGlide = (): void => {
    const glide = grabGlide;
    if (!glide) return;
    grabGlide = null;
    grabGlideSteppedMs = null;
    const scale = strength("pan");
    base.panBy(glide.x / 60 * scale, glide.y / 60 * scale, glide.height);
  };
  const stepGrab = (nowMs: number): void => {
    if (!controller.isAnchorPanActive()) { grabSteppedMs = null; return; }
    const dtMs = grabSteppedMs === null ? FRAME_MS : nowMs - grabSteppedMs;
    grabSteppedMs = nowMs;
    const followMs = ports.grabFollowMs?.() ?? 0;
    controller.stepAnchorPan(dtMs, Number.isFinite(followMs) ? Math.max(0, followMs) : 0);
  };
  const stepGrabGlide = (nowMs: number): void => {
    const glide = grabGlide;
    if (!glide) return;
    const dtMs = grabGlideSteppedMs === null ? FRAME_MS : Math.max(0, Math.min(MAX_STEP_MS, nowMs - grabGlideSteppedMs));
    grabGlideSteppedMs = nowMs;
    if (dtMs > 0) {
      const share = decayShare(dtMs);
      const fraction = trackpadMomentumFraction(nowMs - glide.startedMs);
      // Friction is still camera.inertiaDecay. The feed puts back the share it
      // removed, in the proportion a swipe's later wheel events still have, so
      // the speed stays what the drag had and then shrinks. Letting go does
      // not speed the camera up, and the marker is not what slows it.
      glide.x = glide.x * share + glide.releaseX * (1 - share) * fraction;
      glide.y = glide.y * share + glide.releaseY * (1 - share) * fraction;
      controller.panBy(glide.x * dtMs / 1000, glide.y * dtMs / 1000, glide.height);
    }
    if (trackpadMomentumFraction(nowMs - glide.startedMs) === 0 && Math.hypot(glide.x, glide.y) / 60 <= PAN_REST_PX) {
      grabGlide = null;
      grabGlideSteppedMs = null;
    }
  };
  return {
    panBy(dx, dy, height) {
      endRememberedGrab();
      foldGrabGlide();
      syncUnified();
      const scale = strength("pan");
      base.panBy(dx * scale, dy * scale, height);
      ports.renderer.requestRender();
    },
    orbitBy(pitch, heading, anchor) {
      endRememberedGrab();
      syncUnified();
      const scale = strength("orbit");
      base.orbitBy(pitch * scale, heading * scale, current(anchor));
      ports.renderer.requestRender();
    },
    zoomBy(factor, anchor) {
      endRememberedGrab();
      syncUnified();
      const scale = strength("zoom");
      const pushed = Number.isFinite(factor) && factor > 0 ? factor ** scale : factor;
      base.zoomBy(pushed, current(anchor));
      ports.renderer.requestRender();
    },
    armReleaseMomentum(channel) { base.armReleaseMomentum(channel); },
    releaseMomentum(channel) { base.releaseMomentum(channel); ports.renderer.requestRender(); },
    ...(anchors ? {
      acquireAnchors: request => anchors.acquire(request),
      holdAnchors: acquisition => anchors.hold(acquisition),
      releaseAnchors: acquisition => anchors.release(acquisition),
    } satisfies Pick<InertialCameraController<HTMLCanvasElement>, "acquireAnchors" | "holdAnchors" | "releaseAnchors"> : {}),
    // A grab pan: the ground under the pointer is held, and each frame brings it to the pointer.
    beginAnchorPan(pick) {
      grabGlide = null;
      grabGlideSteppedMs = null;
      endTwistGlide();
      base.cancel();
      grabSteppedMs = null;
      const began = controller.beginAnchorPan(pick);
      rememberGrab();
      return began;
    },
    panAnchorTo(pick) { const held = controller.panAnchorTo(pick); if (held) ports.renderer.requestRender(); return held; },
    getAnchorPanScreenError: pick => controller.getAnchorPanScreenError(pick),
    // Two fingers holding the ground twist and spread: the view turns and zooms about the point they hold.
    twistAnchorPan(headingDeltaDeg, factor) {
      const step = controller.twistAnchorPan(headingDeltaDeg, factor);
      if (step.moved) {
        const now = ports.nowMs();
        twistSamples = [...twistSamples.filter(sample => sample.t >= now - TWIST_WINDOW_MS), { t: now, heading: headingDeltaDeg, log: Math.log(factor) }];
        ports.renderer.requestRender();
      }
      return step;
    },
    endAnchorPan() {
      // Let go: the speed it had, in pixels per second, keeps being fed for as long as a
      // swipe's wheel events, shrinking the same way, and camera.inertiaDecay slows it.
      // A twist's turn and zoom glide on the same way about the point. A press that
      // never moved, or that had already settled, leaves no glide and no marker.
      const point = controller.grabbedPoint();
      const fling = controller.endAnchorPan();
      const stepped = grabSteppedMs;
      grabSteppedMs = null;
      syncUnified();
      startTwistGlide(point, ports.nowMs(), stepped);
      if (twistGlide) ports.renderer.requestRender();
      if (!fling) { if (!twistGlide) grabbed = null; grabGlide = null; grabGlideSteppedMs = null; return; }
      const cap = (px: number): number => Math.max(-MAX_PAN_PX_PER_FRAME, Math.min(MAX_PAN_PX_PER_FRAME, px));
      const scale = strength("pan");
      const x = cap(fling.screenDxPx) * scale * 60;
      const y = cap(fling.screenDyPx) * scale * 60;
      grabGlide = { x, y, height: fling.canvasHeight, releaseX: x, releaseY: y, startedMs: ports.nowMs() };
      grabGlideSteppedMs = stepped;
      ports.renderer.requestRender();
    },
    update(nowMs = ports.nowMs()) {
      stepGrab(nowMs);
      stepGrabGlide(nowMs);
      stepTwistGlide(nowMs);
      syncUnified();
      base.update(nowMs);
      // The frame the pan glide comes to rest reports no grabbed point, as a zoom or turn at rest reports no anchor.
      if (grabbed && !controller.isAnchorPanActive() && !grabGlide && !twistGlide && !panGliding()) grabbed = null;
    },
    cancelInertial() { base.cancel(); grabGlide = null; grabGlideSteppedMs = null; endTwistGlide(); endRememberedGrab(); },
    cancel() { base.cancel(); controller.cancelAnchorPan(); grabSteppedMs = null; grabGlide = null; grabGlideSteppedMs = null; endTwistGlide(); grabbed = null; },
    isActive: () => base.isActive() || controller.isAnchorPanMoving() || grabGlide !== null || twistGlide !== null,
    // The point stays for the glide. panHeld is the finger: once it is up, the marker is only showing where the grab was.
    anchors: () => (grabbed ? { ...base.anchors(), pan: grabbed, panHeld: controller.isAnchorPanActive() } : base.anchors()),
    motion() {
      const current = base.motion();
      if (!grabGlide) return current;
      return { ...current, pan: { x: current.pan.x + grabGlide.x / 60, y: current.pan.y + grabGlide.y / 60, canvasHeight: grabGlide.height } };
    },
    rebaseTo(next) { foldGrabGlide(); if (!controller.isAnchorPanActive()) grabbed = null; base.rebaseTo(next); ports.renderer.requestRender(); },
  };
}
