import { describeGoogleTileFailure, readGoogleTileHttpFailure, type GoogleTileHttpFailure } from "../browser/describeGoogleTileFailure.js";
import { measureMapResponse } from "../browser/mapDownloadMeter.js";
import { Matrix, Vector3, type Scene, type TransformNode } from "@babylonjs/core";
import type { Tile, TilesRendererBase, TilesRendererBaseEventMap } from "3d-tiles-renderer/core";
import type { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { NumberRange } from "@foss-earth/ui/settings";
import { isSphereBelowHorizon } from "../terrain/imagery/imageryGeometry.js";
import type { TerrainLightingAdapter } from "./imagery/terrainLightPlugin.js";
import type { whenMeshesReady } from "@foss-earth/renderer/babylon";
import type { GoogleTileResourceTiming } from "../browser/describeGoogleTileFailure.js";
import type { SurfaceOwnerChange } from "../surface/currentReadiness.js";
import { createNativeMapSettlement, NativeMapStartupError } from "./nativeMapSettlement.js";
import { finishOwnedCleanup } from "./ownedCleanup.js";

/** Structural Babylon binding over the public core traversal contract. */
export interface GoogleTilesRenderer extends TilesRendererBase<TilesRendererBaseEventMap<TransformNode>> {
  group: TransformNode;
  checkCollisions: boolean;
}

const GOOGLE_3D_TILES_ROOT_URL = "https://tile.googleapis.com/v1/3dtiles/root.json";

export interface GoogleTilesRuntimeOptions {
  scene: Scene;
  apiKey: string;
  /**
   * Optional scene-space point used to choose Google tile refinement. The
   * active Babylon camera still controls the visible frustum.
   */
  getTerrainDetailAnchor?: () => Vector3 | null;
  /**
   * A region loaded around a focus point, beyond or instead of the view:
   * `map.focus.*`. Read once per update. Null or omitted: the view only.
   */
  getFocus?: () => GoogleFocus | null;
  onDownloadBytes?: (bytes: number) => void;
  onLoadError?: (error: Error, url: string) => void;
  onLoadStart?: () => void;
  onLoadEnd?: (visibleTiles: number, activeTiles: number) => void;
  /** The camera-visible loaded geometric error changed after a traversal. */
  onDetailFeedback?: () => void;
  /** Actual visibility/disposal/adoption or loading/suspension status changed. */
  onSurfaceChange?: (change: SurfaceOwnerChange) => void;
  /** The registry holding `map.google.*`, followed live. Required from the host. */
  settings: SettingsRegistry;
  /** Third-party map traversal/parser consumes the supplied scene/device. */
  createTilesRenderer(rootUrl: string, scene: Scene): GoogleTilesRenderer;
  createAuthPlugin(options: { apiToken: string; autoRefreshToken: boolean; useRecommendedSettings: boolean }): GoogleCloudAuthPlugin;
  createAbortController(): AbortController;
  combineSignals(signals: readonly AbortSignal[]): AbortSignal;
  /** Bound to the host renderer's readiness/timer policy. */
  whenMeshesReady: typeof whenMeshesReady;
  lighting: Pick<TerrainLightingAdapter, "followTerrainLight">;
  responseRealm: { Response: typeof Response; TransformStream: typeof TransformStream };
  recordMapRequest(url: string): void;
  resourceTiming(url: string): GoogleTileResourceTiming | null;
  online(): boolean | undefined;
  origin(): string | undefined;
  log: { info(...values: unknown[]): void; error(...values: unknown[]): void };
}

export interface GoogleTilesRuntime {
  tiles: GoogleTilesRenderer;
  /** Changes when the visible collision surface is replaced or removed. */
  getRevision(): number;
  /** What the `map.google.*` budgets bound right now. */
  getLoadingState(): GoogleLoadingState;
  /** The renderer's pixel-based detail target, optionally overridden for a session. */
  getTerrainDetailState(): GoogleTerrainDetailState;
  setTerrainDetailTarget(errorTarget: number | null): void;
  update(): void;
  /**
   * While suspended, nothing is selected (`update` does nothing) and the
   * download and parse queues start no job; running jobs finish. Queued
   * tiles wait for the next selection.
   */
  setSuspended(suspended: boolean): void;
  dispose(): void;
}
export interface SettledGoogleTilesRuntime extends GoogleTilesRuntime { whenSettled(): Promise<void> }

/** What to load around a focus point. */
export interface GoogleFocus {
  /** "around": everything within the radius by distance from the point, the rest only coarsely. "both": that and the view. */
  mode: "around" | "both";
  /** ECEF metres, which is the tileset's own space. */
  position: { x: number; y: number; z: number };
  radiusMeters: number;
  /** The smallest error target the region may ask for, in px; null follows the renderer's. */
  finestErrorPx: number | null;
  horizonCull: boolean;
}

export interface GoogleLoadingState {
  cachedTiles: number;
  cachedBytes: number;
  /** Tiles waiting for a download slot. */
  queued: number;
  /** Downloads and parses running now, which `map.google.downloads` and `.parses` bound. */
  downloading: number;
  parsing: number;
  /** Downloaded tiles waiting for a parse slot. */
  waitingToParse: number;
  /**
   * Tiles whose children the renderer is still preparing. Until they are
   * ready it cannot ask for anything finer, though nothing is downloading.
   */
  preparingChildren: number;
}

const MiB = 1024 * 1024;
export const GOOGLE_LOADING_IDS = ["map.google.cacheTiles", "map.google.cacheBytes", "map.google.downloads", "map.google.parses"] as const;

/** The renderer's cache and queues as the `map.google.*` parameters say. */
function applyLoadingParameters(tiles: GoogleTilesRenderer, settings: SettingsRegistry, suspended = false): void {
  const count = settings.get<NumberRange>("map.google.cacheTiles");
  const bytes = settings.get<NumberRange>("map.google.cacheBytes");
  tiles.lruCache.minSize = Math.round(count.min);
  tiles.lruCache.maxSize = Math.round(count.max);
  tiles.lruCache.minBytesSize = bytes.min * MiB;
  tiles.lruCache.maxBytesSize = bytes.max * MiB;
  // Suspended, the queues hold what they have and start nothing.
  tiles.downloadQueue.maxJobs = suspended ? 0 : Math.round(settings.get<number>("map.google.downloads"));
  tiles.parseQueue.maxJobs = suspended ? 0 : Math.round(settings.get<number>("map.google.parses"));
}

/**
 * `errorTarget` is the 3D Tiles renderer's screen-space-error target in
 * pixels. It changes which children are selected for rendering; it is not an
 * elevation-accuracy measurement.
 */
export interface GoogleTerrainDetailState {
  defaultErrorTarget: number;
  errorTarget: number;
  overrideErrorTarget: number | null;
  /**
   * Largest screen-space geometric error of the loaded, camera-visible tile
   * set, in pixels. Independent of the request and refinement anchor. Null
   * means no measurable loaded coverage; Infinity means the camera is inside
   * a tile's bounds, so its projected error has no finite bound.
   */
  loadedErrorTarget: number | null;
}

const MIN_TERRAIN_ERROR_TARGET = 1;
const MAX_TERRAIN_ERROR_TARGET = 524_288;

interface TileViewErrorTarget {
  inView: boolean;
  error: number;
  distanceFromCamera: number;
}

interface TileWithBabylonBounds extends Tile {
  engineData: {
    boundingVolume: {
      distanceToPoint(point: Vector3): number;
      sphere?: { centerWorld: Vector3; radiusWorld: number } | null;
      obb?: { points?: Vector3[] } | null;
    };
  };
}

/** A tile's bounding sphere in tileset space, from its sphere or the corners of its box. */
const tileSpheres = new WeakMap<object, { center: { x: number; y: number; z: number }; radius: number } | null>();
function tileSphere(tile: TileWithBabylonBounds): { center: { x: number; y: number; z: number }; radius: number } | null {
  const volume = tile.engineData.boundingVolume;
  if (tileSpheres.has(volume)) return tileSpheres.get(volume)!;
  let sphere: { center: { x: number; y: number; z: number }; radius: number } | null = null;
  if (volume.sphere) {
    const { centerWorld, radiusWorld } = volume.sphere;
    sphere = { center: { x: centerWorld.x, y: centerWorld.y, z: centerWorld.z }, radius: radiusWorld };
  } else if (volume.obb?.points?.length) {
    const points = volume.obb.points;
    const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
    sphere = { center, radius: Math.max(...points.map(p => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z))) };
  }
  tileSpheres.set(volume, sphere);
  return sphere;
}

