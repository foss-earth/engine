import { createMapDownloadMeter } from "./mapDownloadMeter";
import { setMapCacheLimits } from "../../terrain/mapCache";
import { createSurfaceQuery, type SurfaceQuery } from "../../terrain/surfaceQuery";
import { resolveTerrainSource, type TerrainSource } from "../../terrain/terrainTiles";
import { evaluateTerrainReadiness, terrainReadinessSamples, validateTerrainPreparation,
  type TerrainPreparationOptions, type TerrainPreparationResult } from "../../terrain/terrainReadiness";
import {
  Color3,
  Color4,
  Engine,
  GeospatialCamera,
  HemisphericLight,
  type AbstractMesh,
  type Camera,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
  WebGPUEngine,
} from "@babylonjs/core";
import { GeospatialClippingBehavior } from "@babylonjs/core/Behaviors/Cameras/geospatialClippingBehavior";

import { bootstrapGlobeRenderer, type RendererMode, type RendererSelection } from "./createRendererMode";
import {
  createGoogleTilesRuntime,
  type GoogleTerrainDetailState,
  type GoogleTilesRuntime,
} from "./createTilesRuntime";
import { createRasterTilesRuntime, type RasterDetailFeedback, type RasterTilesRuntime } from "./createRasterTilesRuntime";
import { DEFAULT_RASTER_IMAGERY } from "./resolveMapRuntimeConfig";
import { isKnownRasterBaseMapId, resolveRasterBaseMapSource, withSourceKey, type RasterBaseMapSource } from "./rasterBaseMaps";
import { getAppSettings } from "../../settings/appSettings";
import type { SettingsRegistry } from "../../settings/registry";
import type { AutoDetailDecision } from "../../terrain/autoDetail";
import { createTerrainPerformanceCapture, type TerrainPerformanceCapture } from "../../terrain/terrainPerformanceCapture";

declare global {
  interface Window {
    fossTerrainPerformance?: TerrainPerformanceCapture;
    __fossMapDebug?: {
      readonly runtimeMode: RuntimeMode;
      readonly sceneMeshCount: number;
      readonly enabledMeshCount: number;
      readonly rasterVisibleTiles: number;
      readonly rasterActiveTiles: number;
      readonly fallbackEnabled: boolean;
      readonly activeCamera: string | null;
      readonly schedulerActive: boolean;
      readonly pendingTextureCount: number;
      readonly readyTextureCount: number;
      readonly recentEvents: readonly MapDebugEvent[];
    };
  }
}
import { createRenderScheduler, type RenderScheduler } from "./renderScheduler";
import { geodeticToEcef, DEG_TO_RAD } from "../../camera/cameraMath";
import { CameraController, type OrbitTargetHeightOptions } from "../../camera/cameraState";
import { createInputController, type InputController } from "../../input/createInputController";
import { createInertialCameraController, type InertialCameraController } from "../../input/inertialCameraController";
import type { GlobeNavigationIntentFrame } from "../../input/globeNavigation";
import type { InputModePreference, InputSensitivitySettings } from "../../input/inputSettings";
import type { GlobeViewState } from "../types";

const PLANET_RADIUS_METERS = 6_378_137;
const DEFAULT_FALLBACK_BACKGROUND = new Color4(0.01, 0.02, 0.05, 1);
const DEFAULT_GOOGLE_BACKGROUND = new Color4(0.04, 0.05, 0.07, 1);
const DEFAULT_CAMERA_LAT_DEG = 44.977753;
const DEFAULT_CAMERA_LON_DEG = -93.265011;
const DEFAULT_CAMERA_ALTITUDE_METERS = 600;
const DEFAULT_CAMERA_YAW_RAD = -0.2513281792775774;
const DEFAULT_CAMERA_PITCH_RAD = 1.167625429373872;

export interface BabylonRuntimeOptions {
  googleApiKey?: string | null;
  /** Whether Google 3D Tiles should be the initial active source when keyed. */
  preferGoogleTiles?: boolean;
  rasterBaseMap?: RasterBaseMapSource | null;
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
  terrainSource?: TerrainSource;
  /**
   * @deprecated The quality profiles are retired: terrain detail is
   * `map.detail.terrain.*`, adjusted by `map.auto.*`; `?terrainQuality` sets
   * them for a visit. Ignored.
   */
  rasterQuality?: unknown;
  /** How 2D basemap imagery is selected and drawn. */
  rasterImagery?: "atlas" | "legacy";
  /** Explicit opt-in; no per-query timings or capture buffers by default. */
  terrainPerformanceCapture?: TerrainPerformanceCapture;
  rendererForce?: RendererMode | null;
  onStatusChange?: (status: BabylonRuntimeStatus) => void;
  /** Enable a consumer-driven simulation camera and frame callback. */
  simMode?: boolean;
  /**
   * The registry the runtime reads its parameters from and follows: the
   * renderer, the map source and elevation, provider keys, the imagery path
   * and where Google refines from. The app's when omitted.
   */
  settings?: SettingsRegistry;
}

export type { RendererMode };

export type RuntimeMode = "google-tiles" | "raster-basemap" | "fallback";

export interface BabylonRuntimeStatus {
  mode: RuntimeMode;
  message: string;
  googleApiKeyProvided: boolean;
  rasterBaseMap: RasterBaseMapSource | null;
  /**
   * The basemap whose imagery is on screen. During a switch it stays the old
   * one until the new source can cover the globe, so its credit stays shown.
   */
  displayedRasterBaseMap?: RasterBaseMapSource | null;
  terrainSource: TerrainSource | null;
  lastError: string | null;
}

export interface BabylonTileMetrics {
  visibleTiles: number;
  activeTiles: number;
}

export type { GoogleTerrainDetailState };

/**
 * Where Google 3D Tiles measure distance when choosing mesh detail: the
 * camera or the selected focus point, which in a simulation is its floating
 * origin unless the host registers another. `map.focus.refineFrom` chooses.
 */
export type GoogleTerrainDetailAnchor = "camera" | "focus-point";

/**
 * A point the map can be loaded around (`map.focus.point`), such as an
 * aircraft. Its position is read at most once per rendered frame.
 */
export interface FocusPoint {
  /** Stable: saved as the parameter's value. */
  id: string;
  label: string;
  /** ECEF metres, or null while it is not known. */
  getPosition(): { x: number; y: number; z: number } | null;
}

/** Levels as the adjustment reports them: "0.5 levels", "1 level". */
function formatLevels(levels: number): string {
  const rounded = Math.round(levels * 100) / 100;
  return `${rounded} level${rounded === 1 ? "" : "s"}`;
}

/** The parameters that decide the focus region, read by both maps each frame. */
const FOCUS_PARAMETER_IDS = [
  "map.focus.mode",
  "map.focus.point",
  "map.focus.radius",
  "map.focus.horizonCull",
  "map.focus.detailBelow.imagery",
  "map.focus.detailBelow.google",
] as const;

interface MapDebugEvent {
  at: number;
  event: string;
  detail?: Record<string, unknown>;
}

