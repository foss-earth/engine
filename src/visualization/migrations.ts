/** Pure legacy records. The host settings registry validates mapped values. */
export interface VisualizationMigration { key: string; migrate(raw: string): Record<string, number | boolean> | null }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function numbers(raw: string, prefix: string, keys: readonly string[]): Record<string, number> | null {
  const parsed: unknown = JSON.parse(raw); if (!record(parsed)) return null;
  const values: Record<string, number> = {};
  for (const key of keys) if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) values[`${prefix}.${key}`] = parsed[key];
  return values;
}
export const VISUALIZATION_MIGRATIONS: readonly VisualizationMigration[] = [
  { key: "foss-earth.poiSpriteTunerVisible", migrate: raw => raw === "true" || raw === "false" ? { "interface.poiSpriteTuner": raw === "true" } : null },
  { key: "foss-earth.compassScaleTunerVisible", migrate: raw => raw === "true" || raw === "false" ? { "interface.compassScaleTuner": raw === "true" } : null },
  { key: "foss-earth.compassHeightOffsetMeters", migrate: raw => Number.isFinite(Number(raw)) ? { "visualization.compass.heightOffset": Math.max(-1000, Math.min(1000, Number(raw))) } : null },
  { key: "foss-earth.compass-scale-defaults", migrate: raw => numbers(raw, "visualization.compass", ["radiusScale", "minRadius", "maxRadius", "labelSizeScale"]) },
  { key: "foss-earth.poi-sprite-size-defaults", migrate: raw => numbers(raw, "visualization.poiSprite", ["maxSize", "minSize", "minRefZoom", "maxRefZoom"]) },
];
