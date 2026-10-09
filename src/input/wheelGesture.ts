import type { InputSettings } from "./inputSettings.js";
export interface WheelGestureEvent { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; shiftKey: boolean }

export type WheelGestureMode = "pan" | "pinchZoom" | "wheelZoom" | "orbit" | "ignore";

/** The pause, ms, that ends one wheel gesture; a trackpad swipe's momentum after the fingers lift is still the swipe. */
export const WHEEL_GESTURE_IDLE_MS = 180;
const PIXEL_DELTA_MODE = 0;
const FRACTIONAL_DELTA_EPSILON = 0.001;

interface WheelGestureSession {
  mode: WheelGestureMode;
  lastEventTimeMs: number;
}

function hasFractionalDelta(value: number): boolean {
  return Math.abs(value - Math.round(value)) > FRACTIONAL_DELTA_EPSILON;
}

function isLikelyVerticalMouseWheel(e: WheelGestureEvent): boolean {
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

function isLikelyHorizontalMouseWheel(e: WheelGestureEvent): boolean {
  const absDeltaX = Math.abs(e.deltaX);
  const absDeltaY = Math.abs(e.deltaY);
  if (e.deltaMode !== PIXEL_DELTA_MODE) {
    return absDeltaX > FRACTIONAL_DELTA_EPSILON && absDeltaY <= FRACTIONAL_DELTA_EPSILON;
  }

  const hasFineDelta = hasFractionalDelta(e.deltaX) || hasFractionalDelta(e.deltaY);
  return !hasFineDelta && absDeltaX > FRACTIONAL_DELTA_EPSILON && absDeltaY <= FRACTIONAL_DELTA_EPSILON;
}

function classifyWheelGestureMode(
  e: WheelGestureEvent,
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
  nowMs(): number;
  isSafariWithGestures: boolean;
  isOrbitMode?: () => boolean;
  mode: () => InputSettings["mode"];
  /**
   * When the last wheel event came before this classifier began reading
   * them (`options.nowMs()`). The gesture it belongs to, if it goes on,
   * was another reader's, and is ignored to its end.
   */
  precedingWheelMs?: number;
}): (e: WheelGestureEvent) => WheelGestureMode {
  let session: WheelGestureSession | null = options.precedingWheelMs === undefined ? null : { mode: "ignore", lastEventTimeMs: options.precedingWheelMs };
  return (e) => {
    const now = options.nowMs();
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

