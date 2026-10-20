import { DEFAULT_RETRY_DELAY_MS } from "../../terrain/retryDelay.js";
import type { DeviceContext, ParameterBounds, ParameterSpec } from "@foss-earth/ui/settings";
import { MAP_TAB } from "./map.js";

const MiB = 1024 * 1024;
/** One atlas page slot: 288 px square with its gutter, RGBA, with mips. */
const SLOT_BYTES = 288 * 288 * 4 * (4 / 3);
/** The smallest atlas the imagery runtime can use: 24 slots and a page table. */
const MIN_ATLAS_MIB = 32;

/**
 * The largest atlas a renderer can hold, in MiB: one square texture as large
 * as its texture limit allows (WebGL 1: 4096 px, power of two), with mips,
 * plus a page table. Null until the renderer is known.
 */
export function atlasLimitMiB(context: Pick<DeviceContext, "rendererMode" | "maxTextureSize">): { mib: number; side: number } | null {
  if (!context.maxTextureSize) return null;
  const side = context.rendererMode === "webgl"
    ? 2 ** Math.floor(Math.log2(Math.min(4096, context.maxTextureSize)))
    : context.maxTextureSize;
  const slots = Math.floor(side / 288) ** 2;
  return { mib: Math.floor((slots * SLOT_BYTES + 1024 * 1024 * 4) / MiB), side };
}

function gpuBudgetBounds(context: DeviceContext): ParameterBounds {
  const limit = atlasLimitMiB(context);
  if (!limit) return { min: MIN_ATLAS_MIB, max: 8192, reason: "the renderer's texture limit is not known until it starts" };
  return { min: MIN_ATLAS_MIB, max: Math.max(MIN_ATLAS_MIB, limit.mib), reason: `the largest atlas a ${limit.side} px texture holds` };
}

function gpuBudgetDefault(context: DeviceContext): { value: number; derivedFrom: string } {
  const bounds = gpuBudgetBounds(context);
  if (!context.deviceMemoryGiB) {
    return { value: Math.min(bounds.max, 128), derivedFrom: "128 MiB, because this browser does not say how much memory the device has" };
  }
  const share = Math.round((context.deviceMemoryGiB * 1024) / 32);
  const value = Math.max(bounds.min, Math.min(bounds.max, share));
  return {
    value,
    derivedFrom: `1/32 of the ${context.deviceMemoryGiB} GiB the browser reports${value !== share ? `, limited to ${value} MiB by ${bounds.reason ?? "the bounds"}` : ""}`,
  };
}

interface Quantity {
  id: string;
  label: string;
  description: string;
  unit: ParameterSpec["unit"];
  min: number;
  max: number;
  fallback: number;
  reason: string;
  source: string;
  section?: "loading" | "selection" | "terrain-selection";
  level?: "main" | "all";
  scale?: "linear" | "log2";
  step?: number;
}

function quantity(spec: Quantity): ParameterSpec {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    unit: spec.unit,
    kind: "number",
    bounds: () => ({ min: spec.min, max: spec.max }),
    scale: spec.scale ?? "linear",
    ...(spec.step !== undefined ? { step: spec.step } : {}),
    default: spec.fallback,
    defaultReason: spec.reason,
    home: { tab: MAP_TAB, section: spec.section ?? "loading", level: spec.level ?? "all" },
    appliesLive: true,
    source: spec.source,
  };
}

const IMAGERY_RUNTIME = "src/babylon/imagery/createImageryRuntime.ts";
const RASTER_RUNTIME = "src/babylon/createRasterTilesRuntime.ts";
const GOOGLE_RUNTIME = "src/babylon/createTilesRuntime.ts";
const MAP_CACHE = "src/browser/mapCache.ts";
const SELECTOR = "src/terrain/imagery/imagerySelector.ts";
const TERRAIN_SELECTOR = "src/terrain/terrainSelector.ts";
const STARTING_VALUE = "The starting calibration of the projected-imagery work; not yet measured across devices.";

