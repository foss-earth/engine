import type { CameraController } from "../camera/cameraState";
import { computeTwoPointGestureMetrics } from "../camera/cameraMath";
import type { TwoPointGestureMetrics } from "../camera/cameraMath";

// ─── Constants ───────────────────────────────────────────────────────

/** Degrees of orbit change per pixel of two-finger centroid movement. */
const TOUCH_ORBIT_DEG_PER_PX = 0.15;
/** Minimum centroid translation (px) before orbit is applied. */
const TOUCH_ORBIT_DEADZONE_PX = 0.75;
/** Minimum pinch distance change (px) before zoom is applied. */
const TOUCH_PINCH_DEADZONE_PX = 1.5;

// ─── Types ────────────────────────────────────────────────────────────

interface ActiveTouch {
  x: number;
  y: number;
}

interface TouchSession {
  previousMetrics: TwoPointGestureMetrics;
}

// ─── Controller ──────────────────────────────────────────────────────

/**
 * Attach a two-finger touch gesture handler to the canvas.
 *
 * When two pointer-type=touch contacts are active the handler:
 *  - Applies orbit (heading/pitch) from centroid translation
 *  - Applies zoom from pinch distance change
 *
 * Single-finger touch falls through to Babylon's built-in camera handler.
 *
 * Event propagation is stopped during active two-finger sessions so
 * Babylon's own pinch-zoom handler does not double-process the events.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachTouchController(
  canvas: HTMLCanvasElement,
  camera: CameraController,
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

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);

    if (activePointers.size === 2) {
      const metrics = getCurrentMetrics();
      if (metrics) {
        session = { previousMetrics: metrics };
        // Prevent Babylon from initiating its own two-finger gesture.
        e.stopPropagation();
      }
    } else if (activePointers.size > 2) {
      // More than two fingers — cancel our session and let Babylon decide.
      session = null;
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType !== "touch" || !activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (!session || activePointers.size !== 2) return;

    // Prevent Babylon from moving the camera while our gesture is active.
    e.preventDefault();
    e.stopPropagation();

    const metrics = getCurrentMetrics();
    if (!metrics) return;

    const dx = metrics.centroidX - session.previousMetrics.centroidX;
    const dy = metrics.centroidY - session.previousMetrics.centroidY;
    const distanceDeltaPx = metrics.distancePx - session.previousMetrics.distancePx;

    // Two-finger swipe → orbit (heading + pitch)
    if (Math.abs(dx) >= TOUCH_ORBIT_DEADZONE_PX || Math.abs(dy) >= TOUCH_ORBIT_DEADZONE_PX) {
      camera.orbitBy(dy * TOUCH_ORBIT_DEG_PER_PX, dx * TOUCH_ORBIT_DEG_PER_PX);
    }

    // Pinch → zoom
    if (Math.abs(distanceDeltaPx) >= TOUCH_PINCH_DEADZONE_PX) {
      const scaleDelta = metrics.distancePx / session.previousMetrics.distancePx;
      const factor = 1.5 - scaleDelta * 0.5;
      if (Math.abs(factor - 1) > 0.001) {
        camera.zoomBy(factor);
      }
    }

    session.previousMetrics = metrics;
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    activePointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    if (activePointers.size < 2) {
      session = null;
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