export interface BabylonRuntime {
  /** Stream and refine a destination before creating or relocating an aircraft. */
  prepareTerrain(options: TerrainPreparationOptions): Promise<TerrainPreparationResult>;
  /** Collision and placement queries against the currently displayed map mesh. */
  surface: SurfaceQuery;
  engine: Engine | WebGPUEngine;
  scene: Scene;
  renderer: RendererSelection;
  status: BabylonRuntimeStatus;
  /**
    * The active GeospatialCamera. Fallback mode uses the same geospatial scale
    * as Google mode so layers can render ECEF-positioned primitives in both modes.
   * Use this to wire POI tracking or other camera-direct integrations.
   */
  geospatialCamera: GeospatialCamera | null;
    /** Return the current camera state. */
    getViewState(): GlobeViewState | null;
    /** Merge partial overrides into the current camera state. */
  setViewState(partial: Partial<GlobeViewState>): void;
  /** Configure the surface height and starting offset used by the camera orbit target. */
  configureOrbitTargetHeight(options: OrbitTargetHeightOptions | null): void;
  /** Return current base-map tile counts, or null when no tile runtime is active. */
  getTileMetrics(): BabylonTileMetrics | null;
  /** Google renderer detail target, when Google 3D Tiles are active. */
  getGoogleTerrainDetailState(): GoogleTerrainDetailState | null;
  /**
   * Override the Google renderer's screen-space-error target for this session.
   * A larger number displays a coarser mesh. `null` restores the renderer's
   * normal adaptive target.
   */
  setGoogleTerrainDetailTarget(errorTarget: number | null): void;
  /**
   * Adds a point the map can be loaded around, listed in Map → Detail's Focus
   * point. Returns a function that removes it.
   */
  registerFocusPoint(point: FocusPoint): () => void;
  /** The selected focus point in ECEF metres, or null while it is not known. */
  getFocusPosition(): { x: number; y: number; z: number } | null;
  /** Return the point used to choose Google mesh detail. */
  getGoogleTerrainDetailAnchor(): GoogleTerrainDetailAnchor;
  /**
   * Choose the point used to refine Google mesh detail. Visibility remains
   * based on the active view camera in either mode.
   */
  setGoogleTerrainDetailAnchor(anchor: GoogleTerrainDetailAnchor): void;
  /**
   * Request raster imagery detail as a signed offset in binary resolution
   * steps, positive for finer imagery. Only imagery changes; elevation and
   * terrain geometry do not.
   */
  setRasterDetailTarget(offset: number): void;
  /** Whether raster detail is supported and what limits its delivery; null without a raster basemap. */
  getRasterDetailFeedback(): RasterDetailFeedback | null;
  /** Called when raster detail delivery changes. Returns an unsubscribe fn. */
  onRasterDetailFeedback(listener: () => void): () => void;
  /** Called after every status change, while paused too. Returns an unsubscribe fn. */
  subscribeStatus(listener: (status: BabylonRuntimeStatus) => void): () => void;
  /** Switch imagery without reloading the application or resetting consumers. */
  setRasterBaseMap(source: RasterBaseMapSource): void;
  /** Switch between Google 3D Tiles and a raster basemap without a page reload. */
  setMapSource(source: "google" | RasterBaseMapSource): void;
  /** Switch the elevation stream used by raster basemaps. */
  setTerrainSource(source: TerrainSource): void;
  /**
   * Called when automatic adjustment moves 2D basemap detail (`map.auto.*`),
   * with the frame time that caused it, for a host's log. Returns a function
   * that stops it.
   */
  onDetailAdjusted(listener: (decision: AutoDetailDecision) => void): () => void;
  /**
   * Tell the input system whether the camera is currently locked to a POI.
   * When true, two-finger trackpad swipe orbits instead of panning.
   */
  setOrbitMode(active: boolean): void;
  /** Force or auto-detect the active input mode used by wheel/pointer controllers. */
  setInputMode(mode: InputModePreference): void;
  /** Set movement sensitivity multipliers for mouse, trackpad, and touch. */
  setInputSensitivity(sensitivity: Partial<InputSensitivitySettings>): void;
  /**
   * Apply host-owned, normalized navigation rates through the same inertial
   * camera path used by pointer input. This avoids repeated setViewState calls
   * that would cancel existing inertia.
   */
  applyGlobeNavigationIntents(frame: GlobeNavigationIntentFrame): void;
  /** Toggle anchor-based globe drag pan (grabbed surface point follows cursor). */
  setGlobeAnchorRotation(enabled: boolean): void;
  getGlobeAnchorRotation(): boolean;
  /**
   * Render-on-demand controls. The runtime no longer runs an unconditional
   * render loop; consumers must call requestRender() after any external scene
   * mutation (theme change, layer mutation, etc.) to see the result.
   */
  requestRender(): void;
  beginContinuous(): void;
  endContinuous(): void;
  /** Pause the scheduler (e.g. when the tab is hidden). */
  setPaused(paused: boolean): void;
  /** True while the scheduler is pumping frames (rAF in flight or continuous). */
  isRendering(): boolean;
  /** Subscribe to render-active transitions. Returns an unsubscribe fn. */
  onActiveRenderChange(listener: (active: boolean) => void): () => void;
  /** True while at least one Google tile load is in flight. */
  isStreamingTiles(): boolean;
  /** Rolling one-second map payload rate; cached responses may contribute. */
  getMapDownloadBytesPerSecond(): number;
  onMapDownloadRateChange(listener: (bytesPerSecond: number) => void): () => void;
  /** Subscribe to tile-streaming transitions. Returns an unsubscribe fn. */
  onTilesStreamingChange(listener: (streaming: boolean) => void): () => void;
  /** Root for world content that must follow a simulation's floating origin. */
  getWorldRoot(): TransformNode | null;
  /** Update the geospatial position used to select raster tiles in simulation mode. */
  setSimViewState(partial: Partial<GlobeViewState>): void;
  /** Set the simulation callback invoked before each rendered frame. */
  /** Hold continuous rendering only while the simulation is running. Defaults to true in simMode. */
  setSimRunning(running: boolean): void;
  setSimTick(callback: ((deltaSeconds: number) => void) | null): void;
  destroy(): void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

interface FallbackExperience {
  globeMesh: AbstractMesh;
  light: HemisphericLight;
}

function createFallbackExperience(scene: Scene, worldRoot: TransformNode | null): FallbackExperience {
  scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;

  const light = new HemisphericLight("fallback-light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.95;

  const globeMesh = MeshBuilder.CreateSphere(
    "fallback-globe",
    { diameter: PLANET_RADIUS_METERS * 2, segments: 96 },
    scene,
  );
  globeMesh.isPickable = false;
  if (worldRoot) {
    globeMesh.parent = worldRoot;
  }

  const globeMaterial = new StandardMaterial("fallback-globe-material", scene);
  globeMaterial.diffuseColor = Color3.FromHexString("#355f8f");
  globeMaterial.specularColor = Color3.FromHexString("#1f2937");
  globeMesh.material = globeMaterial;

  return { globeMesh, light };
}

function createGeospatialCamera(scene: Scene): GeospatialCamera {
  const camera = new GeospatialCamera("geo-camera", scene, {
    planetRadius: PLANET_RADIUS_METERS,
  });
  // Remove Babylon's built-in pointer + wheel inputs. We drive the camera entirely
  // through our own InputController (wheel/touch/mouse/safariGestures); leaving
  // Babylon's GeospatialCameraPointersInput and GeospatialCameraMouseWheelInput
  // attached makes every gesture get processed twice (ours + Babylon's pinch/drag),
  // producing the jumpy "camera moves in other ways while zooming" behavior on touch.
  camera.inputs.removeByType("GeospatialCameraPointersInput");
  camera.inputs.removeByType("GeospatialCameraMouseWheelInput");
  camera.attachControl(true);
  camera.addBehavior(new GeospatialClippingBehavior());

  const { x: cx, y: cy, z: cz } = geodeticToEcef(
    DEFAULT_CAMERA_LAT_DEG * DEG_TO_RAD,
    DEFAULT_CAMERA_LON_DEG * DEG_TO_RAD,
    0,
  );
  camera.center = new Vector3(cx, cy, cz);
  camera.radius = DEFAULT_CAMERA_ALTITUDE_METERS;
  camera.yaw = DEFAULT_CAMERA_YAW_RAD;
  camera.pitch = DEFAULT_CAMERA_PITCH_RAD;
  camera.limits.radiusMin = 25;
  camera.checkCollisions = true;

  return camera;
}

export async function createBabylonRuntime(
  canvas: HTMLCanvasElement,
  options: BabylonRuntimeOptions = {},
): Promise<BabylonRuntime> {
  const settings = options.settings ?? getAppSettings();
  const savedGoogleKey = settings.get("map.source.googleKey");
  const normalizedApiKey = options.googleApiKey?.trim() || (typeof savedGoogleKey === "string" ? savedGoogleKey.trim() : "");
  const mapDebugEnabled = new URLSearchParams(window.location.search).get("mapDebug") === "1";
  const mapDebugEvents: MapDebugEvent[] = [];
  const recordMapDebugEvent = (event: string, detail?: Record<string, unknown>): void => {
    if (!mapDebugEnabled) return;
    mapDebugEvents.push({ at: performance.now(), event, detail });
    if (mapDebugEvents.length > 100) mapDebugEvents.shift();
  };
  const hasGoogleApiKey = normalizedApiKey.length > 0;
  const shouldStartGoogle = hasGoogleApiKey && options.preferGoogleTiles !== false;
  const simMode = options.simMode === true;
  const backend = settings.get("renderer.backend");
  const { renderer, scene } = await bootstrapGlobeRenderer(canvas, {
    force: options.rendererForce ?? (backend === "webgpu" || backend === "webgl2" || backend === "webgl" ? backend : null),
  });
  // Defaults and bounds that depend on the renderer can now be resolved.
  settings.setDeviceContext({
    rendererMode: renderer.mode,
    maxTextureSize: (renderer.engine.getCaps() as { maxTextureSize?: number }).maxTextureSize ?? null,
  });
  const captureFromUrl = new URLSearchParams(window.location.search).get("terrainCapture") === "1";
  const terrainCapture = options.terrainPerformanceCapture ?? (captureFromUrl ? createTerrainPerformanceCapture() : undefined);
  const previousCapture = window.fossTerrainPerformance;
  if (captureFromUrl) window.fossTerrainPerformance = terrainCapture;

  let simLight: HemisphericLight | null = null;
  if (simMode) {
    scene.clearColor = new Color4(0.45, 0.65, 0.92, 1);
    simLight = new HemisphericLight("sim-light", new Vector3(0, 1, 0), scene);
    simLight.intensity = 1.1;
  }

  const downloadMeter = createMapDownloadMeter();
  let tilesRuntime: GoogleTilesRuntime | null = null;
  let googleTerrainDetailTarget: number | null = null;
  const anchorForRefinement = (value: unknown): GoogleTerrainDetailAnchor => (value === "focus" ? "focus-point" : "camera");
  let googleTerrainDetailAnchor: GoogleTerrainDetailAnchor = anchorForRefinement(settings.get("map.focus.refineFrom"));
  let rasterTilesRuntime: RasterTilesRuntime | null = null;
  let googleTilesStartupWatchdog: number | null = null;
  let fallbackExperienceCreated = false;
  let fallbackExperience: FallbackExperience | null = null;
  let googleLight: HemisphericLight | null = null;
  let geospatialCamera: GeospatialCamera | null = null;
  let cameraController: CameraController | null = null;
  let inertialCameraController: InertialCameraController | null = null;
  let inputController: InputController | null = null;
  let orbitModeActive = false;
  let simRunning = simMode;
  let simTick: ((deltaSeconds: number) => void) | null = null;
  let simViewState: GlobeViewState | null = null;
  let preparationViewState: GlobeViewState | null = null;
  let preparationRadiusMeters = 0;
  let preparationCamera: UniversalCamera | null = null;
  let activePreparationCamera: Camera | null = null;
  let preparationPreviousCamera: Camera | null = null;
  let preparationTick: ((now: number) => void) | null = null;
  let cancelPreparation: ((error: Error) => void) | null = null;
  let activeRasterBaseMap = options.rasterBaseMap ?? null;
  // Focus points: the built-in orbit target and those a host registers.
  const focusPoints = new Map<string, FocusPoint>();
  const syncFocusChoices = (): void => settings.setChoices("map.focus.point", [
    { id: "orbit-target", label: simMode ? "Simulation origin" : "Orbit target" },
    ...[...focusPoints.values()].map(point => ({ id: point.id, label: point.label })),
  ]);
  syncFocusChoices();
  const worldMatrix = (): ReturnType<TransformNode["computeWorldMatrix"]> | null => (worldRoot ? worldRoot.computeWorldMatrix(true) : null);
  const ecefToScene = (ecef: { x: number; y: number; z: number }): Vector3 => {
    const world = worldMatrix();
    const point = new Vector3(ecef.x, ecef.y, ecef.z);
    return world ? Vector3.TransformCoordinates(point, world) : point;
  };
  /** The orbit target in ECEF: the globe camera's target, or a simulation's floating origin. */
  const orbitTarget = (): { x: number; y: number; z: number } | null => {
    if (worldRoot) {
      if (!worldRoot.parent) return null;
      const origin = Vector3.TransformCoordinates(Vector3.Zero(), worldRoot.computeWorldMatrix(true).clone().invert());
      return { x: origin.x, y: origin.y, z: origin.z };
    }
    const center = geospatialCamera?.center;
    return center ? { x: center.x, y: center.y, z: center.z } : null;
  };
  // Both maps' updates in one frame see the same focus position; outside a
  // frame, such as a host's own update, it is read fresh.
  let inFrame = false;
  let focusCache: { value: { x: number; y: number; z: number } | null } | null = null;
  /** The selected focus point, read at most once per rendered frame. */
  const focusPosition = (): { x: number; y: number; z: number } | null => {
    if (inFrame && focusCache) return focusCache.value;
    const id = String(settings.get("map.focus.point"));
    const point = focusPoints.get(id);
    let value: { x: number; y: number; z: number } | null = null;
    try { value = point ? point.getPosition() : orbitTarget(); } catch { value = null; }
    value = value && [value.x, value.y, value.z].every(Number.isFinite) ? { x: value.x, y: value.y, z: value.z } : null;
    if (inFrame) focusCache = { value };
    return value;
  };
  /** The region to load around the focus point, when the focus mode asks for one. */
  const focusRequest = (): { mode: "around" | "both"; position: { x: number; y: number; z: number }; radiusMeters: number; horizonCull: boolean } | null => {
    const mode = settings.get("map.focus.mode");
    if (mode !== "around" && mode !== "both") return null;
    const position = focusPosition();
    if (!position) return null;
    const radius = settings.get("map.focus.radius");
    return { mode, position, radiusMeters: typeof radius === "number" ? radius : 0, horizonCull: settings.get("map.focus.horizonCull") !== false };
  };

  // A provider's key goes into its requests only: the source the rest of the app sees has none.
  const keyedSource = (source: RasterBaseMapSource): RasterBaseMapSource => {
    const key = source.apiKey ? settings.get(source.apiKey.parameter) : "";
    return withSourceKey(source, typeof key === "string" ? key : "");
  };
  let activeTerrainSource = resolveTerrainSource(options.terrainSource);
  const detailAdjustedListeners = new Set<(decision: AutoDetailDecision) => void>();
  let lastRasterFrameAt = performance.now();
  const worldRoot = simMode ? new TransformNode("sim-world-root", scene) : null;

  // Held while Google tiles are initializing so the scheduler pumps
  // tiles.update() every frame even when the user hasn't moved the camera.
  // Without this the render-on-demand scheduler idles after the very first
  // frame and the tile-load loop stalls until a camera gesture wakes it.
  let startupHeld = false;
  const releaseStartupHold = (): void => {
    if (!startupHeld) return;
    startupHeld = false;
    scheduler.endContinuous();
  };

  // Streaming signal: shared between the tiles event wiring (which sets it via
  // beginStreaming/endStreaming) and the public onTilesStreamingChange API.
  const streamingListenersRef = new Set<(streaming: boolean) => void>();
  const streamingActiveRef = { value: false };

  // Render-on-demand scheduler. The tick runs inertial decay, tiles streaming,
  // and the scene render in that order; the scheduler keeps pumping while
  // inertia is still active or while a continuous-mode caller (e.g. tile load)
  // holds a reference, and idles otherwise.
  const status: BabylonRuntimeStatus = {
    mode: shouldStartGoogle ? "google-tiles" : "fallback",
    message: shouldStartGoogle
      ? "Google Photorealistic 3D Tiles are initializing."
      : "Fallback mode active.",
    googleApiKeyProvided: hasGoogleApiKey,
    rasterBaseMap: activeRasterBaseMap,
    terrainSource: activeTerrainSource,
    lastError: null,
  };
  const scheduler: RenderScheduler = createRenderScheduler({
    tick: () => {
      inFrame = true;
      focusCache = null;
      const frameNow = performance.now();
      terrainCapture?.beginFrame(frameNow);
      if (!simMode) {
        inertialCameraController?.update();
      }
      updateTerrainPreparationCamera();
      tilesRuntime?.update();
      rasterTilesRuntime?.reportFrame(frameNow, frameNow - lastRasterFrameAt, document.hidden);
      lastRasterFrameAt = frameNow;
      rasterTilesRuntime?.update();
      if (status.mode === "raster-basemap" && (rasterTilesRuntime?.getMetrics().visibleTiles ?? 0) > 0) {
        hideFallbackExperience();
      }
      // beginFrame/endFrame are normally invoked by engine.runRenderLoop's
      // internal _processFrame. We bypass that loop, so we must bracket the
      // render ourselves — WebGPU only presents the swap chain inside
      // endFrame(), and engine.getFps() / frameId are only updated in
      // beginFrame(). Without this the canvas stays black on WebGPU.
      renderer.engine.beginFrame();
      const deltaSeconds = Math.max(renderer.engine.getDeltaTime() / 1000, 1 / 240);
      simTick?.(deltaSeconds);
      scene.render();
      renderer.engine.endFrame();
      // Sampling after render observes current mesh transforms, including the
      // simulation's floating origin. Refinement keeps running with no aircraft.
      preparationTick?.(frameNow);
      terrainCapture?.endFrame();
      inFrame = false;
      focusCache = null;
      if (mapDebugEnabled) {
        recordMapDebugEvent("scene-render", { mode: status.mode, enabledMeshes: scene.meshes.filter(mesh => mesh.isEnabled()).length });
      }
    },
    shouldKeepRendering: () => simRunning || (inertialCameraController?.isActive() ?? false),
  });

  // Credits are the shell's to show: the map source HUD links the basemap's,
  // and the Map tab the elevation provider's.
  const statusListeners = new Set<(status: BabylonRuntimeStatus) => void>();
  const rasterDetailListeners = new Set<() => void>();
  let rasterDetailOffset = 0;
  const emitStatus = (): void => {
    options.onStatusChange?.({ ...status });
    for (const listener of [...statusListeners]) listener({ ...status });
  };
  const knownRasterBaseMaps = new Map<string, RasterBaseMapSource>();
  const emitRasterDetailFeedback = (): void => {
    const displayedId = rasterTilesRuntime?.getDisplayedSourceId() ?? null;
    const displayed = displayedId ? knownRasterBaseMaps.get(displayedId) ?? status.rasterBaseMap : null;
    if (status.mode === "raster-basemap" && displayed && status.displayedRasterBaseMap?.id !== displayed.id) {
      status.displayedRasterBaseMap = displayed;
      emitStatus();
    }
    for (const listener of [...rasterDetailListeners]) listener();
  };

  function clearGoogleWatchdog(): void {
    if (googleTilesStartupWatchdog !== null) {
      window.clearTimeout(googleTilesStartupWatchdog);
      googleTilesStartupWatchdog = null;
    }
  }

  let streamingHeld = false;
  const beginStreaming = (): void => {
    if (streamingHeld) return;
    streamingHeld = true;
    streamingActiveRef.value = true;
    scheduler.beginContinuous();
    for (const listener of streamingListenersRef) listener(true);
  };
  const endStreaming = (): void => {
    if (!streamingHeld) return;
    streamingHeld = false;
    streamingActiveRef.value = false;
    scheduler.endContinuous();
    for (const listener of streamingListenersRef) listener(false);
  };

  function ensureGeospatialCamera(): GeospatialCamera {
    if (geospatialCamera) {
      // Flight mode owns scene.activeCamera with its cockpit/chase camera.
      // Map transitions only need the geospatial camera to exist; activating it
      // here replaces that flight camera (which has been disabled) and renders
      // an empty scene.
      if (!simMode || !scene.activeCamera) scene.activeCamera = geospatialCamera;
      return geospatialCamera;
    }

    geospatialCamera = createGeospatialCamera(scene);
    if (!simMode || !scene.activeCamera) scene.activeCamera = geospatialCamera;
    cameraController = new CameraController(geospatialCamera);
    const baseInertial = createInertialCameraController(cameraController);
    // Every input gesture goes through the inertial controller. Wrap its input
    // methods so each one wakes the on-demand scheduler. The wrapped methods
    // delegate to the underlying controller, which queues velocity; the
    // scheduler then pumps frames until the velocity decays under threshold
    // (via shouldKeepRendering -> isActive()).
    inertialCameraController = {
      panBy(dx, dy, h) {
        baseInertial.panBy(dx, dy, h);
        scheduler.requestRender();
      },
      orbitBy(p, h) {
        baseInertial.orbitBy(p, h);
        scheduler.requestRender();
      },
      zoomBy(f) {
        baseInertial.zoomBy(f);
        scheduler.requestRender();
      },
      beginAnchorPan(pick) {
        baseInertial.cancel();
        return cameraController!.beginAnchorPan(pick);
      },
      panAnchorTo(pick, sensitivity) {
        const moved = cameraController!.panAnchorTo(pick, sensitivity);
        if (moved) {
          scheduler.requestRender();
        }
        return moved;
      },
      getAnchorPanScreenError(pick) {
        return cameraController!.getAnchorPanScreenError(pick);
      },
      endAnchorPan() {
        cameraController!.endAnchorPan();
      },
      update: baseInertial.update,
      /** Stop inertial velocity only — does not end an active anchor-pan grab. */
      cancelInertial() {
        baseInertial.cancel();
      },
      cancel() {
        baseInertial.cancel();
        cameraController?.endAnchorPan();
      },
      isActive: baseInertial.isActive,
    };
    inputController = simMode
      ? null
      : createInputController(canvas, inertialCameraController, { isOrbitMode: () => orbitModeActive });

    return geospatialCamera;
  }

  /**
   * Preparation must select the same tiles a camera would normally select.
   * The flight camera can be aimed at the horizon (or temporarily absent), so
   * use an overhead view only while the loading overlay is present. This is a
   * camera change, not a tile traversal or download-priority override.
   */
  function updateTerrainPreparationCamera(): void {
    if (!preparationViewState) return;

    let camera: Camera;
    if (simMode && worldRoot?.parent) {
      if (!preparationCamera) {
        preparationCamera = new UniversalCamera("terrain-preparation-camera", Vector3.Zero(), scene);
        preparationCamera.fov = 1.05;
        preparationCamera.minZ = 1;
        preparationCamera.maxZ = 250_000;
      }
      const altitudeMeters = Math.max(3000, preparationRadiusMeters * 3);
      preparationCamera.position.set(0, altitudeMeters, 0);
      preparationCamera.setTarget(Vector3.Zero());
      preparationCamera.setEnabled(true);
      camera = preparationCamera;
    } else {
      const geospatial = ensureGeospatialCamera();
      const center = geodeticToEcef(
        preparationViewState.latDeg * DEG_TO_RAD,
        preparationViewState.lonDeg * DEG_TO_RAD,
        0,
      );
      geospatial.center = new Vector3(center.x, center.y, center.z);
      geospatial.radius = Math.max(3000, preparationRadiusMeters * 3);
      geospatial.yaw = 0;
      geospatial.pitch = 0;
      geospatial.setEnabled(true);
      camera = geospatial;
    }

    if (activePreparationCamera !== camera) {
      activePreparationCamera = camera;
    }
    scene.activeCamera = camera;
  }

  function beginTerrainPreparationCamera(): void {
    preparationPreviousCamera = scene.activeCamera;
    updateTerrainPreparationCamera();
  }

  function endTerrainPreparationCamera(): void {
    const camera = activePreparationCamera;
    activePreparationCamera = null;
    if (camera && scene.activeCamera === camera) {
      scene.activeCamera = preparationPreviousCamera;
    }
    preparationPreviousCamera = null;
    preparationCamera?.setEnabled(false);
  }

  function ensureFallbackExperience(): void {
    if (fallbackExperienceCreated) {
      scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;
      fallbackExperience?.globeMesh.setEnabled(true);
      fallbackExperience?.light.setEnabled(true);
      recordMapDebugEvent("fallback-show");
      return;
    }

    fallbackExperience = createFallbackExperience(scene, worldRoot);
    fallbackExperienceCreated = true;
    recordMapDebugEvent("fallback-create");
  }

  function hideFallbackExperience(): void {
    fallbackExperience?.globeMesh.setEnabled(false);
    fallbackExperience?.light.setEnabled(false);
    recordMapDebugEvent("fallback-hide");
  }

  function enableFallbackMode(reason: string): void {
    recordMapDebugEvent("fallback-mode-select", { reason });
    releaseStartupHold();
    endStreaming();

    if (activeRasterBaseMap) {
      enableRasterBaseMapMode(reason);
      return;
    }

    if (status.mode === "fallback" && fallbackExperienceCreated) {
      status.lastError = reason;
      status.message = "Fallback mode active due to Google tiles load failure.";
      emitStatus();
      return;
    }

    clearGoogleWatchdog();

    if (tilesRuntime) recordMapDebugEvent("google-runtime-dispose");
    tilesRuntime?.dispose();
    tilesRuntime = null;
    if (rasterTilesRuntime) recordMapDebugEvent("raster-runtime-dispose");
    rasterTilesRuntime?.dispose();
    rasterTilesRuntime = null;

    if (googleLight) {
      googleLight.dispose();
      googleLight = null;
    }

    status.mode = "fallback";
    status.lastError = reason;
    status.message = "Fallback mode active due to Google tiles load failure.";

    ensureGeospatialCamera();
    ensureFallbackExperience();

    console.warn("[runtime] Switching to fallback mode", { reason });
    emitStatus();
  }

  function enableRasterBaseMapMode(reason: string | null, recreate = false): void {
    recordMapDebugEvent("raster-mode-select", { source: activeRasterBaseMap?.id ?? null, reason, recreate });
    const retainRasterCoverage = status.mode === "raster-basemap"
      && (rasterTilesRuntime?.getMetrics().visibleTiles ?? 0) > 0;
    const retainGoogleCoverage = status.mode === "google-tiles"
      && (tilesRuntime?.tiles.visibleTiles.size ?? 0) > 0;
    releaseStartupHold();
    endStreaming();
    clearGoogleWatchdog();

    // Keep visible Google geometry until raster coverage has been adopted.
    // A pending Google runtime has no useful coverage and must not leave stale
    // callbacks that can later change the selected raster mode.
    if (!retainGoogleCoverage) {
      if (tilesRuntime) recordMapDebugEvent("google-runtime-dispose");
      tilesRuntime?.dispose();
      tilesRuntime = null;
      googleLight?.dispose();
      googleLight = null;
    }

    ensureGeospatialCamera();
    ensureFallbackExperience();
    // Switching from Google (or a failed raster load) has no raster coverage
    // yet. Keep the simple globe visible until actual raster tiles arrive;
    // otherwise the canvas is just the clear colour during the handoff.
    if (retainRasterCoverage || retainGoogleCoverage) hideFallbackExperience();

    const rasterBaseMap = activeRasterBaseMap;
    if (!rasterBaseMap) {
      enableFallbackMode(reason ?? "No raster basemap was configured.");
      return;
    }

    if (recreate || !rasterTilesRuntime) {
      if (rasterTilesRuntime) recordMapDebugEvent("raster-runtime-dispose");
      rasterTilesRuntime?.dispose();
      rasterTilesRuntime = createRasterTilesRuntime({
        onDownloadBytes: downloadMeter.addBytes,
        scene,
        source: keyedSource(rasterBaseMap),
        settings,
        getFocus: () => {
          const request = focusRequest();
          if (!request) return null;
          const finest = settings.get("map.focus.detailBelow.imagery");
          return { ...request, offsetCap: typeof finest === "number" ? finest : null };
        },
        worldRoot: worldRoot ?? undefined,
        getSurfaceHeightMeters: options.getSurfaceHeightMeters,
        terrainSource: activeTerrainSource,
        detailOffset: rasterDetailOffset,
        onDetailAdjusted: decision => {
          const text = `${decision.to > decision.from ? "Coarsened" : "Refined"} 2D map detail to ${formatLevels(decision.to)} below the request: frames averaged ${decision.meanFrameMs.toFixed(1)} ms against a ${decision.goalMs.toFixed(1)} ms goal.`;
          console.info("[map auto]", text);
          recordMapDebugEvent("detail-adjusted", { ...decision });
          for (const listener of detailAdjustedListeners) listener(decision);
        },
        imagery: options.rasterImagery ?? (settings.get("map.detail.imageryPath") === "legacy" ? "legacy" : DEFAULT_RASTER_IMAGERY),
        onDetailFeedback: emitRasterDetailFeedback,
        performanceCapture: terrainCapture,
        requestRender: () => scheduler.requestRender(),
        onDebugEvent: recordMapDebugEvent,
        onLoadStart: () => {
          recordMapDebugEvent("raster-load-start");
          status.message = `${activeRasterBaseMap?.label ?? "Raster"} tiles are loading.`;
          beginStreaming();
          emitStatus();
        },
        onLoadEnd: (visibleTiles, activeTiles) => {
          recordMapDebugEvent("raster-load-end", { visibleTiles, activeTiles });
          status.message = `${activeRasterBaseMap?.label ?? "Raster"} active (visible: ${visibleTiles}, active: ${activeTiles}).`;
          if (visibleTiles > 0) {
            hideFallbackExperience();
            if (tilesRuntime) {
              recordMapDebugEvent("google-runtime-dispose");
              tilesRuntime.dispose();
              tilesRuntime = null;
              googleLight?.dispose();
              googleLight = null;
            }
          }
          endStreaming();
          scheduler.requestRender();
          emitStatus();
        },
        onLoadError: (error, url) => {
          recordMapDebugEvent("raster-load-error", { error: error.message, url });
          status.lastError = `${error.message} (${url})`;
          status.message = `${activeRasterBaseMap?.label ?? "Raster"} reported tile load errors.`;
          emitStatus();
        },
      });
    } else if (rasterTilesRuntime.source.id !== rasterBaseMap.id) {
      rasterTilesRuntime.setSource(keyedSource(rasterBaseMap));
    }

    status.mode = "raster-basemap";
    status.rasterBaseMap = rasterBaseMap;
    knownRasterBaseMaps.set(rasterBaseMap.id, rasterBaseMap);
    const displayedId = rasterTilesRuntime.getDisplayedSourceId();
    status.displayedRasterBaseMap = knownRasterBaseMaps.get(displayedId) ?? rasterBaseMap;
    status.terrainSource = activeTerrainSource;
    status.lastError = reason;
    status.message = reason
      ? `${rasterBaseMap.label} active after Google tiles failed.`
      : `${rasterBaseMap.label} raster basemap active.`;
    rasterTilesRuntime.update();
    scheduler.requestRender();

    console.info("[runtime] Raster basemap runtime initialized", { source: rasterBaseMap.id, terrain: activeTerrainSource.id, reason });
    emitStatus();
  }

  function enableGoogleTilesMode(): void {
    recordMapDebugEvent("google-mode-select");
    releaseStartupHold();
    endStreaming();
    clearGoogleWatchdog();
    const retainRasterCoverage = (rasterTilesRuntime?.getMetrics().visibleTiles ?? 0) > 0;
    // Preserve the last usable raster surface until Google has visible tiles.
    if (!retainRasterCoverage) {
      if (rasterTilesRuntime) recordMapDebugEvent("raster-runtime-dispose");
      rasterTilesRuntime?.dispose();
      rasterTilesRuntime = null;
    }
    if (!hasGoogleApiKey) {
      if (activeRasterBaseMap) enableRasterBaseMapMode("Google 3D Tiles need an API key.");
      else enableFallbackMode("Google 3D Tiles need an API key.");
      return;
    }
    tilesRuntime?.dispose();
    tilesRuntime = null;
    googleLight?.dispose();
    googleLight = null;

    try {
      scene.clearColor = DEFAULT_GOOGLE_BACKGROUND;

      ensureGeospatialCamera();
      ensureFallbackExperience();
      scene.clearColor = DEFAULT_GOOGLE_BACKGROUND;

      googleLight = new HemisphericLight("google-tiles-light", new Vector3(0, 1, 0), scene);
      googleLight.intensity = 1.0;

      // Hold a continuous-render reference from startup until the first tiles
      // become visible. This ensures tiles.update() is called every frame so
      // the tile-load loop progresses without requiring a camera gesture.
      startupHeld = true;
      scheduler.beginContinuous();

      tilesRuntime = createGoogleTilesRuntime({
        onDownloadBytes: downloadMeter.addBytes,
        scene,
        apiKey: normalizedApiKey,
        // Flight attaches the simulation world to a floating-origin parent.
        // Before that happens, terrain preparation owns the active camera and
        // its normal camera-based detail selection remains the safe behavior.
        settings,
        getTerrainDetailAnchor: () => {
          if (googleTerrainDetailAnchor === "focus-point") {
            const focus = focusPosition();
            return focus ? ecefToScene(focus) : null;
          }
          return null;
        },
        getFocus: () => {
          const request = focusRequest();
          if (!request) return null;
          const finest = settings.get("map.focus.detailBelow.google");
          return { ...request, finestErrorPx: typeof finest === "number" ? finest : null };
        },
        onLoadError: (error, url) => {
          if (status.mode !== "google-tiles") return;
          recordMapDebugEvent("google-load-error", { error: error.message, url });
          status.lastError = error.message;
          status.message = "Google tiles reported load errors.";
          emitStatus();

          if (!tilesRuntime || tilesRuntime.tiles.visibleTiles.size === 0) {
            enableFallbackMode(
              `Google 3D tiles could not be loaded (${error.message}). Check key permissions and API access for tile.googleapis.com.`,
            );
          }
        },
        onLoadStart: () => {
          if (status.mode !== "google-tiles") return;
          recordMapDebugEvent("google-load-start");
          status.message = "Google tiles are loading.";
          beginStreaming();
          emitStatus();
        },
        onLoadEnd: (visibleTiles, activeTiles) => {
          if (status.mode !== "google-tiles") return;
          recordMapDebugEvent("google-load-end", { visibleTiles, activeTiles });
          status.lastError = null;
          status.message = `Google tiles loaded (visible: ${visibleTiles}, active: ${activeTiles}).`;
          endStreaming();
          scheduler.requestRender();
          emitStatus();

          if (visibleTiles > 0) {
            hideFallbackExperience();
            if (rasterTilesRuntime) {
              recordMapDebugEvent("raster-runtime-dispose");
              rasterTilesRuntime.dispose();
              rasterTilesRuntime = null;
            }
            clearGoogleWatchdog();
            releaseStartupHold();
          }
        },
      });

      if (googleTerrainDetailTarget !== null) {
        tilesRuntime.setTerrainDetailTarget(googleTerrainDetailTarget);
      }

      tilesRuntime.tiles.checkCollisions = true;
      if (worldRoot) {
        tilesRuntime.tiles.group.parent = worldRoot;
      }

      status.mode = "google-tiles";
      status.message = "Google Photorealistic 3D Tiles mode active.";
      status.lastError = null;
      emitStatus();

      googleTilesStartupWatchdog = window.setTimeout(() => {
        if (status.mode !== "google-tiles") {
          return;
        }

        if (!tilesRuntime || tilesRuntime.tiles.visibleTiles.size === 0) {
          enableFallbackMode(
            "No Google tiles became visible after startup. Confirm your API key is valid, Maps Tiles API is enabled, and localhost is allowed in key restrictions.",
          );
        }
      }, simMode ? 120_000 : 10_000);

      console.info("[runtime] Google tiles runtime initialized");
    } catch (error) {
      console.error("[runtime] Google tiles initialization failed, entering fallback mode", error);
      enableFallbackMode(getErrorMessage(error));
    }
  }

  emitStatus();

  if (shouldStartGoogle) {
    enableGoogleTilesMode();
  } else {
    if (activeRasterBaseMap) {
      enableRasterBaseMapMode(null);
    } else {
      ensureGeospatialCamera();
      ensureFallbackExperience();
      status.message = "Fallback mode active: missing Google Maps API key.";
      emitStatus();
    }

    console.warn("[runtime] No Google Maps API key found. Starting without Google 3D tiles.");
  }

  function applyMapSource(source: "google" | RasterBaseMapSource): void {
    recordMapDebugEvent("map-source-selection", { source });
    if (source === "google") {
      if (status.mode !== "google-tiles") enableGoogleTilesMode();
      return;
    }
    if (activeRasterBaseMap?.id === source.id && status.mode === "raster-basemap") return;
    activeRasterBaseMap = source;
    enableRasterBaseMapMode(null);
  }

  function applyTerrainSource(source: TerrainSource): void {
    const nextSource = resolveTerrainSource(source);
    if (activeTerrainSource.id === nextSource.id) return;
    activeTerrainSource = nextSource;
    status.terrainSource = nextSource;
    if (status.mode === "raster-basemap") {
      rasterTilesRuntime?.setTerrainSource(nextSource);
      scheduler.requestRender();
    }
    emitStatus();
  }

  // The runtime follows its parameters wherever they change: the Map tab, Show
  // all parameters, an import, a preset or another tab.
  const stopWatchingSettings = [
    settings.watch("map.source.basemap", value => {
      const id = String(value);
      if (id === "google") applyMapSource("google");
      else if (isKnownRasterBaseMapId(id)) applyMapSource(resolveRasterBaseMapSource(id));
    }),
    settings.watch("map.source.elevation", value => applyTerrainSource(resolveTerrainSource(String(value)))),
    settings.watch("map.focus.refineFrom", value => {
      googleTerrainDetailAnchor = anchorForRefinement(value);
      scheduler.requestRender();
    }),
    settings.watch("map.source.cartoKey", () => {
      const source = activeRasterBaseMap;
      if (status.mode !== "raster-basemap" || !source?.apiKey || !rasterTilesRuntime) return;
      rasterTilesRuntime.setSource(keyedSource(source));
      scheduler.requestRender();
    }),
    // Both maps read the focus region each frame; a change needs one drawn.
    ...FOCUS_PARAMETER_IDS.map(id => settings.watch(id, () => {
      focusCache = null;
      scheduler.requestRender();
    })),
  ];

  // The HTTP tile cache is shared by every map on the page; its limits are parameters.
  const MiB = 1024 * 1024;
  const settingNumber = (id: string): number => {
    const value = settings.get(id);
    return typeof value === "number" ? value : 0;
  };
  const applyMapCacheLimits = (): void => setMapCacheLimits({
    maxBytes: settingNumber("map.cache.httpBytes") * MiB,
    maxEntries: Math.round(settingNumber("map.cache.httpEntries")),
    maxTileBytes: settingNumber("map.cache.maxTileBytes") * MiB,
  });
  applyMapCacheLimits();
  stopWatchingSettings.push(
    settings.watch("map.cache.httpBytes", applyMapCacheLimits),
    settings.watch("map.cache.httpEntries", applyMapCacheLimits),
    settings.watch("map.cache.maxTileBytes", applyMapCacheLimits),
  );

  // Each budget shows what it bounds, read while its section is on screen.
  const mebibytes = (bytes: number): string => `${bytes >= 10 * MiB ? Math.round(bytes / MiB) : (bytes / MiB).toFixed(1)} MiB`;
  const imagery = () => (status.mode === "raster-basemap" ? rasterTilesRuntime?.getImageryDiagnostics().atlas ?? null : null);
  let uploadSample: { at: number; bytes: number } | null = null;
  const google = () => (status.mode === "google-tiles" ? tilesRuntime?.getLoadingState?.() ?? null : null);
  const raster = () => (status.mode === "raster-basemap" ? rasterTilesRuntime : null);
  const formatPx = (px: number): string => `${px >= 10 ? Math.round(px) : px.toFixed(1)} px`;
  const because = (decision: AutoDetailDecision | null): string => (decision
    ? `, since frames averaged ${decision.meanFrameMs.toFixed(1)} ms against a ${decision.goalMs.toFixed(1)} ms goal`
    : "");
  const readings: Array<[string, () => string | null]> = [
    ["map.imagery.gpuBudget", () => {
      const atlas = imagery()?.atlas;
      return atlas ? `${mebibytes(atlas.estimatedGpuBytes)} allocated, ${atlas.capacity - atlas.freeSlots} of ${atlas.capacity} pages in use` : null;
    }],
    ["map.imagery.stagingBudget", () => {
      const residency = imagery()?.residency;
      return residency ? `${mebibytes(residency.stagedBytes + residency.inFlightReservedBytes)} waiting` : null;
    }],
    ["map.imagery.concurrentRequests", () => {
      const residency = imagery()?.residency;
      return residency ? `${residency.inFlight} in flight` : null;
    }],
    ["map.imagery.queuedRequests", () => {
      const residency = imagery()?.residency;
      return residency ? `${residency.queued} queued${residency.overflow > 0 ? `, ${residency.overflow} left out` : ""}` : null;
    }],
    ["map.imagery.uploadPerFrame", () => {
      const counters = imagery()?.counters;
      if (!counters) return null;
      const at = performance.now();
      const previous = uploadSample;
      uploadSample = { at, bytes: counters.uploadBytes };
      if (!previous || at <= previous.at) return null;
      return `${mebibytes(((counters.uploadBytes - previous.bytes) * 1000) / (at - previous.at))}/s uploaded`;
    }],
    ["map.imagery.selectionTimePerFrame", () => {
      const plan = imagery()?.plan;
      return plan ? `the last choice took ${plan.cpuMs.toFixed(1)} ms over ${plan.nodesEvaluated} regions` : null;
    }],
    ["map.imagery.maxNodes", () => {
      const plan = imagery()?.plan;
      return plan ? `${plan.nodesEvaluated} examined${plan.truncated ? ", limit reached" : ""}` : null;
    }],
    ["map.focus.radius", () => {
      const diagnostics = imagery();
      const focus = diagnostics?.focus;
      if (!focus) return null;
      const limited = diagnostics.plan?.limits.includes("memory") ? "; the GPU budget limits its detail" : "";
      return `${focus.pages} imagery pages in the region, about ${focus.estimatedPages} expected from this view${limited}`;
    }],
    ["map.detail.terrain.default", () => {
      const terrain = raster()?.getTerrainState();
      return terrain ? `${formatPx(terrain.targetPx)} in use${terrain.targetPx !== terrain.requestedTargetPx ? `, ${formatPx(terrain.requestedTargetPx)} asked for` : ""}` : null;
    }],
    ["map.terrain.maxTiles", () => {
      const terrain = raster()?.getTerrainState();
      return terrain ? `${terrain.selectedTiles} chosen, ${terrain.neededTiles} in view or around the focus point${terrain.truncated ? ", limit reached" : ""}` : null;
    }],
    ["map.auto.terrainDetail", () => {
      const runtime = raster();
      const auto = runtime?.getAutoDetailState();
      if (!runtime || !auto?.terrainEnabled) return null;
      const terrain = runtime.getTerrainState();
      return auto.adjustment > 0 && terrain.targetPx > terrain.requestedTargetPx
        ? `${formatPx(terrain.targetPx)}, coarser than the ${formatPx(terrain.requestedTargetPx)} asked for${because(auto.lastDecision)}`
        : "At the detail asked for";
    }],
    ["map.auto.imageryDetail", () => {
      const auto = raster()?.getAutoDetailState();
      if (!auto?.imageryEnabled) return null;
      return auto.offset < auto.requestedOffset
        ? `${formatLevels(auto.requestedOffset - auto.offset)} coarser than asked for${because(auto.lastDecision)}`
        : "At the detail asked for";
    }],
    ["map.auto.frameTimeGoal", () => {
      const auto = raster()?.getAutoDetailState();
      if (!auto || auto.goalMs === null) return null;
      return `${auto.goalMs.toFixed(1)} ms in use${auto.lastMeanMs !== null ? `; the last window averaged ${auto.lastMeanMs.toFixed(1)} ms` : ""}`;
    }],
    ["map.terrain.cachedTiles", () => {
      const metrics = status.mode === "raster-basemap" ? rasterTilesRuntime?.getMetrics() : null;
      return metrics ? `${metrics.activeTiles} kept, ${metrics.visibleTiles} shown` : null;
    }],
    ["map.google.cacheTiles", () => { const state = google(); return state ? `${state.cachedTiles} kept` : null; }],
    ["map.google.cacheBytes", () => { const state = google(); return state ? `${mebibytes(state.cachedBytes)} kept` : null; }],
    ["map.google.downloads", () => { const state = google(); return state ? `${state.downloading} downloading` : null; }],
    ["map.google.parses", () => { const state = google(); return state ? `${state.parsing} parsing` : null; }],
  ];
  const removeReadings = readings.map(([id, read]) => settings.setReadingSource(id, read));

  const handleResize = () => {
    renderer.engine.resize();
    scheduler.requestRender();
  };
  window.addEventListener("resize", handleResize);

  const handleVisibility = () => {
    scheduler.setPaused(document.hidden);
  };
  document.addEventListener("visibilitychange", handleVisibility);

  if (mapDebugEnabled) {
    window.__fossMapDebug = {
      get runtimeMode() { return status.mode; },
      get sceneMeshCount() { return scene.meshes.length; },
      get enabledMeshCount() { return scene.meshes.filter(mesh => mesh.isEnabled()).length; },
      get rasterVisibleTiles() { return rasterTilesRuntime?.getMetrics().visibleTiles ?? 0; },
      get rasterActiveTiles() { return rasterTilesRuntime?.getMetrics().activeTiles ?? 0; },
      get fallbackEnabled() { return fallbackExperience?.globeMesh.isEnabled() ?? false; },
      get activeCamera() { return scene.activeCamera?.name ?? null; },
      get schedulerActive() { return scheduler.isActive(); },
      get pendingTextureCount() { return scene.textures.filter(texture => !texture.isReady()).length; },
      get readyTextureCount() { return scene.textures.filter(texture => texture.isReady()).length; },
      get recentEvents() { return mapDebugEvents; },
    };
    recordMapDebugEvent("debug-ready");
  }

  // Kick the first frame so initial scene state paints.
  scheduler.requestRender();

  const surface = createSurfaceQuery(scene, () => worldRoot, mesh => Boolean(mesh.metadata?.mapSurface)
    || Boolean(tilesRuntime && mesh.isDescendantOf(tilesRuntime.tiles.group)),
    () => status.mode === "google-tiles" ? tilesRuntime?.getRevision() ?? 0 : rasterTilesRuntime?.getRevision() ?? 0,
    (lat, lon) => status.mode === "raster-basemap" ? rasterTilesRuntime?.sample(lat, lon) : undefined);

  function prepareTerrain(request: TerrainPreparationOptions): Promise<TerrainPreparationResult> {
    try { validateTerrainPreparation(request); } catch (error) { return Promise.reject(error); }
    cancelPreparation?.(new DOMException("Terrain preparation was replaced by another destination.", "AbortError"));
    if (request.signal?.aborted) return Promise.reject(new DOMException("Terrain preparation cancelled.", "AbortError"));
    const sourceMode = status.mode;
    if (sourceMode === "fallback") {
      if (status.lastError) return Promise.reject(new Error(status.lastError));
      const groundHeightMeters = options.getSurfaceHeightMeters?.(request.latDeg, request.lonDeg) ?? 0;
      request.onProgress?.({ phase: "ready", readySamples: 1, totalSamples: 1, progress: 1, message: "World ready." });
      return Promise.resolve({ groundHeightMeters, altitudeMeters: Math.max(request.altitudeMeters ?? -Infinity,
        groundHeightMeters + (request.altitudeAboveGroundMeters ?? (request.altitudeMeters === undefined ? 1524 : 0)),
        groundHeightMeters + (request.clearanceMeters ?? 1000)) });
    }
    const radiusMeters = request.radiusMeters ?? 1000;
    preparationRadiusMeters = radiusMeters;
    preparationViewState = { latDeg: request.latDeg, lonDeg: request.lonDeg, headingDeg: 0, pitchDeg: 90,
      zoomMeters: Math.max(2000, radiusMeters * 2) };
    beginTerrainPreparationCamera();
    const points = terrainReadinessSamples(request.latDeg, request.lonDeg, radiusMeters);
    const preparationStartedAt = performance.now();
    let lastTerrainProgressAt = preparationStartedAt;
    let lastTerrainSignature = "";
    let centerQuality: number | null = null;
    let settledChecks = 0;
    /** Google tiles queued, downloading or parsing; null when not on Google or not known. */
    const googlePendingTiles = (): number | null => {
      if (sourceMode !== "google-tiles") return null;
      const loading = tilesRuntime?.getLoadingState?.();
      return loading ? loading.queued + loading.downloading + loading.parsing : null;
    };
    let latestProgress: Parameters<NonNullable<TerrainPreparationOptions["onProgress"]>>[0] = {
      phase: "loading", readySamples: 0, totalSamples: points.length, progress: 0,
      message: "Waiting for terrain to cover the aircraft's location.",
    };
    const publishPreparationProgress = (progress: typeof latestProgress, failure?: Error): void => {
      const now = performance.now();
      const raster = sourceMode === "raster-basemap" ? rasterTilesRuntime : null;
      const requests = raster?.getLoadingDiagnostics?.();
      const visibleTiles = raster?.getMetrics().visibleTiles ?? tilesRuntime?.tiles.visibleTiles.size ?? 0;
      // Queue churn and retries are activity, not improvement in usable ground.
      const signature = `${progress.readySamples}/${centerQuality}/${visibleTiles}`;
      if (signature !== lastTerrainSignature) {
        lastTerrainSignature = signature;
        lastTerrainProgressAt = now;
      }
      const stalledForMs = now - lastTerrainProgressAt;
      // Provider errors can contain signed URLs or API keys. Reports retain
      // the endpoint and error, never URL credentials or query strings.
      const lastError = (failure?.message ?? status.lastError)?.replace(/https?:\/\/[^\s)]+/g, value => {
        try { const url = new URL(value); return url.origin + url.pathname; }
        catch { return "[provider URL]"; }
      }) ?? null;
      latestProgress = {
        ...progress,
        diagnostics: {
          status: failure ? "failed" : progress.phase === "ready" ? "ready" : stalledForMs >= 15_000 ? "stalled" : "loading",
          provider: sourceMode === "google-tiles" ? "Google 3D Tiles" : activeTerrainSource.label,
          elapsedMs: now - preparationStartedAt,
          stalledForMs,
          timeoutMs: request.timeoutMs ?? 120_000,
          activeElevationRequests: requests?.activeElevationRequests ?? null,
          queuedElevationRequests: requests?.queuedElevationRequests ?? null,
          pendingTiles: requests?.pendingTiles ?? googlePendingTiles(),
          visibleTiles,
          centerQuality,
          requiredQuality: sourceMode === "google-tiles" ? null : 10,
          lastError,
        },
      };
      request.onProgress?.(latestProgress);
    };
    scheduler.beginContinuous();
    return new Promise<TerrainPreparationResult>((resolve, reject) => {
      let settled = false;
      let lastSampleAt = -Infinity;
      const abort = () => finish(new DOMException("Terrain preparation cancelled.", "AbortError"));
      const timeout = window.setTimeout(() => finish(new Error("Terrain near the destination did not become ready. Check the map connection and retry.")), request.timeoutMs ?? 120_000);
      function finish(error: Error | null, result?: TerrainPreparationResult): void {
        if (settled) return;
        settled = true;
        if (error) publishPreparationProgress({ ...latestProgress, message: error.message }, error);
        window.clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        preparationTick = null;
        cancelPreparation = null;
        endTerrainPreparationCamera();
        preparationViewState = null;
        preparationRadiusMeters = 0;
        scheduler.endContinuous();
        if (error) reject(error);
        else resolve(result!);
      }
      cancelPreparation = error => finish(error);
      request.signal?.addEventListener("abort", abort, { once: true });
      preparationTick = now => {
        if (sourceMode !== status.mode) {
          finish(new Error(status.lastError ?? "Map source changed while preparing the destination. Retry with the selected map."));
          return;
        }
        if (now - lastSampleAt < 200) return;
        lastSampleAt = now;
        const samples = points.map(point => surface.sample(point.latDeg, point.lonDeg));
        centerQuality = samples[0]?.quality ?? null;
        // Google is ready once its renderer has loaded what it chose for the
        // preparation view, on two checks in a row: before that, its surface
        // can be a coarse tile far from the ground.
        const pending = googlePendingTiles();
        settledChecks = pending === 0 ? settledChecks + 1 : 0;
        const evaluation = evaluateTerrainReadiness(request, samples, sourceMode === "google-tiles", pending === null || settledChecks >= 2);
        const result = evaluation.result;
        // A complete sample set is a coherent snapshot of displayed terrain.
        // Waiting for subsequent samples made normal tile eviction reset the
        // loading bar from 95% to zero before a flight could begin.
        if (result) {
          publishPreparationProgress({ ...evaluation.progress, phase: "ready", progress: 1, message: "Terrain ready for flight." });
          finish(null, result);
          return;
        }
        publishPreparationProgress(evaluation.progress);
      };
      publishPreparationProgress(latestProgress);
      scheduler.requestRender();
    });
  }

  const applyGlobeNavigationIntents = (frame: GlobeNavigationIntentFrame): void => {
    if (simMode || !inertialCameraController) {
      return;
    }
    const dt = Number.isFinite(frame.dt) ? Math.max(0, Math.min(0.1, frame.dt)) : 0;
    if (dt === 0) {
      return;
    }
    const canvasHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
    for (const intent of frame.intents) {
      const value = Number.isFinite(intent.value) ? Math.max(-1, Math.min(1, intent.value)) : 0;
      switch (intent.actionId) {
        case "globe.panX":
          inertialCameraController.panBy(value * 900 * dt, 0, canvasHeight);
          break;
        case "globe.panY":
          inertialCameraController.panBy(0, -value * 900 * dt, canvasHeight);
          break;
        case "globe.orbitHeading":
          inertialCameraController.orbitBy(0, value * 75 * dt);
          break;
        case "globe.orbitPitch":
          inertialCameraController.orbitBy(value * 65 * dt, 0);
          break;
        case "globe.zoom":
          inertialCameraController.zoomBy(Math.exp(-value * 1.5 * dt));
          break;
      }
    }
  };

  return {
    surface,
    prepareTerrain,
    engine: renderer.engine,
    scene,
    renderer,
    status,
    get geospatialCamera(): GeospatialCamera | null {
      return geospatialCamera;
    },
    getViewState(): GlobeViewState | null {
      if (simMode && simViewState) return simViewState;
      return cameraController?.getViewState() ?? null;
    },
    setViewState(partial: Partial<GlobeViewState>): void {
      inertialCameraController?.cancel();
      cameraController?.setViewState(partial);
      scheduler.requestRender();
    },
    configureOrbitTargetHeight(options: OrbitTargetHeightOptions | null): void {
      inertialCameraController?.cancel();
      cameraController?.configureOrbitTargetHeight(options);
      scheduler.requestRender();
    },
    getTileMetrics(): BabylonTileMetrics | null {
      if (tilesRuntime) {
        return {
          visibleTiles: tilesRuntime.tiles.visibleTiles.size,
          activeTiles: tilesRuntime.tiles.activeTiles.size,
        };
      }
      return rasterTilesRuntime?.getMetrics() ?? null;
    },
    getGoogleTerrainDetailState(): GoogleTerrainDetailState | null {
      return tilesRuntime?.getTerrainDetailState() ?? null;
    },
    setGoogleTerrainDetailTarget(errorTarget: number | null): void {
      googleTerrainDetailTarget = errorTarget;
      tilesRuntime?.setTerrainDetailTarget(errorTarget);
      scheduler.requestRender();
    },
    registerFocusPoint(point: FocusPoint): () => void {
      if (point.id === "orbit-target") throw new Error("The focus point id orbit-target is built in.");
      focusPoints.set(point.id, point);
      syncFocusChoices();
      focusCache = null;
      scheduler.requestRender();
      return () => {
        if (focusPoints.get(point.id) !== point) return;
        focusPoints.delete(point.id);
        syncFocusChoices();
        focusCache = null;
        scheduler.requestRender();
      };
    },
    getFocusPosition: focusPosition,
    getGoogleTerrainDetailAnchor(): GoogleTerrainDetailAnchor {
      return googleTerrainDetailAnchor;
    },
    setGoogleTerrainDetailAnchor(anchor: GoogleTerrainDetailAnchor): void {
      googleTerrainDetailAnchor = anchor;
      scheduler.requestRender();
    },
    setRasterDetailTarget(offset: number): void {
      if (!Number.isFinite(offset) || offset === rasterDetailOffset) return;
      rasterDetailOffset = offset;
      rasterTilesRuntime?.setDetailTarget(offset);
      scheduler.requestRender();
    },
    getRasterDetailFeedback(): RasterDetailFeedback | null {
      return status.mode === "raster-basemap" ? rasterTilesRuntime?.getDetailFeedback() ?? null : null;
    },
    onRasterDetailFeedback(listener: () => void): () => void {
      rasterDetailListeners.add(listener);
      return () => { rasterDetailListeners.delete(listener); };
    },
    subscribeStatus(listener: (status: BabylonRuntimeStatus) => void): () => void {
      statusListeners.add(listener);
      return () => { statusListeners.delete(listener); };
    },
    setRasterBaseMap(source): void {
      if (activeRasterBaseMap?.id === source.id && status.mode === "raster-basemap") return;
      activeRasterBaseMap = source;
      enableRasterBaseMapMode(null);
    },
    setMapSource: applyMapSource,
    setTerrainSource: applyTerrainSource,
    onDetailAdjusted(listener): () => void {
      detailAdjustedListeners.add(listener);
      return () => { detailAdjustedListeners.delete(listener); };
    },
    setOrbitMode(active: boolean): void {
      orbitModeActive = active;
    },
    setInputMode(mode: InputModePreference): void {
      inputController?.setMode(mode);
    },
    setInputSensitivity(sensitivity: Partial<InputSensitivitySettings>): void {
      inputController?.setSensitivity(sensitivity);
    },
    applyGlobeNavigationIntents,
    setGlobeAnchorRotation(enabled: boolean): void {
      inputController?.setGlobeAnchorRotation(enabled);
    },
    getGlobeAnchorRotation(): boolean {
      return inputController?.getGlobeAnchorRotation() ?? false;
    },
    requestRender(): void {
      scheduler.requestRender();
    },
    beginContinuous(): void {
      scheduler.beginContinuous();
    },
    endContinuous(): void {
      scheduler.endContinuous();
    },
    setPaused(paused: boolean): void {
      scheduler.setPaused(paused);
    },
    isRendering(): boolean {
      return scheduler.isActive();
    },
    onActiveRenderChange(listener): () => void {
      return scheduler.onActiveChange(listener);
    },
    getMapDownloadBytesPerSecond: downloadMeter.getBytesPerSecond,
    onMapDownloadRateChange: downloadMeter.subscribe,
    isStreamingTiles(): boolean {
      return streamingActiveRef.value;
    },
    onTilesStreamingChange(listener): () => void {
      streamingListenersRef.add(listener);
      return () => {
        streamingListenersRef.delete(listener);
      };
    },
    getWorldRoot(): TransformNode | null {
      return worldRoot;
    },
    setSimViewState(partial: Partial<GlobeViewState>): void {
      if (!simMode) return;
      const current = simViewState ?? {
        latDeg: DEFAULT_CAMERA_LAT_DEG,
        lonDeg: DEFAULT_CAMERA_LON_DEG,
        headingDeg: 0,
        pitchDeg: 0,
        zoomMeters: DEFAULT_CAMERA_ALTITUDE_METERS,
      };
      simViewState = { ...current, ...partial };
      rasterTilesRuntime?.update();
    },
    setSimRunning(running): void {
      if (!simMode || simRunning === running) return;
      simRunning = running;
      scheduler.requestRender();
    },
    setSimTick(callback: ((deltaSeconds: number) => void) | null): void {
      simTick = callback;
    },
    destroy() {
      for (const stop of stopWatchingSettings) stop();
      for (const remove of removeReadings) remove();
      cancelPreparation?.(new DOMException("Map runtime destroyed.", "AbortError"));
      if (captureFromUrl && window.fossTerrainPerformance === terrainCapture) {
        if (previousCapture) window.fossTerrainPerformance = previousCapture;
        else delete window.fossTerrainPerformance;
      }
      statusListeners.clear();
      rasterDetailListeners.clear();
      downloadMeter.destroy();
      scheduler.stop();
      clearGoogleWatchdog();

      tilesRuntime?.dispose();
      tilesRuntime = null;

      rasterTilesRuntime?.dispose();
      rasterTilesRuntime = null;

      inputController?.destroy();
      inputController = null;

      inertialCameraController?.cancel();
      inertialCameraController = null;

      if (googleLight) {
        googleLight.dispose();
        googleLight = null;
      }
      if (simLight) {
        simLight.dispose();
        simLight = null;
      }

      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", handleResize);
      scene.dispose();
      renderer.engine.dispose();
    },
  };
}