export const MAP_LOADING_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "map.terrain.proximityAnchor",
    label: "Proximity anchor",
    description: "Prepare nearby ground around the camera eye, the selected focus point, or both.",
    kind: "choice",
    unit: "none",
    choices: [{"id":"eye","label":"Eye"},{"id":"focus","label":"Focus"},{"id":"both","label":"Both"}],
    default: "both",
    defaultReason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.",
    home: { tab: MAP_TAB, section: "terrain-selection", level: "all" },
    appliesLive: true,
    source: TERRAIN_SELECTOR,
  },
  {
    id: "map.terrain.proximityBlendMode",
    label: "Detail blend",
    description: "Combine view and proximity detail by their maximum, a smooth power norm, or their sum.",
    kind: "choice",
    unit: "none",
    choices: [{"id":"max","label":"Max"},{"id":"power-norm","label":"Power"},{"id":"weighted-sum","label":"Sum"}],
    default: "max",
    defaultReason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.",
    home: { tab: MAP_TAB, section: "terrain-selection", level: "all" },
    appliesLive: true,
    source: TERRAIN_SELECTOR,
  },
  quantity({
    id: "map.terrain.proximityBlendPower", label: "Blend power", unit: "ratio", min: 1, max: 8, step: 0.5, fallback: 2, section: "terrain-selection",
    description: "How smoothly view and proximity detail combine in Power mode.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.losWeight", label: "View weight", unit: "ratio", min: 0, max: 4, step: 0.05, fallback: 1, section: "terrain-selection",
    description: "How strongly visible terrain contributes to detail selection.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.losGazeExponent", label: "Gaze exponent", unit: "ratio", min: 0, max: 8, step: 0.25, fallback: 0, section: "terrain-selection",
    description: "Concentrates visible detail toward the view center; zero weights the whole view equally.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.losPeripheralFloor", label: "Peripheral floor", unit: "ratio", min: 0.05, max: 1, step: 0.05, fallback: 0.25, section: "terrain-selection",
    description: "The smallest share of view detail kept at the edges when gaze weighting is enabled.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.proximityWeight", label: "Proximity weight", unit: "ratio", min: 0, max: 4, step: 0.05, fallback: 1, section: "terrain-selection",
    description: "How strongly nearby terrain contributes to detail selection; the safety core retains its minimum level independently.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.proximityCoreMeters", label: "Safety core", unit: "m", min: 15, max: 2000, step: 0.1, fallback: 200, scale: "log2", section: "terrain-selection",
    description: "Nearby ground within this radius retains the minimum proximity detail.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.proximityRadiusMeters", label: "Proximity radius", unit: "m", min: 50, max: 50000, step: 0.1, fallback: 1500, scale: "log2", section: "terrain-selection",
    description: "The outer horizontal radius of terrain refined around each anchor and its predicted motion.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.proximityHeightMeters", label: "Proximity height", unit: "m", min: 20, max: 10000, step: 0.1, fallback: 600, scale: "log2", section: "terrain-selection",
    description: "The vertical clearance within which proximity detail applies.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.proximityFalloffExponent", label: "Proximity falloff", unit: "ratio", min: 0.25, max: 4, step: 0.25, fallback: 1, section: "terrain-selection",
    description: "Shapes how proximity detail fades between the safety core and outer radius.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.proximityLookaheadSeconds", label: "Motion lookahead", unit: "s", min: 0, max: 5, step: 0.1, fallback: 1.5, section: "terrain-selection",
    description: "How far ahead along anchor motion to prepare nearby terrain.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.minProximityZoom", label: "Minimum proximity level", unit: "levels", min: 0, max: 18, step: 1, fallback: 14, section: "terrain-selection",
    description: "The minimum terrain level in the safety core, independent of visual detail and limited by the finest terrain level.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.maxProximityErrorPx", label: "Maximum proximity error", unit: "px", min: 1, max: 128, step: 0.25, fallback: 8, scale: "log2", section: "terrain-selection",
    description: "The largest Google 3D tile error allowed in the safety core, independent of visual detail.",
    reason: "Starting proximity LOD tuning; applies while Robust orbit LOD is on.", source: TERRAIN_SELECTOR,
  }),
  {
    id: "map.imagery.gpuBudget",
    label: "2D imagery GPU memory",
    description: "How much GPU memory the complete 2D imagery atlas mip chain and full transactional page-table texture may use. More keeps more imagery at full detail while the view moves; changing it reloads the imagery.",
    unit: "MiB",
    kind: "number",
    bounds: gpuBudgetBounds,
    scale: "log2",
    step: 0.05,
    default: gpuBudgetDefault,
    defaultReason: "A share of the device's memory, bounded by the renderer's texture limit. Includes both physical table versions used for managed transactional publication.",
    home: { tab: MAP_TAB, section: "loading", level: "main" },
    appliesLive: true,
    source: IMAGERY_RUNTIME,
  },
  quantity({
    id: "map.imagery.stagingBudget", label: "2D imagery waiting for upload", unit: "MiB", min: 1, max: 512, fallback: 16, scale: "log2",
    description: "Decoded imagery that may wait to go to the GPU, requests in flight included. More lets downloads run further ahead of uploads.",
    reason: STARTING_VALUE, source: "src/terrain/imagery/imageryResidency.ts",
  }),
  quantity({
    id: "map.imagery.concurrentRequests", label: "2D imagery requests at once", unit: "count", min: 1, max: 32, fallback: 16,
    description: "Imagery requests in flight at the same time. A source's own policy may allow fewer.",
    reason: "Sixteen. On the tour's first view at 80 ms a request, 16 elevation and imagery requests asleep the renderer in 2.9 s on a desktop and 13.4 s on a 4× phone proxy, against 5.7 s and 15.6 s at 6. HTTP/1.1 hosts still open six connections.", source: "src/terrain/imagery/imageryResidency.ts",
  }),
  quantity({
    id: "map.imagery.queuedRequests", label: "2D imagery requests queued", unit: "count", min: 8, max: 4096, fallback: 128, scale: "log2",
    description: "Imagery the view wants that may wait for a request. Beyond it, the least useful is left out until the view settles.",
    reason: STARTING_VALUE, source: "src/terrain/imagery/imageryResidency.ts",
  }),
  quantity({
    id: "map.imagery.uploadPerFrame", label: "2D imagery upload per frame", unit: "MiB", min: 0.25, max: 64, fallback: 2, scale: "log2",
    description: "Imagery written to the GPU in one frame. More fills in faster and costs more frame time while it does.",
    reason: STARTING_VALUE, source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.imagery.selectionTimePerFrame", label: "2D imagery selection time per frame", unit: "ms", min: 0.25, max: 16, fallback: 2, scale: "log2",
    description: "Processor time one frame may spend choosing and preparing imagery before it continues in the next.",
    reason: STARTING_VALUE, source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.imagery.missingRetryAfter", label: "Ask again for missing imagery after", unit: "s", min: 10, max: 86_400, fallback: 600, scale: "log2", step: 0.05,
    description: "How long an image the server says it does not have is remembered before it is asked for again. Meanwhile a coarser level stands in.",
    reason: "What the atlas remembered a missing image for before this became a parameter.", source: "src/terrain/imagery/imageryResidency.ts",
  }),
  {
    id: "map.retryDelay",
    label: "Retry after a failed download",
    description: "The wait before a failed terrain or 2D imagery download is tried again: the first wait, doubling with each failure in a row, up to the longest.",
    unit: "s",
    kind: "range",
    bounds: () => ({ min: 0.25, max: 600 }),
    scale: "log2",
    step: 0.05,
    default: { min: DEFAULT_RETRY_DELAY_MS.min / 1000, max: DEFAULT_RETRY_DELAY_MS.max / 1000 },
    defaultReason: "What failed downloads backed off by before this became a parameter.",
    home: { tab: MAP_TAB, section: "loading", level: "all" },
    appliesLive: true,
    source: "src/terrain/retryDelay.ts",
  },
  quantity({
    id: "map.imagery.reselectWhileMoving", label: "2D imagery reselection while moving", unit: "ms", min: 0, max: 1000, fallback: 100, step: 10,
    description: "The shortest time between two choices of imagery while the view moves. The last view is always chosen for.",
    reason: STARTING_VALUE, source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.imagery.anisotropy", label: "2D imagery anisotropic filtering", unit: "samples", min: 1, max: 16, fallback: 4, scale: "log2", step: 1,
    description: "Texture samples along a steep view of the ground: sharper imagery near the horizon, more GPU work per pixel.",
    reason: "What every map texture used before this became a setting.", source: "src/babylon/imagery/imageryAtlas.ts",
  }),
  quantity({
    id: "map.imagery.pageTablePatches", label: "2D imagery page tables", unit: "count", min: 16, max: 4096, fallback: 256, scale: "log2", step: 1,
    description: "Maximum visible terrain patches with detailed imagery page tables. Managed transactional updates reserve two physical blocks per patch inside the imagery GPU budget, so outgoing tables remain visible until incoming writes complete. A patch without one shows one page across it. Changing it reloads the imagery.",
    reason: "The page tables the atlas was built with before this became a setting. This counts logical patches; managed publication needs two physical versions per patch, fully charged to the same imagery GPU budget.", source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.terrain.cachedTiles", label: "Terrain tiles kept", unit: "count", min: 32, max: 4096, fallback: 160, scale: "log2", step: 0.05, level: "main",
    description: "Terrain tiles kept loaded, so returning to a place does not load it again. The tiles the view needs, those it shows and the coarser ones above them, are kept even beyond this.",
    reason: "What was kept by default before this became a setting.", source: RASTER_RUNTIME,
  }),
  quantity({
    id: "map.terrain.reselectWhileMoving", label: "Terrain reselection interval", unit: "ms", min: 0, max: 1000, fallback: 100, step: 10,
    description: "While the view moves or elevation arrives, terrain tiles are chosen again at most this often; the view it stops at, and the last elevation to arrive, are always chosen for.",
    reason: "The interval 2D imagery uses, so both follow the camera alike.", source: RASTER_RUNTIME,
  }),
  quantity({
    id: "map.terrain.maxLevel", label: "Finest terrain level", unit: "levels", min: 8, max: 20, fallback: 16, step: 1,
    description: "The finest terrain tile level 2D basemaps ask for. Imagery can be finer than the terrain it is drawn on.",
    reason: "The level terrain was capped at before this became a setting; its tiles are about 600 m across at the equator.", source: RASTER_RUNTIME,
  }),
  quantity({
    id: "map.terrain.coarserElevation", label: "Coarser elevation", unit: "levels", min: 0, max: 3, fallback: 0, step: 1,
    description: "Takes each terrain tile's heights from the elevation tile this many levels above it, which covers 4, 16 or 64 tiles. A 512-pixel elevation tile has 8 pixels for each of a 64-segment tile's segments, so even 3 levels keep about one pixel per vertex. Relief is smoother and heights can differ by metres. On the Minneapolis tour, 1 level downloaded and decoded about 60% less elevation and 3 levels about 75% less. Changing it loads the terrain again.",
    reason: "Each tile's own elevation, as terrain was loaded before this became a setting.", source: RASTER_RUNTIME,
  }),
  {
    id: "map.google.cacheTiles",
    label: "Google tiles kept",
    description: "Google 3D tiles kept after they leave the view: the renderer starts freeing unused ones above the lower end and must stay below the upper.",
    unit: "count",
    kind: "range",
    bounds: () => ({ min: 100, max: 100_000 }),
    scale: "log2",
    step: 0.05,
    default: { min: 6000, max: 8000 },
    defaultReason: "The tiles renderer's own defaults.",
    home: { tab: MAP_TAB, section: "loading", level: "all" },
    appliesLive: true,
    source: GOOGLE_RUNTIME,
  },
  {
    id: "map.google.cacheBytes",
    label: "Google tile memory",
    description: "Memory for Google 3D tiles: the renderer starts freeing unused tiles above the lower end and must stay below the upper.",
    unit: "MiB",
    kind: "range",
    bounds: () => ({ min: 32, max: 8192 }),
    scale: "log2",
    step: 0.05,
    default: { min: 307.2, max: 409.6 },
    defaultReason: "The tiles renderer's own defaults, 0.3 and 0.4 GiB.",
    home: { tab: MAP_TAB, section: "loading", level: "main" },
    appliesLive: true,
    source: GOOGLE_RUNTIME,
  },
  quantity({
    id: "map.google.downloads", label: "Google downloads at once", unit: "count", min: 1, max: 100, fallback: 25,
    description: "Google 3D tile downloads in flight at the same time.",
    reason: "The tiles renderer's own default.", source: GOOGLE_RUNTIME,
  }),
  quantity({
    id: "map.google.parses", label: "Google tiles parsed at once", unit: "count", min: 1, max: 32, fallback: 5,
    description: "Downloaded Google 3D tiles decoded into meshes at the same time.",
    reason: "The tiles renderer's own default.", source: GOOGLE_RUNTIME,
  }),
  quantity({
    id: "map.cache.httpBytes", label: "Saved tiles", unit: "MiB", min: 0, max: 4096, fallback: 128, step: 1, level: "main",
    description: "Disk space for public map tiles the app keeps between visits. Google 3D tiles use the browser's own cache instead.",
    reason: "The limit the cache had before this became a setting.", source: MAP_CACHE,
  }),
  quantity({
    id: "map.cache.httpEntries", label: "Saved tiles, count", unit: "count", min: 0, max: 100_000, fallback: 1024, scale: "linear", step: 1,
    description: "How many public map tiles the app keeps between visits.",
    reason: "The limit the cache had before this became a setting.", source: MAP_CACHE,
  }),
  quantity({
    id: "map.cache.maxTileBytes", label: "Largest saved tile", unit: "MiB", min: 0.25, max: 64, fallback: 8, scale: "log2",
    description: "A tile larger than this is not kept between visits.",
    reason: "The limit the cache had before this became a setting.", source: MAP_CACHE,
  }),
];

