import type { ParameterSpec } from "@foss-earth/ui/settings";
import { DEFAULT_POI_REFINEMENT_POLICY } from "../../sprites/core.js";
import { DEFAULT_DOT_TEXTURE_SIZE, DEFAULT_SPRITE_CAPACITY } from "../../sprites/types.js";
import { DEFAULT_HORIZON_MARGIN } from "../../perf/culling.js";
import { DEFAULT_COMPASS_LABEL_TEXTURE_SIZE, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS } from "../../visualization/defaults.js";
const PERFORMANCE = { tab: "renderer", section: "performance" } as const;
const COMPASS = { tab: "interface", section: "compass" } as const;
const LEGACY_COMPASS = { id: "visualization.compass.mode", value: "legacy" } as const;

function toggle(id: string, label: string, description: string, fallback: boolean, reason: string, home: { tab: string; section: string }, source: string, level: "main" | "all" = "main"): ParameterSpec {
  return {
    id,
    label,
    description,
    unit: "none",
    kind: "boolean",
    default: fallback,
    defaultReason: reason,
    home: { ...home, level },
    appliesLive: true,
    source,
  };
}

function metres(id: string, label: string, description: string, fallback: number, min: number, max: number, source: string): ParameterSpec {
  return {
    id,
    label,
    description,
    unit: "m",
    kind: "number",
    bounds: () => ({ min, max }),
    scale: "log2",
    default: fallback,
    defaultReason: "The value it was drawn with before it became a setting.",
    home: { ...PERFORMANCE, level: "all" },
    appliesLive: true,
    source,
  };
}

