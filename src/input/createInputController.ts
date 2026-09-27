import type { CameraInputTarget } from "./inertialCameraController";
import { attachWheelController } from "./wheelController";
import { attachSafariGestures, isSafariGestureSupported } from "./safariGestures";
import { attachTouchController } from "./touchController";
import { attachMouseController } from "./mouseController";
import {
  DEFAULT_INPUT_RATES,
  DEFAULT_INPUT_SETTINGS,
  loadGlobeAnchorRotationPreference,
  normalizeSensitivitySettings,
  saveGlobeAnchorRotationPreference,
  type InputModePreference,
  type InputRates,
  type InputSensitivitySettings,
  type InputSettings,
} from "./inputSettings";

export interface InputController {
  setMode(mode: InputModePreference): void;
  setSensitivity(sensitivity: Partial<InputSensitivitySettings>): void;
  setGlobeAnchorRotation(enabled: boolean): void;
  getGlobeAnchorRotation(): boolean;
  /** The devices' rates before sensitivity: `input.mouse.*`, `input.wheel.*` and `input.touch.*`. */
  setRates(rates: Partial<InputRates>): void;
  getRates(): InputRates;
  /**
   * While suspended, gestures reach no camera: a navigation lease owns input.
   * Suspending ends an anchor drag and stops inertia.
   */
  setSuspended(suspended: boolean): void;
  destroy(): void;
}

/**
 * Create and attach all input controllers to the canvas.
 *
 * Wires:
 *  - Trackpad-aware wheel handler (pan / orbit / zoom)
 *  - Safari GestureEvent handler (rotation + pinch on macOS Safari)
 *  - Two-finger touch handler (orbit + pinch on touch devices)
 *
 * Also registers document-level wheel/gesture prevention to stop the
 * browser from scrolling or zooming the page during globe interaction.
 *
 * @returns An `InputController` whose `destroy()` removes every listener.
 */
export function createInputController(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget,
  options: { isOrbitMode?: () => boolean } = {},
): InputController {
  const hasSafariGestures = isSafariGestureSupported();
  const settings: InputSettings = {
    mode: DEFAULT_INPUT_SETTINGS.mode,
    sensitivity: normalizeSensitivitySettings(DEFAULT_INPUT_SETTINGS.sensitivity),
    globeAnchorRotation: loadGlobeAnchorRotationPreference(),
    rates: { ...DEFAULT_INPUT_RATES },
  };

  // ── Document-level prevention ────────────────────────────────────
  // Prevent the page from scrolling or zooming while the user interacts
  // with the globe canvas. Scope to events targeting the canvas so wheel
  // gestures over HTML overlays (menus, panels) continue to scroll normally.
  const isCanvasEvent = (e: Event): boolean => {
    const t = e.target as Node | null;
    return t === canvas || (t != null && canvas.contains(t));
  };
  const docWheelHandler = (e: Event): void => { if (isCanvasEvent(e)) e.preventDefault(); };
  document.addEventListener("wheel", docWheelHandler, { passive: false });

  // Every controller moves the camera through this gate, so suspension needs
  // no change to them: their pointer bookkeeping continues, their effect stops.
  let suspended = false;
  const target: CameraInputTarget = {
    panBy: (dx, dy, height) => { if (!suspended) camera.panBy(dx, dy, height); },
    orbitBy: (pitch, heading) => { if (!suspended) camera.orbitBy(pitch, heading); },
    zoomBy: factor => { if (!suspended) camera.zoomBy(factor); },
    cancelInertial: () => camera.cancelInertial?.(),
    cancel: () => camera.cancel?.(),
    beginAnchorPan: pick => (!suspended && camera.beginAnchorPan ? camera.beginAnchorPan(pick) : false),
    panAnchorTo: (pick, sensitivity) => (!suspended && camera.panAnchorTo ? camera.panAnchorTo(pick, sensitivity) : false),
    getAnchorPanScreenError: pick => (!suspended && camera.getAnchorPanScreenError ? camera.getAnchorPanScreenError(pick) : null),
    endAnchorPan: () => camera.endAnchorPan?.(),
  };

  const docGestureCleanup: Array<() => void> = [];
  if (hasSafariGestures) {
    for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
      const handler = (e: Event): void => { if (isCanvasEvent(e)) e.preventDefault(); };
      document.addEventListener(type, handler, { passive: false } as AddEventListenerOptions);
      docGestureCleanup.push(() => document.removeEventListener(type, handler));
    }
  }

  // ── Canvas-level handlers ────────────────────────────────────────
  const detachWheel = attachWheelController(canvas, target, { isSafariWithGestures: hasSafariGestures, isOrbitMode: options.isOrbitMode, getSettings: () => settings });
  const detachSafari = hasSafariGestures ? attachSafariGestures(canvas, target, { getSettings: () => settings }) : (): void => undefined;
  const detachTouch = attachTouchController(canvas, target, { isOrbitMode: options.isOrbitMode, getSettings: () => settings });
  const detachMouse = attachMouseController(canvas, target, { isOrbitMode: options.isOrbitMode, getSettings: () => settings });

  return {
    setMode(mode: InputModePreference): void {
      settings.mode = mode;
    },
    setSensitivity(sensitivity: Partial<InputSensitivitySettings>): void {
      settings.sensitivity = normalizeSensitivitySettings({
        mouse: { ...settings.sensitivity.mouse, ...sensitivity.mouse },
        trackpad: { ...settings.sensitivity.trackpad, ...sensitivity.trackpad },
        touch: { ...settings.sensitivity.touch, ...sensitivity.touch },
      });
    },
    setGlobeAnchorRotation(enabled: boolean): void {
      settings.globeAnchorRotation = enabled;
      saveGlobeAnchorRotationPreference(enabled);
    },
    getGlobeAnchorRotation(): boolean {
      return settings.globeAnchorRotation;
    },
    setRates(rates: Partial<InputRates>): void {
      settings.rates = { ...(settings.rates ?? DEFAULT_INPUT_RATES), ...rates };
    },
    getRates(): InputRates {
      return { ...(settings.rates ?? DEFAULT_INPUT_RATES) };
    },
    setSuspended(next: boolean): void {
      if (suspended === next) return;
      suspended = next;
      if (suspended) {
        camera.endAnchorPan?.();
        camera.cancel?.();
      }
    },
    destroy(): void {
      detachWheel();
      detachSafari();
      detachTouch();
      detachMouse();
      document.removeEventListener("wheel", docWheelHandler);
      for (const cleanup of docGestureCleanup) cleanup();
    },
  };
}
