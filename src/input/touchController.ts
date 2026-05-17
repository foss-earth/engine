import { classifyTwoPointGestureIntent, computeTwoPointGestureMetrics } from "../camera/cameraMath";
import type { TwoPointGestureIntent, TwoPointGestureMetrics } from "../camera/cameraMath";
import type { CameraInputTarget } from "./inertialCameraController";

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

// ─── Types ────────────────────────────────────────────────────────────

interface ActiveTouch {
  x: number;
  y: number;
}

type TouchSession =
  | { kind: "single"; pointerId: number; previousPoint: ActiveTouch }
  | {
    kind: "multi";
    startMetrics: TwoPointGestureMetrics;
    previousMetrics: TwoPointGestureMetrics;
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
): () => void {
  const activePointers = new Map<number, ActiveTouch>();
  let session: TouchSession | null = null;

  function getSortedPoints(): [ActiveTouch, ActiveTouch] | null {
    if (activePointers.size !== 2) return null;
    const sorted = Array.from(activePointers.entries())
      .sort(([a], [b]) => a - b)
      .map(([, p]) => p);
    return [sorted[0], sorted[1]];
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

  function startTwoFingerSession(): void {
    const metrics = getCurrentMetrics();
    session = metrics ? { kind: "multi", startMetrics: metrics, previousMetrics: metrics, intent: null } : null;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    stopTouchEvent(e);
    camera.cancel?.();
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);

    if (activePointers.size === 1) {
      startSingleFingerSession();
    } else if (activePointers.size === 2) {
      startTwoFingerSession();
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
        camera.panBy(-dx, -dy, canvas.clientHeight);
      }
      session.previousPoint = { ...point };
      return;
    }

    if (activePointers.size !== 2) return;

    if (!session || session.kind !== "multi") {
      startTwoFingerSession();
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
    const scaleRatio = session.startMetrics.distancePx > 0
      ? metrics.distancePx / session.startMetrics.distancePx
      : 1;
    const isReasonableDelta = Math.abs(dx) <= TOUCH_MAX_DELTA_PX
      && Math.abs(dy) <= TOUCH_MAX_DELTA_PX
      && Math.abs(distanceDeltaPx) <= TOUCH_MAX_DELTA_PX;

    if (!isReasonableDelta) {
      session.previousMetrics = metrics;
      return;
    }

    session.intent ??= classifyTwoPointGestureIntent(totalCentroidTranslationPx, scaleRatio);

    if (session.intent === "swipe"
      && (Math.abs(dx) >= TOUCH_ORBIT_DEADZONE_PX || Math.abs(dy) >= TOUCH_ORBIT_DEADZONE_PX)) {
      camera.orbitBy(dy * TOUCH_ORBIT_DEG_PER_PX, dx * TOUCH_ORBIT_DEG_PER_PX);
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
        camera.zoomBy(factor);
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
      startTwoFingerSession();
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
  };
}
