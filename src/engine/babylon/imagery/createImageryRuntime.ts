import type { Material, Scene, TransformNode } from "@babylonjs/core";
import type { TileId } from "../../../terrain/imagery/imageryGeometry";
import {
  createImagerySelector,
  estimateFocusPages,
  imageKey,
  imageSourceKey,
  measureImageryView,
  type ImageryFocus,
  type ImageryHysteresis,
  type ImageryPlan,
  type ImagerySelectionInput,
  type ImagerySourceCapabilities,
  type ImagerySurface,
} from "../../../terrain/imagery/imagerySelector";
import type { ImageryConstraint, ImageryReloadConstraint } from "../../../terrain/imagery/imageryConstraints";
import { imagerySourceSupport, imageryTileUrl, type ImageryDescriptor } from "../../../terrain/imagery/imagerySources";
import type { DetailLimit } from "../../../terrain/mapDetailPolicy";
import { createImageryAtlas, planAtlasForBackend, readAtlasCapabilities, type AtlasCapabilities, type ImageryAtlas } from "./imageryAtlas";
import { IMAGERY_TABLE_MAX_CELLS_LOG2, slotBytes, type ImageryAtlasLayout } from "./imageryAtlasLayout";
import { buildImageryDisplay, buildPatchTable, createBoundLevels, measureLoadedImagery, type ImageryDisplay, type LoadedImageryBinding, type LoadedImageryRegion } from "./imageryBinding";
import { createBrowserImageryLoader } from "./imageryLoader";
import { ImageryAtlasMaterialPlugin } from "./imageryMaterialPlugin";
import {
  createImageryResidency,
  type ImageryLoader,
  type ImageryRequest,
  type ImageryResidency,
  type ImageryResidencyStats,
  type ImageryResourceLimits,
} from "./imageryResidency";
import { imageryViewChanged, readImageryView } from "./imageryView";

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
  hysteresis: ImageryHysteresis;
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
  onDownloadBytes?(bytes: number): void;
  onError?(error: Error, url: string): void;
  /** Delivery or support changed. */
  onFeedback?(): void;
  /** Fallback coverage became usable or changed: terrain may show more patches. */
  onCoverageChange?(): void;
  loader?: ImageryLoader;
  capabilities?: AtlasCapabilities;
  now?: () => number;
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
  const now = options.now ?? (() => performance.now());
  const worldRoot = options.worldRoot ?? null;
  let limits = options.limits;
  let tuning = options.tuning;
  const capabilities = options.capabilities ?? readAtlasCapabilities(options.scene);

  /** The largest atlas the budget and the renderer allow. */
  const allocate = (): { layout: ImageryAtlasLayout; atlas: ImageryAtlas } | { error: string } => {
    const nextLayout = planAtlasForBackend(capabilities, limits.gpuBytes, tuning.tablePatches);
    if (!nextLayout) return { error: "This renderer cannot hold the imagery atlas." };
    try {
      return { layout: nextLayout, atlas: createImageryAtlas(options.scene, nextLayout, tuning.anisotropy) };
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
  if ("error" in first) unsupportedReason = first.error;
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
    for (const problem of support.problems) console.warn("[imagery]", problem);
    return support.capabilities ? { descriptor, capabilities: support.capabilities } : null;
  };
  let requested = resolveSource(options.source);
  if (!requested) unsupportedReason ??= `${options.source.id} tiles are not a supported size.`;
  let displayed: SourceState | null = null;
  let offset = options.offset ?? 0;

  const loader = options.loader ?? createBrowserImageryLoader({ onBytes: options.onDownloadBytes });
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeAt = Infinity;
  let disposed = false;
  const createResidency = (store: ImageryAtlas | null): ImageryResidency => createImageryResidency({
    loader,
    store: store ?? { capacity: 0, allocate: () => null, release: () => {}, upload: () => {} },
    limits,
    now,
    onChange: () => { if (!disposed) options.requestRender(); },
    onError: options.onError,
  });
  let residency: ImageryResidency = createResidency(atlas);

  const selector = createImagerySelector();
  let plan: ImageryPlan | null = null;
  let restartSelection = true;
  let lastView: ReturnType<typeof readImageryView> = null;
  let lastSurfaceRevision = -1;
  let lastMissingRevision = -1;
  let lastMergeResidency = -1;
  let lastTraversalStart = -Infinity;
  let lastFocus: ImageryFocus | null = null;
  // What the running traversal measured; a traversal can span several frames.
  let traversalInputs: { view: NonNullable<ReturnType<typeof readImageryView>>; surfaceRevision: number; missingRevision: number; focus: ImageryFocus | null } | null = null;
  let lastPublishedResidency = -1;
  let planChangedSincePublish = true;
  let patchesChanged = true;
  let display: ImageryDisplay | null = null;
  let shownPlan: { plan: ImageryPlan; source: SourceState; focus: boolean } | null = null;
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

  const scheduleWake = (at: number | null): void => {
    if (disposed || at === null || !Number.isFinite(at) || at >= wakeAt) return;
    wakeAt = at;
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      wakeAt = Infinity;
      options.requestRender();
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

  function selectionInput(view: NonNullable<ReturnType<typeof readImageryView>>, source: SourceState, focus: ImageryFocus | null): ImagerySelectionInput {
    return {
      view,
      source: source.capabilities,
      offset,
      surface: options.surface,
      availability: { isResident: residency.isResident, isMissing: residency.isMissing, getRevision: residency.getRevision },
      maxLevelFor: options.surface.maxLevelFor,
      maxPages: pageBudget(),
      maxNodes: tuning.maxNodes,
      hysteresis: tuning.hysteresis,
      focus,
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
      const before = leaf.footprintPx * 2 ** Math.max(0, pageLevel - shownLevel);
      const benefit = leaf.screenArea * (exceed(before) - exceed(leaf.footprintPx)) + leaf.screenArea * 1e-3 + 1e-6;
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
    const due = plan?.wakeAt !== null && plan?.wakeAt !== undefined && now() >= plan.wakeAt;
    const mergeReady = (plan?.mergeCandidates.length ?? 0) > 0 && residency.getRevision() !== lastMergeResidency;
    // Around a focus point the view decides nothing: turning the camera selects nothing again.
    const viewMatters = focus?.mode !== "around";
    const wanted = restartSelection || selector.isRunning() || !plan
      || (viewMatters && imageryViewChanged(lastView, view)) || focusChanged(lastFocus, focus)
      || surfaceRevision !== lastSurfaceRevision
      || missingRevision !== lastMissingRevision || due || mergeReady;
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
      traversalInputs = { view, surfaceRevision, missingRevision, focus };
    }
    const step = selector.step(selectionInput(view, requested, traversalInputs?.focus ?? focus), started + limits.cpuMsPerUpdate, now, restartSelection);
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
    lastSurfaceRevision = traversalInputs?.surfaceRevision ?? surfaceRevision;
    lastMissingRevision = traversalInputs?.missingRevision ?? missingRevision;
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
  }

  function publish(): void {
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
      shownPlan = { plan, source, focus: lastFocus !== null };
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
  function reallocate(reason: "gpu-budget" | "page-tables"): void {
    if (!atlas) return;
    const next = allocate();
    if ("error" in next) {
      allocationError = `${next.error} The atlas stays at ${Math.round((layout?.estimatedBytes ?? 0) / MiB)} MiB.`;
      options.onFeedback?.();
      return;
    }
    allocationError = null;
    reload = reason === "gpu-budget"
      ? { cause: "reload", reason, parameter: "map.imagery.gpuBudget", value: limits.gpuBytes / MiB }
      : { cause: "reload", reason, parameter: "map.imagery.pageTablePatches", value: tuning.tablePatches };
    residency.dispose();
    // A second change before the first finished: the atlas in between was never drawn.
    if (retiredAtlas) atlas.dispose(); else retiredAtlas = atlas;
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
      // Ordinary view selection already measured these regions. Focus
      // footprints describe loading around a point, so measure its leaves
      // from the actual view without choosing or requesting more imagery.
      const reusable = !shownPlan.focus && !imageryViewChanged(lastView, latestView) && surfaceRevision === lastSurfaceRevision && current === plan;
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
        effective: layout.tableBlocks, needed: tablesNeeded, patches: fallbackPatches,
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
      const pending = restartSelection || selector.isRunning() || residency.isBusy() || (display?.fallbackLeaves ?? 0) > 0 || displayed !== requested || !plan;
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
    // Raw textures come back empty: drop residency and tables and load again.
    reload = { cause: "reload", reason: "context-restored", parameter: null, value: null };
    atlas?.clear();
    residency.reset();
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
    options.requestRender();
  };
  const engine = options.scene.getEngine() as unknown as { onContextRestoredObservable?: { add(callback: () => void): unknown; removeCallback(callback: () => void): void } };
  engine.onContextRestoredObservable?.add(onContextRestored);

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
      const source = displayed;
      if (!source || !display) return false;
      return coverageComplete(source, rootsCovering(source, tile));
    },
    getDisplayedSourceId: () => displayed?.descriptor.id ?? null,
    update() {
      if (disposed || !atlas || !requested) {
        refreshFeedback();
        return;
      }
      select();
      residency.pump();
      const uploadStarted = now();
      const bytes = residency.upload(uploadStarted + limits.cpuMsPerUpdate);
      if (bytes > 0) {
        counters.uploads += 1;
        counters.uploadBytes += bytes;
      }
      publish();
      refreshLoadedDetail();
      refreshFeedback();
      // Admitted work that is waiting only on this thread asks for another update.
      const stats = residency.stats();
      if (selector.isRunning() || (stats.staged > 0 && bytes > 0)) options.requestRender();
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
    dispose() {
      disposed = true;
      clearTimeout(wakeTimer);
      engine.onContextRestoredObservable?.removeCallback(onContextRestored);
      residency.dispose();
      (loader as { dispose?: () => void }).dispose?.();
      for (const patch of patches.values()) patch.plugin.setAtlas(null);
      patches.clear();
      atlas?.dispose();
      atlas = null;
      retiredAtlas?.dispose();
      retiredAtlas = null;
    },
  };
}
