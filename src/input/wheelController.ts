import type { CameraInputTarget } from "./inertialCameraController";
import { DEFAULT_INPUT_RATES, type InputSettings } from "./inputSettings";

export type WheelGestureMode = "pan" | "pinchZoom" | "wheelZoom" | "orbit" | "ignore";

const WHEEL_GESTURE_IDLE_MS = 180;
const PIXEL_DELTA_MODE = 0;
const FRACTIONAL_DELTA_EPSILON = 0.001;

interface WheelGestureSession {
  mode: WheelGestureMode;
  lastEventTimeMs: number;
}

function hasFractionalDelta(value: number): boolean {
  return Math.abs(value - Math.round(value)) > FRACTIONAL_DELTA_EPSILON;
}

function isLikelyVerticalMouseWheel(e: WheelEvent): boolean {
  if (e.deltaMode !== PIXEL_DELTA_MODE) {
    return Math.abs(e.deltaY) > FRACTIONAL_DELTA_EPSILON;
  }

  const absDeltaX = Math.abs(e.deltaX);
  const absDeltaY = Math.abs(e.deltaY);
  const hasHorizontalDelta = absDeltaX > FRACTIONAL_DELTA_EPSILON;
  const hasFineDelta = hasFractionalDelta(e.deltaX) || hasFractionalDelta(e.deltaY);

  // Smooth mouse wheels often report modest integer pixel deltas such as 40
  // or 53. Treating those as trackpad pan moves lat/lon violently at high
  // altitude, so vertical-only integer wheel deltas should zoom regardless
  // of magnitude. Trackpad pans normally expose fractional deltas and/or a
  // horizontal component.
  return !hasHorizontalDelta && !hasFineDelta && absDeltaY > FRACTIONAL_DELTA_EPSILON;
}

function isLikelyHorizontalMouseWheel(e: WheelEvent): boolean {
  const absDeltaX = Math.abs(e.deltaX);
  const absDeltaY = Math.abs(e.deltaY);
  if (e.deltaMode !== PIXEL_DELTA_MODE) {
    return absDeltaX > FRACTIONAL_DELTA_EPSILON && absDeltaY <= FRACTIONAL_DELTA_EPSILON;
  }

  const hasFineDelta = hasFractionalDelta(e.deltaX) || hasFractionalDelta(e.deltaY);
  return !hasFineDelta && absDeltaX > FRACTIONAL_DELTA_EPSILON && absDeltaY <= FRACTIONAL_DELTA_EPSILON;
}

function classifyWheelGestureMode(
  e: WheelEvent,
  isSafariWithGestures: boolean,
  isOrbitMode: boolean,
  inputMode: InputSettings["mode"],
): WheelGestureMode {
  if (e.shiftKey) return inputMode === "trackpad" ? "pinchZoom" : "orbit";
  if (e.ctrlKey && !isSafariWithGestures) return "pinchZoom";
  if (inputMode === "trackpad") return isOrbitMode ? "orbit" : "pan";
  if (inputMode === "mouse") return isLikelyHorizontalMouseWheel(e) ? "ignore" : "wheelZoom";
  if (isLikelyVerticalMouseWheel(e)) return "wheelZoom";
  if (isLikelyHorizontalMouseWheel(e)) return "ignore";
  // When the camera is locked to a POI the user expects two-finger swipe to
  // orbit around the selected point rather than pan away from it.
  return isOrbitMode ? "orbit" : "pan";
}

/**
 * Reads each wheel event as one gesture's: the first event after a pause
 * decides whether the gesture pans, orbits, zooms or is ignored, and the rest
 * of it follows, so a swipe that picks up a modifier or a stray delta partway
 * keeps its meaning. The globe and a panorama's look input read wheels alike.
 */
export function createWheelGestureClassifier(options: {
  isSafariWithGestures: boolean;
  isOrbitMode?: () => boolean;
  mode: () => InputSettings["mode"];
}): (e: WheelEvent) => WheelGestureMode {
  let session: WheelGestureSession | null = null;
  return (e) => {
    const now = performance.now();
    if (!session || now - session.lastEventTimeMs > WHEEL_GESTURE_IDLE_MS) {
      session = {
        mode: classifyWheelGestureMode(e, options.isSafariWithGestures, options.isOrbitMode?.() ?? false, options.mode()),
        lastEventTimeMs: now,
      };
    } else {
      session.lastEventTimeMs = now;
    }
    return session.mode;
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
  camera: CameraInputTarget,
  options: { isSafariWithGestures: boolean; isOrbitMode?: () => boolean; getSettings?: () => InputSettings },
): () => void {
  const rates = () => options.getSettings?.().rates ?? DEFAULT_INPUT_RATES;
  const classify = createWheelGestureClassifier({
    isSafariWithGestures: options.isSafariWithGestures,
    isOrbitMode: options.isOrbitMode,
    mode: () => options.getSettings?.().mode ?? "auto",
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
