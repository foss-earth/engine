import { describeGoogleTileFailure, readGoogleTileHttpFailure, type GoogleTileHttpFailure } from "../browser/describeGoogleTileFailure.js";
import { measureMapResponse } from "../browser/mapDownloadMeter.js";
import { Frustum, Matrix, Plane, Vector3, type Scene, type TransformNode } from "@babylonjs/core";
import type { Tile, TilesRendererBase, TilesRendererBaseEventMap } from "3d-tiles-renderer/core";
import type { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { NumberRange } from "@foss-earth/ui/settings";
import { isSphereBelowHorizon } from "../terrain/imagery/imageryGeometry.js";
import { ecefToGeodetic } from "../camera/cameraMath.js";
import type { TerrainLightingAdapter } from "./imagery/terrainLightPlugin.js";
import type { whenMeshesReady } from "@foss-earth/renderer/babylon";
import type { GoogleTileResourceTiming } from "../browser/describeGoogleTileFailure.js";
import type { SurfaceOwnerChange } from "../surface/currentReadiness.js";
import { createNativeMapSettlement, NativeMapStartupError } from "./nativeMapSettlement.js";
import { finishOwnedCleanup } from "./ownedCleanup.js";
import { createGoogleDetailDistribution, unavailableDetailDistribution } from "../terrain/detailDistribution.js";
import type { DetailDistribution } from "../terrain/mapDetailPolicy.js";
import { blendTerrainErrors, TERRAIN_PROXIMITY_DEFAULTS } from "../terrain/terrainSelector.js";

/** Structural Babylon binding over the public core traversal contract. */
export interface GoogleTilesRenderer extends TilesRendererBase<TilesRendererBaseEventMap<TransformNode>> {
  group: TransformNode;
  checkCollisions: boolean;
  /** Explicit native-factory capability; replacing its calculator revokes the fast path. */
  nativeViewSnapshot?: {
    adapter: "babylonjs-0.4.24";
    calculateTileViewError(tile: TileWithBabylonBounds, target: TileViewErrorTarget): void;
  };
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
  /** ECEF anchor, also available when no focus loading region is enabled. */
  getProximityFocus?: () => { x: number; y: number; z: number } | null;
  /** Monotonic clock for anchor prediction. Without a clock, velocity is zero. */
  nowMs?: () => number;
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
  /** One count per drawable in-view tile. Null is not used; unavailable is explicit. */
  loadedDistribution: DetailDistribution;
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
      intersectsFrustum?(planes: Plane[]): boolean;
      sphere?: { centerWorld: Vector3; radiusWorld: number } | null;
      obb?: {
        points?: Vector3[];
        min?: Vector3; max?: Vector3; transform?: Matrix; inverseTransform?: Matrix;
        clampPoint?(point: Vector3, target: Vector3): Vector3;
      } | null;
    };
  };
}

/** A tile's bounding sphere in tileset space, from its sphere or the corners of its box. */
const tileSpheres = new WeakMap<object, { center: { x: number; y: number; z: number }; radius: number } | null>();
function tileSphere(tile: TileWithBabylonBounds): { center: { x: number; y: number; z: number }; radius: number } | null {
  const volume = tile.engineData.boundingVolume;
  const cached = tileSpheres.get(volume);
  if (cached !== undefined) return cached;
  let sphere: { center: { x: number; y: number; z: number }; radius: number } | null = null;
  if (volume.sphere) {
    const { centerWorld, radiusWorld } = volume.sphere;
    sphere = { center: { x: centerWorld.x, y: centerWorld.y, z: centerWorld.z }, radius: radiusWorld };
  } else if (volume.obb?.points?.length) {
    const points = volume.obb.points;
    const center = { x: 0, y: 0, z: 0 };
    for (const point of points) { center.x += point.x / points.length; center.y += point.y / points.length; center.z += point.z / points.length; }
    let radius = 0;
    for (const point of points) radius = Math.max(radius, Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z));
    sphere = { center, radius };
  }
  tileSpheres.set(volume, sphere);
  return sphere;
}

interface GoogleTilesRendererWithViewError extends GoogleTilesRenderer {
  calculateTileViewError(tile: TileWithBabylonBounds, target: TileViewErrorTarget): void;
}

/** Keep the installed adapter's arithmetic and culling, preparing its fixed
 * camera/group state once at the first measurement of each traversal. The
 * factory's function identity makes this opt-in safe for custom renderer ports.
 */