export const MAP_SELECTION_PARAMETERS: readonly ParameterSpec[] = [
  quantity({
    id: "map.imagery.refineAbove", label: "Refine above", unit: "ratio", min: 1, max: 4, fallback: 1.2, step: 0.05, section: "selection",
    description: "While the view moves, a region shown at one level asks for a finer one when its pixels exceed the target by this much. Above 1, the view does not flicker between levels at the threshold.",
    reason: STARTING_VALUE, source: SELECTOR,
  }),
  quantity({
    id: "map.imagery.refineAtRest", label: "Refine at rest above", unit: "ratio", min: 1, max: 4, fallback: 1, step: 0.05, section: "selection",
    description: "Once the view stops, a region asks for a finer level when its pixels exceed the target by this much. At 1 the view settles on the imagery it would load from scratch, however it got there; at Refine above, a small move loads nothing more.",
    reason: "At 1, the imagery a view settles on does not depend on how it got there.", source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.imagery.coarsenBelow", label: "Coarsen below", unit: "ratio", min: 0.1, max: 1, fallback: 0.8, step: 0.05, section: "selection",
    description: "Finer imagery may give way to a coarser level once its parent's pixels are this far under the target.",
    reason: STARTING_VALUE, source: SELECTOR,
  }),
  quantity({
    id: "map.imagery.coarsenAfter", label: "Coarsen after", unit: "ms", min: 0, max: 10_000, fallback: 500, step: 50, section: "selection",
    description: "How long a region must stay coarse enough before its finer imagery gives way.",
    reason: STARTING_VALUE, source: SELECTOR,
  }),
  quantity({
    id: "map.imagery.pinFor", label: "Keep new detail for", unit: "ms", min: 0, max: 10_000, fallback: 1000, step: 50, section: "selection",
    description: "Newly shown finer imagery stays at least this long, so a small movement does not undo it.",
    reason: STARTING_VALUE, source: SELECTOR,
  }),
  quantity({
    id: "map.imagery.fallbackGap", label: "Stand-in gap", unit: "levels", min: 1, max: 10, fallback: 4, step: 1, section: "selection",
    description: "When a region would show imagery this many levels coarser than it asks for, a nearer ancestor is loaded first as a stand-in.",
    reason: STARTING_VALUE, source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.imagery.fallbackStep", label: "Stand-in step", unit: "levels", min: 1, max: 6, fallback: 3, step: 1, section: "selection",
    description: "How many levels above the wanted image the stand-in is: one image covering 4 to the power of this many.",
    reason: STARTING_VALUE, source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.imagery.maxNodes", label: "Selection limit", unit: "count", min: 1000, max: 200_000, fallback: 12_000, scale: "log2", step: 0.05, section: "selection",
    description: "The most regions one choice of imagery may examine. Where it runs out, the rest keep coarser imagery, and the Detail section and the log say this limit stopped them.",
    reason: STARTING_VALUE, source: SELECTOR,
  }),
  {
    id: "map.imagery.pageTableDepth",
    label: "Page table depth",
    description: "How many imagery levels finer than its terrain one patch's page table can reach.",
    unit: "levels",
    kind: "number",
    bounds: () => ({ min: 6, max: 6 }),
    default: 6,
    defaultReason: "A 64 × 64 table per patch, the block the shader reads.",
    home: { tab: MAP_TAB, section: "selection", level: "all" },
    appliesLive: true,
    source: "src/terrain/imagery/imageryAtlasLayout.ts",
    readOnly: "Fixed by the shader's page-table layout.",
  },
];

