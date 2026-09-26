import type { ParameterSpec } from "../types";

/** Sections that stay in the Settings tab until the tabs they affect exist. */
export const SETTINGS_TAB = "settings";

export const TOOLBAR_BUTTONS = [
  ["help", "Help (?)", "the ? button that opens the controls help"],
  ["settings", "Settings (⚙)", "the ⚙ button that opens the Settings tab"],
  ["theme", "Theme", "the light and dark theme button"],
  ["inputMode", "Input method", "the input method button, which opens the Controls tab"],
] as const;

export const PERFORMANCE_HUD_METRICS = [
  ["fps", "FPS", true, "Frames per second rendered by the map."],
  ["frame", "Frame time", false, "Average time spent rendering each frame."],
  ["p95", "P95 frame time", false, "95th percentile frame time over the recent sample window."],
  ["activeMeshes", "Active meshes (#⬟)", false, "Babylon meshes currently active in the scene."],
  ["drawCalls", "Draw calls", false, "GPU draw calls submitted for the current frame when the renderer exposes them."],
  ["tiles", "Map tiles (#/#t)", false, "Visible map tiles over active map tiles managed by the tile runtime."],
  ["culling", "Culling", false, "Visible tracked objects over total tracked objects after hemisphere culling."],
  ["memory", "Memory", true, "Approximate JavaScript heap memory currently used by the page."],
] as const;

function toggle(id: string, label: string, description: string, fallback: boolean, reason: string, section: string, source: string, level: "main" | "all" = "main"): ParameterSpec {
  return {
    id,
    label,
    description,
    unit: "none",
    kind: "boolean",
    default: fallback,
    defaultReason: reason,
    home: { tab: SETTINGS_TAB, section, level },
    appliesLive: true,
    source,
  };
}

function metres(id: string, label: string, description: string, fallback: number, min: number, max: number, section: string, source: string): ParameterSpec {
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
    home: { tab: SETTINGS_TAB, section, level: "all" },
    appliesLive: true,
    source,
  };
}

export const INTERFACE_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "interface.theme",
    label: "Theme",
    description: "Light or dark panels and toolbar.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "dark", label: "Dark" },
      { id: "light", label: "Light" },
    ],
    default: "dark",
    defaultReason: "A dark frame keeps attention on the map.",
    home: { tab: SETTINGS_TAB, section: "toolbar", level: "all" },
    appliesLive: true,
    source: "src/theme/theme.ts",
  },
  ...TOOLBAR_BUTTONS.map(([button, label, what]) => toggle(
    `interface.toolbar.${button}`, label, `Shows ${what}. Hiding it never hides what it opens: that stays under +.`,
    true, "A first-time visitor does not know that + opens the same things.", "toolbar", "src/hud/hudButtonVisibility.ts",
  )),
  ...PERFORMANCE_HUD_METRICS.map(([metric, label, visible, tooltip]) => toggle(
    `interface.performanceHud.${metric}`, `${label} on the toolbar`, tooltip,
    visible, visible ? "Shown by default: it is the first thing to look at." : "Hidden by default: a debugging reading.", "performance", "src/app/createGlobeApp.ts",
  )),
  toggle("interface.poiSpriteTuner", "POI sprite size tuner", "Shows the panel that tunes the size of point-of-interest sprites.",
    false, "A debugging panel.", "performance", "src/hud/poiSpriteSizeTuner.ts"),
  toggle("interface.compassScaleTuner", "Compass scale tuner", "Shows the panel that tunes the orbit compass's size.",
    false, "A debugging panel.", "performance", "src/hud/compassScaleTuner.ts"),
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
    id: "visualization.compass.radiusScale",
    label: "Compass radius",
    description: "The orbit compass's radius as a share of the camera's distance.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 0.001, max: 1 }),
    scale: "log2",
    default: 0.035,
    defaultReason: "The value it was drawn with before it became a setting.",
    home: { tab: SETTINGS_TAB, section: "performance", level: "all" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  metres("visualization.compass.minRadius", "Compass smallest radius", "The orbit compass never gets smaller than this.", 750, 1, 1_000_000, "performance", "src/visualization/orbitCompass.ts"),
  metres("visualization.compass.maxRadius", "Compass largest radius", "The orbit compass never gets larger than this.", 240_000, 1, 10_000_000, "performance", "src/visualization/orbitCompass.ts"),
  {
    id: "visualization.compass.labelSizeScale",
    label: "Compass label size",
    description: "The compass's letters as a share of its radius.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 0.01, max: 2 }),
    scale: "log2",
    default: 0.16,
    defaultReason: "The value it was drawn with before it became a setting.",
    home: { tab: SETTINGS_TAB, section: "performance", level: "all" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  metres("visualization.poiSprite.maxSize", "POI sprite largest size", "Point-of-interest sprites never get larger than this.", 40_000, 1, 10_000_000, "performance", "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.minSize", "POI sprite smallest size", "Point-of-interest sprites never get smaller than this.", 200, 1, 10_000_000, "performance", "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.minRefZoom", "POI sprite near distance", "At this camera distance or closer, sprites are at their smallest.", 100, 1, 100_000_000, "performance", "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.maxRefZoom", "POI sprite far distance", "At this camera distance or farther, sprites are at their largest.", 1_000_000, 1, 100_000_000, "performance", "src/hud/poiSpriteSizeTuner.ts"),
];