function cacheNativeViewMeasurement(tiles: GoogleTilesRenderer, scene: Scene): void {
  const renderer = tiles as GoogleTilesRendererWithViewError;
  const capability = tiles.nativeViewSnapshot;
  if (capability?.adapter !== "babylonjs-0.4.24" || capability.calculateTileViewError !== renderer.calculateTileViewError) return;
  const calculate = renderer.calculateTileViewError.bind(renderer);
  const update = tiles.update.bind(tiles);
  const worldToTiles = Matrix.Identity(), cameraInTiles = Vector3.Zero();
  const worldPlanes = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
  const tilePlanes: Plane[] = [];
  let depth = 0, prepared = false, invalidatedDuringCapture = false;
  let orthographic = false, pixelSize = 0, denominator = 0;
  tiles.update = () => {
    depth++; prepared = false;
    try { update(); } finally { depth--; prepared = false; }
  };
  renderer.calculateTileViewError = (tile, target) => {
    if (depth === 0) { calculate(tile, target); return; }
    const volume = tile.engineData.boundingVolume;
    if (!volume.intersectsFrustum) { calculate(tile, target); return; }
    if (!prepared) {
      const camera = scene.activeCamera;
      if (!camera) { calculate(tile, target); return; }
      const engine = scene.getEngine();
      const scaling = engine.getHardwareScalingLevel();
      // The native adapter uses the full drawing buffer, including when the
      // camera has a partial viewport. Preserve that existing measurement.
      const width = engine.getRenderWidth() * scaling, height = engine.getRenderHeight() * scaling;
      const projectionMatrix = camera.getProjectionMatrix(), projection = projectionMatrix.m;
      const projectionVersion = projectionMatrix.updateFlag;
      orthographic = projection[15] === 1;
      if (orthographic) {
        const w = 2 / projection[0], h = 2 / projection[5];
        pixelSize = Math.max(h / height, w / width);
      } else denominator = (2 / projection[5]) / height;
      const groupMatrix = tiles.group.getWorldMatrix(), groupVersion = groupMatrix.updateFlag;
      groupMatrix.invertToRef(worldToTiles);
      const x = camera.globalPosition.x, y = camera.globalPosition.y, z = camera.globalPosition.z;
      Vector3.TransformCoordinatesToRef(camera.globalPosition, worldToTiles, cameraInTiles);
      // The adapter passes true despite the current Babylon declaration's
      // zero-argument signature; preserve the call for supplied camera types.
      const nativeCamera = camera as typeof camera & { getTransformationMatrix(force: boolean): Matrix };
      Frustum.GetPlanesToRef(nativeCamera.getTransformationMatrix(true), worldPlanes);
      for (let i = 0; i < 6; i++) tilePlanes[i] = worldPlanes[i].transform(worldToTiles);
      // Native reads the eye before querying the transformation matrix. Camera
      // subclasses can update their cached state in that later call: preserve
      // the first tile's old point, then recapture changed state for later tiles.
      invalidatedDuringCapture = x !== camera.globalPosition.x || y !== camera.globalPosition.y || z !== camera.globalPosition.z
        || projectionVersion !== projectionMatrix.updateFlag || groupVersion !== groupMatrix.updateFlag;
      prepared = true;
    }
    const distance = volume.distanceToPoint(cameraInTiles);
    const error = orthographic ? tile.geometricError / pixelSize : distance === 0 ? Infinity : tile.geometricError / (distance * denominator);
    const inView = volume.intersectsFrustum(tilePlanes);
    target.inView = inView;
    target.error = error;
    target.distanceFromCamera = distance;
    if (invalidatedDuringCapture) prepared = false;
  };
}

/** A coarse stand-in is hidden while its geometric error exceeds this many times the eye's height. */
const STAND_IN_HEIGHT_RATIO = 16;
/** The least eye height counted: near or below the ellipsoid, the eye's height there is not its height above the ground. */
const STAND_IN_MIN_HEIGHT_METERS = 100;

/**
 * While finer tiles load, the renderer keeps a loaded tile drawn in their
 * place, and Google's tile bounds overlap: a tile thousands of kilometres
 * across can contain the camera and stand in for its own distant subtree, its
 * coarse surface kilometres above the ground under the eye and a band across
 * the horizon. A tile with children whose geometric error exceeds its distance
 * from the eye is drawn only as such a stand-in: the traversal refines it at
 * any error target. It is hidden, and so is not ground, while its error also
 * exceeds `STAND_IN_HEIGHT_RATIO` times the eye's height. Coarse tiles nearer
 * the ground's own scale stay, as the finer tiles they stand in for are often
 * all that would show instead. The renderer still counts a hidden tile
 * visible; it is shown again here, unless the renderer has hidden it since.
 * True when what is drawn changed.
 */
