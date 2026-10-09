import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { normalizeOrbitInvertSettings, ORBIT_INVERT_PARAMETER_IDS, type OrbitInvertSettings } from "../input/orbitInvertSettings.js";

/** Shared with gamepad orbit; reads the registry's cached values, cheap on every input frame. */
export function getOrbitInvertSettings(settings: SettingsRegistry): Readonly<OrbitInvertSettings> {
  return loadOrbitInvertSettings(settings);
}

export function loadOrbitInvertSettings(settings: SettingsRegistry): OrbitInvertSettings {
  return normalizeOrbitInvertSettings({
    invertYaw: settings.get(ORBIT_INVERT_PARAMETER_IDS.invertYaw) === true,
    invertPitch: settings.get(ORBIT_INVERT_PARAMETER_IDS.invertPitch) === true,
    recenterMode: settings.get(ORBIT_INVERT_PARAMETER_IDS.recenterMode) === "recenter" ? "recenter" : "hold",
  });
}

export function saveOrbitInvertSettings(registry: SettingsRegistry, settings: OrbitInvertSettings): void {
  const next = normalizeOrbitInvertSettings(settings);
  registry.setMany({
    [ORBIT_INVERT_PARAMETER_IDS.invertYaw]: next.invertYaw,
    [ORBIT_INVERT_PARAMETER_IDS.invertPitch]: next.invertPitch,
    [ORBIT_INVERT_PARAMETER_IDS.recenterMode]: next.recenterMode,
  });
}
