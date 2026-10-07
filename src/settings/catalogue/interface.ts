import { CHECK_PUBLISHED_EVERY_DEFAULT } from "../../app/publishedVersion";
import { TRAIL_STEPS_DEFAULT } from "../../diagnostics/sessionTrail";
import { GAME_LOG_LINE_MS, GAME_LOG_MAX_LINES } from "../../log/gameLogDefaults";
import { SEARCH_DEFAULTS } from "../../search/searchDefaults";
import type { ParameterSpec } from "../types";

/** The Settings tab: presets, saved settings, the app's own files and version, diagnostics and About. */
export const SETTINGS_TAB = "settings";
/** The Interface tab: the toolbar, theme, log and search. */
export const INTERFACE_TAB = "interface";
/** Performance debug, in the Renderer tab: tuners and measurements. */
const PERFORMANCE = { tab: "renderer", section: "performance" } as const;

export type ToolbarVisibility = "on" | "auto" | "off";

function toolbarVisibility(id: string, label: string, description: string, fallback: ToolbarVisibility, reason: string, source: string): ParameterSpec<ToolbarVisibility> {
  return {
    id,
    label,
    description: `${description} On keeps it shown, wrapping if needed. Auto shows it when it fits in one row, in priority order. Off hides it.`,
    unit: "none",
    kind: "choice",
    choices: [
      { id: "on", label: "On", icon: "toggle-on", description: "Always show, wrapping if needed." },
      { id: "auto", label: "Auto", shortLabel: "A", description: "Show when it fits in one row, in priority order." },
      { id: "off", label: "Off", icon: "toggle-off", description: "Keep hidden." },
    ],
    legacyValues: [
      { value: true, replacement: "on" },
      { value: false, replacement: "off" },
    ],
    default: fallback,
    defaultReason: reason,
    persistDefault: true,
    home: { tab: INTERFACE_TAB, section: "toolbar", level: "main" },
    appliesLive: true,
    source,
  };
}

/** How the position readout says which number is the latitude and which the longitude. */
export type CoordinateLabels = "none" | "words" | "icons";
/** What the position readout's altitude is measured from: mean sea level, or the ground below. */
export type AltitudeReference = "asl" | "agl";
export type AltitudeUnit = "m" | "ft";

export const POSITION_COORDINATE_LABELS_ID = "interface.position.coordinateLabels";
export const POSITION_ALTITUDE_ID = "interface.position.altitude";
export const POSITION_ALTITUDE_UNIT_ID = "interface.position.altitudeUnit";
export const POSITION_SEA_LEVEL_GRID_ID = "interface.position.seaLevelGrid";
const POSITION_READOUT = { tab: INTERFACE_TAB, section: "position", level: "main" } as const;

export const TOOLBAR_BUTTONS = [
  ["help", "Help (?)", "the ? button that opens the controls help"],
  ["renderer", "Renderer", "the WebGPU or WebGL indicator that opens the Renderer tab"],
  ["inputMode", "Input method", "the input method button, which opens the Controls tab"],
  ["theme", "Theme button", "the light and dark theme button"],
  ["settings", "Settings (⚙)", "the ⚙ button that opens the Settings tab"],
  ["fullscreen", "Fullscreen", "the button that enters or leaves fullscreen"],
  ["position", "Camera position", "the latitude, longitude, altitude, heading, pitch and zoom readout that opens Location"],
] as const;

/** The default toolbar ordering; Custom mode uses each item's saved priority. */
export const TOOLBAR_PRIORITIES = [
  ["north", "North", 0],
  ["help", "Help (?)", 1],
  ["inputMode", "Input method", 2],
  ["fullscreen", "Fullscreen", 3],
  ["fps", "FPS", 4],
  ["renderer", "Renderer", 5],
  ["position", "Camera position", 6],
  ["theme", "Theme button", 7],
  ["settings", "Settings (⚙)", 8],
  ["frame", "Frame time", 10],
  ["p95", "P95 frame time", 11],
  ["activeMeshes", "Active meshes (#⬟)", 12],
  ["drawCalls", "Draw calls", 13],
  ["tiles", "Map tiles (#/#t)", 14],
  ["culling", "Culling", 15],
  ["memory", "Memory", 16],
] as const;