interface GoogleTilesRendererWithViewError extends GoogleTilesRenderer {
  calculateTileViewError(tile: TileWithBabylonBounds, target: TileViewErrorTarget): void;
}

/** Reuse the traversal's camera measurement before any focus/anchor overrides. */
function observeLoadedError(tiles: GoogleTilesRenderer): () => number | null {
  const errors = new WeakMap<Tile, number | null>();
  const renderer = tiles as GoogleTilesRendererWithViewError;
  const calculate = renderer.calculateTileViewError.bind(renderer);
  renderer.calculateTileViewError = (tile, target) => {
    calculate(tile, target);
    errors.set(tile, target.inView && !Number.isNaN(target.error) && target.error >= 0 ? target.error : null);
  };
  return () => {
    let worst: number | null = null;
    // Selection is complete now: partially downloaded descendants and tiles
    // kept only for the focus region do not describe the displayed detail.
    for (const tile of tiles.visibleTiles) {
      const error = errors.get(tile);
      if (error != null) worst = worst === null ? error : Math.max(worst, error);
    }
    return worst;
  };
}

interface GoogleTilesRendererWithParsing extends GoogleTilesRenderer {
  parseTile(buffer: ArrayBuffer, tile: Tile & { engineData: { scene: TransformNode | null } }, extension: string, uri: string, signal: AbortSignal): Promise<void>;
}

