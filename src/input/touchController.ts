import { classifyTwoPointGestureIntent, computeTwoPointGestureMetrics } from "../camera/cameraMath";
import type { TwoPointGestureIntent, TwoPointGestureMetrics } from "../camera/cameraMath";
import type { CameraInputTarget } from "./inertialCameraController";
import { MOVEMENT_SENSITIVITY_BASE, type InputSettings } from "./inputSettings";

// ─── Constants ───────────────────────────────────────────────────────

/** Degrees of orbit change per pixel of two-finger centroid movement. */
const TOUCH_ORBIT_DEG_PER_PX = 0.15;
/** Maximum accepted per-frame centroid delta. Larger values are treated as pointer churn, not intentional motion. */
const TOUCH_MAX_DELTA_PX = 80;
/** Minimum one-finger translation (px) before pan is applied. */
const TOUCH_PAN_DEADZONE_PX = 0.5;
/** Minimum centroid translation (px) before orbit is applied. */
const TOUCH_ORBIT_DEADZONE_PX = 0.75;
/** Minimum pinch distance change (px) before zoom is applied. */
const TOUCH_PINCH_DEADZONE_PX = 1.5;
/** Minimum per-finger movement (px) before a touch contributes to intent classification. */
const TOUCH_INTENT_POINTER_MOVE_PX = 4;
/** Delay before a one-moving-touch pivot pinch may commit to zoom. */
const TOUCH_SINGLE_TOUCH_PINCH_DELAY_MS = 120;

// ─── Types ────────────────────────────────────────────────────────────

interface ActiveTouch {
  x: number;
  y: number;
}

interface ActiveTouchEntry {
  pointerId: number;
  point: ActiveTouch;
}

interface TouchMovementState {
  hasTwoMovingTouches: boolean;
  touchesMovingTogether: boolean;
}

type TouchSession =
  | { kind: "single"; pointerId: number; previousPoint: ActiveTouch }
  | {
    kind: "multi";
    startPoints: Map<number, ActiveTouch>;
    startMetrics: TwoPointGestureMetrics;
    previousMetrics: TwoPointGestureMetrics;
    startTimeMs: number;
    intent: TwoPointGestureIntent;
  };

// ─── Controller ──────────────────────────────────────────────────────

