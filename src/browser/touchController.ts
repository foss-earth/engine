import { orbitWith, zoomWith, type CameraInputTarget } from "../input/inertialCameraController.js";
import { DEFAULT_INPUT_RATES, type InputSettings } from "../input/inputSettings.js";
import type { AnchorAcquisition } from "../input/navigationAnchors.js";
import type { TouchDebugEvent, TouchDebugOverlayHandle } from "../input/touchDiagnostics.js";

/** A contact already down when the handler attaches, such as one that took the camera over from a lease's owner, and where it is. */
export interface HeldTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

// ─── Gesture recognition ─────────────────────────────────────────────
// These filter noise out of the touch stream; they decide nothing about how
// far a gesture moves the camera. The rates are parameters (`input.touch.*`),
// and the sensitivity slider multiplies them (0.5 = half, 2 = double).

/** Maximum accepted centroid movement per frame (px). Orbit jitter guard. */
const TOUCH_MAX_DELTA_PX = 80;
/**
 * Maximum accepted finger-distance change per frame (px) for zoom.
 * Higher than the centroid guard because fast pinch is a real gesture:
 * two thumbs can spread/contract >80 px in a single frame at 60 fps.
 * Frames that exceed this are clamped rather than dropped so the baseline
 * keeps advancing and subsequent frames are not cascaded-rejected.
 */
const TOUCH_MAX_ZOOM_DELTA_PX = 250;
/** Minimum one-finger translation (px) before pan is applied. */
const TOUCH_PAN_DEADZONE_PX = 0.5;
/**
 * Cumulative centroid travel (px) before orbit starts emitting deltas.
 * Just enough to suppress micro-jitter at finger landing; not a mode lock.
 */
const ORBIT_ACTIVATION_PX = 4;
/**
 * Cumulative |log(distanceRatio)| before zoom starts emitting deltas.
 * ln(1.05) ≈ 0.0488 — fingers must spread/contract ~5% before zoom kicks in.
 */
const ZOOM_ACTIVATION_LOG = Math.log(1.05);

// ─── Types ────────────────────────────────────────────────────────────

interface Point2D {
  x: number;
  y: number;
}

interface PanSession {
  kind: "pan";
  identifier: number;
  previous: Point2D;
  anchorPanActive: boolean;
}

interface TransformSession {
  kind: "transform";
  // Identifiers of the two contacts we're tracking (first two touches).
  identifierA: number;
  identifierB: number;
  // Previous frame's transform state — used to compute per-frame deltas.
  previousCentroid: Point2D;
  previousDistance: number;
  // Accumulated since session start — used only for activation hysteresis.
  accumulatedCentroidTravelPx: number;
  accumulatedAbsLogScale: number;
  orbitActive: boolean;
  zoomActive: boolean;
  /** Where this pair zooms and turns: picked under its first midpoint, and held once it moves. */
  anchors: AnchorAcquisition | null;
  anchorsHeld: boolean;
}

type Session = PanSession | TransformSession | null;

/** What the controller reads of a touch: a Touch, or a contact handed back. */
type Contact = Pick<Touch, "identifier" | "clientX" | "clientY">;

// ─── Pure geometry helpers ───────────────────────────────────────────