export const MAP_TERRAIN_SELECTION_PARAMETERS: readonly ParameterSpec[] = [
  quantity({
    id: "map.terrain.meshRebuildTimePerFrame", label: "Terrain mesh rebuild time per frame", unit: "ms", min: 0.25, max: 16, fallback: 2, scale: "log2", section: "terrain-selection",
    description: "Processor time a frame may spend rebuilding terrain meshes after a segment change before continuing in the next frame.",
    reason: "The existing raster runtime yielded after 2 ms; this exposes that budget to the person using the globe.", source: RASTER_RUNTIME,
  }),
  quantity({
    id: "map.terrain.errorPerSpacing", label: "Error per vertex spacing", unit: "ratio", min: 0.05, max: 1, fallback: 0.25, step: 0.05, section: "terrain-selection",
    description: "How far the ground between a terrain tile's vertices is taken to stray from its mesh, as a share of their spacing. It turns a tile's size into the error the detail target is measured against.",
    reason: "The share Cesium uses for heightmap terrain.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.tileSegments", label: "Mesh segments per tile", unit: "count", min: 8, max: 256, fallback: 64, scale: "log2", step: 1, section: "terrain-selection",
    description: "How many segments each side of a terrain tile's mesh has. More gives each tile finer relief, so fewer, larger tiles meet the target; changing it rebuilds the meshes.",
    reason: "The segments the finest terrain tiles had by default before this became a setting.", source: RASTER_RUNTIME,
  }),
  quantity({
    id: "map.terrain.maxTiles", label: "Terrain selection limit", unit: "count", min: 64, max: 8192, fallback: 512, scale: "log2", step: 0.05, section: "terrain-selection",
    description: "The most terrain tiles one choice may cover the globe with. Where it runs out, the farthest regions stay coarser than the target.",
    reason: "About twice the tiles a horizon view at the default detail needs.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.refineAbove", label: "Refine above", unit: "ratio", min: 1, max: 4, fallback: 1.2, step: 0.05, section: "terrain-selection",
    description: "A terrain tile shown at one level splits when its error exceeds the target by this much. Above 1, terrain does not switch levels back and forth at the threshold.",
    reason: "The value 2D imagery starts from.", source: TERRAIN_SELECTOR,
  }),
  quantity({
    id: "map.terrain.coarsenBelow", label: "Coarsen below", unit: "ratio", min: 0.1, max: 1, fallback: 0.8, step: 0.05, section: "terrain-selection",
    description: "Split terrain gives way to its parent once the parent's error is this far under the target.",
    reason: "The value 2D imagery starts from.", source: TERRAIN_SELECTOR,
  }),
  {
    id: "map.terrain.robustOrbitLOD",
    label: "Robust orbit LOD",
    description: "Refines nearby terrain around the eye and predicted anchor motion independently of view detail, for raster basemaps and Google 3D Tiles. Retains recently viewed terrain, prevents coarse stand-ins from replacing fine elevation, and lets visible children settle independently of off-screen siblings.",
    kind: "boolean",
    unit: "none",
    default: false,
    defaultReason: "Opt-in fix for low-LOD retention and upward camera jolts during orbital camera motion.",
    home: { tab: MAP_TAB, section: "terrain-selection", level: "all" },
    appliesLive: true,
    source: RASTER_RUNTIME,
  },
];
