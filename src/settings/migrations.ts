import type { LegacyMigration, ParameterValue, SettingsStorage } from "@foss-earth/ui/settings";
import { VISUALIZATION_MIGRATIONS } from "../visualization/migrations.js";
import { DEFAULT_RASTER_BASE_MAP_ID } from "../map/rasterBaseMaps.js";
function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The legacy map detail record: one policy per source; the catalogue keeps one per kind. */
function migrateMapDetail(raw: string): Record<string, ParameterValue> | null {
  const parsed = parseJson(raw);
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.policies)) return null;
  const values: Record<string, ParameterValue> = {};
  const google = parsed.policies.google;
  if (isObject(google) && finite(google.finestErrorPx) && finite(google.coarsestErrorPx)) {
    values["map.detail.google.range"] = { min: google.finestErrorPx, max: google.coarsestErrorPx };
    const fallback = google.defaultValue;
    if (finite(fallback)) values["map.detail.google.default"] = fallback;
    else if (isObject(fallback) && (fallback.policy === "device-hints" || fallback.policy === "renderer-default")) {
      values["map.detail.google.default"] = fallback.policy;
    }
  }
  // The default basemap's policy if it was saved, otherwise the first 2D one.
  const rasterKeys = Object.keys(parsed.policies).filter(key => key.startsWith("raster:"));
  const rasterKey = rasterKeys.includes(`raster:${DEFAULT_RASTER_BASE_MAP_ID}`) ? `raster:${DEFAULT_RASTER_BASE_MAP_ID}` : rasterKeys[0];
  const raster = rasterKey ? parsed.policies[rasterKey] : null;
  if (isObject(raster) && finite(raster.coarseOffset) && finite(raster.fineOffset)) {
    values["map.detail.imagery.range"] = { min: raster.coarseOffset, max: raster.fineOffset };
    values["map.detail.imagery.default"] = finite(raster.defaultValue) ? raster.defaultValue : "normal";
  }
  return values;
}

function migrateSensitivity(raw: string, version: string | null): Record<string, ParameterValue> | null {
  const parsed = parseJson(raw);
  if (!isObject(parsed)) return null;
  const values: Record<string, ParameterValue> = {};
  for (const device of ["mouse", "trackpad", "touch"] as const) {
    const movements = parsed[device];
    if (!isObject(movements)) continue;
    for (const movement of ["pan", "orbit", "zoom"] as const) {
      const value = movements[movement];
      if (!finite(value)) continue;
      // An older record's zoom and touch rates were tuned for other controllers; they reset.
      if (version !== "1" && version !== "6" && (movement === "zoom" || device === "touch")) continue;
      values[`input.sensitivity.${device}.${movement}`] = Math.max(0.1, Math.min(10, value));
    }
  }
  return values;
}

function booleanString(id: string) {
  return (raw: string): Record<string, ParameterValue> | null => (raw === "true" || raw === "false" ? { [id]: raw === "true" } : null);
}

export function createEngineMigrations(storage: Pick<SettingsStorage, "getItem"> | null): readonly LegacyMigration[] {
  function readStorage(key: string): string | null { try { return storage?.getItem(key) ?? null; } catch { return null; } }
  return [
    ...VISUALIZATION_MIGRATIONS,
    // Adopt credentials stored under a query name; the stable settings id is
    // independent of that URL spelling. Existing settings always win.
    ...["gkey", "key", "googleKey"].map(key => ({ key, migrate: (raw: string) =>
      raw.trim() ? { "map.source.googleKey": raw.trim() } : null })),
    { key: "foss-earth.map-detail.v1", migrate: migrateMapDetail },
    { key: "foss-earth.globeAnchorRotation", migrate: booleanString("input.globeAnchorRotation") },
    { key: "foss-earth.inputMode", migrate: raw => (["mouse", "trackpad", "touch"].includes(raw) ? { "input.mode": raw } : null) },
    { key: "moir-park.map-input-mode", migrate: raw => (["mouse", "trackpad", "touch"].includes(raw) ? { "input.mode": raw } : null) },
    { key: "foss-earth.inputSensitivity", migrate: raw => migrateSensitivity(raw, readStorage("foss-earth.inputSensitivityVersion") ?? readStorage("moir-park.map-input-sensitivity-version")) },
    { key: "moir-park.map-input-sensitivity", migrate: raw => migrateSensitivity(raw, readStorage("moir-park.map-input-sensitivity-version")) },
    { key: "osfs.orbit-invert", migrate: raw => { const parsed = parseJson(raw); if (!isObject(parsed)) return null; return {
      "input.orbit.invertYaw": parsed.invertYaw === true, "input.orbit.invertPitch": parsed.invertPitch === true,
      "input.orbit.recenterMode": parsed.recenterMode === "recenter" ? "recenter" : "hold" }; } },
  ];
}
