import type { Material, Scene, TransformNode } from "@babylonjs/core";
import { finishOwnedCleanup } from "../ownedCleanup.js";
import { tileContains, type TileId } from "../../terrain/imagery/imageryGeometry.js";
import {
  createImagerySelector,
  estimateFocusPages,
  imageKey,
  imageSourceKey,
  measureImageryView,
  type ImageryFocus,
  type ImageryHysteresis,
  type ImageryRefinePoint,
  type ImageryPlan,
  type ImagerySelectionInput,
  type ImagerySourceCapabilities,
  type ImagerySurface,
} from "../../terrain/imagery/imagerySelector.js";
import type { ImageryConstraint, ImageryReloadConstraint } from "../../terrain/imagery/imageryConstraints.js";
import { imagerySourceSupport, imageryTileUrl, type ImageryDescriptor } from "../../terrain/imagery/imagerySources.js";
import { retryDelayMs } from "../../terrain/retryDelay.js";
import type { DetailLimit } from "../../terrain/mapDetailPolicy.js";
import { createImageryAtlas, planAtlasForBackend, type ImageryAtlasDevicePorts, type ManagedImageryAtlasResources, type OwnedImageryTableJob, type AtlasCapabilities, type ImageryAtlas } from "./imageryAtlas.js";
import { IMAGERY_TABLE_BLOCK, IMAGERY_TABLE_MAX_CELLS_LOG2, slotBytes, type ImageryAtlasLayout } from "../../terrain/imagery/imageryAtlasLayout.js";
import { buildImageryDisplay, buildPatchTable, patchTableDepth, createBoundLevels, measureLoadedImagery, type ImageryDisplay, type LoadedImageryBinding, type LoadedImageryRegion } from "../../terrain/imagery/imageryBinding.js";
import { prepareManagedPatchTable, type HeldPatchTable } from "../../terrain/imagery/managedPatchTable.js";
import type { TextureTransferOutcome, TextureTransferRetirement } from "@foss-earth/renderer";
import { ImageryAtlasMaterialPlugin } from "./imageryMaterialPlugin.js";
import {
  createImageryResidency,
  type ImageryLoader,
  type ImageryRequest,
  type ImageryResidency,
  type ImageryResidencyStats,
  type ImageryResourceLimits,
} from "../../terrain/imagery/imageryResidency.js";
import { imageryViewChanged, readImageryView } from "./imageryView.js";

/** What to load around a focus point, beyond the view: `map.focus.*`. */
export interface ImageryFocusRequest {
  mode: "around" | "both";
  /** ECEF metres. */
  position: { x: number; y: number; z: number };
  radiusMeters: number;
  /** The finest offset the region may ask for; null follows the view's. */
  offsetCap: number | null;
  horizonCull: boolean;
}

/** How imagery is chosen and drawn, beyond its budgets: the `map.imagery.*` parameters. */
export interface ImageryTuning {
  /** New traversals for a moving view start at most this often, in ms; the last view is always selected. */
  reselectWhileMovingMs: number;
  /** Texture samples along steep views. */
  anisotropy: number;
  /**
   * A leaf whose region would otherwise show a page this many levels coarser
   * (often the level-2 coverage, a flat colour) asks first for its ancestor
   * `fallbackStep` levels up: one small image that stands in for many leaves.
   */
  fallbackGap: number;
  fallbackStep: number;
  /** Terrain patches that may each hold a page-table block. */
  tablePatches: number;
  maxNodes: number;
  /** `refineAbove` holds while the view moves. */
  hysteresis: ImageryHysteresis;
  /** Once the view rests, an existing leaf refines past this many times its target. 1 settles on what a fresh view selects. */
  refineAtRestAbove: number;
}

export interface ImageryFeedback {
  support: "ready" | "unavailable";
  reason?: string;
  pending: boolean;
  limits: DetailLimit[];
  /** The selector's current offset, independent of loading and spatial delivery. */
  activeTarget: number | null;
  /** Visible-area estimate of bound imagery detail; mixed regions are averaged in log space. */
  loadedTarget?: number | null;
  effectiveTarget: number | null;
  /** The source the plan is for, which a switch can leave drawing the old one meanwhile. */
  source: { id: string; version: string; label: string } | null;
  /** What limits visible imagery, as the decisions applying each limit established it. */
  constraints: ImageryConstraint[];
}

export interface ImageryDiagnostics {
  requestedSource: string;
  displayedSource: string | null;
  offset: number;
  backend: AtlasCapabilities["backend"];
  plan: {
    leaves: number;
    levels: Record<number, number>;
    variants: number;
    limits: DetailLimit[];
    nodesEvaluated: number;
    truncated: boolean;
    cpuMs: number;
    /** Leaves by projected footprint in physical px per image px: <=0.5, <=1, <=2, <=4, >4. */
    footprints: [number, number, number, number, number];
    /**
     * Per region: requested level and variant, footprint and limit, and the
     * page level visible patches' materials sample there: null where none binds it.
     */
    regions: Array<{ key: string; variant: string | null; delivered: number | null; footprintPx: number; screenArea: number; limit: DetailLimit | null }>;
    /** Images the source does not have that selection refined past toward resident imagery: not a limit. */
    refinedPastMissing: number;
  } | null;
  residency: ImageryResidencyStats;
  atlas: { capacity: number; freeSlots: number; estimatedGpuBytes: number; width: number; height: number; tableBlocks: number } | null;
  /** Why the last budget change could not reallocate the atlas, when it could not. */
  allocationError: string | null;
  /**
   * The focus region, while one is loaded: the pages its regions hold in the
   * last plan, and about how many the current radius needs from this view.
   */
  focus: { pages: number; estimatedPages: number } | null;
  /** Visible patches needing a table are `tablesNeeded`; `fallbackPatches` of them got none. */
  binding: { patches: number; blocks: number; tablesNeeded: number; fallbackPatches: number; fallbackLeaves: number; capped: number; emptyCells: number };
  counters: { selections: number; selectionCpuMs: number; publishes: number; tableWrites: number; uploads: number; uploadBytes: number };
  /** The feedback's constraints. */
  constraints: ImageryConstraint[];
}

export interface ImageryRuntimeOptions {
  scene: Scene;
  worldRoot?: TransformNode | null;
  source: ImageryDescriptor;
  offset?: number;
  /** The budgets: `map.imagery.*`. */
  limits: ImageryResourceLimits;
  tuning: ImageryTuning;
  surface: ImagerySurface & {
    /** The finest imagery a region's terrain binding can show. */
    maxLevelFor?(tile: TileId): number;
    /** Changes when the adopted surface changes. */
    getRevision(): number;
  };
  requestRender(): void;
  /** The focus region to load as well as, or instead of, the view; null or omitted: the view only. */
  getFocus?(): ImageryFocusRequest | null;
  /**
   * The point the regions the view sees are measured from, in ECEF metres:
   * `map.focus.refineBasemapFrom`. Null or omitted: their projected size.
   */
  getRefinePoint?(): { x: number; y: number; z: number } | null;
  onDownloadBytes?(bytes: number): void;
  onError?(error: Error, url: string): void;
  /** Delivery or support changed. */
  onFeedback?(): void;
  /** Fallback coverage became usable or changed: terrain may show more patches. */
  onCoverageChange?(): void;
  loader: ImageryLoader<AbortSignal>;
  /** Borrowed by default. Supply an explicit owned release only for a loader
   * dedicated to this runtime; a shared host loader must remain alive. */
  releaseOwnedLoader?(): void;
  createAbortController(): AbortController;
  device: ImageryAtlasDevicePorts;
  /** Optional accounted whole-batch path; all methods bind the same host broker. */
  managedAtlas?: ManagedImageryAtlasResources;
  /** Actual restored host adapter; the host has already observed/cancelled loss. */
  restoreManagedDevice?(): ImageryAtlasDevicePorts;
  after(callback: () => void, delayMs: number): () => void;
  log: { warn(...values: unknown[]): void };
  capabilities: AtlasCapabilities;
  now: () => number;
}

export interface ImageryRuntime {
  readonly supported: boolean;
  /**
   * New budgets. Admission limits apply from the next update; a new GPU
   * budget reallocates the atlas, and the old one keeps drawing until the new
   * one's fallback coverage is resident.
   */
  setLimits(limits: ImageryResourceLimits): void;
  /** New tuning; a new number of page tables reallocates the atlas the same way. */
  setTuning(tuning: ImageryTuning): void;
  setSource(source: ImageryDescriptor): void;
  setOffset(offset: number): void;
  /** Draws a terrain patch's material from the atlas. */
  attachPatch(key: string, tile: TileId, material: Material): void;
  detachPatch(key: string): void;
  /** Patches drawn this frame get page-table blocks; hidden ones give theirs back. */
  setPatchVisible(key: string, visible: boolean): void;
  /** True when fallback coverage for this terrain tile is resident, so it can be drawn. */
  hasCoverage(tile: TileId): boolean;
  /** The source whose pages are displayed, for attribution during a switch. */
  getDisplayedSourceId(): string | null;
  update(): void;
  getFeedback(): ImageryFeedback;
  getDiagnostics(): ImageryDiagnostics;
  dispose(): void;
}

