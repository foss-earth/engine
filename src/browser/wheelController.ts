import type { CameraInputTarget } from "../input/inertialCameraController.js";
import { DEFAULT_INPUT_RATES, type InputSettings } from "../input/inputSettings.js";
import { WHEEL_GESTURE_IDLE_MS, createWheelGestureClassifier } from "../input/wheelGesture.js";
export interface WheelWatchPorts { window: Pick<Window, "addEventListener" | "removeEventListener">; nowMs(): number }
const FRACTIONAL_DELTA_EPSILON = 0.001;

export interface WheelGestureWatch {
  /** Whether the wheel event being handled now began a gesture, rather than continuing one. */
  begins(): boolean;
  /** When the last wheel event came, `ports.nowMs()`: for a reader that starts while a gesture may be under way. */
  lastEventMs(): number;
  /** When the gesture under way, or the last one, began. */
  gestureStartMs(): number;
  dispose(): void;
}

/**
 * Watches the canvas's wheel events from the window's capture phase, before
 * any handler can stop them, to tell a gesture's first event from the rest:
 * whoever handles an event can then ask whether it began a gesture, and a
 * reader attached later, when the last one came.
 */
export function watchWheelGestures(canvas: HTMLElement, ports: WheelWatchPorts): WheelGestureWatch {
  let last = Number.NEGATIVE_INFINITY;
  let started = Number.NEGATIVE_INFINITY;
  let begins = true;
  const onWheel = (event: Event): void => {
    const target = event.target as Node | null;
    if (target !== canvas && !(target && canvas.contains(target))) return;
    const now = ports.nowMs();
    begins = now - last > WHEEL_GESTURE_IDLE_MS;
    if (begins) started = now;
    last = now;
  };
  ports.window.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return {
    begins: () => begins,
    lastEventMs: () => last,
    gestureStartMs: () => started,
    dispose: () => ports.window.removeEventListener("wheel", onWheel, { capture: true }),
  };
}

/**
 * Attach a trackpad-aware wheel event handler to the canvas.
 *
 * Behavior matrix (matches foss-earth / Cesium parity):
 *   - Trackpad two-finger swipe (no modifier)  → pan lat/lon
 *   - Shift + wheel / swipe                     → orbit heading/pitch
 *   - Ctrl + wheel (non-Safari, i.e. pinch)     → zoom
 *   - Mouse wheel (no modifier)                 → zoom
 *
 * Runs in capture phase with stopImmediatePropagation so Babylon's
 * built-in camera wheel handler never fires.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachWheelController(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget<HTMLCanvasElement>,
  options: { nowMs(): number; isSafariWithGestures: boolean; isOrbitMode?: () => boolean; getSettings?: () => InputSettings; precedingWheelMs?: number },
): () => void {
  const rates = () => options.getSettings?.().rates ?? DEFAULT_INPUT_RATES;
  const classify = createWheelGestureClassifier({
    nowMs: options.nowMs,
    isSafariWithGestures: options.isSafariWithGestures,
    isOrbitMode: options.isOrbitMode,
    mode: () => options.getSettings?.().mode ?? "auto",
    precedingWheelMs: options.precedingWheelMs,
  });

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Prevent Babylon's own wheel/zoom handler from firing on the same event.
    e.stopImmediatePropagation();
    const mode = classify(e);

    // ── Trackpad two-finger swipe = pan ──────────────────────────────────
    if (mode === "pan") {
      const sensitivity = options.getSettings?.().sensitivity.trackpad.pan ?? 1;
      const rate = rates().trackpadPanRate * sensitivity;
      camera.panBy(e.deltaX * rate, e.deltaY * rate, canvas.clientHeight);
      return;
    }

    // ── Shift+wheel = orbit (heading + pitch) ────────────────────────────
    if (mode === "orbit") {
      const settings = options.getSettings?.();
      const sensitivity = settings?.mode === "mouse"
        ? settings.sensitivity.mouse.orbit
        : settings?.sensitivity.trackpad.orbit ?? 1;
      // POI orbit mode maps trackpad swipe to orbit; invert pitch so swipe-up
      // tilts the view upward (matches pan drag direction users expect).
      const pitchSign = options.isOrbitMode?.() ? -1 : 1;
      const rate = rates().wheelOrbitDegPerPx;
      const pitchDeltaDeg = pitchSign * e.deltaY * rate * sensitivity;
      const headingDeltaDeg = -e.deltaX * rate * sensitivity;
      camera.orbitBy(pitchDeltaDeg, headingDeltaDeg);
      return;
    }

    if (mode === "ignore") {
      return;
    }

    // ── Ctrl+wheel = macOS trackpad pinch-to-zoom (non-Safari browsers) ──
    if (mode === "pinchZoom") {
      const sensitivity = options.getSettings?.().sensitivity.trackpad.zoom ?? 1;
      const factor = 1 + e.deltaY * rates().trackpadPinchZoomPerPx * sensitivity;
      camera.zoomBy(factor);
      return;
    }

    // ── Mouse wheel = coarser zoom ───────────────────────────────────────
    // Scroll down (deltaY>0) = zoom out; scroll up (deltaY<0) = zoom in.
    if (Math.abs(e.deltaY) <= FRACTIONAL_DELTA_EPSILON) return;
    const sensitivity = options.getSettings?.().sensitivity.mouse.zoom ?? 1;
    // The notch's share of the distance, as a power of 1.08 out and of 0.92 in.
    const exponent = Math.log1p(Math.max(0, rates().wheelZoomPerNotch)) / Math.log(1.08);
    const factor = Math.pow(e.deltaY > 0 ? 1.08 : 0.92, sensitivity * exponent);
    camera.zoomBy(factor);
  }

  canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });

  return () => {
    canvas.removeEventListener("wheel", onWheel, { capture: true });
  };
}