function createStandInFilter(tiles: GoogleTilesRenderer, scene: Scene): (enabled: boolean) => boolean {
  type StandIn = TileWithBabylonBounds & { engineData: { scene?: TransformNode | null } };
  const hidden = new Set<StandIn>();
  const worldToTiles = Matrix.Identity(), eye = Vector3.Zero();
  return enabled => {
    let changed = false;
    for (const tile of hidden) if (!tiles.visibleTiles.has(tile)) hidden.delete(tile);
    const camera = scene.activeCamera;
    if (!enabled || !camera) {
      for (const tile of hidden) tile.engineData.scene?.setEnabled(true);
      changed = hidden.size > 0;
      hidden.clear();
      return changed;
    }
    // The eye, in the tiles' frame, once a tile is coarse enough to need it.
    let coarsest: number | null = null;
    for (const tile of tiles.visibleTiles as Set<StandIn>) {
      const node = tile.engineData.scene;
      if (!node) continue;
      let hide = false;
      if (tile.geometricError > STAND_IN_HEIGHT_RATIO * STAND_IN_MIN_HEIGHT_METERS && (tile.children?.length ?? 0) > 0) {
        if (coarsest === null) {
          tiles.group.getWorldMatrix().invertToRef(worldToTiles);
          Vector3.TransformCoordinatesToRef(camera.globalPosition, worldToTiles, eye);
          coarsest = STAND_IN_HEIGHT_RATIO * Math.max(STAND_IN_MIN_HEIGHT_METERS, ecefToGeodetic(eye.x, eye.y, eye.z).altMeters);
        }
        hide = tile.geometricError > coarsest && tile.geometricError > tile.engineData.boundingVolume.distanceToPoint(eye);
      }
      if (hide === hidden.has(tile)) continue;
      if (hide) hidden.add(tile); else hidden.delete(tile);
      node.setEnabled(!hide);
      changed = true;
    }
    return changed;
  };
}

const GOOGLE_TILE_LOADED = 4;

/** A tile the renderer can draw. Mocks without traversal internals still count. */
function tileDrawable(tile: Tile): boolean {
  const internal = tile.internal;
  if (!internal) return true;
  if (internal.hasRenderableContent === false) return false;
  return internal.loadingState === undefined || internal.loadingState === GOOGLE_TILE_LOADED;
}

/**
 * Reuse the traversal's camera measurement before any focus/anchor overrides.
 * The scalar stays the maximum. The distribution counts each drawable in-view
 * tile once, including when that maximum does not change.
 */
