import type { DeviceContext, ParameterBounds, ParameterSpec } from "../types";
import { MAP_TAB } from "./map";

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

const IMAGERY_RUNTIME = "src/engine/babylon/imagery/createImageryRuntime.ts";
const RASTER_RUNTIME = "src/engine/babylon/createRasterTilesRuntime.ts";
const GOOGLE_RUNTIME = "src/engine/babylon/createTilesRuntime.ts";
const MAP_CACHE = "src/terrain/mapCache.ts";
const SELECTOR = "src/terrain/imagery/imagerySelector.ts";
const TERRAIN_SELECTOR = "src/terrain/terrainSelector.ts";
const STARTING_VALUE = "The starting calibration of the projected-imagery work; not yet measured across devices.";

export const MAP_LOADING_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "map.imagery.gpuBudget",
    label: "2D imagery GPU memory",
    description: "How much GPU memory the atlas of 2D imagery may use. More keeps more imagery at full detail while the view moves; changing it reloads the imagery.",
    unit: "MiB",
    kind: "number",
    bounds: gpuBudgetBounds,
    scale: "log2",
    step: 0.05,
    default: gpuBudgetDefault,
    defaultReason: "A share of the device's memory, bounded by the renderer's texture limit.",
    home: { tab: MAP_TAB, section: "loading", level: "main" },
    appliesLive: true,
    source: IMAGERY_RUNTIME,
  },
  quantity({
    id: "map.imagery.stagingBudget", label: "2D imagery waiting for upload", unit: "MiB", min: 1, max: 512, fallback: 16, scale: "log2",
    description: "Decoded imagery that may wait to go to the GPU, requests in flight included. More lets downloads run further ahead of uploads.",
    reason: STARTING_VALUE, source: "src/engine/babylon/imagery/imageryResidency.ts",
  }),
  quantity({
    id: "map.imagery.concurrentRequests", label: "2D imagery requests at once", unit: "count", min: 1, max: 32, fallback: 6,
    description: "Imagery requests in flight at the same time. A source's own policy may allow fewer.",
    reason: "Six, the number of connections a browser opens to one host over HTTP/1.1.", source: "src/engine/babylon/imagery/imageryResidency.ts",
  }),
  quantity({
    id: "map.imagery.queuedRequests", label: "2D imagery requests queued", unit: "count", min: 8, max: 4096, fallback: 128, scale: "log2",
    description: "Imagery the view wants that may wait for a request. Beyond it, the least useful is left out until the view settles.",
    reason: STARTING_VALUE, source: "src/engine/babylon/imagery/imageryResidency.ts",
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
    id: "map.imagery.reselectWhileMoving", label: "2D imagery reselection while moving", unit: "ms", min: 0, max: 1000, fallback: 100, step: 10,
    description: "The shortest time between two choices of imagery while the view moves. The last view is always chosen for.",
    reason: STARTING_VALUE, source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.imagery.anisotropy", label: "2D imagery anisotropic filtering", unit: "samples", min: 1, max: 16, fallback: 4, scale: "log2", step: 1,
    description: "Texture samples along a steep view of the ground: sharper imagery near the horizon, more GPU work per pixel.",
    reason: "What every map texture used before this became a setting.", source: "src/engine/babylon/imagery/imageryAtlas.ts",
  }),
  quantity({
    id: "map.imagery.pageTablePatches", label: "2D imagery page tables", unit: "count", min: 16, max: 4096, fallback: 256, scale: "log2", step: 1,
    description: "Terrain patches that can each have their own table of imagery pages. A patch without one shows one page across it. Changing it reloads the imagery.",
    reason: "The page tables the atlas was built with before this became a setting.", source: IMAGERY_RUNTIME,
  }),
  quantity({
    id: "map.terrain.cachedTiles", label: "Terrain tiles kept", unit: "count", min: 32, max: 4096, fallback: 160, scale: "log2", step: 0.05, level: "main",
    description: "Terrain tiles kept after they leave the view, so returning does not load them again.",
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
    description: "A region shown at one level asks for a finer one when its pixels exceed the target by this much. Above 1, the view does not flicker between levels at the threshold.",
    reason: STARTING_VALUE, source: SELECTOR,
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
    description: "The most regions one choice of imagery may examine. Where it runs out, the rest keep coarser imagery and the Detail section says the renderer limited it.",
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
    source: "src/engine/babylon/imagery/imageryAtlasLayout.ts",
    readOnly: "Fixed by the shader's page-table layout.",
  },
];

export const MAP_TERRAIN_SELECTION_PARAMETERS: readonly ParameterSpec[] = [
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
];
