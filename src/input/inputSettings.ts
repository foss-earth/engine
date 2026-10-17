import type { InputRates } from "./inputRates.js";

export type InputModePreference = "auto" | "mouse" | "trackpad" | "touch";

export interface MovementSensitivity {
  pan: number;
  orbit: number;
  zoom: number;
}

export interface InputSensitivitySettings {
  mouse: MovementSensitivity;
  trackpad: MovementSensitivity;
  touch: MovementSensitivity;
}

export { DEFAULT_INPUT_RATES, type InputRates } from "./inputRates.js";

/**
 * Two fingers that twist in place, as in Google Maps: the pair holds the
 * ground between them, its twist turns the view about that ground, its
 * spread zooms toward it, and moving it drags that ground along, until it
 * lifts. A two-finger swipe still turns and tilts the view about the compass.
 */
export interface TouchTwistSettings {
  /** `input.touch.twistTurn`. */
  enabled: boolean;
  /** `input.touch.twistThreshold`: how far, degrees, a pair twists in place before it holds the ground. */
  thresholdDeg: number;
}

export const TOUCH_TWIST_ID = "input.touch.twistTurn";
export const TOUCH_TWIST_THRESHOLD_ID = "input.touch.twistThreshold";
export const DEFAULT_TOUCH_TWIST: TouchTwistSettings = Object.freeze({ enabled: true, thresholdDeg: 15 });
export const TOUCH_TWIST_THRESHOLD_BOUNDS = Object.freeze({ min: 3, max: 45 });

export interface InputSettings {
  mode: InputModePreference;
  sensitivity: InputSensitivitySettings;
  /** When true, drag-pan rotates the globe so the grabbed surface point follows the cursor. */
  globeAnchorRotation: boolean;
  /** The devices' rates; DEFAULT_INPUT_RATES when omitted. */
  rates?: InputRates;
  /** A two-finger twist that holds the ground; DEFAULT_TOUCH_TWIST (off) when omitted. */
  touchTwist?: TouchTwistSettings;
}

export const DEFAULT_INPUT_SENSITIVITY: InputSensitivitySettings = {
  mouse: { pan: 1, orbit: 1, zoom: 1 },
  trackpad: { pan: 1, orbit: 1, zoom: 1 },
  touch: { pan: 1, orbit: 1, zoom: 1 },
};

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  mode: "auto",
  sensitivity: DEFAULT_INPUT_SENSITIVITY,
  /** Google Earth-style grab pan — surface point under the cursor stays fixed while dragging. */
  globeAnchorRotation: true,
};

/** @deprecated Keys before the settings registry; migrated into `input.*` and left for rollback. */
export const GLOBE_ANCHOR_ROTATION_STORAGE_KEY = "foss-earth.globeAnchorRotation";
/** @deprecated See GLOBE_ANCHOR_ROTATION_STORAGE_KEY. */
export const INPUT_MODE_STORAGE_KEY = "foss-earth.inputMode";
/** @deprecated See GLOBE_ANCHOR_ROTATION_STORAGE_KEY. */
export const INPUT_SENSITIVITY_STORAGE_KEY = "foss-earth.inputSensitivity";
/** @deprecated See GLOBE_ANCHOR_ROTATION_STORAGE_KEY. */
export const INPUT_SENSITIVITY_VERSION_KEY = "foss-earth.inputSensitivityVersion";
export const INPUT_SENSITIVITY_VERSION = "1";

export type HudInputMode = Exclude<InputModePreference, "auto">;

export function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.1, Math.min(10, value));
}

export function normalizeSensitivitySettings(
  settings: Partial<InputSensitivitySettings>,
): InputSensitivitySettings {
  return {
    mouse: {
      pan: clampSensitivity(settings.mouse?.pan ?? DEFAULT_INPUT_SENSITIVITY.mouse.pan),
      orbit: clampSensitivity(settings.mouse?.orbit ?? DEFAULT_INPUT_SENSITIVITY.mouse.orbit),
      zoom: clampSensitivity(settings.mouse?.zoom ?? DEFAULT_INPUT_SENSITIVITY.mouse.zoom),
    },
    trackpad: {
      pan: clampSensitivity(settings.trackpad?.pan ?? DEFAULT_INPUT_SENSITIVITY.trackpad.pan),
      orbit: clampSensitivity(settings.trackpad?.orbit ?? DEFAULT_INPUT_SENSITIVITY.trackpad.orbit),
      zoom: clampSensitivity(settings.trackpad?.zoom ?? DEFAULT_INPUT_SENSITIVITY.trackpad.zoom),
    },
    touch: {
      pan: clampSensitivity(settings.touch?.pan ?? DEFAULT_INPUT_SENSITIVITY.touch.pan),
      orbit: clampSensitivity(settings.touch?.orbit ?? DEFAULT_INPUT_SENSITIVITY.touch.orbit),
      zoom: clampSensitivity(settings.touch?.zoom ?? DEFAULT_INPUT_SENSITIVITY.touch.zoom),
    },
  };
}