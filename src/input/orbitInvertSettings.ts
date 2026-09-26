import { getAppSettings } from "../settings/appSettings";

export interface OrbitInvertSettings {
  invertYaw: boolean;
  invertPitch: boolean;
  recenterMode: "hold" | "recenter";
}

export const DEFAULT_ORBIT_INVERT_SETTINGS: OrbitInvertSettings = {
  invertYaw: false,
  invertPitch: false,
  recenterMode: "hold",
};

/**
 * Which way a dragged or nudged orbit turns, and whether it holds where it was
 * left or springs back: the `input.orbit.*` parameters. They were saved under
 * `osfs.orbit-invert` before this module moved out of the flight simulator;
 * the registry migrates that key once.
 */
export const ORBIT_INVERT_PARAMETER_IDS = {
  invertYaw: "input.orbit.invertYaw",
  invertPitch: "input.orbit.invertPitch",
  recenterMode: "input.orbit.recenterMode",
} as const;

/** Shared with gamepad orbit; reads the registry's cached values, cheap on every input frame. */
export function getOrbitInvertSettings(): Readonly<OrbitInvertSettings> {
  return loadOrbitInvertSettings();
}

export function normalizeOrbitInvertSettings(
  partial: Partial<OrbitInvertSettings> | null | undefined,
): OrbitInvertSettings {
  return {
    invertYaw: Boolean(partial?.invertYaw),
    invertPitch: Boolean(partial?.invertPitch),
    recenterMode: partial?.recenterMode === "recenter" ? "recenter" : "hold",
  };
}

export function loadOrbitInvertSettings(): OrbitInvertSettings {
  const settings = getAppSettings();
  return normalizeOrbitInvertSettings({
    invertYaw: settings.get(ORBIT_INVERT_PARAMETER_IDS.invertYaw) === true,
    invertPitch: settings.get(ORBIT_INVERT_PARAMETER_IDS.invertPitch) === true,
    recenterMode: settings.get(ORBIT_INVERT_PARAMETER_IDS.recenterMode) === "recenter" ? "recenter" : "hold",
  });
}

export function saveOrbitInvertSettings(settings: OrbitInvertSettings): void {
  const next = normalizeOrbitInvertSettings(settings);
  getAppSettings().setMany({
    [ORBIT_INVERT_PARAMETER_IDS.invertYaw]: next.invertYaw,
    [ORBIT_INVERT_PARAMETER_IDS.invertPitch]: next.invertPitch,
    [ORBIT_INVERT_PARAMETER_IDS.recenterMode]: next.recenterMode,
  });
}