/**
 * Attach a two-finger touch gesture handler to the canvas.
 *
 * One-finger touch pans the camera.
 *
 * When two pointer-type=touch contacts are active the handler locks the gesture
 * into one intent:
 *  - Swipe/orbit from centroid translation
 *  - Pinch/zoom from distance change
 *
 * Event propagation is stopped during touch sessions so Babylon's own handlers
 * do not also move the camera at gesture start/end.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachTouchController(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget,
  options: { getSettings?: () => InputSettings } = {},
): () => void {
  const activePointers = new Map<number, ActiveTouch>();
  let session: TouchSession | null = null;

  function getSortedEntries(): [ActiveTouchEntry, ActiveTouchEntry] | null {
    if (activePointers.size !== 2) return null;
    const sorted = Array.from(activePointers.entries())
      .sort(([a], [b]) => a - b)
      .map(([pointerId, point]) => ({ pointerId, point }));
    return [sorted[0], sorted[1]];
  }

  function getSortedPoints(): [ActiveTouch, ActiveTouch] | null {
    const entries = getSortedEntries();
    return entries ? [entries[0].point, entries[1].point] : null;
  }

  function getCurrentMetrics(): TwoPointGestureMetrics | null {
    const pts = getSortedPoints();
    return pts ? computeTwoPointGestureMetrics(pts[0], pts[1]) : null;
  }

  function stopTouchEvent(e: PointerEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function startSingleFingerSession(): void {
    if (activePointers.size !== 1) return;
    const [pointerId, point] = Array.from(activePointers.entries())[0];
    session = { kind: "single", pointerId, previousPoint: { ...point } };
  }

  function startTwoFingerSession(timeMs: number): void {
    const entries = getSortedEntries();
    const metrics = getCurrentMetrics();
    session = entries && metrics
      ? {
        kind: "multi",
        startPoints: new Map(entries.map(({ pointerId, point }) => [pointerId, { ...point }])),
        startMetrics: metrics,
        previousMetrics: metrics,
        startTimeMs: timeMs,
        intent: null,
      }
      : null;
  }

  function getTouchMovementState(multiSession: Extract<TouchSession, { kind: "multi" }>): TouchMovementState {
    const entries = getSortedEntries();
    if (!entries) return { hasTwoMovingTouches: false, touchesMovingTogether: false };

    const movements = entries.map(({ pointerId, point }) => {
      const startPoint = multiSession.startPoints.get(pointerId);
      const dx = startPoint ? point.x - startPoint.x : 0;
      const dy = startPoint ? point.y - startPoint.y : 0;
      return { dx, dy, magnitude: Math.hypot(dx, dy) };
    });

    const [firstMove, secondMove] = movements;
    const hasTwoMovingTouches = firstMove.magnitude >= TOUCH_INTENT_POINTER_MOVE_PX
      && secondMove.magnitude >= TOUCH_INTENT_POINTER_MOVE_PX;
    if (!hasTwoMovingTouches) {
      return { hasTwoMovingTouches: false, touchesMovingTogether: false };
    }

    const dot = firstMove.dx * secondMove.dx + firstMove.dy * secondMove.dy;
    const cosine = dot / (firstMove.magnitude * secondMove.magnitude);
    const magnitudeRatio = Math.min(firstMove.magnitude, secondMove.magnitude)
      / Math.max(firstMove.magnitude, secondMove.magnitude);
    return {
      hasTwoMovingTouches: true,
      touchesMovingTogether: cosine >= 0.7 && magnitudeRatio >= 0.5,
    };
  }

  function safelyCapturePointer(pointerId: number): void {
    try {
      canvas.setPointerCapture(pointerId);
    } catch {
      // Some browsers (notably iOS Safari) throw InvalidPointerId on rapid
      // multi-touch.  Swallow — the gesture still works without capture.
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    stopTouchEvent(e);
    camera.cancel?.();
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    safelyCapturePointer(e.pointerId);

    if (activePointers.size === 1) {
      startSingleFingerSession();
    } else if (activePointers.size === 2) {
      startTwoFingerSession(e.timeStamp);
    } else if (activePointers.size > 2) {
      // More than two fingers — cancel our session and let Babylon decide.
      session = null;
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType !== "touch" || !activePointers.has(e.pointerId)) return;
    stopTouchEvent(e);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      if (!session || session.kind !== "single" || session.pointerId !== e.pointerId) {
        startSingleFingerSession();
        return;
      }

      const point = activePointers.get(e.pointerId);
      if (!point) return;
      const dx = point.x - session.previousPoint.x;
      const dy = point.y - session.previousPoint.y;
      const isReasonableDelta = Math.abs(dx) <= TOUCH_MAX_DELTA_PX && Math.abs(dy) <= TOUCH_MAX_DELTA_PX;
      if (isReasonableDelta && (Math.abs(dx) >= TOUCH_PAN_DEADZONE_PX || Math.abs(dy) >= TOUCH_PAN_DEADZONE_PX)) {
        const sensitivity = options.getSettings?.().sensitivity.touch.pan ?? 1;
        camera.panBy(-dx * sensitivity * MOVEMENT_SENSITIVITY_BASE, -dy * sensitivity * MOVEMENT_SENSITIVITY_BASE, canvas.clientHeight);
      }
      session.previousPoint = { ...point };
      return;
    }

    if (activePointers.size !== 2) return;

    if (!session || session.kind !== "multi") {
      startTwoFingerSession(e.timeStamp);
      return;
    }

    const metrics = getCurrentMetrics();
    if (!metrics) return;

    const dx = metrics.centroidX - session.previousMetrics.centroidX;
    const dy = metrics.centroidY - session.previousMetrics.centroidY;
    const distanceDeltaPx = metrics.distancePx - session.previousMetrics.distancePx;
    const totalCentroidTranslationPx = Math.hypot(
      metrics.centroidX - session.startMetrics.centroidX,
      metrics.centroidY - session.startMetrics.centroidY,
    );
    const totalDistanceDeltaPx = metrics.distancePx - session.startMetrics.distancePx;
    const isReasonableDelta = Math.abs(dx) <= TOUCH_MAX_DELTA_PX
      && Math.abs(dy) <= TOUCH_MAX_DELTA_PX
      && Math.abs(distanceDeltaPx) <= TOUCH_MAX_DELTA_PX;

    if (!isReasonableDelta) {
      session.previousMetrics = metrics;
      return;
    }

    const wasUnclassified = session.intent === null;
    const touchMovementState = getTouchMovementState(session);
    const allowSingleTouchPinch = !touchMovementState.hasTwoMovingTouches
      && e.timeStamp - session.startTimeMs >= TOUCH_SINGLE_TOUCH_PINCH_DELAY_MS;
    session.intent ??= classifyTwoPointGestureIntent(
      totalCentroidTranslationPx,
      totalDistanceDeltaPx,
      touchMovementState.hasTwoMovingTouches,
      touchMovementState.touchesMovingTogether,
      allowSingleTouchPinch,
    );
    // When intent first commits, re-baseline startMetrics so any leftover
    // pre-classification drift from this gesture can't bias decisions later
    // in the same session.  We still apply this frame's motion below.
    if (wasUnclassified && session.intent !== null) {
      session.startMetrics = metrics;
    }

    if (session.intent === "swipe"
      && (Math.abs(dx) >= TOUCH_ORBIT_DEADZONE_PX || Math.abs(dy) >= TOUCH_ORBIT_DEADZONE_PX)) {
      const sensitivity = options.getSettings?.().sensitivity.touch.orbit ?? 1;
      camera.orbitBy(dy * TOUCH_ORBIT_DEG_PER_PX * sensitivity * MOVEMENT_SENSITIVITY_BASE, dx * TOUCH_ORBIT_DEG_PER_PX * sensitivity * MOVEMENT_SENSITIVITY_BASE);
    }

    if (session.intent === "pinch"
      && Math.abs(distanceDeltaPx) >= TOUCH_PINCH_DEADZONE_PX
      && metrics.distancePx > 0
      && session.previousMetrics.distancePx > 0) {
      // zoomBy is multiplicative: factor < 1 zooms in, > 1 zooms out.
      // Fingers spreading apart (distancePx grows) must zoom in, so factor = prev / current.
      // Using the exact ratio keeps the gesture frame-rate independent (chained ratios
      // compose to the total pinch scale change) — unlike a linear approximation.
      const factor = session.previousMetrics.distancePx / metrics.distancePx;
      if (Math.abs(factor - 1) > 0.001) {
        const sensitivity = options.getSettings?.().sensitivity.touch.zoom ?? 1;
        camera.zoomBy(Math.pow(factor, sensitivity * MOVEMENT_SENSITIVITY_BASE));
      }
    }

    session.previousMetrics = metrics;
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    if (activePointers.has(e.pointerId)) {
      stopTouchEvent(e);
    }
    activePointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    if (activePointers.size === 1) {
      startSingleFingerSession();
    } else if (activePointers.size === 0) {
      session = null;
    } else if (activePointers.size === 2) {
      startTwoFingerSession(e.timeStamp);
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  // Safety net: some browsers (notably iOS Safari) occasionally drop
  // pointerup/pointercancel during fast multi-touch.  Listening on the
  // window guarantees stale pointers can't get stuck in `activePointers`
  // and block fresh two-finger sessions from being recognized as pinch.
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };
}