function centroid(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ─── Controller ──────────────────────────────────────────────────────

/**
 * Continuous two-touch transform recognizer (MapLibre / Google Maps style).
 *
 * One finger pans.
 *
 * Two fingers produce a continuous transform that is applied every frame:
 *   - centroid translation drives orbit
 *   - distance ratio drives zoom
 *
 * The two components are independent — both can be active in the same gesture
 * (you can orbit and zoom simultaneously, exactly like a real map).  A small
 * activation hysteresis suppresses jitter at finger landing; after that all
 * motion is applied directly.  There is no "intent commit", no delay, no
 * mode lock — the only thing classified at any moment is *this frame's*
 * motion.
 *
 * Uses TouchEvent rather than PointerEvent because Android Firefox can
 * deliver wildly asymmetric pointermove streams during a two-finger swipe
 * (one finger fires 10 events while the other fires 0), making a per-pointer
 * model unreliable.  TouchEvent always reports the full active TouchList per
 * event, so each frame has both finger positions.
 *
 * A pair zooms and turns about the anchors `input.touch.*` choose, picked
 * under its midpoint when it lands and kept until it lifts: the midpoint
 * moving turns the view, it does not move the anchor. `heldTouches`, down
 * before the handler attached, go on as the gesture they were.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachTouchController(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget<HTMLCanvasElement>,
  options: { isOrbitMode?: () => boolean; getSettings?: () => InputSettings; onDebug?: (event: TouchDebugEvent) => void; attachTouchDebugOverlay?: () => TouchDebugOverlayHandle; heldTouches?: readonly HeldTouch[] | null } = {},
): () => void {
  // Pan, orbit and pinch rates at sensitivity 1: `input.touch.*`.
  const rates = () => options.getSettings?.().rates ?? DEFAULT_INPUT_RATES;
  // ── Debug overlay wiring ────────────────────────────────────────
  let debugOverlayDestroy: (() => void) | null = null;
  let debugSink: ((event: TouchDebugEvent) => void) | null = options.onDebug ?? null;
  if (options.attachTouchDebugOverlay) {
    const overlay = options.attachTouchDebugOverlay();
    debugOverlayDestroy = overlay.destroy;
    const userSink = debugSink;
    debugSink = (e) => {
      overlay.onDebug(e);
      userSink?.(e);
    };
  }

  let session: Session = null;
  const touchMoveCount = new Map<number, number>();
  // Contacts handed back, down before this handler: their touchstart, if it comes now, is not a new touch.
  const handedBack = new Set((options.heldTouches ?? []).map(t => t.identifier));

  /**
   * Replaces the session; a pair that ends lets go of its anchors, and what it set moving glides on about them.
   * A one-finger pan that ends lets go of the ground it grabbed, as a pair lands or the finger lifts.
   */
  function setSession(next: Session): void {
    if (session?.kind === "transform" && session !== next && session.anchors) camera.releaseAnchors?.(session.anchors);
    if (session?.kind === "pan" && session !== next && session.anchorPanActive) camera.endAnchorPan?.();
    session = next;
  }

  function activeIds(touches: TouchList): number[] {
    return Array.from(touches, (t) => t.identifier).sort((a, b) => a - b);
  }

  function moveCountSnapshot(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [id, count] of touchMoveCount) out[id] = count;
    return out;
  }

  function sessionKindLabel(): "none" | "single" | "multi" {
    if (!session) return "none";
    return session.kind === "pan" ? "single" : "multi";
  }

  function emitDebug(event: TouchDebugEvent, touches: TouchList): void {
    if (!debugSink) return;
    debugSink({
      ...event,
      activePointerIds: activeIds(touches),
      sessionKind: sessionKindLabel(),
      perPointerMoveCount: moveCountSnapshot(),
    });
  }

  function pointFromTouch(t: Contact): Point2D {
    return { x: t.clientX, y: t.clientY };
  }

  function firstTwo(touches: ArrayLike<Contact>): [Contact, Contact] | null {
    if (touches.length < 2) return null;
    return [touches[0], touches[1]];
  }

  // ── Session transitions ─────────────────────────────────────────

  function startPanSession(touches: ArrayLike<Contact>): void {
    if (touches.length < 1) {
      setSession(null);
      return;
    }
    const t = touches[0];
    // The last session lets go first: its grab is not the one this finger takes.
    setSession(null);
    let anchorPanActive = false;
    if ((options.getSettings?.().globeAnchorRotation ?? false) && camera.beginAnchorPan) {
      anchorPanActive = camera.beginAnchorPan({
        clientX: t.clientX,
        clientY: t.clientY,
        canvas,
      });
    }
    setSession({ kind: "pan", identifier: t.identifier, previous: pointFromTouch(t), anchorPanActive });
  }

  function startTransformSession(touches: ArrayLike<Contact>): void {
    const pair = firstTwo(touches);
    if (!pair) {
      setSession(null);
      return;
    }
    const [a, b] = pair;
    const pa = pointFromTouch(a);
    const pb = pointFromTouch(b);
    const midpoint = centroid(pa, pb);
    // A new pair lets go of the last one's anchors before picking its own, from the pose as it is now.
    setSession(null);
    setSession({
      kind: "transform",
      identifierA: a.identifier,
      identifierB: b.identifier,
      previousCentroid: midpoint,
      previousDistance: distance(pa, pb),
      accumulatedCentroidTravelPx: 0,
      accumulatedAbsLogScale: 0,
      orbitActive: false,
      zoomActive: false,
      // One pick under the first midpoint, for zoom and rotation both when both ask for it.
      anchors: camera.acquireAnchors?.({ family: "touch", operations: ["zoom", "orbit"], client: midpoint, canvas, candidate: true }) ?? null,
      anchorsHeld: false,
    });
  }

  function reconcileSession(touches: ArrayLike<Contact>): void {
    if (touches.length === 0) {
      setSession(null);
      return;
    }
    if (touches.length === 1) {
      if (!session || session.kind !== "pan" || session.identifier !== touches[0].identifier) {
        startPanSession(touches);
      } else {
        // Re-baseline previous to current to avoid jumps after multi-touch end.
        session.previous = pointFromTouch(touches[0]);
      }
      return;
    }
    // Two or more touches — track the first two.  If they don't match the
    // active session, restart.
    const pair = firstTwo(touches)!;
    const [a, b] = pair;
    if (
      !session
      || session.kind !== "transform"
      || (session.identifierA !== a.identifier && session.identifierA !== b.identifier)
      || (session.identifierB !== a.identifier && session.identifierB !== b.identifier)
    ) {
      startTransformSession(touches);
    } else {
      // Same pair, but touch count changed (e.g. third finger lifted).
      // Re-baseline previous metrics so the next frame's delta is zero.
      const pa = pointFromTouch(a);
      const pb = pointFromTouch(b);
      session.previousCentroid = centroid(pa, pb);
      session.previousDistance = distance(pa, pb);
    }
  }

  // ── Frame application ───────────────────────────────────────────

  function applyPan(touches: TouchList): void {
    if (!session || session.kind !== "pan") return;
    const s = session;
    const t = Array.from(touches).find((x) => x.identifier === s.identifier);
    if (!t) return;
    const p = pointFromTouch(t);
    const dx = p.x - session.previous.x;
    const dy = p.y - session.previous.y;
    session.previous = p;
    if (Math.abs(dx) > TOUCH_MAX_DELTA_PX || Math.abs(dy) > TOUCH_MAX_DELTA_PX) return;
    if (Math.abs(dx) < TOUCH_PAN_DEADZONE_PX && Math.abs(dy) < TOUCH_PAN_DEADZONE_PX) return;

    const sensitivity = options.getSettings?.().sensitivity.touch.pan ?? 1;

    if (s.anchorPanActive && camera.panAnchorTo) {
      camera.panAnchorTo({
        clientX: p.x,
        clientY: p.y,
        canvas,
      }, sensitivity);
      return;
    }

    camera.panBy(
      -dx * sensitivity * rates().touchPanRate,
      -dy * sensitivity * rates().touchPanRate,
      canvas.clientHeight,
    );
  }

  function applyTransform(touches: TouchList, timestamp: number): void {
    if (!session || session.kind !== "transform") return;
    const pair = firstTwo(touches);
    if (!pair) return;
    const [a, b] = pair;
    // Re-pair if a tracked finger lifted and another took its slot.
    if (
      (session.identifierA !== a.identifier && session.identifierA !== b.identifier)
      || (session.identifierB !== a.identifier && session.identifierB !== b.identifier)
    ) {
      startTransformSession(touches);
      return;
    }

    const pa = pointFromTouch(a);
    const pb = pointFromTouch(b);
    const c = centroid(pa, pb);
    const d = distance(pa, pb);
    if (d <= 0 || session.previousDistance <= 0) {
      session.previousCentroid = c;
      session.previousDistance = d;
      return;
    }

    const dCx = c.x - session.previousCentroid.x;
    const dCy = c.y - session.previousCentroid.y;
    const centroidStepPx = Math.hypot(dCx, dCy);

    // ── Centroid jitter guard (orbit) ─────────────────────────────────────
    // A centroid jump > 80 px is physically impossible on glass — it's a
    // glitch.  Drop the whole frame and keep the old baseline so the next
    // real frame has a clean reference.
    if (Math.abs(dCx) > TOUCH_MAX_DELTA_PX || Math.abs(dCy) > TOUCH_MAX_DELTA_PX) {
      return;
    }

    // ── Distance clamp (zoom) ──────────────────────────────────────────────
    // A fast pinch can legitimately produce large per-frame distance changes.
    // Instead of dropping those frames (which would cascade-reject a whole
    // fast-zoom gesture), clamp the effective distance change and always
    // advance the baseline.  Values beyond TOUCH_MAX_ZOOM_DELTA_PX are true
    // hardware glitches and get capped to the maximum plausible step.
    const clampedD =
      Math.abs(d - session.previousDistance) > TOUCH_MAX_ZOOM_DELTA_PX
        ? session.previousDistance + Math.sign(d - session.previousDistance) * TOUCH_MAX_ZOOM_DELTA_PX
        : d;
    const clampedScaleStep = clampedD / session.previousDistance;
    const clampedLogScaleStep = Math.log(clampedScaleStep);

    session.accumulatedCentroidTravelPx += centroidStepPx;
    session.accumulatedAbsLogScale += Math.abs(clampedLogScaleStep);

    if (!session.orbitActive && session.accumulatedCentroidTravelPx >= ORBIT_ACTIVATION_PX) {
      session.orbitActive = true;
    }
    if (!session.zoomActive && session.accumulatedAbsLogScale >= ZOOM_ACTIVATION_LOG) {
      session.zoomActive = true;
    }
    // The pair is moving the camera now: its anchors are in use, and show.
    if ((session.orbitActive || session.zoomActive) && session.anchors && !session.anchorsHeld) {
      session.anchorsHeld = true;
      camera.holdAnchors?.(session.anchors);
    }

    if (session.orbitActive) {
      const sensitivity = options.getSettings?.().sensitivity.touch.orbit ?? 1;
      const pitchSign = options.isOrbitMode?.() ? -1 : 1;
      orbitWith(
        camera,
        pitchSign * dCy * rates().touchOrbitDegPerPx * sensitivity,
        dCx * rates().touchOrbitDegPerPx * sensitivity,
        session.anchors?.orbit,
      );
    }
    if (session.zoomActive && Math.abs(clampedLogScaleStep) > 0.0001) {
      // zoomBy is multiplicative; factor < 1 zooms in, > 1 zooms out.
      // Fingers spreading apart (clampedD > previousDistance) must zoom in,
      // so factor = previousDistance / clampedD = 1 / clampedScaleStep.
      const sensitivity = options.getSettings?.().sensitivity.touch.zoom ?? 1;
      const factor = 1 / clampedScaleStep;
      zoomWith(camera, Math.pow(factor, sensitivity * rates().touchZoomExponent), session.anchors?.zoom);
    }

    session.previousCentroid = c;
    // Always advance the distance baseline — even on a clamped frame — so
    // subsequent frames don't keep seeing a large delta from a stale value.
    session.previousDistance = d;

    // Debug — repurpose "classify" as a per-frame activity snapshot.
    if (debugSink) {
      const intent = session.orbitActive && session.zoomActive
        ? "swipe" // overlay paints orbit-only as green; "swipe" + note shows combined
        : session.orbitActive
          ? "swipe"
          : session.zoomActive
            ? "pinch"
            : null;
      emitDebug({
        type: "classify",
        timestamp,
        centroidTranslationPx: session.accumulatedCentroidTravelPx,
        distanceDeltaPx: session.accumulatedAbsLogScale,
        hasTwoMovingTouches: true,
        touchesMovingTogether: false,
        intent,
        note: `orbit=${session.orbitActive ? 1 : 0} zoom=${session.zoomActive ? 1 : 0} cStep=${centroidStepPx.toFixed(1)} sStep=${clampedScaleStep.toFixed(3)}`,
      }, touches);
    }
  }

  // ── Event handlers ──────────────────────────────────────────────

  function stop(e: TouchEvent): void {
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onTouchStart(e: TouchEvent): void {
    stop(e);
    // A finger landing stops the glide, unless it is one handed back, already moving the camera.
    const fresh = Array.from(e.changedTouches).filter(t => !handedBack.delete(t.identifier));
    if (fresh.length > 0 || e.changedTouches.length === 0) camera.cancel?.();
    for (const t of Array.from(e.changedTouches)) {
      touchMoveCount.set(t.identifier, 0);
      emitDebug({
        type: "down",
        timestamp: e.timeStamp,
        pointerId: t.identifier,
        pointerType: "touch",
        clientX: Math.round(t.clientX),
        clientY: Math.round(t.clientY),
      }, e.touches);
    }
    reconcileSession(e.touches);
  }

  function onTouchMove(e: TouchEvent): void {
    stop(e);
    for (const t of Array.from(e.changedTouches)) {
      touchMoveCount.set(t.identifier, (touchMoveCount.get(t.identifier) ?? 0) + 1);
      emitDebug({
        type: "move",
        timestamp: e.timeStamp,
        pointerId: t.identifier,
        clientX: Math.round(t.clientX),
        clientY: Math.round(t.clientY),
      }, e.touches);
    }
    if (e.touches.length === 1) {
      if (!session || session.kind !== "pan") startPanSession(e.touches);
      applyPan(e.touches);
    } else if (e.touches.length >= 2) {
      if (!session || session.kind !== "transform") startTransformSession(e.touches);
      applyTransform(e.touches, e.timeStamp);
    }
  }

  function onTouchEnd(e: TouchEvent): void {
    stop(e);
    for (const t of Array.from(e.changedTouches)) {
      handedBack.delete(t.identifier);
      touchMoveCount.delete(t.identifier);
      emitDebug({
        type: e.type === "touchcancel" ? "cancel" : "up",
        timestamp: e.timeStamp,
        pointerId: t.identifier,
      }, e.touches);
    }
    reconcileSession(e.touches);
  }

  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd, { passive: false });
  canvas.addEventListener("touchcancel", onTouchEnd, { passive: false });
  // Contacts that took the camera over go on from where they are, from the pose handed back.
  if (options.heldTouches?.length) reconcileSession(options.heldTouches);

  return () => {
    canvas.removeEventListener("touchstart", onTouchStart);
    canvas.removeEventListener("touchmove", onTouchMove);
    canvas.removeEventListener("touchend", onTouchEnd);
    canvas.removeEventListener("touchcancel", onTouchEnd);
    setSession(null);
    debugOverlayDestroy?.();
  };
}
