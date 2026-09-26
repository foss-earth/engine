import { getAppSettings } from "../settings/appSettings";
import type { InputRates } from "./inputRates";

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

export { DEFAULT_INPUT_RATES, type InputRates } from "./inputRates";

export interface InputSettings {
  mode: InputModePreference;
  sensitivity: InputSensitivitySettings;
  /** When true, drag-pan rotates the globe so the grabbed surface point follows the cursor. */
  globeAnchorRotation: boolean;
  /** The devices' rates; DEFAULT_INPUT_RATES when omitted. */
  rates?: InputRates;
}

export const DEFAULT_INPUT_SENSITIVITY: InputSensitivitySettings = {
  mouse: { pan: 1, orbit: 1, zoom: 1 },
  trackpad: { pan: 1, orbit: 1, zoom: 1 },
  touch: { pan: 1, orbit: 1, zoom: 1 },
};

export const MOVEMENT_SENSITIVITY_BASE = 0.1;

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

const MOVEMENTS = ["pan", "orbit", "zoom"] as const;
const DEVICES = ["mouse", "trackpad", "touch"] as const;

function isHudInputMode(value: unknown): value is HudInputMode {
  return value === "mouse" || value === "trackpad" || value === "touch";
}

/** The saved `input.mode`, when this device has it; otherwise trackpad or the first it has. */
export function loadInputModePreference(availableModes: ReadonlySet<HudInputMode>): HudInputMode {
  const saved = getAppSettings().get("input.mode");
  if (isHudInputMode(saved) && availableModes.has(saved)) return saved;
  return availableModes.has("trackpad") ? "trackpad" : availableModes.values().next().value ?? "mouse";
}

export function saveInputModePreference(mode: HudInputMode): void {
  getAppSettings().set("input.mode", mode);
}

/** The nine `input.sensitivity.<device>.<movement>` parameters. */
export function loadInputSensitivityPreference(): InputSensitivitySettings {
  const settings = getAppSettings();
  const read = (device: typeof DEVICES[number], movement: typeof MOVEMENTS[number]): number => {
    const value = settings.get(`input.sensitivity.${device}.${movement}`);
    return typeof value === "number" ? value : 1;
  };
  return {
    mouse: { pan: read("mouse", "pan"), orbit: read("mouse", "orbit"), zoom: read("mouse", "zoom") },
    trackpad: { pan: read("trackpad", "pan"), orbit: read("trackpad", "orbit"), zoom: read("trackpad", "zoom") },
    touch: { pan: read("touch", "pan"), orbit: read("touch", "orbit"), zoom: read("touch", "zoom") },
  };
}

export function saveInputSensitivityPreference(settings: InputSensitivitySettings): void {
  const normalized = normalizeSensitivitySettings(settings);
  getAppSettings().setMany(Object.fromEntries(DEVICES.flatMap(device => MOVEMENTS.map(movement => [
    `input.sensitivity.${device}.${movement}`, normalized[device][movement],
  ]))));
}

export function loadGlobeAnchorRotationPreference(): boolean {
  return getAppSettings().get("input.globeAnchorRotation") !== false;
}

export function saveGlobeAnchorRotationPreference(enabled: boolean): void {
  getAppSettings().set("input.globeAnchorRotation", enabled);
}

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