import type { ParameterSpec } from "@foss-earth/ui/settings";
import { MAP_CACHE_PRESENTATION_DEFAULTS, MAP_CACHE_PRESENTATION_IDS } from "../../map/mapCachePresentation.js";

/** Existing cache presentation costs belong to the Map tab's loading section. */
export const MAP_CACHE_PRESENTATION_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: MAP_CACHE_PRESENTATION_IDS.rowsShown,
    label: "Saved tiles listed per provider",
    description: "How many saved tile rows a provider's cache list shows. All saved tiles still contribute to its count and storage total.",
    unit: "count", kind: "number", bounds: () => ({ min: 1, max: 4096 }), step: 1, scale: "linear",
    default: MAP_CACHE_PRESENTATION_DEFAULTS.rowsShown,
    defaultReason: "The first 40 tiles shown by both existing cache presentations before the limit became a setting.",
    home: { tab: "map", section: "loading", level: "all" }, appliesLive: true,
    source: "src/shell/MapCachePanel.tsx",
  },
  {
    id: MAP_CACHE_PRESENTATION_IDS.inspectIntervalMs,
    label: "Saved tile list refresh interval",
    description: "Minimum time between cache inspections while the panel is visible. Inspection follows the existing host refresh; it creates no separate timer.",
    unit: "ms", kind: "number", bounds: () => ({ min: 250, max: 60000 }), step: 50, scale: "log2",
    default: MAP_CACHE_PRESENTATION_DEFAULTS.inspectIntervalMs,
    defaultReason: "The existing React cache panel read saved tiles every two seconds.",
    home: { tab: "map", section: "loading", level: "all" }, appliesLive: true,
    source: "src/shell/MapCachePanel.tsx",
  },
];
