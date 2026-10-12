import type { RenderScheduler } from "@foss-earth/renderer";
import type { EcefCoord } from "../camera/cameraMath.js";
import { createInertialCameraController, DEFAULT_INERTIA_DECAY_PER_FRAME, type InertialCameraController } from "../input/inertialCameraController.js";
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
}
/** A pan glide slower than this, in pixels a frame, has stopped: the same rest as the inertial controller. */
const PAN_REST_PX = 0.01;
const FRAME_MS = 1000 / 60;
/** The longest a grab's step or its glide's step waits, matching the inertial controller. */
const MAX_STEP_MS = 100;
/** The inertial pan's cap for one 60 Hz frame. A grab's fling is capped the same way, then kept as a speed. */
const MAX_PAN_PX_PER_FRAME = 80;

/** The grab's release, in screen pixels per second, so a faster display does not fling it further. */
interface GrabGlide {
  x: number;
  y: number;
  height: number;
}

/** Source request-on-input wrapper; target and renderer are supplied, no animation loop is created. */
export function createGlobeInertia(controller: CameraController, ports: GlobeInertiaPorts): InertialCameraController<HTMLCanvasElement> {
  const base = createInertialCameraController<HTMLCanvasElement>(controller, ports);
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
  const rememberGrab = (): void => {
    const point = controller.grabbedPoint();
    grabbed = point ? Object.freeze({ x: point.x, y: point.y, z: point.z }) : null;
  };
  const panGliding = (): boolean => {
    const pan = base.motion().pan;
    return Math.abs(pan.x) > PAN_REST_PX || Math.abs(pan.y) > PAN_REST_PX;
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
    base.panBy(glide.x / 60, glide.y / 60, glide.height);
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
      controller.panBy(glide.x * dtMs / 1000, glide.y * dtMs / 1000, glide.height);
      const share = decayShare(dtMs);
      glide.x *= share;
      glide.y *= share;
    }
    if (Math.hypot(glide.x, glide.y) / 60 <= PAN_REST_PX) {
      grabGlide = null;
      grabGlideSteppedMs = null;
    }
  };
  return {
    panBy(dx, dy, height) { endRememberedGrab(); foldGrabGlide(); base.panBy(dx, dy, height); ports.renderer.requestRender(); },
    orbitBy(pitch, heading, anchor) { endRememberedGrab(); base.orbitBy(pitch, heading, current(anchor)); ports.renderer.requestRender(); },
    zoomBy(factor, anchor) { endRememberedGrab(); base.zoomBy(factor, current(anchor)); ports.renderer.requestRender(); },
    ...(anchors ? {
      acquireAnchors: request => anchors.acquire(request),
      holdAnchors: acquisition => anchors.hold(acquisition),
      releaseAnchors: acquisition => anchors.release(acquisition),
    } satisfies Pick<InertialCameraController<HTMLCanvasElement>, "acquireAnchors" | "holdAnchors" | "releaseAnchors"> : {}),
    // A grab pan: the ground under the pointer is held, and each frame brings it to the pointer.
    beginAnchorPan(pick) {
      grabGlide = null;
      grabGlideSteppedMs = null;
      base.cancel();
      grabSteppedMs = null;
      const began = controller.beginAnchorPan(pick);
      rememberGrab();
      return began;
    },
    panAnchorTo(pick) { const held = controller.panAnchorTo(pick); if (held) ports.renderer.requestRender(); return held; },
    getAnchorPanScreenError: pick => controller.getAnchorPanScreenError(pick),
    endAnchorPan() {
      // Let go: the speed it had, in pixels per second, glides on and slows by camera.inertiaDecay per 60 Hz frame.
      // A press that never moved, or that had already settled, leaves no glide and no marker.
      const fling = controller.endAnchorPan();
      const stepped = grabSteppedMs;
      grabSteppedMs = null;
      if (!fling) { grabbed = null; grabGlide = null; grabGlideSteppedMs = null; return; }
      const cap = (px: number): number => Math.max(-MAX_PAN_PX_PER_FRAME, Math.min(MAX_PAN_PX_PER_FRAME, px));
      grabGlide = { x: cap(fling.screenDxPx) * 60, y: cap(fling.screenDyPx) * 60, height: fling.canvasHeight };
      grabGlideSteppedMs = stepped;
      ports.renderer.requestRender();
    },
    update(nowMs = ports.nowMs()) {
      stepGrab(nowMs);
      stepGrabGlide(nowMs);
      base.update(nowMs);
      // The frame the pan glide comes to rest reports no grabbed point, as a zoom or turn at rest reports no anchor.
      if (grabbed && !controller.isAnchorPanActive() && !grabGlide && !panGliding()) grabbed = null;
    },
    cancelInertial() { base.cancel(); grabGlide = null; grabGlideSteppedMs = null; endRememberedGrab(); },
    cancel() { base.cancel(); controller.cancelAnchorPan(); grabSteppedMs = null; grabGlide = null; grabGlideSteppedMs = null; grabbed = null; },
    isActive: () => base.isActive() || controller.isAnchorPanMoving() || grabGlide !== null,
    anchors: () => (grabbed ? { ...base.anchors(), pan: grabbed } : base.anchors()),
    motion() {
      const current = base.motion();
      if (!grabGlide) return current;
      return { ...current, pan: { x: current.pan.x + grabGlide.x / 60, y: current.pan.y + grabGlide.y / 60, canvasHeight: grabGlide.height } };
    },
    rebaseTo(next) { foldGrabGlide(); if (!controller.isAnchorPanActive()) grabbed = null; base.rebaseTo(next); ports.renderer.requestRender(); },
  };
}