/** Engine-owned host contributions to the existing Controls and Renderer homes. */
export const ENGINE_VISUALIZATION_PARAMETERS: readonly ParameterSpec[] = [
  toggle("interface.poiSpriteTuner", "POI sprite size tuner", "Shows the panel that tunes the size of point-of-interest sprites.",
    false, "A debugging panel.", PERFORMANCE, "src/hud/poiSpriteSizeTuner.ts"),
  toggle("interface.compassScaleTuner", "Compass scale tuner", "Shows the panel that tunes the orbit compass's size.",
    false, "A debugging panel.", PERFORMANCE, "src/hud/compassScaleTuner.ts"),
  {
    id: "visualization.compass.heightOffset",
    label: "Compass orbit height",
    description: "How far above the ground the orbit compass and the orbit target sit.",
    unit: "m",
    kind: "number",
    bounds: () => ({ min: -1000, max: 1000 }),
    step: 10,
    scale: "linear",
    default: 0,
    defaultReason: "On the ground under the orbit target.",
    home: { tab: "controls", section: "camera", level: "main" },
    appliesLive: true,
    source: "src/terrain/anchorHeight.ts",
  },
  {
    id: "visualization.compass.mode",
    label: "Compass",
    description: "Horizon draws N, E, S and W in the sky just above the earth's horizon. Legacy draws the compass on the ground around the point the camera orbits.",
    unit: "none",
    kind: "choice",
    choiceControl: "two-position",
    choices: [
      { id: "legacy", label: "Legacy" },
      { id: "horizon", label: "Horizon" },
    ],
    default: "horizon",
    defaultReason: "Letters on the horizon stay readable up close and when the whole earth is in view. The ground compass is still there.",
    home: { ...COMPASS, level: "main" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  {
    id: "visualization.compass.radius",
    label: "Compass radius",
    description: "How small and how large the ground compass gets, in metres. The lower handle is the size it keeps when the camera is close.",
    unit: "m",
    kind: "range",
    bounds: () => ({ min: 1, max: 10_000_000 }),
    scale: "log2",
    default: { min: DEFAULT_ORBIT_COMPASS_SCALE_PARAMS.minRadius, max: DEFAULT_ORBIT_COMPASS_SCALE_PARAMS.maxRadius },
    defaultReason: "The smallest radius is 8000 m. The largest is unchanged.",
    visibleWhen: LEGACY_COMPASS,
    home: { ...COMPASS, level: "main" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  {
    id: "visualization.compass.distance",
    label: "Compass distance",
    description: "Camera distance where the ground compass is at its smallest, and where it reaches its largest. Closer than the near end it stays small; farther than the far end it stays large.",
    unit: "m",
    kind: "range",
    bounds: () => ({ min: 1, max: 100_000_000 }),
    scale: "log2",
    default: { min: DEFAULT_ORBIT_COMPASS_SCALE_PARAMS.minDistance ?? 1, max: DEFAULT_ORBIT_COMPASS_SCALE_PARAMS.maxDistance ?? 1 },
    defaultReason: "The distances where a radius of 3.5% of the camera distance meets the smallest and largest radius.",
    visibleWhen: LEGACY_COMPASS,
    home: { ...COMPASS, level: "main" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  {
    id: "visualization.compass.labelSizeScale",
    label: "Compass label size",
    description: "The ground compass's letters as a share of the radius the camera distance would give before the size limits apply. They grow as the view pulls back.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 0.01, max: 2 }),
    scale: "log2",
    default: DEFAULT_ORBIT_COMPASS_SCALE_PARAMS.labelSizeScale,
    defaultReason: "The value it was drawn with before it became a setting.",
    visibleWhen: LEGACY_COMPASS,
    home: { ...COMPASS, level: "main" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  metres("visualization.poiSprite.maxSize", "POI sprite largest size", "Point-of-interest sprites never get larger than this.", 40_000, 1, 10_000_000, "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.minSize", "POI sprite smallest size", "Point-of-interest sprites never get smaller than this.", 200, 1, 10_000_000, "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.minRefZoom", "POI sprite near distance", "At this camera distance or closer, sprites are at their smallest.", 100, 1, 100_000_000, "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.maxRefZoom", "POI sprite far distance", "At this camera distance or farther, sprites are at their largest.", 1_000_000, 1, 100_000_000, "src/hud/poiSpriteSizeTuner.ts"),
];

const refinement = DEFAULT_POI_REFINEMENT_POLICY;
/** Named host budgets for source costs that previously had fixed values. */
export const ENGINE_POINT_RESOURCE_PARAMETERS: readonly ParameterSpec[] = [
  ["visualization.poiSprite.minCapacity", "Sprite capacity floor", "The minimum number of point sprites allocated by a layer's manager; its actual point count may require more.", DEFAULT_SPRITE_CAPACITY, 0, 1_000_000, "count", "src/sprites/spriteManager.ts"],
  ["visualization.poiSprite.textureSize", "Marker atlas cell", "Pixels on each side of one circular marker's atlas cell; more pixels hold more detail and use more texture memory.", DEFAULT_DOT_TEXTURE_SIZE, 16, 4096, "px", "src/sprites/atlas.ts"],
  ["visualization.compass.labelTextureSize", "Compass label texture", "Pixels on each side of one compass letter's texture; four labels share the host transfer and texture budgets.", DEFAULT_COMPASS_LABEL_TEXTURE_SIZE, 16, 4096, "px", "src/visualization/orbitCompass.ts"],
  ["visualization.culling.horizonMargin", "Horizon margin", "The allowance subtracted from the spherical horizon threshold before point and polyline culling; all current primitives are scanned on a host update.", DEFAULT_HORIZON_MARGIN, 0, 1, "ratio", "src/perf/culling.ts"],
  ["visualization.poiRefinement.maxZoom", "Refine points within", "Camera distance beyond which point positions keep the smooth surface instead of requesting terrain refinement.", refinement.maxZoomMeters, 1, 100_000_000, "m", "src/sprites/positioning.ts"],
  ["visualization.poiRefinement.probeUp", "Point probe above", "Distance above the smooth surface where a point's downward terrain ray begins.", refinement.probeUpMeters, 1, 1_000_000, "m", "src/sprites/positioning.ts"],
  ["visualization.poiRefinement.probeDown", "Point probe below", "Distance below the smooth surface reached by a point's terrain ray.", refinement.probeDownMeters, 1, 1_000_000, "m", "src/sprites/positioning.ts"],
  ...refinement.lodDistancesMeters.map((value, n) => [`visualization.poiRefinement.lodDistance${n}`, `Point LOD distance ${n+1}`, "The camera-distance boundary for this point terrain-refinement level, ordered nearest to farthest.", value, 1, 100_000_000, "m", "src/sprites/positioning.ts"]),
  ...refinement.lodLevels.map((value, n) => [`visualization.poiRefinement.lod${n}`, `Point terrain level ${n+1}`, "The terrain tile level used in this distance band, ordered nearest to farthest.", value, 0, 24, "count", "src/sprites/positioning.ts"]),
  ...refinement.tileRadiusDistancesMeters.map((value, n) => [`visualization.poiRefinement.radiusDistance${n}`, `Point tile-radius distance ${n+1}`, "The camera-distance boundary for this point's refinement tile radius, ordered nearest to farthest.", value, 1, 100_000_000, "m", "src/sprites/positioning.ts"]),
  ...refinement.tileRadii.map((value, n) => [`visualization.poiRefinement.tileRadius${n}`, `Point tile radius ${n+1}`, "How many terrain tiles around a point's tile may be inspected in this distance band.", value, 0, 32, "count", "src/sprites/positioning.ts"]),
].map(([id, label, description, value, min, max, unit, source]): ParameterSpec => ({
  id: String(id), label: String(label), description: String(description), kind: "number", unit: unit as "count" | "px" | "ratio" | "m",
  bounds: () => ({ min: Number(min), max: Number(max) }), default: Number(value),
  ...(unit === "count" || unit === "px" ? { step: 1 } : {}),
  defaultReason: "The actual source value before it became a named host policy.",
  home: { ...PERFORMANCE, level: "all" }, appliesLive: true, source: String(source),
}));