/** A parsed tile must remain unavailable to REPLACE traversal until it can draw. */
function prepareDrawableTiles(tiles: GoogleTilesRenderer, signal: AbortSignal, ports: Pick<GoogleTilesRuntimeOptions, "whenMeshesReady" | "combineSignals">, work: ReturnType<typeof createNativeMapSettlement>): void {
  const renderer = tiles as GoogleTilesRendererWithParsing;
  const parseTile = renderer.parseTile.bind(renderer);
  renderer.parseTile = (buffer, tile, extension, uri, tileSignal) => work.run(async () => {
    await parseTile(buffer, tile, extension, uri, ports.combineSignals([tileSignal, signal]));
    const model = tile.engineData.scene;
    if (!model || tileSignal.aborted || signal.aborted) return;
    // The adapter keeps the model disabled. Resolving parse marks the tile
    // LOADED and allows its parent to disappear on the next traversal.
    await ports.whenMeshesReady(model.getChildMeshes(), { signal: ports.combineSignals([tileSignal, signal]) });
  });
}

/**
 * The Babylon adapter uses `scene.activeCamera` both for frustum culling and
 * for screen-space-error distance. Flight needs those concerns to be
 * independent: a chase camera can sit far behind the aircraft, while tiles
 * must still refine around the aircraft. Keep the adapter's frustum result,
 * then replace only its distance-derived error.
 *
 * A focus region changes what loads as well. Around a focus point, the view
 * decides nothing: tiles within the radius refine by their distance from the
 * point (never nearer than the camera is to it), in every direction, and the
 * rest of the globe shows only the tiles that cover it coarsely. With the view
 * as well, the region is added to what the camera sees. Rendering still culls
 * by the camera; only what is loaded changes.
 */