function observeLoadedError(tiles: GoogleTilesRenderer): () => { worst: number | null; distribution: DetailDistribution } {
  const samples = new WeakMap<Tile, { inView: boolean; error: number }>();
  const renderer = tiles as GoogleTilesRendererWithViewError;
  const calculate = renderer.calculateTileViewError.bind(renderer);
  renderer.calculateTileViewError = (tile, target) => {
    calculate(tile, target);
    const sample = samples.get(tile);
    if (sample) { sample.inView = target.inView === true; sample.error = target.error; }
    else samples.set(tile, { inView: target.inView === true, error: target.error });
  };
  return () => {
    let worst: number | null = null;
    const measured: Array<{ inView: boolean; error: number; drawable: boolean }> = [];
    // Selection is complete now: partially downloaded descendants and tiles
    // kept only for the focus region do not describe the displayed detail.
    // The maximum stays every in-view measurement. Counts skip tiles that
    // are not drawable yet.
    for (const tile of tiles.visibleTiles) {
      const sample = samples.get(tile);
      if (!sample?.inView) continue;
      if (tileDrawable(tile)) measured.push({ inView: true, error: sample.error, drawable: true });
      if (Number.isNaN(sample.error) || sample.error < 0) continue;
      worst = worst === null ? sample.error : Math.max(worst, sample.error);
    }
    return { worst, distribution: createGoogleDetailDistribution(1, measured) };
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
  settings: SettingsRegistry,
  getProximityFocus: GoogleTilesRuntimeOptions["getProximityFocus"],
  nowMs: GoogleTilesRuntimeOptions["nowMs"],
): () => void {
  const renderer = tiles as GoogleTilesRendererWithViewError;
  const nativeCalculateTileViewError = renderer.calculateTileViewError.bind(renderer);
  const nativeUpdate = tiles.update.bind(tiles);
  const worldToTiles = Matrix.Identity();
  const anchorInTiles = Vector3.Zero();
  const cameraInTiles = Vector3.Zero();
  const focusInTiles = Vector3.Zero();
  const cameraForward = Vector3.Zero();
  const cameraWorld = Matrix.Identity();
  const closestAnchor = Vector3.Zero();
  const closestPoint = Vector3.Zero();
  const capsulePoint = Vector3.Zero();
  const boxStart = Vector3.Zero(), boxEnd = Vector3.Zero();
  const boxBreaks = new Float64Array(8);
  const eyeTrajectory = { start: Vector3.Zero(), end: Vector3.Zero(), previous: Vector3.Zero(), at: Number.NaN, active: false, version: 0 };
  const focusTrajectory = { start: Vector3.Zero(), end: Vector3.Zero(), previous: Vector3.Zero(), at: Number.NaN, active: false, version: 0 };
  // The adapter's preprocessNode constructs a fresh immutable volume for each
  // tile. Reuse its measurement while every capsule/error input is identical.
  // Weak keys release these entries when the renderer evicts their tiles.
  const proximityMeasures = new WeakMap<TileWithBabylonBounds, { revision: number; volume: TileWithBabylonBounds["engineData"]["boundingVolume"]; measure: TileWithBabylonBounds["engineData"]["boundingVolume"]["distanceToPoint"]; geometricError: number; inView: boolean; error: number; distance: number }>();
  const proximityTarget = { inView: false, error: 0, distanceFromCamera: Infinity };
  let settingsDirty = true;
  let proximityRevision = 0, measuredEyeVersion = -1, measuredFocusVersion = -1;
  let measuredProjection = Number.NaN, measuredOrthographic = false, measuredErrorTarget = Number.NaN;
  let distinctFocusTrajectory = false;
  let lookaheadSeconds = 1.5;
  let proximityAnchor: unknown = "both";
  let proximityEnabled = false;
  let coreMeters: number = TERRAIN_PROXIMITY_DEFAULTS.coreMeters;
  let radiusMeters: number = TERRAIN_PROXIMITY_DEFAULTS.radiusMeters;
  let falloffExponent: number = TERRAIN_PROXIMITY_DEFAULTS.falloffExponent;
  let proximityWeight: number = TERRAIN_PROXIMITY_DEFAULTS.proximityWeight;
  let losWeight: number = TERRAIN_PROXIMITY_DEFAULTS.losWeight;
  let gazeExponent: number = TERRAIN_PROXIMITY_DEFAULTS.losGazeExponent;
  let peripheralFloor: number = TERRAIN_PROXIMITY_DEFAULTS.losPeripheralFloor;
  let blendMode: "max" | "power-norm" | "weighted-sum" = TERRAIN_PROXIMITY_DEFAULTS.blendMode;
  let blendPower: number = TERRAIN_PROXIMITY_DEFAULTS.blendPower;
  let maxProximityErrorPx = 8;
  let hasDetailAnchor = false;
  let focus: GoogleFocus | null = null;
  let focusMinDistance = 0;
  let focusErrorScale = 1;
  let focusViewer = { x: 0, y: 0, z: 0 };
  let isOrthographic = false;
  let orthographicPixelSize = 0;
  let screenSpaceErrorDenominator = 0;

  const numberSetting = (id: string, fallback: number): number => {
    const value = settings.get(id);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const updateTrajectory = (trajectory: typeof eyeTrajectory, position: { x: number; y: number; z: number } | null, at: number, lookahead: number): void => {
    const wasActive = trajectory.active;
    trajectory.active = position !== null;
    if (!position) { trajectory.at = Number.NaN; if (wasActive) trajectory.version++; return; }
    const elapsed = (at - trajectory.at) / 1000;
    const dx = position.x - trajectory.previous.x, dy = position.y - trajectory.previous.y, dz = position.z - trajectory.previous.z;
    const displacement = Math.hypot(dx, dy, dz);
    const scale = elapsed > 0 && displacement <= 2000 ? lookahead * Math.min(1 / elapsed, 1000 / Math.max(1e-9, displacement)) : 0;
    const endX = position.x + dx * scale, endY = position.y + dy * scale, endZ = position.z + dz * scale;
    if (!wasActive || !trajectory.start.equalsToFloats(position.x, position.y, position.z) || !trajectory.end.equalsToFloats(endX, endY, endZ)) trajectory.version++;
    trajectory.start.set(position.x, position.y, position.z);
    trajectory.end.set(endX, endY, endZ);
    trajectory.previous.copyFrom(trajectory.start);
    trajectory.at = at;
  };

  // A renderer update traverses many tiles. The anchor, focus, tile-group
  // transform, camera projection, and render size remain fixed for that
  // traversal, so calculate them once rather than per tile.
  tiles.update = () => {
    hasDetailAnchor = false;
    focus = null;
    const anchor = getTerrainDetailAnchor?.() ?? null;
    const nextFocus = getFocus?.() ?? null;
    const camera = scene.activeCamera;
    proximityEnabled = settings.get("map.terrain.robustOrbitLOD") === true && camera !== null && camera !== undefined;
    if ((anchor || nextFocus || proximityEnabled) && camera) {
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
      if (proximityEnabled) {
        if (settingsDirty) {
          const defaults = TERRAIN_PROXIMITY_DEFAULTS;
          coreMeters = numberSetting("map.terrain.proximityCoreMeters", defaults.coreMeters);
          radiusMeters = numberSetting("map.terrain.proximityRadiusMeters", defaults.radiusMeters);
          falloffExponent = numberSetting("map.terrain.proximityFalloffExponent", defaults.falloffExponent);
          proximityWeight = numberSetting("map.terrain.proximityWeight", defaults.proximityWeight);
          losWeight = numberSetting("map.terrain.losWeight", defaults.losWeight);
          gazeExponent = numberSetting("map.terrain.losGazeExponent", defaults.losGazeExponent);
          peripheralFloor = numberSetting("map.terrain.losPeripheralFloor", defaults.losPeripheralFloor);
          blendPower = numberSetting("map.terrain.proximityBlendPower", defaults.blendPower);
          maxProximityErrorPx = numberSetting("map.terrain.maxProximityErrorPx", 8);
          const mode = settings.get("map.terrain.proximityBlendMode");
          blendMode = mode === "power-norm" || mode === "weighted-sum" ? mode : "max";
          lookaheadSeconds = numberSetting("map.terrain.proximityLookaheadSeconds", 1.5);
          proximityAnchor = settings.get("map.terrain.proximityAnchor");
          settingsDirty = false;
          proximityRevision++;
        }
        Vector3.TransformCoordinatesToRef(camera.globalPosition, worldToTiles, cameraInTiles);
        // The inverse view maps camera +Z (or -Z in a right-handed scene) to its gaze.
        if (gazeExponent > 0 && losWeight > 0) {
          cameraForward.set(0, 0, scene.useRightHandedSystem ? -1 : 1);
          if (typeof camera.getViewMatrix === "function") {
            camera.getViewMatrix().invertToRef(cameraWorld);
            Vector3.TransformNormalToRef(cameraForward, cameraWorld, cameraForward);
          }
          Vector3.TransformNormalToRef(cameraForward, worldToTiles, cameraForward);
          cameraForward.normalize();
        }
        const at = nowMs?.() ?? 0;
        updateTrajectory(eyeTrajectory, proximityAnchor === "focus" ? null : cameraInTiles, at, lookaheadSeconds);
        updateTrajectory(focusTrajectory, proximityAnchor === "eye" ? null : getProximityFocus?.() ?? nextFocus?.position ?? (hasDetailAnchor ? anchorInTiles : null), at, lookaheadSeconds);
        distinctFocusTrajectory = focusTrajectory.active && (!eyeTrajectory.active || !focusTrajectory.start.equals(eyeTrajectory.start) || !focusTrajectory.end.equals(eyeTrajectory.end));
        const projection = isOrthographic ? orthographicPixelSize : screenSpaceErrorDenominator;
        if (eyeTrajectory.version !== measuredEyeVersion || focusTrajectory.version !== measuredFocusVersion
          || projection !== measuredProjection || isOrthographic !== measuredOrthographic || tiles.errorTarget !== measuredErrorTarget) proximityRevision++;
        measuredEyeVersion = eyeTrajectory.version; measuredFocusVersion = focusTrajectory.version;
        measuredProjection = projection; measuredOrthographic = isOrthographic; measuredErrorTarget = tiles.errorTarget;
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
    if (!proximityEnabled) {
      eyeTrajectory.at = focusTrajectory.at = Number.NaN;
      if (eyeTrajectory.active) eyeTrajectory.version++;
      if (focusTrajectory.active) focusTrajectory.version++;
      eyeTrajectory.active = focusTrajectory.active = false;
    }
    nativeUpdate();
  };

  const errorAt = (tile: TileWithBabylonBounds, distance: number): number => {
    if (isOrthographic) return tile.geometricError / orthographicPixelSize;
    return distance === 0 ? Infinity : tile.geometricError / (distance * screenSpaceErrorDenominator);
  };

  // Within each interval between local box-face crossings, clamping is affine.
  // Its world-space squared distance is a quadratic, so testing its minimum in
  // at most seven intervals gives the exact segment distance, including scaled
  // and sheared affine boxes, using the adapter's own clamping convention.
  const boxCapsuleDistance = (trajectory: typeof eyeTrajectory, box: NonNullable<TileWithBabylonBounds["engineData"]["boundingVolume"]["obb"]>): number => {
    const start = trajectory.start, end = trajectory.end;
    Vector3.TransformCoordinatesToRef(start, box.inverseTransform!, boxStart);
    Vector3.TransformCoordinatesToRef(end, box.inverseTransform!, boxEnd);
    const sx = boxStart.x, sy = boxStart.y, sz = boxStart.z;
    const dx = boxEnd.x - sx, dy = boxEnd.y - sy, dz = boxEnd.z - sz;
    const wx = end.x - start.x, wy = end.y - start.y, wz = end.z - start.z;
    const min = box.min!, max = box.max!, matrix = box.transform!.m;
    boxBreaks[0] = 0; boxBreaks[1] = 1;
    let count = 2;
    for (let axis = 0; axis < 3; axis++) {
      const origin = axis === 0 ? sx : axis === 1 ? sy : sz;
      const delta = axis === 0 ? dx : axis === 1 ? dy : dz;
      if (delta === 0) continue;
      for (let side = 0; side < 2; side++) {
        const bound = side === 0 ? min : max;
        const crossing = ((axis === 0 ? bound.x : axis === 1 ? bound.y : bound.z) - origin) / delta;
        if (!(crossing > 0 && crossing < 1)) continue;
        let insertion = count;
        while (insertion > 0 && boxBreaks[insertion - 1] > crossing) { boxBreaks[insertion] = boxBreaks[insertion - 1]; insertion--; }
        boxBreaks[insertion] = crossing; count++;
      }
    }
    let best = Infinity, bestFraction = 0;
    for (let interval = 1; interval < count; interval++) {
      const low = boxBreaks[interval - 1], high = boxBreaks[interval], middle = (low + high) / 2;
      const mx = sx + dx * middle, my = sy + dy * middle, mz = sz + dz * middle;
      const cx = mx < min.x ? min.x : mx > max.x ? max.x : sx;
      const cy = my < min.y ? min.y : my > max.y ? max.y : sy;
      const cz = mz < min.z ? min.z : mz > max.z ? max.z : sz;
      const cdx = mx < min.x || mx > max.x ? 0 : dx;
      const cdy = my < min.y || my > max.y ? 0 : dy;
      const cdz = mz < min.z || mz > max.z ? 0 : dz;
      const ax = start.x - (cx * matrix[0] + cy * matrix[4] + cz * matrix[8] + matrix[12]);
      const ay = start.y - (cx * matrix[1] + cy * matrix[5] + cz * matrix[9] + matrix[13]);
      const az = start.z - (cx * matrix[2] + cy * matrix[6] + cz * matrix[10] + matrix[14]);
      const bx = wx - (cdx * matrix[0] + cdy * matrix[4] + cdz * matrix[8]);
      const by = wy - (cdx * matrix[1] + cdy * matrix[5] + cdz * matrix[9]);
      const bz = wz - (cdx * matrix[2] + cdy * matrix[6] + cdz * matrix[10]);
      const denominator = bx * bx + by * by + bz * bz;
      const fraction = denominator > 0 ? Math.max(low, Math.min(high, -(ax * bx + ay * by + az * bz) / denominator)) : low;
      const rx = ax + bx * fraction, ry = ay + by * fraction, rz = az + bz * fraction;
      const squared = rx * rx + ry * ry + rz * rz;
      if (squared < best) { best = squared; bestFraction = fraction; }
      if (best === 0) break;
    }
    closestAnchor.set(start.x + wx * bestFraction, start.y + wy * bestFraction, start.z + wz * bestFraction);
    return Math.sqrt(best);
  };

  // Spheres use exact projection; the installed box contract uses the analytic
  // path above. Unknown/custom volumes retain the convex-distance fallback.
  const capsuleDistance = (tile: TileWithBabylonBounds, trajectory: typeof eyeTrajectory): number => {
    const volume = tile.engineData.boundingVolume;
    const start = trajectory.start, end = trajectory.end;
    const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    let fraction = 0;
    const sphere = tileSphere(tile);
    if (sphere && lengthSquared > 0) {
      fraction = Math.max(0, Math.min(1, ((sphere.center.x - start.x) * dx + (sphere.center.y - start.y) * dy + (sphere.center.z - start.z) * dz) / lengthSquared));
    }
    closestAnchor.set(start.x + fraction * dx, start.y + fraction * dy, start.z + fraction * dz);
    if (sphere && Math.hypot(closestAnchor.x - sphere.center.x, closestAnchor.y - sphere.center.y, closestAnchor.z - sphere.center.z) - sphere.radius > radiusMeters) return Infinity;
    const projectedDistance = volume.distanceToPoint(closestAnchor);
    if (projectedDistance === 0 || lengthSquared === 0 || (volume.sphere && !volume.obb)) return projectedDistance;
    const box = volume.obb;
    if (!volume.sphere && box?.min && box.max && box.transform && box.inverseTransform
      && box.transform.m[3] === 0 && box.transform.m[7] === 0 && box.transform.m[11] === 0 && box.transform.m[15] === 1) return boxCapsuleDistance(trajectory, box);
    let low = 0, high = 1;
    let best = projectedDistance;
    let bestFraction = fraction;
    const startDistance = volume.distanceToPoint(start);
    if (startDistance < best) { best = startDistance; bestFraction = 0; }
    const endDistance = volume.distanceToPoint(end);
    if (endDistance < best) { best = endDistance; bestFraction = 1; }
    if (best === 0) {
      closestAnchor.copyFrom(bestFraction === 0 ? start : end);
      return 0;
    }
    for (let iteration = 0; iteration < 48; iteration++) {
      const left = low + (high - low) / 3, right = high - (high - low) / 3;
      capsulePoint.set(start.x + left * dx, start.y + left * dy, start.z + left * dz);
      const leftDistance = volume.distanceToPoint(capsulePoint);
      capsulePoint.set(start.x + right * dx, start.y + right * dy, start.z + right * dz);
      const rightDistance = volume.distanceToPoint(capsulePoint);
      if (leftDistance < best) { best = leftDistance; bestFraction = left; }
      if (rightDistance < best) { best = rightDistance; bestFraction = right; }
      if (best === 0) break;
      if (leftDistance < rightDistance) high = right;
      else low = left;
    }
    closestAnchor.set(start.x + bestFraction * dx, start.y + bestFraction * dy, start.z + bestFraction * dz);
    return best;
  };

  const proximityError = (tile: TileWithBabylonBounds, trajectory: typeof eyeTrajectory, target: TileViewErrorTarget): number => {
    if (!trajectory.active) return 0;
    const distance = capsuleDistance(tile, trajectory);
    if (distance > radiusMeters) return 0;
    const sphere = tileSphere(tile);
    if (sphere && isSphereBelowHorizon(closestAnchor, sphere.center, sphere.radius)) return 0;
    const u = Math.max(0, Math.min(1, (distance - coreMeters) / Math.max(1, radiusMeters - coreMeters)));
    let error = proximityWeight === 0 ? 0 : proximityWeight * (1 - u ** falloffExponent) * errorAt(tile, Math.max(1, distance));
    if (distance <= coreMeters) error = Math.max(error, tiles.errorTarget * (tile.geometricError / maxProximityErrorPx));
    target.inView = true;
    target.distanceFromCamera = Math.min(target.distanceFromCamera, distance);
    return error;
  };

  renderer.calculateTileViewError = (tile, target) => {
    nativeCalculateTileViewError(tile, target);
    if (hasDetailAnchor) {
      const distance = tile.engineData.boundingVolume.distanceToPoint(anchorInTiles);
      target.distanceFromCamera = distance;
      target.error = errorAt(tile, distance);
    }
    if (focus) {
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
    }
    if (!proximityEnabled) return;
    let gaze = 1;
    const sphere = target.inView && losWeight > 0 && gazeExponent > 0 ? tileSphere(tile) : null;
    if (sphere) {
      const obb = tile.engineData.boundingVolume.obb;
      if (obb?.clampPoint) {
        obb.clampPoint(cameraInTiles, closestPoint);
        closestPoint.subtractInPlace(cameraInTiles);
      } else {
        closestPoint.set(sphere.center.x - cameraInTiles.x, sphere.center.y - cameraInTiles.y, sphere.center.z - cameraInTiles.z);
        if (closestPoint.length() <= sphere.radius) closestPoint.setAll(0);
      }
      const length = closestPoint.length();
      const cosine = length > 0 ? Vector3.Dot(cameraForward, closestPoint) / length : 1;
      gaze = Math.max(peripheralFloor, Math.max(0, cosine) ** gazeExponent);
    }
    const losError = target.inView && losWeight > 0 ? losWeight * gaze * target.error : 0;
    let cached = proximityMeasures.get(tile);
    if (!cached || cached.revision !== proximityRevision || cached.volume !== tile.engineData.boundingVolume
      || cached.measure !== tile.engineData.boundingVolume.distanceToPoint || cached.geometricError !== tile.geometricError) {
      proximityTarget.inView = false; proximityTarget.distanceFromCamera = Infinity;
      const proxError = Math.max(proximityError(tile, eyeTrajectory, proximityTarget), distinctFocusTrajectory ? proximityError(tile, focusTrajectory, proximityTarget) : 0);
      if (!cached) { cached = { revision: 0, volume: tile.engineData.boundingVolume, measure: tile.engineData.boundingVolume.distanceToPoint, geometricError: 0, inView: false, error: 0, distance: Infinity }; proximityMeasures.set(tile, cached); }
      cached.revision = proximityRevision; cached.volume = tile.engineData.boundingVolume; cached.measure = tile.engineData.boundingVolume.distanceToPoint; cached.geometricError = tile.geometricError;
      cached.inView = proximityTarget.inView; cached.error = proxError; cached.distance = proximityTarget.distanceFromCamera;
    }
    if (cached.inView) { target.inView = true; target.distanceFromCamera = Math.min(target.distanceFromCamera, cached.distance); }
    const proxError = cached.error;
    target.error = blendTerrainErrors(losError, proxError, blendMode, blendPower);
  };
  return () => { settingsDirty = true; };
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
  cacheNativeViewMeasurement(tiles, scene);
  const filterStandIns = createStandInFilter(tiles, scene);
  const readLoadedError = observeLoadedError(tiles);
  let loadedErrorTarget: number | null = null;
  let loadedDistribution: DetailDistribution = unavailableDetailDistribution("google", "google", 1, "Loaded detail has not been measured.");
  const refreshViewSettings = applyViewMeasure(tiles, scene, options.getTerrainDetailAnchor, options.getFocus, options.settings, options.getProximityFocus, options.nowMs);
  const settings = options.settings;
  let suspended = false;
  applyLoadingParameters(tiles, settings);
  const loadingIds = new Set<string>(GOOGLE_LOADING_IDS);
  const unsubscribeSettings = settings.subscribe(changed => {
    if ([...changed].some(id => loadingIds.has(id))) applyLoadingParameters(tiles, settings, suspended);
    for (const id of changed) if (id.startsWith("map.terrain.")) { refreshViewSettings(); break; }
  });
  setupCleanup.push(unsubscribeSettings);
  tiles.fetchOptions.mode = "cors";
  // A reload reuses the browser's copies of models and child tilesets. Their
  // URLs carry the session the root issued, so the root is revalidated instead
  // (Google answers 304 for an unchanged dataset, keeping the cached root and
  // its session) and everything else comes from the cache first. The browser
  // still owns HTTP storage and no-store.
  tiles.fetchOptions.cache = "force-cache";
  // Traverse directly to the requested detail, so cached leaf models draw
  // without loading every coarse parent first. Experimental in 0.4; compatible
  // here because nothing splits tiles or shares this cache or its queues, and
  // traversal still uses the view-error and parse hooks above.
  tiles.optimizedLoadStrategy = true;

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
  // A cached session expires while the browser still holds the root that
  // issued it. Renewal fetches that root with the failed request's options, so
  // it must skip the cache, or it gets the expired session back and every
  // uncached model keeps failing.
  const auth = (authPlugin as { auth?: { refreshToken?: (init: RequestInit) => Promise<unknown> } }).auth;
  if (auth?.refreshToken) {
    const refreshToken = auth.refreshToken.bind(auth);
    auth.refreshToken = init => refreshToken({ ...init, cache: "reload" });
  }
  const fetchFailures = new Map<string, GoogleTileHttpFailure>();
  const fetchData = downloader.fetchData.bind(downloader);
  downloader.fetchData = (uri, fetchOptions) => work.run(async () => {
    options.recordMapRequest(uri);
    const cache: RequestCache | undefined = uri === GOOGLE_3D_TILES_ROOT_URL ? "no-cache" : fetchOptions.cache;
    const response = await fetchData(uri, { ...fetchOptions, cache, signal: options.combineSignals([drawableLifetime.signal, ...(fetchOptions.signal ? [fetchOptions.signal] : [])]) });
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
      return { defaultErrorTarget, errorTarget: tiles.errorTarget, overrideErrorTarget, loadedErrorTarget, loadedDistribution };
    },
    setTerrainDetailTarget(nextErrorTarget) {
      overrideErrorTarget = normaliseTerrainDetailTarget(nextErrorTarget);
      tiles.errorTarget = overrideErrorTarget ?? defaultErrorTarget;
    },
    update() {
      if (suspended || disposed) return;
      tiles.update();
      if (filterStandIns(settings.get("map.terrain.hideCoarseStandIns") !== false)) handleSurfaceChange();
      const next = readLoadedError();
      if (next.worst !== loadedErrorTarget || next.distribution.revision !== loadedDistribution.revision) {
        loadedErrorTarget = next.worst;
        loadedDistribution = next.distribution;
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