interface PatchState {
  tile: TileId;
  plugin: ImageryAtlasMaterialPlugin;
  /** The atlas the patch's material draws from; the old one during a reallocation. */
  atlas: ImageryAtlas | null;
  visible: boolean;
  block: number | null;
  tableSignature: string | null;
  table: Uint8Array | null;
  /** Retained across atlas/source handovers until the material actually changes. */
  bound: LoadedImageryBinding | null;
  ownedTable?: HeldPatchTable | null;
  pendingTable?: PendingTable | null;
  boundSlots?: Set<number>;
  boundSource?: SourceState | null;
  boundRevision?: number;
  boundPlan?: ImageryPlan | null;
  tableFailures?: number;
  tableRetryAt?: number;
}
interface PendingTable {
  patch: PatchState; atlas: ImageryAtlas; block: number; table: HeldPatchTable;
  signature: string; source: SourceState; plan: ImageryPlan; revision: number; display: ImageryDisplay; slots: Set<number>;
  job: OwnedImageryTableJob; outcome: TextureTransferOutcome | null; retirement: TextureTransferRetirement | null;
  closed: boolean; cancelled: boolean; backedOff: boolean;
  /** Why the runtime withdrew the table itself; the outcome that reason fails it with is no error. */
  withdrawn?: unknown;
}

interface SourceState {
  descriptor: ImageryDescriptor;
  capabilities: ImagerySourceCapabilities;
}

const COVERAGE_PRIORITY = 1e12;
const MiB = 1024 * 1024;

