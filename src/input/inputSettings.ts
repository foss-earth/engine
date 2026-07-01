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

export interface InputSettings {
  mode: InputModePreference;
  sensitivity: InputSensitivitySettings;
  /** When true, drag-pan rotates the globe so the grabbed surface point follows the cursor. */
  globeAnchorRotation: boolean;
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

export const GLOBE_ANCHOR_ROTATION_STORAGE_KEY = "foss-earth.globeAnchorRotation";

export const INPUT_MODE_STORAGE_KEY = "foss-earth.inputMode";
export const INPUT_SENSITIVITY_STORAGE_KEY = "foss-earth.inputSensitivity";
export const INPUT_SENSITIVITY_VERSION_KEY = "foss-earth.inputSensitivityVersion";
export const INPUT_SENSITIVITY_VERSION = "1";

/** Legacy keys written by an older Fundfolio embed — read once for migration. */
const LEGACY_INPUT_MODE_STORAGE_KEY = "moir-park.map-input-mode";
const LEGACY_INPUT_SENSITIVITY_STORAGE_KEY = "moir-park.map-input-sensitivity";
const LEGACY_INPUT_SENSITIVITY_VERSION_KEY = "moir-park.map-input-sensitivity-version";
const LEGACY_INPUT_SENSITIVITY_VERSION = "6";

export type HudInputMode = Exclude<InputModePreference, "auto">;

function isHudInputMode(value: string | null): value is HudInputMode {
  return value === "mouse" || value === "trackpad" || value === "touch";
}

export function loadInputModePreference(availableModes: ReadonlySet<HudInputMode>): HudInputMode {
  try {
    const saved = window.localStorage.getItem(INPUT_MODE_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_INPUT_MODE_STORAGE_KEY);
    if (isHudInputMode(saved) && availableModes.has(saved)) {
      return saved;
    }
  } catch {
    // Ignore restricted storage.
  }

  return availableModes.has("trackpad") ? "trackpad" : availableModes.values().next().value ?? "mouse";
}

export function saveInputModePreference(mode: HudInputMode): void {
  try {
    window.localStorage.setItem(INPUT_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore restricted storage.
  }
}

export function loadInputSensitivityPreference(): InputSensitivitySettings {
  try {
    const raw = window.localStorage.getItem(INPUT_SENSITIVITY_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_INPUT_SENSITIVITY_STORAGE_KEY);
    const savedVersion = window.localStorage.getItem(INPUT_SENSITIVITY_VERSION_KEY)
      ?? window.localStorage.getItem(LEGACY_INPUT_SENSITIVITY_VERSION_KEY);
    const next = normalizeSensitivitySettings(raw ? JSON.parse(raw) as Partial<InputSensitivitySettings> : {});
    if (savedVersion !== INPUT_SENSITIVITY_VERSION && savedVersion !== LEGACY_INPUT_SENSITIVITY_VERSION) {
      next.mouse.zoom = DEFAULT_INPUT_SENSITIVITY.mouse.zoom;
      next.trackpad.zoom = DEFAULT_INPUT_SENSITIVITY.trackpad.zoom;
      next.touch.pan = DEFAULT_INPUT_SENSITIVITY.touch.pan;
      next.touch.orbit = DEFAULT_INPUT_SENSITIVITY.touch.orbit;
      next.touch.zoom = DEFAULT_INPUT_SENSITIVITY.touch.zoom;
      saveInputSensitivityPreference(next);
    }
    return next;
  } catch {
    return normalizeSensitivitySettings({});
  }
}

export function saveInputSensitivityPreference(settings: InputSensitivitySettings): void {
  try {
    window.localStorage.setItem(INPUT_SENSITIVITY_STORAGE_KEY, JSON.stringify(settings));
    window.localStorage.setItem(INPUT_SENSITIVITY_VERSION_KEY, INPUT_SENSITIVITY_VERSION);
  } catch {
    // Ignore restricted storage.
  }
}

export function loadGlobeAnchorRotationPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(GLOBE_ANCHOR_ROTATION_STORAGE_KEY);
    if (stored === null) {
      return DEFAULT_INPUT_SETTINGS.globeAnchorRotation;
    }
    return stored === "true";
  } catch {
    return DEFAULT_INPUT_SETTINGS.globeAnchorRotation;
  }
}

export function saveGlobeAnchorRotationPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(GLOBE_ANCHOR_ROTATION_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore private-mode or restricted-storage failures.
  }
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