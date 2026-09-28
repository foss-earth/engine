import type { CameraInputTarget } from "./inertialCameraController";
import { attachWheelController, watchWheelGestures } from "./wheelController";
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
   * While suspended, the globe's controllers are detached: a navigation lease
   * owns input, and every event reaches its listeners untouched. Suspending
   * ends an anchor drag and stops inertia; resuming attaches them afresh, so
   * a gesture that spanned the handover starts over, and a wheel gesture
   * under way, such as the momentum of a swipe the lease read, is ignored
   * to its end.
   */
  setSuspended(suspended: boolean): void;
  /** The input mode wheel and gesture events are read with. */
  getMode(): InputModePreference;
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

  let suspended = false;
  // Seen while suspended too, so that resuming knows whether a wheel gesture is under way.
  const wheels = watchWheelGestures(canvas);

  const docGestureCleanup: Array<() => void> = [];
  if (hasSafariGestures) {
    for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
      const handler = (e: Event): void => { if (isCanvasEvent(e)) e.preventDefault(); };
      document.addEventListener(type, handler, { passive: false } as AddEventListenerOptions);
      docGestureCleanup.push(() => document.removeEventListener(type, handler));
    }
  }

  // ── Canvas-level handlers ────────────────────────────────────────
  // They run in the capture phase and stop the events they use, so while a
  // lease owns input they are not attached at all.
  const attachControllers = (): (() => void) => {
    const detachers = [
      attachWheelController(canvas, camera, { isSafariWithGestures: hasSafariGestures, isOrbitMode: options.isOrbitMode, getSettings: () => settings, precedingWheelMs: wheels.lastEventMs() }),
      hasSafariGestures ? attachSafariGestures(canvas, camera, { getSettings: () => settings }) : (): void => undefined,
      attachTouchController(canvas, camera, { isOrbitMode: options.isOrbitMode, getSettings: () => settings }),
      attachMouseController(canvas, camera, { isOrbitMode: options.isOrbitMode, getSettings: () => settings }),
    ];
    return () => { for (const detach of detachers) detach(); };
  };
  let detachControllers: (() => void) | null = attachControllers();

  return {
    setMode(mode: InputModePreference): void {
      settings.mode = mode;
    },
    getMode: () => settings.mode,
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
        detachControllers?.();
        detachControllers = null;
      } else {
        detachControllers = attachControllers();
      }
    },
    destroy(): void {
      detachControllers?.();
      detachControllers = null;
      document.removeEventListener("wheel", docWheelHandler);
      wheels.dispose();
      for (const cleanup of docGestureCleanup) cleanup();
    },
  };
}