function signature(data: Uint8Array, cellsLog2: number): string {
  // A cheap content signature: FNV-1a over the used cells.
  let hash = 2166136261;
  const side = 2 ** cellsLog2;
  for (let row = 0; row < side; row++) {
    for (let index = row * 64 * 4; index < (row * 64 + side) * 4; index++) {
      hash ^= data[index];
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${cellsLog2}:${hash >>> 0}`;
}

/**
 * Raster imagery chosen by its projected pixel size and drawn from a paged
 * atlas, independently of terrain. Imagery changes never touch terrain
 * buffers, coverage or surface revisions: they only upload pages and rewrite
 * page tables.
 */
export function createImageryRuntime(options: ImageryRuntimeOptions): ImageryRuntime {
  const now = options.now;
  const worldRoot = options.worldRoot ?? null;
  let limits = options.limits;
  let tuning = options.tuning;
  const capabilities = options.capabilities;
  const managed = options.managedAtlas;
  let disposed = false, device = options.device;
  let stopAvailable: (() => void) | null = null, capacityBlocked = false;
  let capacityKey = managed?.capacityKey() ?? "";
  let pendingReallocation: "gpu-budget" | "page-tables" | "source" | null = null;
  const managedRetired = new Set<ImageryAtlas>();
  const retiredResidencies = new Map<ImageryAtlas, ImageryResidency>();
  const reportManaged = (error: unknown): void => {
    try { if (options.onError) options.onError(error instanceof Error ? error : new Error(String(error)), "imagery managed resources"); else options.log.warn("[imagery]", error); }
    catch { /* The sole supplied host error channel was attempted. */ }
  };
  const wakeManaged = (): void => { if (!disposed) try { options.requestRender(); } catch (error) { reportManaged(error); } };

  /** The largest atlas the budget and the renderer allow. */
  const allocate = (overlap = false): { layout: ImageryAtlasLayout; atlas: ImageryAtlas } | { error: string } => {
    // A managed table swap uses an unbound second physical block for each
    // configured logical patch, entirely inside the existing GPU byte budget.
    const nextLayout = planAtlasForBackend(capabilities, limits.gpuBytes, tuning.tablePatches * (managed ? 2 : 1));
    if (!nextLayout) return { error: "This renderer cannot hold the imagery atlas." };
    try {
      return { layout: nextLayout, atlas: createImageryAtlas(options.scene, nextLayout, tuning.anisotropy, device, managed ? {
        generation: () => managed.generation(), reserveGpu: (bytes, label, flags) => managed.reserveGpu(bytes, label, flags),
        reserveTable: (bytes, label) => managed.reserveTable(bytes, label), reserveCopy: (bytes, label) => managed.reserveCopy(bytes, label),
        canUpload: (bytes, extra) => managed.canUpload(bytes, extra), subscribeAvailable: listener => managed.subscribeAvailable(listener), capacityKey: () => managed.capacityKey(),
        overlap, requestRender: wakeManaged, onError: reportManaged,
      } : undefined) };
    } catch (error) {
      return { error: `The imagery atlas could not be created: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  let layout: ImageryAtlasLayout | null = null;
  let atlas: ImageryAtlas | null = null;
  /** The atlas a reallocation replaced; patches draw from it until the new one covers them. */
  let retiredAtlas: ImageryAtlas | null = null;
  let allocationError: string | null = null;
  let unsupportedReason: string | null = null;
  const first = allocate();
  if ("error" in first) { unsupportedReason = first.error; if (managed) { pendingReallocation = "page-tables"; capacityBlocked = true; } }
  else ({ layout, atlas } = first);
  const backendLimited = capabilities.backend === "webgl" && !capabilities.explicitGradients;
  // A texture-size cap can hold the atlas well below the budget; a memory
  // limit that follows is then the renderer's.
  const atlasCappedByBackend = (): boolean => layout !== null && layout.estimatedBytes < limits.gpuBytes * 0.75;
  /** Pages the budget allows selection to use inside the atlas. */
  const pageBudget = (): number => {
    const capacity = atlas?.capacity ?? 0;
    const byBytes = Math.floor((limits.gpuBytes - (layout ? layout.tableSize ** 2 * 4 : 0)) / slotBytes());
    const usable = Math.min(capacity, byBytes);
    return Math.max(16, usable - 16 - Math.ceil(usable * 0.15));
  };

  const resolveSource = (descriptor: ImageryDescriptor): SourceState | null => {
    const support = imagerySourceSupport(descriptor);
    for (const problem of support.problems) options.log.warn("[imagery]", problem);
    return support.capabilities ? { descriptor, capabilities: support.capabilities } : null;
  };
  let requested = resolveSource(options.source);
  if (!requested) unsupportedReason ??= `${options.source.id} tiles are not a supported size.`;
  let displayed: SourceState | null = null;
  let offset = options.offset ?? 0;

  const loader = options.loader;
  let wakeTimer: (() => void) | undefined;
  let wakeAt = Infinity;
  const createResidency = (store: ImageryAtlas | null): ImageryResidency => createImageryResidency({
    loader,
    store: store ?? { capacity: 0, allocate: () => null, release: () => {}, upload: () => {} },
    limits,
    now,
    createAbortController: options.createAbortController,
    onChange: () => { if (!disposed) options.requestRender(); },
    onError: options.onError,
  });
  let residency: ImageryResidency = createResidency(atlas);

  const selector = createImagerySelector(now);
  let plan: ImageryPlan | null = null;
  let restartSelection = true;
  let lastView: ReturnType<typeof readImageryView> = null;
  let lastSurfaceRevision = -1;
  let lastMissingRevision = -1;
  let lastMergeResidency = -1;
  let lastTraversalStart = -Infinity;
  let lastFocus: ImageryFocus | null = null;
  let lastRefine: ImageryRefinePoint | null = null;
  let lastOffset = offset;
  // What the running traversal measured; a traversal can span several frames. `moving`: the view, focus, refine point
  // or offset changed since the last selection, so the traversal keeps hysteresis.
  let traversalInputs: { view: NonNullable<ReturnType<typeof readImageryView>>; surfaceRevision: number; missingRevision: number; focus: ImageryFocus | null; refine: ImageryRefinePoint | null; offset: number; moving: boolean } | null = null;
  // The last selection kept hysteresis because the view moved: once it rests, one more selection refines to the target.
  let settleDue = false;
  let lastPublishedResidency = -1;
  let planChangedSincePublish = true;
  let patchesChanged = true;
  let display: ImageryDisplay | null = null;
  let acceptedCoverage = new Set<string>();
  /** `viewFootprints`: the plan measured its regions by their size in the view, so they need no measuring again. */
  let shownPlan: { plan: ImageryPlan; source: SourceState; viewFootprints: boolean } | null = null;
  let latestView: ReturnType<typeof readImageryView> = null;
  let measuredView: ReturnType<typeof readImageryView> = null;
  let measuredPlan: ImageryPlan | null = null;
  let measuredSurfaceRevision = -1;
  let measuredAt = -Infinity;
  let measuredPublish = -1;
  let loadedRegions: LoadedImageryRegion[] = [];
  let loadedTarget: number | null = null;
  let capped = 0;
  let emptyCells = 0;
  let fallbackPatches = 0;
  let tablesNeeded = 0;
  /** Shown imagery discarded by an atlas replacement or a lost context, until it is back. */
  let reload: ImageryReloadConstraint | null = null;
  /** Regions a budget coarsened after showing them finer, since that budget began to limit. */
  let reduced = { pages: 0, nodes: 0 };
  let feedback: ImageryFeedback = { support: "unavailable", reason: unsupportedReason ?? undefined, pending: false, limits: [], activeTarget: null, loadedTarget: null, effectiveTarget: null, source: null, constraints: [] };
  const patches = new Map<string, PatchState>();
  const counters = { selections: 0, selectionCpuMs: 0, publishes: 0, tableWrites: 0, uploads: 0, uploadBytes: 0 };
  let countedUploads = 0, countedUploadBytes = 0;
  try { if (managed) stopAvailable = managed.subscribeAvailable(() => {
    if (disposed) return;
    try {
      const next = managed.capacityKey();
      if (next === capacityKey) return;
      capacityKey = next;
      if (capacityBlocked || pendingReallocation) { capacityBlocked = false; patchesChanged = true; wakeManaged(); }
    } catch (error) { reportManaged(error); }
  }); }
  catch (error) { finishOwnedCleanup([() => residency.dispose(), () => atlas?.dispose(), () => options.releaseOwnedLoader?.()], "Managed availability setup cleanup failed.", [error]); throw error; }

  const scheduleWake = (at: number | null): void => {
    if (disposed || at === null || !Number.isFinite(at) || at >= wakeAt) return;
    wakeAt = at;
    wakeTimer?.();
    wakeTimer = options.after(() => {
      wakeTimer = undefined;
      wakeAt = Infinity;
      if (!disposed) options.requestRender();
    }, Math.max(0, at - now()));
  };

  const standardKey = (source: SourceState, tile: TileId) => imageKey(source.capabilities, tile, null);

  function rootsCovering(source: SourceState, tile: TileId): TileId[] {
    const root = plan?.coverage[0]?.z ?? Math.max(source.capabilities.minLevel, Math.min(2, source.capabilities.maxLevel));
    if (tile.z >= root) {
      const shift = tile.z - root;
      return [{ z: root, x: tile.x >> shift, y: tile.y >> shift }];
    }
    const shift = root - tile.z;
    const tiles: TileId[] = [];
    for (let y = 0; y < 2 ** shift; y++) for (let x = 0; x < 2 ** shift; x++) tiles.push({ z: root, x: (tile.x << shift) + x, y: (tile.y << shift) + y });
    return tiles;
  }

  function coverageComplete(source: SourceState, roots: readonly TileId[]): boolean {
    return roots.every(root => residency.isResident(standardKey(source, root)) || residency.isMissing(standardKey(source, root)));
  }

  /** The focus region as the selector measures it: from the camera's distance to the point, at this view's pixel size. */
  function currentFocus(view: NonNullable<ReturnType<typeof readImageryView>>): ImageryFocus | null {
    const request = options.getFocus?.();
    if (!request) return null;
    const { position } = request;
    return {
      mode: request.mode,
      position: { ...position },
      radiusMeters: request.radiusMeters,
      minDistanceMeters: Math.hypot(view.camera.x - position.x, view.camera.y - position.y, view.camera.z - position.z),
      pixelAngle: view.pixelAngle ?? 1 / view.renderHeight,
      offset: request.offsetCap === null ? offset : Math.min(offset, request.offsetCap),
      horizonCull: request.horizonCull,
    };
  }

  /** The point regions the view sees are measured from, from this view: no nearer than the camera is to it. */
  function currentRefine(view: NonNullable<ReturnType<typeof readImageryView>>): ImageryRefinePoint | null {
    const position = options.getRefinePoint?.();
    if (!position) return null;
    return {
      position: { ...position },
      minDistanceMeters: Math.hypot(view.camera.x - position.x, view.camera.y - position.y, view.camera.z - position.z),
      pixelAngle: view.pixelAngle ?? 1 / view.renderHeight,
    };
  }

  /** A change in the refine point worth a new selection: it moved, or the camera's distance to it changed. */
  function refineChanged(a: ImageryRefinePoint | null, b: ImageryRefinePoint | null): boolean {
    if (!a || !b) return a !== b;
    const moved = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
    return moved > 0.5 || Math.abs(a.minDistanceMeters - b.minDistanceMeters) > 0.02 * Math.max(1, a.minDistanceMeters) || a.pixelAngle !== b.pixelAngle;
  }

  /** A change in the focus region worth a new selection: the point moved, or what it asks for changed. */
  function focusChanged(a: ImageryFocus | null, b: ImageryFocus | null): boolean {
    if (!a || !b) return a !== b;
    const moved = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
    const nearer = Math.abs(a.minDistanceMeters - b.minDistanceMeters) > 0.02 * Math.max(1, a.minDistanceMeters);
    return a.mode !== b.mode || moved > 0.5 || nearer || a.radiusMeters !== b.radiusMeters
      || a.pixelAngle !== b.pixelAngle || a.offset !== b.offset || a.horizonCull !== b.horizonCull;
  }

  function focusDiagnostics(): ImageryDiagnostics["focus"] {
    const focus = lastView ? currentFocus(lastView) : null;
    if (!focus) return null;
    let pages = 0;
    for (const leaf of plan?.leaves ?? []) if (leaf.inFocus) pages += leaf.pages;
    return { pages, estimatedPages: Math.round(estimateFocusPages(focus)) };
  }

  function selectionInput(view: NonNullable<ReturnType<typeof readImageryView>>, source: SourceState, focus: ImageryFocus | null, refineFrom: ImageryRefinePoint | null, moving: boolean): ImagerySelectionInput {
    return {
      view,
      source: source.capabilities,
      offset,
      surface: options.surface,
      availability: { isResident: residency.isResident, isMissing: residency.isMissing, getRevision: residency.getRevision },
      maxLevelFor: options.surface.maxLevelFor,
      maxPages: pageBudget(),
      maxNodes: tuning.maxNodes,
      // Hysteresis keeps leaves from refining while the view moves across a threshold. At rest they refine to the
      // target, so where the view stops, not how it got there, decides the imagery. Splits are still kept: merging
      // waits as before.
      hysteresis: moving ? tuning.hysteresis : { ...tuning.hysteresis, refineAbove: tuning.refineAtRestAbove },
      focus,
      refineFrom,
      now: now(),
    };
  }

  function demand(source: SourceState, current: ImageryPlan): void {
    const requests: ImageryRequest[] = [];
    const sourceKey = imageSourceKey(source.capabilities);
    const request = (tile: TileId, variant: string | null, priority: number, coverage: boolean): ImageryRequest => {
      const size = variant === null
        ? { width: source.capabilities.tileWidth, height: source.capabilities.tileHeight }
        : source.capabilities.variants.find(candidate => candidate.id === variant) ?? { width: 256, height: 256 };
      return {
        imageKey: imageKey(source.capabilities, tile, variant),
        url: imageryTileUrl(source.descriptor, tile, variant),
        width: size.width,
        height: size.height,
        priority,
        coverage,
        sourceKey,
      };
    };
    for (const root of current.coverage) requests.push(request(root, null, COVERAGE_PRIORITY, true));
    const target = current.physicalTarget;
    const exceed = (footprint: number) => Math.max(0, footprint / target - 1);
    for (const leaf of current.leaves) {
      if (leaf.presumedMissing || residency.isMissing(leaf.imageKey)) continue;
      const pages = leaf.pages;
      const pageLevel = leaf.tile.z + Math.log2(Math.sqrt(pages));
      // Improvement over what the display shows there now, per byte to decode and upload.
      let shownLevel = 0;
      let { z, x, y } = leaf.tile;
      while (z >= 0) {
        const page = display?.pages.get(`${z}/${x}/${y}`);
        if (page) { shownLevel = page.z; break; }
        if (z === 0) break;
        z -= 1; x >>= 1; y >>= 1;
      }
      // A tile around the camera measures Infinity so that it splits. At the
      // source's finest level it cannot, so its page counts as reaching the target.
      const footprint = Number.isFinite(leaf.footprintPx) ? leaf.footprintPx : target;
      const before = footprint * 2 ** Math.max(0, pageLevel - shownLevel);
      const benefit = leaf.screenArea * (exceed(before) - exceed(footprint)) + leaf.screenArea * 1e-3 + 1e-6;
      const priority = benefit / (pages * slotBytes());
      requests.push(request(leaf.tile, leaf.variant, priority, false));
      const stepUp = Math.min(tuning.fallbackStep, leaf.tile.z - source.capabilities.minLevel);
      if (pageLevel - shownLevel >= tuning.fallbackGap && stepUp > 0 && !residency.isResident(leaf.imageKey)) {
        const ancestor = { z: leaf.tile.z - stepUp, x: leaf.tile.x >> stepUp, y: leaf.tile.y >> stepUp };
        if (ancestor.z > shownLevel && !residency.isMissing(standardKey(source, ancestor))) {
          requests.push(request(ancestor, null, priority * 2, false));
        }
      }
    }
    for (const tile of current.mergeCandidates) requests.push(request(tile, null, 1e-9, false));
    residency.setDemand(requests);
  }

  function select(): void {
    if (!requested || !atlas) return;
    const view = readImageryView(options.scene, worldRoot);
    latestView = view;
    if (!view) return;
    const surfaceRevision = options.surface.getRevision();
    const missingRevision = residency.getMissingRevision();
    const focus = currentFocus(view);
    const refine = currentRefine(view);
    const due = plan?.wakeAt !== null && plan?.wakeAt !== undefined && now() >= plan.wakeAt;
    const mergeReady = (plan?.mergeCandidates.length ?? 0) > 0 && residency.getRevision() !== lastMergeResidency;
    // Around a focus point the view decides nothing: turning the camera selects nothing again.
    const viewMatters = focus?.mode !== "around";
    const moved = (viewMatters && imageryViewChanged(lastView, view)) || focusChanged(lastFocus, focus)
      || refineChanged(lastRefine, refine) || offset !== lastOffset;
    const wanted = restartSelection || selector.isRunning() || !plan || moved || settleDue
      || surfaceRevision !== lastSurfaceRevision || missingRevision !== lastMissingRevision || due || mergeReady;
    if (!wanted) return;
    // During continuous motion, start a traversal at most every 100 ms and
    // wake once more afterwards so the final view is always selected.
    const throttled = !restartSelection && !selector.isRunning() && plan !== null && now() - lastTraversalStart < tuning.reselectWhileMovingMs;
    if (throttled) {
      scheduleWake(lastTraversalStart + tuning.reselectWhileMovingMs);
      return;
    }
    const started = now();
    if (!selector.isRunning() || restartSelection) {
      lastTraversalStart = started;
      // A first selection has no hysteresis memory to keep.
      traversalInputs = { view, surfaceRevision, missingRevision, focus, refine, offset, moving: moved && plan !== null };
    }
    const step = selector.step(selectionInput(view, requested, traversalInputs?.focus ?? focus, traversalInputs?.refine ?? refine, traversalInputs?.moving ?? moved), started + limits.cpuMsPerUpdate, now, restartSelection);
    counters.selectionCpuMs += now() - started;
    restartSelection = false;
    if (step.running) {
      options.requestRender();
      return;
    }
    counters.selections += 1;
    // Anything that changed while the traversal ran is selected next time.
    lastView = traversalInputs?.view ?? view;
    lastFocus = traversalInputs?.focus ?? focus;
    lastRefine = traversalInputs?.refine ?? refine;
    lastSurfaceRevision = traversalInputs?.surfaceRevision ?? surfaceRevision;
    lastMissingRevision = traversalInputs?.missingRevision ?? missingRevision;
    lastOffset = traversalInputs?.offset ?? offset;
    settleDue = traversalInputs?.moving ?? moved;
    traversalInputs = null;
    lastMergeResidency = residency.getRevision();
    plan = step.plan;
    planChangedSincePublish = true;
    if (plan) {
      const { regions, reduced: now } = plan.shortfall;
      reduced = {
        pages: regions.pages > 0 ? reduced.pages + now.pages : 0,
        nodes: regions.nodes > 0 ? reduced.nodes + now.nodes : 0,
      };
      demand(requested, plan);
      scheduleWake(plan.wakeAt);
    }
    if (settleDue) {
      // Select again once the throttle allows, without waiting for another reason to draw.
      const at = lastTraversalStart + tuning.reselectWhileMovingMs;
      if (at <= now()) options.requestRender();
      else scheduleWake(at);
    }
  }

  const pendingTableJobs = new Set<PendingTable>();
  const disposingAtlases = new Set<ImageryAtlas>();
  function syncManagedPins(): void {
    const slots = new Set<number>();
    for (const patch of patches.values()) {
      if (!patch.visible) continue;
      if (patch.atlas === atlas) for (const slot of patch.boundSlots ?? []) slots.add(slot);
      if (patch.pendingTable?.atlas === atlas) for (const slot of patch.pendingTable.slots) slots.add(slot);
    }
    residency.setPinned(slots);
    for (const [oldAtlas, oldResidency] of retiredResidencies) {
      const oldSlots = new Set<number>();
      for (const patch of patches.values()) if (patch.visible && patch.atlas === oldAtlas) for (const slot of patch.boundSlots ?? []) oldSlots.add(slot);
      oldResidency.setPinned(oldSlots);
    }
  }
  function retireUnusedManagedAtlases(): void {
    for (const old of managedRetired) {
      if (disposingAtlases.has(old) || [...patches.values()].some(patch => patch.atlas === old || patch.pendingTable?.atlas === old)) continue;
      disposingAtlases.add(old);
      const oldResidency = retiredResidencies.get(old); retiredResidencies.delete(old);
      try { oldResidency?.dispose(); } catch (error) { reportManaged(error); }
      try { old.dispose(); } catch (error) { reportManaged(error); }
      if (old.whenDisposed) void old.whenDisposed.then(result => {
        if (result.cleanupError !== undefined) { reportManaged(result.cleanupError); return; }
        managedRetired.delete(old); disposingAtlases.delete(old);
        if (!disposed && managedRetired.size === 0) try { atlas?.settleReplacement?.(); } catch (error) { reportManaged(error); }
        wakeManaged();
      });
      else managedRetired.delete(old);
    }
  }
  function closePendingTable(pending: PendingTable, errors: unknown[]): void {
    if (pending.closed) return;
    pending.closed = true;
    try { pending.table.close(); } catch (error) { errors.push(error); }
  }
  function cancelManagedTable(pending: PendingTable, reason: unknown): void {
    if (pending.patch.pendingTable === pending) pending.patch.pendingTable = null;
    pending.cancelled = true;
    const errors: unknown[] = [];
    try { pending.job.cancel(reason); } catch (error) { errors.push(error); }
    closePendingTable(pending, errors);
    try { pending.job.release(); } catch (error) { errors.push(error); }
    if (errors.length) reportManaged(errors.length === 1 ? errors[0] : new AggregateError(errors, "Managed table cancellation cleanup failed."));
  }
  /** Withdraws a table this runtime no longer wants: a cancellation, not a failure. */
  function cancelPendingTable(patch: PatchState, reason: unknown): void {
    if (!patch.pendingTable) return;
    patch.pendingTable.withdrawn = reason;
    cancelManagedTable(patch.pendingTable, reason);
  }
  function tableSlots(table: HeldPatchTable): Set<number> {
    const slots = new Set<number>(), data = table.data, side = 2 ** table.cellsLog2;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const index = (y * IMAGERY_TABLE_BLOCK + x) * 4;
      if (data[index + 3] === 255) slots.add(data[index] + data[index + 1] * 256);
    }
    return slots;
  }
  function updateManagedDisplay(candidate: ImageryDisplay, source: SourceState, selected: ImageryPlan): void {
    if (disposed || atlas === null || requested !== source || plan !== selected) return;
    const visible = [...patches.values()].filter(patch => patch.visible);
    const revision = residency.getRevision();
    if (visible.some(patch => patch.atlas !== atlas || patch.boundSource !== source || patch.boundPlan !== selected || patch.boundRevision !== revision || patch.pendingTable)) return;
    const sourceChanged = displayed !== source, firstDisplay = display === null;
    display = candidate; displayed = source; acceptedCoverage = new Set(selected.coverage.map(tile => `${tile.z}/${tile.x}/${tile.y}`)); shownPlan = { plan: selected, source, viewFootprints: lastFocus === null && lastRefine === null };
    lastPublishedResidency = residency.getRevision(); planChangedSincePublish = false; patchesChanged = false;
    if (sourceChanged || firstDisplay) try { options.onCoverageChange?.(); } catch (error) { reportManaged(error); }
    retireUnusedManagedAtlases();
  }
  function backoffPendingTable(pending: PendingTable): void {
    if (pending.backedOff || pending.cancelled || pending.patch.pendingTable !== pending || disposed) return;
    pending.backedOff = true;
    pending.patch.tableFailures = (pending.patch.tableFailures ?? 0) + 1;
    pending.patch.tableRetryAt = now() + retryDelayMs(pending.patch.tableFailures, limits.retryDelayMs);
    scheduleWake(pending.patch.tableRetryAt);
  }
  function bindManagedDirect(patch: PatchState, nextAtlas: ImageryAtlas, candidate: ImageryDisplay, source: SourceState, selected: ImageryPlan, revision: number): void {
    let page: { slot: number; z: number } | undefined; let { z, x, y } = patch.tile;
    for (;;) { page = candidate.pages.get(`${z}/${x}/${y}`); if (page || z === 0) break; z -= 1; x >>= 1; y >>= 1; }
    const directSignature = page ? `direct:${page.slot}:${page.z}` : "direct:empty";
    if (patch.atlas === nextAtlas && patch.tableSignature === directSignature && patch.boundSource === source) { patch.boundPlan = selected; patch.boundRevision = revision; return; }
    const oldAtlas = patch.atlas, oldBlock = patch.block, oldTable = patch.ownedTable;
    try {
      patch.plugin.setBinding(nextAtlas, null, page ? { slot: page.slot, level: page.z } : null);
      patch.atlas = nextAtlas; patch.block = null; patch.tableSignature = directSignature; patch.table = null; patch.ownedTable = null;
      patch.bound = { tile: patch.tile, table: null, directLevel: page?.z ?? null }; patch.boundSlots = new Set(page ? [page.slot] : []); patch.boundSource = source; patch.boundPlan = selected; patch.boundRevision = revision;
      counters.publishes += 1;
      if (oldBlock !== null) try { oldAtlas?.releaseBlock(oldBlock); } catch (error) { reportManaged(error); }
      try { oldTable?.close(); } catch (error) { reportManaged(error); }
    } catch (error) { reportManaged(error); }
  }
  function finishPendingTable(pending: PendingTable): void {
    if (!pending.outcome || !pending.retirement) return;
    pendingTableJobs.delete(pending);
    const patch = pending.patch;
    const current = !disposed && !pending.cancelled && [...patches.values()].includes(patch) && patch.visible
      && patch.pendingTable === pending && atlas === pending.atlas && requested === pending.source && plan === pending.plan && residency.getRevision() === pending.revision && pending.job.isCurrent();
    if (!current || pending.outcome.status !== "uploaded" || pending.retirement.status !== "completed" || pending.retirement.cleanupError !== undefined) {
      if (patch.pendingTable === pending) patch.pendingTable = null;
      const errors: unknown[] = [];
      if (pending.outcome.status === "failed" && pending.outcome.error !== pending.withdrawn) errors.push(pending.outcome.error);
      if (pending.retirement.cleanupError !== undefined) errors.push(pending.retirement.cleanupError);
      closePendingTable(pending, errors);
      try { pending.job.release(); } catch (error) { errors.push(error); }
      if (errors.length) reportManaged(errors.length === 1 ? errors[0] : new AggregateError(errors, "Managed table upload and cleanup failed."));
      patchesChanged = true; syncManagedPins(); retireUnusedManagedAtlases(); wakeManaged(); return;
    }
    const previousAtlas = patch.atlas, previousBlock = patch.block, previousTable = patch.ownedTable;
    const origin = pending.atlas.blockOrigin(pending.block);
    // Native success plus retirement is proven. Change the material first; an
    // unacknowledged write never changes signature/bindings or outgoing pins.
    try { patch.plugin.setBinding(pending.atlas, { ...origin, cellsLog2: pending.table.cellsLog2 }, null); }
    catch (error) {
      patch.pendingTable = null; const errors: unknown[] = [error]; closePendingTable(pending, errors);
      try { pending.job.release(); } catch (cleanup) { errors.push(cleanup); }
      reportManaged(errors.length === 1 ? errors[0] : new AggregateError(errors, "Managed table binding cleanup failed.")); patchesChanged = true; syncManagedPins(); wakeManaged(); return;
    }
    patch.pendingTable = null; patch.atlas = pending.atlas; patch.block = pending.block;
    patch.tableSignature = pending.signature; patch.table = pending.table.data; patch.ownedTable = pending.table;
    patch.bound = { tile: patch.tile, table: { cellsLog2: pending.table.cellsLog2, data: pending.table.data }, directLevel: null };
    patch.boundSlots = pending.slots; patch.boundSource = pending.source; patch.boundPlan = pending.plan; patch.boundRevision = pending.revision; patch.tableFailures = 0; patch.tableRetryAt = 0;
    counters.tableWrites += 1; counters.publishes += 1;
    const errors: unknown[] = [];
    if (previousBlock !== null) try { previousAtlas?.releaseBlock(previousBlock); } catch (error) { errors.push(error); }
    try { previousTable?.close(); } catch (error) { errors.push(error); }
    // Keep the incoming binding even if outgoing cleanup fails. All outgoing
    // ownership was independently attempted after material adoption.
    if (errors.length) reportManaged(errors.length === 1 ? errors[0] : new AggregateError(errors, "Managed outgoing table cleanup failed."));
    syncManagedPins(); updateManagedDisplay(pending.display, pending.source, pending.plan); retireUnusedManagedAtlases(); wakeManaged();
  }
  function publishManaged(): void {
    if (!managed || !atlas || !requested || !plan || !coverageComplete(requested, plan.coverage)) return;
    const residencyRevision = residency.getRevision();
    if (!planChangedSincePublish && !patchesChanged && residencyRevision === lastPublishedResidency) return;
    const nextAtlas = atlas, source = requested, selected = plan;
    const candidate = buildImageryDisplay({
      leaves: selected.leaves.map(leaf => ({ tile: leaf.tile, imageKey: leaf.imageKey, pagesPerSide: Math.round(Math.sqrt(leaf.pages)), presumedMissing: leaf.presumedMissing })),
      coverage: selected.coverage, slotsFor: residency.slotsFor, standardKey: tile => standardKey(source, tile), isMissing: residency.isMissing,
    });
    capped = 0; emptyCells = 0; fallbackPatches = 0; tablesNeeded = 0; let logicalTables = 0;
    for (const patch of patches.values()) {
      if (!patch.visible) {
        cancelPendingTable(patch, new Error("Patch became hidden."));
        const oldAtlas = patch.atlas, oldBlock = patch.block, oldTable = patch.ownedTable;
        patch.block = null; patch.ownedTable = null; patch.table = null; patch.tableSignature = null; patch.bound = null; patch.boundSlots = new Set(); patch.boundSource = null;
        try { if (oldBlock !== null) oldAtlas?.releaseBlock(oldBlock); } catch (error) { reportManaged(error); }
        try { oldTable?.close(); } catch (error) { reportManaged(error); }
        // Hidden materials must not keep an outgoing native atlas alive.
        patch.plugin.setBinding(nextAtlas, null, null); patch.atlas = nextAtlas;
        continue;
      }
      const needsTable = patchTableDepth(candidate, patch.tile).cellsLog2 > 0;
      if (needsTable) { tablesNeeded += 1; logicalTables += 1; }
      const allowedTable = needsTable && logicalTables <= Math.min(tuning.tablePatches, Math.floor(nextAtlas.layout.tableBlocks / 2));
      if (patch.pendingTable) {
        if (allowedTable && patch.pendingTable.atlas === nextAtlas && patch.pendingTable.source === source && patch.pendingTable.plan === selected && patch.pendingTable.revision === residencyRevision) continue;
        cancelPendingTable(patch, new Error("Desired page-table generation changed."));
      }
      if (!allowedTable) {
        if (needsTable) fallbackPatches += 1;
        // A replacement's coarse coverage is not the planned detailed binding.
        // Keep the outgoing table and pins until incoming detail can publish a
        // proven table. Missing/coarsened selections may still adopt directly.
        const awaitingDetail = !needsTable && patch.block !== null && patch.boundSource
          && (patch.atlas !== nextAtlas || patch.boundSource !== source)
          && selected.leaves.some(leaf => !leaf.presumedMissing && !residency.isMissing(leaf.imageKey)
            && !residency.isResident(leaf.imageKey)
            && leaf.tile.z + Math.round(Math.log2(Math.sqrt(leaf.pages))) > patch.tile.z
            && (tileContains(patch.tile, leaf.tile) || tileContains(leaf.tile, patch.tile)));
        if (awaitingDetail) continue;
        bindManagedDirect(patch, nextAtlas, candidate, source, selected, residencyRevision); continue;
      }
      if ((patch.tableRetryAt ?? 0) > now()) { scheduleWake(patch.tableRetryAt!); continue; }
      const tableBytes = IMAGERY_TABLE_BLOCK ** 2 * 4;
      if (!managed.canUpload(tableBytes, tableBytes)) { capacityBlocked = true; fallbackPatches += 1; continue; }
      let table: HeldPatchTable | null;
      try { table = prepareManagedPatchTable(candidate, patch.tile, { reserve: (bytes, label) => managed.reserveTable(bytes, label) }); }
      catch (error) { reportManaged(error); capacityBlocked = true; continue; }
      if (!table) { capacityBlocked = true; fallbackPatches += 1; continue; }
      if (table.capped) capped += 1; emptyCells += table.emptyCells;
      const tableSignature = signature(table.data, table.cellsLog2);
      if (patch.atlas === nextAtlas && patch.tableSignature === tableSignature && patch.boundSource === source) { patch.boundPlan = selected; patch.boundRevision = residencyRevision; try { table.close(); } catch (error) { reportManaged(error); } continue; }
      const block = nextAtlas.allocateBlock();
      if (block === null) { capacityBlocked = true; fallbackPatches += 1; try { table.close(); } catch (error) { reportManaged(error); } continue; }
      let job: OwnedImageryTableJob | null;
      try { job = nextAtlas.prepareOwnedTable!(block, table.data, () => table!.retain()); }
      catch (error) { reportManaged(error); job = null; }
      if (!job) {
        capacityBlocked = true; fallbackPatches += 1;
        try { nextAtlas.releaseBlock(block); } catch (error) { reportManaged(error); }
        try { table.close(); } catch (error) { reportManaged(error); }
        continue;
      }
      const pending: PendingTable = { patch, atlas: nextAtlas, block, table, signature: tableSignature, source, plan: selected, revision: residencyRevision, display: candidate,
        slots: tableSlots(table), job, outcome: null, retirement: null, closed: false, cancelled: false, backedOff: false };
      patch.pendingTable = pending; pendingTableJobs.add(pending); syncManagedPins();
      void job.settled.then(outcome => {
        pending.outcome = outcome;
        if (outcome?.status !== "uploaded") { backoffPendingTable(pending); cancelManagedTable(pending, outcome?.status === "failed" ? outcome.error : new Error("Table native device/outcome is unavailable.")); }
        finishPendingTable(pending);
      }, error => { pending.outcome = { status: "failed", error }; backoffPendingTable(pending); cancelManagedTable(pending, error); finishPendingTable(pending); });
      void job.retired.then(retirement => {
        if (retirement?.status !== "completed" && retirement?.status !== "device-lost") { reportManaged(new Error("Table retirement proof is malformed; block remains quarantined.")); return; }
        pending.retirement = retirement; if (retirement.cleanupError !== undefined) backoffPendingTable(pending); finishPendingTable(pending);
      }, error => { reportManaged(error); cancelManagedTable(pending, error); /* Keep unknown native block/GPU ownership. */ });
      try { job.submit(); } catch (error) { cancelManagedTable(pending, error); reportManaged(error); }
    }
    syncManagedPins(); updateManagedDisplay(candidate, source, selected); retireUnusedManagedAtlases();
    capacityKey = managed.capacityKey();
  }

  function publish(): void {
    if (managed) { publishManaged(); return; }
    if (!atlas || !requested || !plan) return;
    const residencyRevision = residency.getRevision();
    if (!planChangedSincePublish && !patchesChanged && residencyRevision === lastPublishedResidency) return;
    // Keep showing the old source until the new one's fallback coverage is resident.
    if (displayed !== requested && coverageComplete(requested, plan.coverage)) {
      displayed = requested;
      options.onCoverageChange?.();
    }
    if (displayed === requested && (planChangedSincePublish || residencyRevision !== lastPublishedResidency)) {
      const source = displayed;
      const wasComplete = display !== null;
      display = buildImageryDisplay({
        leaves: plan.leaves.map(leaf => ({ tile: leaf.tile, imageKey: leaf.imageKey, pagesPerSide: Math.round(Math.sqrt(leaf.pages)), presumedMissing: leaf.presumedMissing })),
        coverage: plan.coverage,
        slotsFor: residency.slotsFor,
        standardKey: tile => standardKey(source, tile),
        isMissing: residency.isMissing,
      });
      shownPlan = { plan, source, viewFootprints: lastFocus === null && lastRefine === null };
      if (!wasComplete) options.onCoverageChange?.();
    }
    lastPublishedResidency = residencyRevision;
    planChangedSincePublish = false;
    patchesChanged = false;
    if (!display) return;
    counters.publishes += 1;
    capped = 0;
    emptyCells = 0;
    fallbackPatches = 0;
    const tables: Array<{ patch: PatchState; table: ReturnType<typeof buildPatchTable> }> = [];
    const bindSinglePage = (patch: PatchState): void => {
      let page: { slot: number; z: number } | undefined;
      let { z, x, y } = patch.tile;
      for (;;) {
        page = display!.pages.get(`${z}/${x}/${y}`);
        if (page || z === 0) break;
        z -= 1; x >>= 1; y >>= 1;
      }
      patch.plugin.setTable(null, page ? { slot: page.slot, level: page.z } : null);
      patch.bound = { tile: patch.tile, table: null, directLevel: page?.z ?? null };
    };
    for (const [, patch] of patches) {
      if (!patch.visible) {
        if (patch.block !== null) {
          if (patch.atlas === atlas) atlas.releaseBlock(patch.block);
          patch.block = null;
          patch.tableSignature = null;
          patch.table = null;
        }
        continue;
      }
      // After a reallocation, a patch moves to the new atlas once it can be drawn from it.
      if (patch.atlas !== atlas) {
        patch.plugin.setAtlas(atlas);
        patch.atlas = atlas;
      }
      patch.table ??= new Uint8Array(64 * 64 * 4);
      const table = buildPatchTable(display, patch.tile, patch.table);
      if (table.capped) capped += 1;
      emptyCells += table.emptyCells;
      if (table.cellsLog2 === 0) {
        // One page covers this whole patch exactly. It needs no table lookup
        // or block, leaving the budget for patches with finer resident pages.
        if (patch.block !== null) atlas.releaseBlock(patch.block);
        patch.block = null;
        patch.tableSignature = null;
        bindSinglePage(patch);
        continue;
      }
      tables.push({ patch, table });
    }
    tablesNeeded = tables.length;
    // Release every obsolete block before allocating any replacement. A
    // newly visible patch can precede the patch it replaces in cache order.
    for (const { patch, table } of tables) {
      if (patch.block === null) patch.block = atlas.allocateBlock();
      if (patch.block === null) {
        // No block left: show the one page that covers the whole patch.
        fallbackPatches += 1;
        bindSinglePage(patch);
        continue;
      }
      const tableSignature = signature(table.data, table.cellsLog2);
      if (tableSignature !== patch.tableSignature) {
        atlas.writeBlock(patch.block, table.data);
        patch.tableSignature = tableSignature;
        counters.tableWrites += 1;
      }
      const origin = atlas.blockOrigin(patch.block);
      patch.plugin.setTable({ x: origin.x, y: origin.y, cellsLog2: table.cellsLog2 }, null);
      patch.bound = { tile: patch.tile, table: { cellsLog2: table.cellsLog2, data: table.data }, directLevel: null };
    }
    residency.setPinned(display.slots);
    if (retiredAtlas) {
      for (const patch of patches.values()) {
        if (patch.atlas !== retiredAtlas) continue;
        patch.plugin.setAtlas(atlas);
        patch.atlas = atlas;
      }
      retiredAtlas.dispose();
      retiredAtlas = null;
    }
  }

  /**
   * A new atlas for a new budget. The old one keeps drawing, with its pages and
   * tables, until the new one's fallback coverage is resident; then each patch
   * moves over as its table is written. If the new atlas cannot be created,
   * the old one stays and the diagnostics say why.
   */
  function reallocate(reason: "gpu-budget" | "page-tables" | "source"): void {
    if (!atlas && !managed) return;
    const next = allocate(managed ? atlas !== null || managedRetired.size > 0 : false);
    if ("error" in next) {
      allocationError = `${next.error} The atlas stays at ${Math.round((layout?.estimatedBytes ?? 0) / MiB)} MiB.`;
      if (managed) { pendingReallocation = reason; capacityBlocked = true; capacityKey = managed.capacityKey(); }
      options.onFeedback?.();
      return;
    }
    allocationError = null; pendingReallocation = null;
    if (reason !== "source") reload = reason === "gpu-budget"
      ? { cause: "reload", reason, parameter: "map.imagery.gpuBudget", value: limits.gpuBytes / MiB }
      : { cause: "reload", reason, parameter: "map.imagery.pageTablePatches", value: tuning.tablePatches };
    if (managed) {
      for (const patch of patches.values()) cancelPendingTable(patch, new Error("Atlas allocation generation changed."));
      // Cancel obsolete nonresident jobs but retain old resident page owners
      // and pins until the material actually releases the outgoing atlas.
      if (atlas) { managedRetired.add(atlas); retiredResidencies.set(atlas, residency); try { residency.setDemand([]); } catch (error) { reportManaged(error); } }
      else try { residency.dispose(); } catch (error) { reportManaged(error); }
      ({ layout, atlas } = next); residency = createResidency(atlas); countedUploads = 0; countedUploadBytes = 0;
      if (requested) unsupportedReason = null;
      restartSelection = true; planChangedSincePublish = true; patchesChanged = true;
      // Published old materials/tables remain intact until each ready incoming
      // binding is adopted. A second allocation keeps every still-drawn atlas.
      retireUnusedManagedAtlases(); capacityKey = managed.capacityKey(); wakeManaged(); return;
    }
    const outgoingAtlas = atlas;
    if (!outgoingAtlas) throw new Error("Legacy Atlas reallocation requires the current allocation.");
    residency.dispose();
    // A second change before the first finished: the atlas in between was never drawn.
    if (retiredAtlas) outgoingAtlas.dispose(); else retiredAtlas = outgoingAtlas;
    ({ layout, atlas } = next);
    residency = createResidency(atlas);
    for (const patch of patches.values()) {
      patch.block = null;
      patch.tableSignature = null;
      patch.table = null;
    }
    display = null;
    displayed = null;
    restartSelection = true;
    planChangedSincePublish = true;
    options.requestRender();
  }

  function refreshLoadedDetail(): void {
    if (!latestView || !shownPlan) return;
    const surfaceRevision = options.surface.getRevision();
    const moved = imageryViewChanged(measuredView, latestView) || surfaceRevision !== measuredSurfaceRevision;
    const planChanged = measuredPlan !== shownPlan.plan;
    const bindingsChanged = measuredPublish !== counters.publishes;
    if (!moved && !planChanged && !bindingsChanged) return;
    const measureNow = planChanged || now() - measuredAt >= tuning.reselectWhileMovingMs;
    if ((moved || planChanged) && measureNow) {
      const current = shownPlan.plan;
      const source = shownPlan.source.capabilities;
      // Ordinary view selection already measured these regions. Footprints
      // measured from a point describe loading around it, so measure its
      // leaves from the actual view without choosing or requesting more imagery.
      const reusable = shownPlan.viewFootprints && !imageryViewChanged(lastView, latestView) && surfaceRevision === lastSurfaceRevision && current === plan;
      loadedRegions = reusable ? current.leaves.map(leaf => ({
        tile: leaf.tile,
        referenceLevel: leaf.tile.z + Math.log2((leaf.variant === null ? source.tileWidth : source.variants.find(variant => variant.id === leaf.variant)!.width) / 256),
        footprintPx: leaf.footprintPx,
        screenArea: leaf.screenArea,
      })) : measureImageryView({ view: latestView, source, surface: options.surface }, current.leaves.map(leaf => leaf.tile), current.coverage).map(region => ({
        ...region, referenceLevel: region.tile.z + Math.log2(source.tileWidth / 256),
      }));
      measuredPlan = current;
      measuredView = latestView;
      measuredSurfaceRevision = surfaceRevision;
      measuredAt = now();
    } else if (moved) {
      scheduleWake(measuredAt + tuning.reselectWhileMovingMs);
      if (!bindingsChanged) return;
    }
    loadedTarget = measureLoadedImagery(loadedRegions, [...patches.values()].filter(patch => patch.visible && patch.bound).map(patch => patch.bound!), shownPlan.plan.physicalTarget * 2 ** shownPlan.plan.offset);
    measuredPublish = counters.publishes;
  }

  /**
   * Each limit on visible imagery, from the decision that applied it: the
   * plan's shortfall, residency's placement and the last publication.
   */
  function currentConstraints(source: SourceState, stats: ImageryResidencyStats): ImageryConstraint[] {
    const constraints: ImageryConstraint[] = [];
    if (!atlas || !layout) return constraints;
    const configuredMiB = limits.gpuBytes / MiB;
    if (plan) {
      const { regions, morePages, bindingLevels } = plan.shortfall;
      if (regions.missing + regions.ceiling + regions.outside + regions.density > 0) {
        constraints.push({
          cause: "source", missingRegions: regions.missing, finestLevelRegions: regions.ceiling,
          finestLevel: source.capabilities.maxLevel, outsideRegions: regions.outside, scaleRegions: regions.density,
        });
      }
      if (regions.pages > 0) {
        constraints.push({
          cause: "gpu-budget", parameter: "map.imagery.gpuBudget", configuredMiB,
          atlasMiB: layout.estimatedBytes / MiB, atlasPages: atlas.capacity, rendererCapped: atlasCappedByBackend(),
          selectablePages: pageBudget(), selectedPages: plan.leaves.reduce((sum, leaf) => sum + leaf.pages, 0),
          morePagesAtLeast: morePages, regions: regions.pages, reducedRegions: reduced.pages,
        });
      }
      if (regions.nodes > 0) {
        constraints.push({
          cause: "node-cap", parameter: "map.imagery.maxNodes", configured: tuning.maxNodes,
          examined: plan.nodesEvaluated, regions: regions.nodes, reducedRegions: reduced.nodes,
        });
      }
      if (regions.binding > 0 || capped > 0) {
        constraints.push({ cause: "binding-depth", tableDepth: IMAGERY_TABLE_MAX_CELLS_LOG2, levels: bindingLevels, regions: regions.binding, cappedPatches: capped });
      }
    }
    if (stats.unplaced > 0) {
      constraints.push({
        cause: "atlas-full", parameter: "map.imagery.gpuBudget", configuredMiB, atlasPages: atlas.capacity,
        pinnedPages: stats.pinnedPages, waitingImages: stats.unplaced,
      });
    }
    if (fallbackPatches > 0) {
      constraints.push({
        cause: "page-tables", parameter: "map.imagery.pageTablePatches", configured: tuning.tablePatches,
        effective: managed ? Math.min(tuning.tablePatches, Math.floor(layout.tableBlocks / 2)) : layout.tableBlocks, needed: tablesNeeded, patches: fallbackPatches,
      });
    }
    if (backendLimited) constraints.push({ cause: "renderer", reason: "no-explicit-gradients" });
    if (reload) constraints.push(reload);
    return constraints;
  }

  function refreshFeedback(): void {
    let next: ImageryFeedback;
    if (!atlas || !requested) {
      next = { support: "unavailable", reason: unsupportedReason ?? "Imagery is unavailable.", pending: false, limits: [], activeTarget: null, loadedTarget: null, effectiveTarget: null, source: null, constraints: [] };
    } else {
      const stats = residency.stats();
      const limitSet = new Set<DetailLimit>([...(plan?.limits ?? []), ...stats.limits]);
      if (capped > 0 || fallbackPatches > 0 || backendLimited || (atlasCappedByBackend() && limitSet.has("memory"))) limitSet.add("backend");
      const pending = restartSelection || settleDue || selector.isRunning() || residency.isBusy() || (display?.fallbackLeaves ?? 0) > 0 || displayed !== requested || !plan || (managed !== undefined && (patchesChanged || planChangedSincePublish || pendingTableJobs.size > 0));
      if (pending) limitSet.add("loading");
      // A reload is over once the view has everything it asks for again.
      if (!pending) reload = null;
      const limitsList = (["source", "backend", "memory", "loading"] as const).filter(limit => limitSet.has(limit));
      const { id, version } = requested.capabilities;
      next = {
        support: "ready",
        pending,
        limits: limitsList,
        activeTarget: offset,
        loadedTarget,
        effectiveTarget: !pending && limitsList.length === 0 ? offset : null,
        source: { id, version, label: requested.descriptor.label ?? id },
        constraints: currentConstraints(requested, stats),
      };
    }
    if (!Object.is(next.loadedTarget, feedback.loadedTarget) || JSON.stringify(next) !== JSON.stringify(feedback)) {
      feedback = next;
      options.onFeedback?.();
    }
  }

  const onContextRestored = (): void => {
    if (disposed) return;
    if (managed) {
      const errors: unknown[] = [];
      for (const patch of patches.values()) {
        cancelPendingTable(patch, new Error("Observed context restoration retired the old table generation."));
        const oldAtlas = patch.atlas, oldBlock = patch.block, oldTable = patch.ownedTable;
        patch.block = null; patch.tableSignature = null; patch.table = null; patch.ownedTable = null; patch.bound = null; patch.boundSlots = new Set(); patch.boundSource = null; patch.atlas = null;
        try { patch.plugin.setBinding(null, null, null); } catch (error) { errors.push(error); }
        try { if (oldBlock !== null) oldAtlas?.releaseBlock(oldBlock); } catch (error) { errors.push(error); }
        try { oldTable?.close(); } catch (error) { errors.push(error); }
      }
      try { residency.dispose(); } catch (error) { errors.push(error); }
      if (atlas) managedRetired.add(atlas);
      atlas = null; layout = null; display = null; displayed = null; acceptedCoverage.clear(); shownPlan = null; loadedTarget = null;
      restartSelection = true; planChangedSincePublish = true; patchesChanged = true;
      reload = { cause: "reload", reason: "context-restored", parameter: null, value: null };
      retireUnusedManagedAtlases();
      if (!options.restoreManagedDevice) {
        unsupportedReason = "Managed imagery restoration needs an explicit restored host device adapter.";
        pendingReallocation = null;
      } else {
        try { device = options.restoreManagedDevice(); reallocate("page-tables"); } catch (error) { errors.push(error); unsupportedReason = "The restored host imagery adapter is unavailable."; }
      }
      if (errors.length) reportManaged(errors.length === 1 ? errors[0] : new AggregateError(errors, "Managed imagery restoration cleanup failed."));
      wakeManaged(); return;
    }
    // Raw textures come back empty: drop residency and tables and load again.
    reload = { cause: "reload", reason: "context-restored", parameter: null, value: null };
    const resetAtlas = atlas, resetResidency = residency;
    display = null;
    displayed = null;
    shownPlan = null;
    loadedTarget = null;
    for (const patch of patches.values()) {
      patch.block = null;
      patch.tableSignature = null;
      patch.bound = null;
    }
    restartSelection = true;
    finishOwnedCleanup([
      () => resetAtlas?.clear(), () => { if (!disposed) resetResidency.reset(); },
      () => { if (!disposed) options.requestRender(); },
    ], "Imagery restoration reset failed.");
  };
  const engine = options.scene.getEngine() as unknown as { onContextRestoredObservable?: { add(callback: () => void): unknown; removeCallback(callback: () => void): void } };
  const disposeOwned = (): void => {
    if (disposed) return;
    disposed = true;
    const stopWake = wakeTimer, ownedAtlas = atlas, oldAtlas = retiredAtlas, stopCapacity = stopAvailable;
    stopAvailable = null; const otherAtlases = [...managedRetired], otherResidencies = [...retiredResidencies.values()]; managedRetired.clear(); retiredResidencies.clear();
    const ownedPatches = [...patches.values()];
    wakeTimer = undefined; wakeAt = Infinity; atlas = null; retiredAtlas = null; patches.clear();
    finishOwnedCleanup([
      () => stopWake?.(), () => stopCapacity?.(),
      () => engine.onContextRestoredObservable?.removeCallback(onContextRestored),
      () => residency.dispose(), ...otherResidencies.map(old => () => old.dispose()), () => options.releaseOwnedLoader?.(),
      ...ownedPatches.flatMap(patch => [
        () => cancelPendingTable(patch, new Error("Imagery runtime disposed.")),
        () => patch.plugin.setAtlas(null), () => patch.ownedTable?.close(),
      ]),
      () => ownedAtlas?.dispose(), () => oldAtlas?.dispose(), ...otherAtlases.map(old => () => old.dispose()),
    ], "Imagery resource cleanup failed.");
  };
  try { engine.onContextRestoredObservable?.add(onContextRestored); }
  catch (error) {
    finishOwnedCleanup([disposeOwned], "Imagery observer setup and resource cleanup failed.", [error]);
    throw error;
  }

  return {
    get supported() { return atlas !== null && requested !== null; },
    setLimits(next) {
      const reallocating = next.gpuBytes !== limits.gpuBytes;
      limits = { ...next };
      if (reallocating) reallocate("gpu-budget");
      else residency.setLimits(limits);
      restartSelection = true;
      options.requestRender();
    },
    setTuning(next) {
      const reallocating = next.tablePatches !== tuning.tablePatches;
      const anisotropy = next.anisotropy !== tuning.anisotropy;
      tuning = { ...next, hysteresis: { ...next.hysteresis } };
      if (anisotropy) {
        atlas?.setAnisotropy(tuning.anisotropy);
        retiredAtlas?.setAnisotropy(tuning.anisotropy);
      }
      if (reallocating) reallocate("page-tables");
      restartSelection = true;
      options.requestRender();
    },
    setSource(source) {
      const next = resolveSource(source);
      if (!next) {
        unsupportedReason = `${source.id} tiles are not a supported size.`;
        requested = null;
        refreshFeedback();
        return;
      }
      if (requested && imageSourceKey(requested.capabilities) === imageSourceKey(next.capabilities)) return;
      requested = next;
      selector.reset();
      plan = null;
      reduced = { pages: 0, nodes: 0 };
      restartSelection = true;
      // Incoming source pages cannot evict still-bound outgoing slots. Borrow
      // the existing charged overlap allocation and retire it only after each
      // replacement binding adopts. Refusal keeps the displayed source intact.
      if (managed && [...patches.values()].some(patch => patch.boundSource)) reallocate("source");
      options.requestRender();
    },
    setOffset(next) {
      if (!Number.isFinite(next) || next === offset) return;
      offset = next;
      restartSelection = true;
      refreshFeedback();
      options.requestRender();
    },
    attachPatch(key, tile, material) {
      if (!atlas) return;
      const existing = patches.get(key);
      if (existing) return;
      const plugin = new ImageryAtlasMaterialPlugin(material);
      plugin.setAtlas(atlas);
      plugin.setPatch(tile.z, tile.x, tile.y);
      patches.set(key, { tile, plugin, atlas, visible: false, block: null, tableSignature: null, table: null, bound: null });
      patchesChanged = true;
    },
    detachPatch(key) {
      const patch = patches.get(key);
      if (!patch) return;
      if (managed) {
        patches.delete(key); cancelPendingTable(patch, new Error("Imagery patch detached."));
        try { if (patch.block !== null) patch.atlas?.releaseBlock(patch.block); } catch (error) { reportManaged(error); }
        try { patch.ownedTable?.close(); } catch (error) { reportManaged(error); }
        try { patch.plugin.setBinding(null, null, null); } catch (error) { reportManaged(error); }
        patchesChanged = true; syncManagedPins(); retireUnusedManagedAtlases(); return;
      }
      if (patch.block !== null && patch.atlas === atlas) atlas?.releaseBlock(patch.block);
      patches.delete(key);
      patchesChanged = true;
    },
    setPatchVisible(key, visible) {
      const patch = patches.get(key);
      if (!patch || patch.visible === visible) return;
      patch.visible = visible;
      patchesChanged = true;
    },
    hasCoverage(tile) {
      if (managed && displayed && display) {
        const roots = rootsCovering(displayed, tile);
        return roots.every(root => acceptedCoverage.has(`${root.z}/${root.x}/${root.y}`));
      }
      const source = displayed;
      if (!source || !display) return false;
      return coverageComplete(source, rootsCovering(source, tile));
    },
    getDisplayedSourceId: () => displayed?.descriptor.id ?? null,
    update() {
      if (!disposed && managed && pendingReallocation && !capacityBlocked) reallocate(pendingReallocation);
      if (disposed || !atlas || !requested || pendingReallocation === "source") {
        refreshFeedback();
        return;
      }
      select();
      residency.pump();
      const refusalsBefore = residency.stats().uploadRefusals ?? 0;
      const uploadStarted = now();
      const bytes = residency.upload(uploadStarted + limits.cpuMsPerUpdate);
      if (managed) {
        const completed = residency.stats();
        counters.uploads += Math.max(0, completed.uploads - countedUploads); counters.uploadBytes += Math.max(0, completed.uploadBytes - countedUploadBytes);
        countedUploads = completed.uploads; countedUploadBytes = completed.uploadBytes;
      } else if (bytes > 0) {
        counters.uploads += 1;
        counters.uploadBytes += bytes;
      }
      publish();
      refreshLoadedDetail();
      refreshFeedback();
      // Admitted work that is waiting only on this thread asks for another update.
      const stats = residency.stats();
      if (selector.isRunning() || (stats.staged > 0 && bytes > 0)) options.requestRender();
      if (managed) { if ((stats.uploadRefusals ?? 0) > refusalsBefore && stats.staged > 0) capacityBlocked = true; capacityKey = managed.capacityKey(); }
      scheduleWake(residency.nextWakeAt());
    },
    getFeedback: () => feedback,
    getDiagnostics() {
      const levels: Record<number, number> = {};
      const footprints: [number, number, number, number, number] = [0, 0, 0, 0, 0];
      for (const leaf of plan?.leaves ?? []) {
        levels[leaf.tile.z] = (levels[leaf.tile.z] ?? 0) + 1;
        const f = leaf.footprintPx;
        footprints[f <= 0.5 ? 0 : f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 3 : 4] += 1;
      }
      let blocks = 0;
      for (const patch of patches.values()) if (patch.block !== null) blocks += 1;
      const boundLevel = createBoundLevels([...patches.values()].filter(patch => patch.visible && patch.bound).map(patch => patch.bound!));
      return {
        requestedSource: requested?.descriptor.id ?? options.source.id,
        displayedSource: displayed?.descriptor.id ?? null,
        offset,
        backend: capabilities.backend,
        plan: plan && {
          leaves: plan.leaves.length,
          levels,
          variants: plan.leaves.filter(leaf => leaf.variant !== null).length,
          limits: plan.limits,
          nodesEvaluated: plan.nodesEvaluated,
          truncated: plan.truncated,
          cpuMs: plan.cpuMs,
          footprints,
          regions: plan.leaves.map(leaf => ({
            key: leaf.key, variant: leaf.variant, delivered: boundLevel(leaf.tile),
            footprintPx: leaf.footprintPx, screenArea: Math.round(leaf.screenArea), limit: leaf.limit,
          })),
          refinedPastMissing: plan.shortfall.refinedPastMissing,
        },
        focus: focusDiagnostics(),
        residency: residency.stats(),
        atlas: atlas && layout && {
          capacity: atlas.capacity,
          freeSlots: atlas.freeSlots(),
          estimatedGpuBytes: layout.estimatedBytes,
          width: layout.width,
          height: layout.height,
          tableBlocks: layout.tableBlocks,
        },
        allocationError,
        binding: { patches: patches.size, blocks, tablesNeeded, fallbackPatches, fallbackLeaves: display?.fallbackLeaves ?? 0, capped, emptyCells },
        counters: { ...counters },
        constraints: feedback.constraints,
      };
    },
    dispose: disposeOwned,
  };
}
