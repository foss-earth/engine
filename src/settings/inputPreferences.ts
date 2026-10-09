import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { normalizeSensitivitySettings, type HudInputMode, type InputSensitivitySettings } from "../input/inputSettings.js";

const MOVEMENTS = ["pan", "orbit", "zoom"] as const;
const DEVICES = ["mouse", "trackpad", "touch"] as const;

function isHudInputMode(value: unknown): value is HudInputMode {
  return value === "mouse" || value === "trackpad" || value === "touch";
}

/** The saved `input.mode`, when this device has it; otherwise trackpad or the first it has. */
export function loadInputModePreference(settings: SettingsRegistry, availableModes: ReadonlySet<HudInputMode>): HudInputMode {
  const saved = settings.get("input.mode");
  if (isHudInputMode(saved) && availableModes.has(saved)) return saved;
  return availableModes.has("trackpad") ? "trackpad" : availableModes.values().next().value ?? "mouse";
}

export function saveInputModePreference(settings: SettingsRegistry, mode: HudInputMode): void {
  settings.set("input.mode", mode);
}

/** The nine `input.sensitivity.<device>.<movement>` parameters. */
export function loadInputSensitivityPreference(settings: SettingsRegistry): InputSensitivitySettings {
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

export function saveInputSensitivityPreference(registry: SettingsRegistry, settings: InputSensitivitySettings): void {
  const normalized = normalizeSensitivitySettings(settings);
  registry.setMany(Object.fromEntries(DEVICES.flatMap(device => MOVEMENTS.map(movement => [
    `input.sensitivity.${device}.${movement}`, normalized[device][movement],
  ]))));
}

export function loadGlobeAnchorRotationPreference(settings: SettingsRegistry): boolean {
  return settings.get("input.globeAnchorRotation") !== false;
}

export function saveGlobeAnchorRotationPreference(settings: SettingsRegistry, enabled: boolean): void {
  settings.set("input.globeAnchorRotation", enabled);
}