export type ToolbarItemId = typeof TOOLBAR_PRIORITIES[number][0];
export const TOOLBAR_EDIT_PRIORITIES_ID = "interface.toolbar.editPriorities";

export function toolbarPriorityParameterId(item: ToolbarItemId): string {
  return `interface.toolbar.priority.${item}`;
}

export const PERFORMANCE_HUD_METRICS = [
  ["fps", "FPS", true, "Frames per second rendered by the map."],
  ["frame", "Frame time", false, "Average time spent rendering each frame."],
  ["p95", "P95 frame time", false, "95th percentile frame time over the recent sample window."],
  ["activeMeshes", "Active meshes (#⬟)", false, "Babylon meshes currently active in the scene."],
  ["drawCalls", "Draw calls", false, "GPU draw calls submitted for the current frame when the renderer exposes them."],
  ["tiles", "Map tiles (#/#t)", false, "Visible map tiles over active map tiles managed by the tile runtime."],
  ["culling", "Culling", false, "Visible tracked objects over total tracked objects after hemisphere culling."],
  ["memory", "Memory", false, "Approximate JavaScript heap memory currently used by the page."],
] as const;

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

export const INTERFACE_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "app.keepFiles",
    label: "Keep the app's files",
    description: "Keeps the app's own files on this device once they have been downloaded, so a later visit starts without asking the network for them, however long ago the last one was. Each file's name carries its content, so a kept file is never out of date: a new version of the app has new names, which are downloaded once, and the old files go. The page itself is not kept: it is the browser's to ask the network for. Off forgets them and leaves the app to the browser's own cache. Scene images are kept apart: Scenes → Saved images.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "GitHub Pages lets the browser keep a file for ten minutes. On a visit to the UMN tour eleven minutes after the last, the browser asked for every file of the app again, and 1.55 of its 1.72 MiB came again in full (docs/proposals/panorama-scenes.md, \"Loading once\").",
    home: { tab: SETTINGS_TAB, section: "app-files", level: "main" },
    appliesLive: true,
    source: "src/app/appFiles.ts",
  },
  {
    id: "app.checkPublished",
    label: "Ask which version is published",
    description: "Asks this site for the page itself when the app starts, when the page is shown again and while it stays shown, no more often than the time below, and compares the build written in it with this page's. A browser that restores a tab, as a phone does, may show its own copy of the page from days before, and with it that day's app; this is how the app can tell. The answer is the page, a few kilobytes, or a few hundred bytes when it has not changed. Off asks nothing, and the app is whichever one the browser shows.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "On 2026-10-04 an iPhone was still running the UMN tour's app of two days and four releases before, from Safari's copy of the page, and nothing said so (docs/app-files.md).",
    home: { tab: SETTINGS_TAB, section: "app-files", level: "main" },
    appliesLive: true,
    source: "src/app/publishedVersion.ts",
  },
  {
    id: "app.checkPublishedEvery",
    label: "Ask again after",
    description: "How long after asking the site which version is published the app asks again, while the page is shown or when it is shown again.",
    unit: { id: "min", text: "min" },
    kind: "number",
    bounds: () => ({ min: 1, max: 1440 }),
    step: 0.05,
    scale: "log2",
    default: CHECK_PUBLISHED_EVERY_DEFAULT,
    defaultReason: "GitHub Pages tells a browser that its copy of a page is good for ten minutes, so asking again after ten asks no more often than the browser itself would.",
    home: { tab: SETTINGS_TAB, section: "app-files", level: "main" },
    appliesLive: true,
    source: "src/app/publishedVersion.ts",
  },
  {
    id: "app.reloadOlderPage",
    label: "Reload an older page by itself",
    description: "When this page is an older version of the app than the published one and nobody has touched it yet, as when a browser has just opened its own copy, the page reloads at once and its log says so. It does that once for a published version: a browser that answers with its old copy again is not asked forever. A page that has been touched is never reloaded by itself: its log says a newer version is published, with a button. Off always leaves it to the button.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "A visitor cannot tell that the page a browser restored is an old one, and an old app may not read today's scene: on 2026-10-03 one showed an error in place of the UMN tour (docs/app-files.md).",
    home: { tab: SETTINGS_TAB, section: "app-files", level: "main" },
    appliesLive: true,
    source: "src/app/publishedVersion.ts",
  },
  {
    id: "diagnostics.trail",
    label: "Remember how a visit ended",
    description: "Keeps each visit's steps on this device: what loaded, the log's lines, warnings, errors and the 360 image entered. A page that a browser stops, as a phone does to one that takes too much memory, runs nothing as it goes, so these steps are how the next visit can say that it happened and the report what it was doing. Nothing is sent anywhere. Off removes this visit's steps from the device; this visit's report still has them.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "On 2026-10-03 the UMN tour kept crashing on an iPhone, and nothing said what it had been doing, on which renderer, or which version of the app it was (docs/diagnostics.md).",
    home: { tab: SETTINGS_TAB, section: "diagnostics", level: "main" },
    appliesLive: true,
    source: "src/diagnostics/sessionTrail.ts",
  },
  {
    id: "diagnostics.trailSteps",
    label: "Steps kept",
    description: "How many of a visit's latest steps are held for its report and kept for the next visit. A step is one line of at most 300 characters; the same line again is counted, not added.",
    unit: "count",
    kind: "number",
    bounds: () => ({ min: 10, max: 1000 }),
    step: 0.05,
    scale: "log2",
    default: TRAIL_STEPS_DEFAULT,
    defaultReason: "Opening an example scene and entering its 360 image is 16 steps (docs/diagnostics.md), so 80 hold a visit of many images, with each kind of trouble as one step however often it comes. They are 24 KB at most, written to this device as a step is added.",
    home: { tab: SETTINGS_TAB, section: "diagnostics", level: "main" },
    appliesLive: true,
    source: "src/diagnostics/sessionTrail.ts",
  },
  {
    id: "interface.theme",
    label: "Theme",
    description: "Light or dark panels and toolbar.",
    unit: "none",
    kind: "choice",
    choiceControl: "two-position",
    choices: [
      { id: "light", label: "Light", shortLabel: "☼" },
      { id: "dark", label: "Dark", shortLabel: "☾" },
    ],
    default: "dark",
    defaultReason: "A dark frame keeps attention on the map.",
    home: { tab: INTERFACE_TAB, section: "toolbar", level: "main" },
    appliesLive: true,
    source: "src/theme/theme.ts",
  },
  ...TOOLBAR_BUTTONS.map(([button, label, what]) => toolbarVisibility(
    `interface.toolbar.${button}`, label, `Shows ${what}.`,
    "auto", "Shown when it fits after the higher-priority controls and before the detail slider and attribution.", "src/hud/hudButtonVisibility.ts",
  )),
  ...PERFORMANCE_HUD_METRICS.map(([metric, label, visible, tooltip]) => toolbarVisibility(
    `interface.performanceHud.${metric}`, label, tooltip,
    visible ? "auto" : "off", visible ? "Shown when it fits after north, help, input method and fullscreen: it is the first performance reading to look at." : "Hidden by default: a debugging reading.", "src/app/createGlobeApp.ts",
  )),
  {
    ...toggle(TOOLBAR_EDIT_PRIORITIES_ID, "Priorities", "Auto uses the default toolbar order. Custom shows priority numbers beside each toolbar control and uses them to decide the order and which automatic items fit first. Returning to Auto keeps your custom numbers for later.",
      false, "Auto uses the default order with priority numbers hidden.", { tab: INTERFACE_TAB, section: "toolbar" }, "src/app/createGlobeApp.ts"),
    booleanControl: "auto-custom",
  },
  ...TOOLBAR_PRIORITIES.map(([item, label, priority]): ParameterSpec<number> => ({
    id: toolbarPriorityParameterId(item),
    label: `${label} priority`,
    description: `Lower numbers place ${label} earlier and give it room before other automatic toolbar items. Items with equal priorities keep their default order.${item === "north" ? " North stays available at every priority." : ""}`,
    unit: "count",
    kind: "number",
    bounds: () => ({ min: 0, max: 99 }),
    step: 1,
    numberControl: "field",
    default: priority,
    defaultReason: "North and help come first, followed by input method, fullscreen, FPS, renderer, position, theme, settings and additional performance readings.",
    home: { tab: INTERFACE_TAB, section: "toolbar", level: "main" },
    visibleWhen: { id: TOOLBAR_EDIT_PRIORITIES_ID, value: true },
    inlineWith: item === "north" ? undefined
      : TOOLBAR_BUTTONS.some(([button]) => button === item) ? `interface.toolbar.${item}`
        : `interface.performanceHud.${item}`,
    appliesLive: true,
    source: "src/app/createGlobeApp.ts",
  })),
  {
    id: POSITION_COORDINATE_LABELS_ID,
    label: "Latitude and longitude",
    description: "How the toolbar's position readout says which number is which. None leaves it to the N or S and E or W after each number. Words writes lat and lon before them. Icons draws a globe with only its parallels before the latitude and one with only its meridians before the longitude.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "none", label: "None", description: "Only the N or S and E or W after each number." },
      { id: "words", label: "Words", description: "lat before the latitude, lon before the longitude." },
      { id: "icons", label: "Icons", description: "A globe of parallels before the latitude, a globe of meridians before the longitude." },
    ],
    default: "none",
    defaultReason: "N or S after the latitude and E or W after the longitude already say which is which, in the narrowest chip.",
    home: POSITION_READOUT,
    appliesLive: true,
    source: "src/hud/positionReadout.ts",
  },
  {
    id: POSITION_ALTITUDE_ID,
    label: "Altitude",
    description: "What the toolbar's altitude is measured from. Above sea level is the height over mean sea level, the EGM2008 geoid. Raster terrain's heights are already above its source's sea level; Google 3D Tiles are drawn at their heights above the WGS84 ellipsoid, so over them the geoid's height there, from the sea level grid below, is taken away. Above ground takes away the height of the drawn terrain directly below, so it reads zero on the ground and changes as the ground rises and falls; it needs the terrain below sampled each time it is drawn, and shows a dash until terrain there has loaded.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "asl", label: "Above sea level (ASL)", description: "Height over mean sea level." },
      { id: "agl", label: "Above ground (AGL)", description: "Height over the terrain directly below." },
    ],
    default: "asl",
    defaultReason: "It does not depend on which terrain has loaded, and is the altitude an altimeter and a chart give.",
    home: POSITION_READOUT,
    appliesLive: true,
    source: "src/hud/positionReadout.ts",
  },
  {
    id: POSITION_SEA_LEVEL_GRID_ID,
    label: "Sea level grid",
    description: "The grid of NGA's EGM2008 geoid, mean sea level, that the altitude above sea level is measured from over Google 3D Tiles, which are drawn at their heights above the WGS84 ellipsoid. A finer grid is closer to the model and a larger download, made once a page when the altitude above sea level is first shown over Google 3D Tiles, and kept with the app's files. Raster terrain's heights are already above sea level and need no grid. Each grid's error is measured against every point of EGM2008's 5′ grid: src/terrain/geoidGrids/provenance.json.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "60", label: "1° (87 KiB)", description: "Within 12.6 m of EGM2008, 46 cm rms; more than 0.5 m off over 11.7% of the globe." },
      { id: "30", label: "30′ (302 KiB)", description: "Within 4.1 m of EGM2008, 17 cm rms; more than 0.5 m off over 2.4% of the globe." },
      { id: "15", label: "15′ (1008 KiB)", description: "Within 1.6 m of EGM2008, 5.5 cm rms; more than 0.5 m off over 0.07% of the globe." },
    ],
    default: "15",
    defaultReason: "It is within half a metre of EGM2008 over all but 0.07% of the globe, less than the readout's metre step, and is downloaded only beside Google 3D Tiles, whose own downloads are far larger.",
    home: POSITION_READOUT,
    visibleWhen: { id: POSITION_ALTITUDE_ID, value: "asl" },
    appliesLive: true,
    source: "src/terrain/geoid.ts",
  },
  {
    id: POSITION_ALTITUDE_UNIT_ID,
    label: "Altitude unit",
    description: "The unit the toolbar's altitude is written in: metres or feet.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "m", label: "Metres (m)" },
      { id: "ft", label: "Feet (ft)" },
    ],
    default: "m",
    defaultReason: "The unit of the zoom distance beside it. An application that flies sets feet.",
    home: POSITION_READOUT,
    appliesLive: true,
    source: "src/hud/positionReadout.ts",
  },
  {
    id: "interface.log.lineDuration",
    label: "Log line time",
    description: "How long a finished line stays over the map before it fades. Opening the log shows every kept line again.",
    unit: "s",
    kind: "number",
    bounds: () => ({ min: 1, max: 600 }),
    step: 0.05,
    scale: "log2",
    default: GAME_LOG_LINE_MS / 1000,
    defaultReason: "Long enough to read a line twice, before this became a parameter.",
    home: { tab: INTERFACE_TAB, section: "log", level: "main" },
    appliesLive: true,
    source: "src/log/createGameLog.ts",
  },
  {
    id: "search.cacheDuration",
    label: "Keep search answers for",
    description: "How long place, nearby-airport, runway and elevation answers are kept on this device, including across reloads, before another lookup asks the service. Your Location form and selected runway are remembered separately.",
    unit: "h",
    kind: "number",
    bounds: () => ({ min: 0.01, max: 720 }),
    step: 0.05,
    scale: "log2",
    default: SEARCH_DEFAULTS.cacheHours,
    defaultReason: "A day, as the geocoder's usage policy asks answers to be cached.",
    home: { tab: INTERFACE_TAB, section: "search", level: "main" },
    appliesLive: true,
    source: "src/search/searchTuning.ts",
  },
  {
    id: "search.cacheEntries",
    label: "Search answers kept",
    description: "How many place, nearby-airport, runway and elevation answers are kept in total on this device; the least recently used goes first.",
    unit: "count",
    kind: "number",
    bounds: () => ({ min: 1, max: 4096 }),
    step: 0.05,
    scale: "log2",
    default: SEARCH_DEFAULTS.cacheEntries,
    defaultReason: "What the place lookup kept before this became a parameter; the airport lookup kept 32.",
    home: { tab: INTERFACE_TAB, section: "search", level: "main" },
    appliesLive: true,
    source: "src/search/searchTuning.ts",
  },
  {
    id: "search.timeout",
    label: "Search timeout",
    description: "How long a place or airport lookup may take before it gives up and says so.",
    unit: "s",
    kind: "number",
    bounds: () => ({ min: 1, max: 300 }),
    step: 0.05,
    scale: "log2",
    default: SEARCH_DEFAULTS.timeoutSeconds,
    defaultReason: "What both lookups waited before this became a parameter.",
    home: { tab: INTERFACE_TAB, section: "search", level: "main" },
    appliesLive: true,
    source: "src/search/searchTuning.ts",
  },
  {
    id: "interface.log.maxLines",
    label: "Log lines kept",
    description: "How many lines the log keeps, newest first; older ones are dropped.",
    unit: "count",
    kind: "number",
    bounds: () => ({ min: 5, max: 2000 }),
    step: 0.05,
    scale: "log2",
    default: GAME_LOG_MAX_LINES,
    defaultReason: "What the log kept before this became a parameter.",
    home: { tab: INTERFACE_TAB, section: "log", level: "main" },
    appliesLive: true,
    source: "src/log/createGameLog.ts",
  },
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
    id: "visualization.compass.radiusScale",
    label: "Compass radius",
    description: "The orbit compass's radius as a share of the camera's distance.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 0.001, max: 1 }),
    scale: "log2",
    default: 0.035,
    defaultReason: "The value it was drawn with before it became a setting.",
    home: { ...PERFORMANCE, level: "all" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  metres("visualization.compass.minRadius", "Compass smallest radius", "The orbit compass never gets smaller than this.", 750, 1, 1_000_000, "src/visualization/orbitCompass.ts"),
  metres("visualization.compass.maxRadius", "Compass largest radius", "The orbit compass never gets larger than this.", 240_000, 1, 10_000_000, "src/visualization/orbitCompass.ts"),
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
    home: { ...PERFORMANCE, level: "all" },
    appliesLive: true,
    source: "src/visualization/orbitCompass.ts",
  },
  metres("visualization.poiSprite.maxSize", "POI sprite largest size", "Point-of-interest sprites never get larger than this.", 40_000, 1, 10_000_000, "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.minSize", "POI sprite smallest size", "Point-of-interest sprites never get smaller than this.", 200, 1, 10_000_000, "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.minRefZoom", "POI sprite near distance", "At this camera distance or closer, sprites are at their smallest.", 100, 1, 100_000_000, "src/hud/poiSpriteSizeTuner.ts"),
  metres("visualization.poiSprite.maxRefZoom", "POI sprite far distance", "At this camera distance or farther, sprites are at their largest.", 1_000_000, 1, 100_000_000, "src/hud/poiSpriteSizeTuner.ts"),
];
