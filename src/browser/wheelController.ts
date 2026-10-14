import { orbitWith, zoomWith, type CameraInputTarget } from "../input/inertialCameraController.js";
import { DEFAULT_INPUT_RATES, type InputSettings } from "../input/inputSettings.js";
import type { AnchorFamily, NavigationAnchor } from "../input/navigationAnchors.js";
import { WHEEL_GESTURE_IDLE_MS, createWheelGestureReader } from "../input/wheelGesture.js";
import { worldViewportHeight } from "./worldViewport.js";
export interface WheelWatchPorts { window: Pick<Window, "addEventListener" | "removeEventListener">; nowMs(): number }
const FRACTIONAL_DELTA_EPSILON = 0.001;

/** Where a wheel event's pointer is: a wheel event always has one, at zero as anywhere. */
function clientOf(e: Pick<WheelEvent, "clientX" | "clientY">): { x: number; y: number } | null {
  return Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ? { x: e.clientX, y: e.clientY } : null;
}

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
 *   - Shift + wheel / swipe                     → orbit heading/pitch (zoom in trackpad mode)
 *   - Ctrl + wheel (non-Safari, i.e. pinch)     → zoom
 *   - Mouse wheel (no modifier)                 → zoom
 *
 * A gesture zooms and orbits about the anchors its first event acquires
 * (`input.mouse.*` for a mouse wheel, `input.trackpad.*` for a pinch, and
 * either for wheel orbit, by input mode). A zoom about the point under the
 * pointer picks again when an event comes from somewhere else; hovering
 * alone does nothing.
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
  const read = createWheelGestureReader({
    nowMs: options.nowMs,
    isSafariWithGestures: options.isSafariWithGestures,
    isOrbitMode: options.isOrbitMode,
    mode: () => options.getSettings?.().mode ?? "auto",
    precedingWheelMs: options.precedingWheelMs,
  });
  // The gesture's anchors: zoom's with where it was picked, orbit's for the whole gesture.
  let zoomAnchor: { anchor: NavigationAnchor | null; x: number; y: number } | null = null;
  let orbitAnchor: { anchor: NavigationAnchor | null } | null = null;

  /** The point a wheel event's gesture zooms about, picked again where the pointer has moved. */
  function zoomAnchorFor(family: AnchorFamily, e: WheelEvent): NavigationAnchor | null {
    if (!camera.acquireAnchors) return null;
    const moved = zoomAnchor !== null && (zoomAnchor.x !== e.clientX || zoomAnchor.y !== e.clientY);
    if (zoomAnchor && !(moved && zoomAnchor.anchor?.requested === "pointer")) return zoomAnchor.anchor;
    // What the gesture began with stays its choice.
    const prefer = zoomAnchor?.anchor ? { zoom: zoomAnchor.anchor.requested } : undefined;
    const anchor = camera.acquireAnchors({ family, operations: ["zoom"], client: clientOf(e), canvas, ...(prefer ? { prefer } : {}) }).zoom ?? null;
    zoomAnchor = { anchor, x: e.clientX, y: e.clientY };
    return anchor;
  }

  function orbitAnchorFor(family: AnchorFamily, e: WheelEvent): NavigationAnchor | null {
    if (!camera.acquireAnchors) return null;
    orbitAnchor ??= { anchor: camera.acquireAnchors({ family, operations: ["orbit"], client: clientOf(e), canvas }).orbit ?? null };
    return orbitAnchor.anchor;
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Prevent Babylon's own wheel/zoom handler from firing on the same event.
    e.stopImmediatePropagation();
    const { mode, begins } = read(e);
    if (begins) {
      zoomAnchor = null;
      orbitAnchor = null;
    }

    // ── Trackpad two-finger swipe = pan ──────────────────────────────────
    if (mode === "pan") {
      const sensitivity = options.getSettings?.().sensitivity.trackpad.pan ?? 1;
      const rate = rates().trackpadPanRate * sensitivity;
      camera.panBy(e.deltaX * rate, e.deltaY * rate, worldViewportHeight(canvas));
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
      // In mouse mode a wheel that orbits is a mouse's; otherwise a trackpad's.
      orbitWith(camera, pitchDeltaDeg, headingDeltaDeg, orbitAnchorFor(settings?.mode === "mouse" ? "mouse" : "trackpad", e));
      return;
    }

    if (mode === "ignore") {
      return;
    }

    // ── Ctrl+wheel = macOS trackpad pinch-to-zoom (non-Safari browsers) ──
    if (mode === "pinchZoom") {
      const sensitivity = options.getSettings?.().sensitivity.trackpad.zoom ?? 1;
      const factor = 1 + e.deltaY * rates().trackpadPinchZoomPerPx * sensitivity;
      // A pinch is a trackpad's, Ctrl+wheel in mouse mode too.
      zoomWith(camera, factor, zoomAnchorFor("trackpad", e));
      return;
    }

    // ── Mouse wheel = coarser zoom ───────────────────────────────────────
    // Scroll down (deltaY>0) = zoom out; scroll up (deltaY<0) = zoom in.
    if (Math.abs(e.deltaY) <= FRACTIONAL_DELTA_EPSILON) return;
    const sensitivity = options.getSettings?.().sensitivity.mouse.zoom ?? 1;
    // The notch's share of the distance, as a power of 1.08 out and of 0.92 in.
    const exponent = Math.log1p(Math.max(0, rates().wheelZoomPerNotch)) / Math.log(1.08);
    const factor = Math.pow(e.deltaY > 0 ? 1.08 : 0.92, sensitivity * exponent);
    zoomWith(camera, factor, zoomAnchorFor("mouse", e));
  }

  canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });

  return () => {
    canvas.removeEventListener("wheel", onWheel, { capture: true });
  };
}