function applyViewMeasure(
  tiles: GoogleTilesRenderer,
  scene: Scene,
  getTerrainDetailAnchor: (() => Vector3 | null) | undefined,
  getFocus: (() => GoogleFocus | null) | undefined,
): void {
  if (!getTerrainDetailAnchor && !getFocus) return;

  const renderer = tiles as GoogleTilesRendererWithViewError;
  const nativeCalculateTileViewError = renderer.calculateTileViewError.bind(renderer);
  const nativeUpdate = tiles.update.bind(tiles);
  const worldToTiles = Matrix.Identity();
  const anchorInTiles = Vector3.Zero();
  const cameraInTiles = Vector3.Zero();
  const focusInTiles = Vector3.Zero();
  let hasDetailAnchor = false;
  let focus: GoogleFocus | null = null;
  let focusMinDistance = 0;
  let focusErrorScale = 1;
  let focusViewer = { x: 0, y: 0, z: 0 };
  let isOrthographic = false;
  let orthographicPixelSize = 0;
  let screenSpaceErrorDenominator = 0;

  // A renderer update traverses many tiles. The anchor, focus, tile-group
  // transform, camera projection, and render size remain fixed for that
  // traversal, so calculate them once rather than per tile.
  tiles.update = () => {
    hasDetailAnchor = false;
    focus = null;
    const anchor = getTerrainDetailAnchor?.() ?? null;
    const nextFocus = getFocus?.() ?? null;
    const camera = scene.activeCamera;
    if ((anchor || nextFocus) && camera) {
      tiles.group.getWorldMatrix().invertToRef(worldToTiles);
      const engine = scene.getEngine();
      const hardwareScaling = engine.getHardwareScalingLevel();
      // The world's viewport, which can be part of a canvas other surfaces share.
      const width = engine.getRenderWidth() * camera.viewport.width * hardwareScaling;
      const height = engine.getRenderHeight() * camera.viewport.height * hardwareScaling;
      const projection = camera.getProjectionMatrix().m;
      isOrthographic = projection[15] === 1;
      orthographicPixelSize = Math.max(2 / projection[5] / height, 2 / projection[0] / width);
      screenSpaceErrorDenominator = 2 / projection[5] / height;
      if (anchor) {
        Vector3.TransformCoordinatesToRef(anchor, worldToTiles, anchorInTiles);
        hasDetailAnchor = true;
      }
      if (nextFocus) {
        focus = nextFocus;
        focusInTiles.set(nextFocus.position.x, nextFocus.position.y, nextFocus.position.z);
        Vector3.TransformCoordinatesToRef(camera.globalPosition, worldToTiles, cameraInTiles);
        focusMinDistance = Vector3.Distance(cameraInTiles, focusInTiles);
        const finest = nextFocus.finestErrorPx ?? tiles.errorTarget;
        focusErrorScale = tiles.errorTarget / Math.max(tiles.errorTarget, finest);
        const lift = 1 + focusMinDistance / Math.max(1, focusInTiles.length());
        focusViewer = { x: focusInTiles.x * lift, y: focusInTiles.y * lift, z: focusInTiles.z * lift };
      }
    }
    nativeUpdate();
  };

  const errorAt = (tile: TileWithBabylonBounds, distance: number): number => {
    if (isOrthographic) return tile.geometricError / orthographicPixelSize;
    return distance === 0 ? Infinity : tile.geometricError / (distance * screenSpaceErrorDenominator);
  };

  renderer.calculateTileViewError = (tile, target) => {
    nativeCalculateTileViewError(tile, target);
    if (hasDetailAnchor) {
      const distance = tile.engineData.boundingVolume.distanceToPoint(anchorInTiles);
      target.distanceFromCamera = distance;
      target.error = errorAt(tile, distance);
    }
    if (!focus) return;
    const distance = tile.engineData.boundingVolume.distanceToPoint(focusInTiles);
    const sphere = focus.horizonCull ? tileSphere(tile) : null;
    const hidden = sphere !== null && isSphereBelowHorizon(focusViewer, sphere.center, sphere.radius);
    const within = !hidden && distance <= focus.radiusMeters;
    const focusError = errorAt(tile, Math.max(1, distance, focusMinDistance)) * focusErrorScale;
    if (focus.mode === "around") {
      // Every tile the point can see takes part; only those within the radius refine.
      target.inView = !hidden;
      target.error = within ? focusError : 0;
      target.distanceFromCamera = distance;
    } else if (within) {
      target.inView = true;
      target.error = Math.max(target.error, focusError);
      target.distanceFromCamera = Math.min(target.distanceFromCamera, distance);
    }
  };
}

function normaliseTerrainDetailTarget(errorTarget: number | null): number | null {
  if (errorTarget === null || !Number.isFinite(errorTarget)) return null;
  return Math.max(MIN_TERRAIN_ERROR_TARGET, Math.min(MAX_TERRAIN_ERROR_TARGET, errorTarget));
}

export function createGoogleTilesRuntime(options: GoogleTilesRuntimeOptions): SettledGoogleTilesRuntime {
  const {
    scene,
    onLoadError,
    onLoadStart,
    onLoadEnd,
  } = options;
  const apiKey = options.apiKey.trim();

  if (!apiKey) {
    throw new Error("Google Maps API key is empty.");
  }

  const drawableLifetime = options.createAbortController();
  const tiles = options.createTilesRenderer(GOOGLE_3D_TILES_ROOT_URL, scene);
  const work = createNativeMapSettlement();
  const setupCleanup: (() => void)[] = [() => work.close(), () => drawableLifetime.abort(), () => tiles.dispose()];
  try {
  // Queue removal can reject its outer promise before an already running native
  // callback finishes. Track both; never use queue counters as retirement proof.
  const childQueue = (tiles as GoogleTilesRenderer & { processNodeQueue?: GoogleTilesRenderer["parseQueue"] }).processNodeQueue;
  for (const queue of [tiles.downloadQueue, tiles.parseQueue, ...(childQueue ? [childQueue] : [])]) {
    if (typeof queue.add !== "function") continue; // Legacy CPU doubles have no runnable queue.
    const add = queue.add.bind(queue);
    queue.add = (item, callback) => work.track(add(item, value => work.run(() => callback(value))));
    setupCleanup.push(() => queue.removeByFilter?.(() => true));
  }
  // Present in the installed 0.4.24 implementation, absent in its declarations.
  const rootOwner = tiles as GoogleTilesRenderer & { loadRootTileset?: () => Promise<unknown> };
  if (typeof rootOwner.loadRootTileset === "function") {
    const root = rootOwner.loadRootTileset.bind(tiles);
    rootOwner.loadRootTileset = () => work.run(() => root());
  }
  prepareDrawableTiles(tiles, drawableLifetime.signal, options, work);
  const readLoadedError = observeLoadedError(tiles);
  let loadedErrorTarget: number | null = null;
  applyViewMeasure(tiles, scene, options.getTerrainDetailAnchor, options.getFocus);
  const settings = options.settings;
  let suspended = false;
  applyLoadingParameters(tiles, settings);
  const loadingIds = new Set<string>(GOOGLE_LOADING_IDS);
  const unsubscribeSettings = settings.subscribe(changed => {
    if ([...changed].some(id => loadingIds.has(id))) applyLoadingParameters(tiles, settings, suspended);
  });
  setupCleanup.push(unsubscribeSettings);
  tiles.fetchOptions.mode = "cors";
  tiles.fetchOptions.cache = "default";

  const authPlugin = options.createAuthPlugin({
    apiToken: apiKey,
    autoRefreshToken: true,
    useRecommendedSettings: true,
  });
  // The plugin owns authenticated fetch and retries. Wrap its existing response
  // rather than replacing authentication or patching global fetch.
  const downloader = authPlugin as GoogleCloudAuthPlugin & {
    fetchData(uri: string, options: RequestInit): Promise<Response>;
  };
  const fetchFailures = new Map<string, GoogleTileHttpFailure>();
  const fetchData = downloader.fetchData.bind(downloader);
  downloader.fetchData = (uri, fetchOptions) => work.run(async () => {
    options.recordMapRequest(uri);
    const response = await fetchData(uri, { ...fetchOptions, signal: options.combineSignals([drawableLifetime.signal, ...(fetchOptions.signal ? [fetchOptions.signal] : [])]) });
    if (response instanceof options.responseRealm.Response && !response.ok) {
      try {
        const pathname = new URL(uri, "https://tile.googleapis.com").pathname;
        fetchFailures.set(pathname, await readGoogleTileHttpFailure(response.clone()));
      } catch {
        // The status line is still on the response the renderer will reject.
      }
    }
    return options.onDownloadBytes ? measureMapResponse(response, options.onDownloadBytes, options.responseRealm) : response;
  });
  tiles.registerPlugin(authPlugin);
  // GoogleCloudAuthPlugin applies its recommended 20 px target while it is
  // registered. Preserve that runtime default so "restore" is exact even if
  // the dependency changes it in a later release.
  const defaultErrorTarget = tiles.errorTarget;
  let overrideErrorTarget: number | null = null;
  let surfaceRevision = 0;
  let disposed = false;
  const handleSurfaceChange = (): void => {
    if (disposed) return;
    surfaceRevision += 1;
    options.onSurfaceChange?.("geometry");
  };

  const handleLoadStart = (): void => {
    if (disposed) return;
    options.log.info("[tiles] Google 3D tiles loading started");
    onLoadStart?.();
    if (!disposed) options.onSurfaceChange?.("loading");
  };

  const handleLoadEnd = (): void => {
    if (disposed) return;
    const visibleTiles = tiles.visibleTiles.size;
    const activeTiles = tiles.activeTiles.size;

    options.log.info("[tiles] Google 3D tiles loading completed", {
      visibleTiles,
      activeTiles,
    });

    onLoadEnd?.(visibleTiles, activeTiles);
    if (!disposed) options.onSurfaceChange?.("loading");
  };

  const handleLoadModel = (event: { scene: TransformNode; tile: Tile }): void => {
    if (disposed) return;
    for (const mesh of event.scene.getChildMeshes()) {
      mesh.metadata = { ...mesh.metadata, googleGeometricErrorMeters: event.tile.geometricError };
      // A tile whose material comes unlit is shown under the sky's light on the ground, as 2D imagery is.
      if (mesh.material) options.lighting.followTerrainLight(mesh.material);
    }
    options.onSurfaceChange?.("loading");
  };
  const handleAsyncLoadChange = (): void => { if (!disposed) options.onSurfaceChange?.("loading"); };

  const handleLoadError = (event: { error: Error; url: string | URL }): void => {
    if (disposed) return;
    const url = String(event.url);
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      // The library sometimes reports a relative tile uri.
    }
    const report = describeGoogleTileFailure({
      error: event.error,
      url,
      http: fetchFailures.get(pathname) ?? null,
      resource: options.resourceTiming(url),
      online: options.online(),
      origin: options.origin(),
    });
    options.log.error("[tiles] Failed to load Google 3D tile resource", report);
    onLoadError?.(new Error(report), url);
    if (!disposed) options.onSurfaceChange?.("loading");
  };

  tiles.addEventListener("tiles-load-start", handleLoadStart);
  tiles.addEventListener("tiles-load-end", handleLoadEnd);
  tiles.addEventListener("load-error", handleLoadError);
  tiles.addEventListener("load-model", handleLoadModel);
  tiles.addEventListener("load-content", handleAsyncLoadChange);
  tiles.addEventListener("load-tileset", handleAsyncLoadChange);
  tiles.addEventListener("tile-download-start", handleAsyncLoadChange);
  tiles.addEventListener("tile-visibility-change", handleSurfaceChange);
  tiles.addEventListener("dispose-model", handleSurfaceChange);

  return {
    tiles, whenSettled: () => work.whenSettled(),
    getRevision: () => surfaceRevision,
    getLoadingState() {
      // Present at run time in 0.4.24, though its declarations leave them out.
      const cache = tiles.lruCache as unknown as { itemSet?: Set<unknown>; cachedBytes?: number };
      type Queue = { currJobs?: number; items?: unknown[] };
      const running = (value: unknown): number => (value as Queue).currJobs ?? 0;
      const waiting = (value: unknown): number => (value as Queue).items?.length ?? 0;
      const renderer = tiles as unknown as { stats?: { queued?: number }; processNodeQueue?: Queue };
      const children = renderer.processNodeQueue;
      return {
        cachedTiles: cache.itemSet?.size ?? 0,
        cachedBytes: cache.cachedBytes ?? 0,
        queued: renderer.stats?.queued ?? 0,
        downloading: running(tiles.downloadQueue),
        parsing: running(tiles.parseQueue),
        waitingToParse: waiting(tiles.parseQueue),
        preparingChildren: children ? running(children) + waiting(children) : 0,
      };
    },
    getTerrainDetailState() {
      return { defaultErrorTarget, errorTarget: tiles.errorTarget, overrideErrorTarget, loadedErrorTarget };
    },
    setTerrainDetailTarget(nextErrorTarget) {
      overrideErrorTarget = normaliseTerrainDetailTarget(nextErrorTarget);
      tiles.errorTarget = overrideErrorTarget ?? defaultErrorTarget;
    },
    update() {
      if (suspended || disposed) return;
      tiles.update();
      const next = readLoadedError();
      if (next !== loadedErrorTarget) {
        loadedErrorTarget = next;
        options.onDetailFeedback?.();
      }
      options.onSurfaceChange?.("status");
    },
    setSuspended(next) {
      if (suspended === next || disposed) return;
      suspended = next;
      applyLoadingParameters(tiles, settings, suspended);
      if (!suspended) {
        // Queued jobs wait for an addition or a completion to run; start them now.
        for (const queue of [tiles.downloadQueue, tiles.parseQueue]) (queue as unknown as { scheduleJobRun?: () => void }).scheduleJobRun?.();
      }
      options.onSurfaceChange?.("status");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      surfaceRevision += 1;
      work.close();
      try { finishOwnedCleanup([
        () => drawableLifetime.abort(), unsubscribeSettings,
        ...[tiles.downloadQueue, tiles.parseQueue, ...(childQueue ? [childQueue] : [])].map(queue => () => queue.removeByFilter?.(() => true)),
        () => tiles.removeEventListener("tiles-load-start", handleLoadStart),
        () => tiles.removeEventListener("tiles-load-end", handleLoadEnd),
        () => tiles.removeEventListener("load-error", handleLoadError),
        () => tiles.removeEventListener("load-model", handleLoadModel),
        () => tiles.removeEventListener("load-content", handleAsyncLoadChange),
        () => tiles.removeEventListener("load-tileset", handleAsyncLoadChange),
        () => tiles.removeEventListener("tile-download-start", handleAsyncLoadChange),
        () => tiles.removeEventListener("tile-visibility-change", handleSurfaceChange),
        () => tiles.removeEventListener("dispose-model", handleSurfaceChange),
        () => tiles.dispose(), () => options.onSurfaceChange?.("disposed"),
      ], "Google map cleanup failed."); } catch (error) { work.recordCleanupFailure(error); throw error; }
    },
  };
  } catch (error) {
    const failures: unknown[] = [error]; work.close();
    for (const action of [() => drawableLifetime.abort(), ...[...setupCleanup].reverse()]) {
      try { action(); } catch (cleanup) { failures.push(cleanup); work.recordCleanupFailure(cleanup); }
    }
    throw new NativeMapStartupError(failures, "Google startup and cleanup failed.", () => work.whenSettled());
  }
}
