import { Color3, Color4, HemisphericLight, MeshBuilder, StandardMaterial, UniversalCamera, Vector3, type AbstractMesh, type Camera, type Engine, type GeospatialCamera, type Scene, type TransformNode, type WebGPUEngine } from "@babylonjs/core";
import type { RendererMode } from "@foss-earth/renderer";
import type { RendererSelection, FrameProfileSession } from "@foss-earth/renderer/babylon";
import type { SkyRuntime } from "@foss-earth/sky/babylon";
import { createMapDownloadMeter } from "../browser/mapDownloadMeter.js";
import { createSurfaceQuery } from "./surfaceQuery.js";
import type { SurfaceQuery } from "../surface/contracts.js";
import { createCurrentDisplayedSurface, type CurrentDisplayedSurface, type CurrentSurfaceOwnerState, type SurfaceOwnerChange } from "../surface/currentReadiness.js";
import { resolveTerrainSource, type TerrainSource } from "../terrain/terrainGrid.js";
import { terrainReadinessSamples } from "../surface/coverageSamples.js";
import { validateTerrainPreparation, type TerrainPreparationOptions, type TerrainPreparationResult } from "../surface/terrainPreparation.js";
import { createGoogleTilesRuntime, type GoogleTerrainDetailState } from "./createTilesRuntime.js";
import { NativeMapStartupError } from "./nativeMapSettlement.js";
import { createRasterTilesRuntime, type RasterDetailFeedback } from "./createRasterTilesRuntime.js";
import { finishOwnedCleanup } from "./ownedCleanup.js";
import type { ImageryConstraint, ImageryConstraintCause } from "../terrain/imagery/imageryConstraints.js";
import { DEFAULT_RASTER_IMAGERY } from "../settings/mapRuntimeConfig.js";
import { isKnownRasterBaseMapId, resolveRasterBaseMapSource, withSourceKey, type RasterBaseMapSource } from "../map/rasterBaseMaps.js";
import type { AutoDetailDecision } from "../terrain/autoDetail.js";
import { geodeticToEcef, DEG_TO_RAD } from "../camera/cameraMath.js";
import { CameraController, type OrbitTargetHeightOptions } from "./cameraState.js";
import { createInputController, type InputController } from "../browser/createInputController.js";
import { passUnusedInputToWorld } from "../browser/passToWorld.js";
import { DEFAULT_GRAB_FOLLOW_MS, DEFAULT_INERTIA_DECAY_PER_FRAME, GRAB_FOLLOW_ID, type InertialCameraController } from "../input/inertialCameraController.js";
import type { CameraHandling } from "../camera/cameraLimits.js";
import type { GlobeNavigationIntentFrame } from "../input/globeNavigationTypes.js";
import type { InputModePreference, InputSensitivitySettings } from "../input/inputSettings.js";
import { INPUT_RATE_IDS } from "../settings/catalogue/controls.js";
import { createCameraSettings } from "../settings/cameraSettings.js";
import type { GlobeViewState } from "../view.js";
import { createNavigationOwner, NAVIGATION_PRESENTATION_LAYER, type EcefVector, type NavigationAcquisition, type NavigationGlide, type NavigationLease, type NavigationPresentation, type NavigationRequest, type NavigationSnapshot, type NavigationState } from "../navigation/navigationLease.js";
import type { ActionIntentFrame } from "@felipegalind0/gamepad-tools/core";
import { createGeospatialGlobeCamera } from "./globeCamera.js";
import { createGlobeInertia } from "./globeInertia.js";
import { createCameraClipping } from "./cameraClipping.js";
import { createNavigationCameraAdapter } from "./navigationCamera.js";
import { createGlobeIntentMotion } from "../input/globeIntentMotion.js";
import { createNavigationAnchorService, type GlobeNavigationAnchors, type NavigationAnchorService, type NavigationAnchorStatus } from "./navigationAnchorService.js";
import { ANCHOR_FALLBACK_MESSAGES, ANCHOR_FAMILIES, ANCHOR_OPERATIONS, NAVIGATION_ANCHOR_SETTING_IDS, SHOW_NAVIGATION_ANCHORS_ID, navigationAnchorSettingId, navigationAnchorsFromSettings, type AnchorFamily, type AnchorOperation } from "../input/navigationAnchors.js";
import { pointInViewProblem } from "../camera/anchoredMotion.js";
import { ecefToVector3, projectEcefToClient } from "./anchorPan.js";
import type { NavigationAnchorMarkers, NavigationAnchorMarkerView } from "../browser/navigationAnchorMarkers.js";
import { createBorrowedRuntimeAuthority } from "./borrowedRuntimeAuthority.js";
import type { GlobeRuntimeOptions, GlobeMapDebugSnapshot } from "./globeRuntimePorts.js";
export type * from "./globeRuntimePorts.js";
export { NAVIGATION_PRESENTATION_LAYER };
const PLANET_RADIUS_METERS = 6_378_137;
const DEFAULT_FALLBACK_BACKGROUND = new Color4(0.01, 0.02, 0.05, 1);
const DEFAULT_GOOGLE_BACKGROUND = new Color4(0.04, 0.05, 0.07, 1);
const DEFAULT_CAMERA_LAT_DEG = 44.977753;
const DEFAULT_CAMERA_LON_DEG = -93.265011;
const DEFAULT_CAMERA_ALTITUDE_METERS = 600;

export type { RendererMode };
export type { GroundLightSource, SkyCost, SkyEnvironment, SkyGroundLight } from "@foss-earth/sky/babylon";

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

export interface GlobeRuntime {
  prepareFrame(nowMs: number): void;
  afterFrame(nowMs: number, rendered?: boolean): void;
  shouldKeepRendering(): boolean;
  isPreparingFrame(): boolean;
  minFrameIntervalMs(): number;
  setExternalViewState(partial: Partial<GlobeViewState>): void;
  setExternalRunning(running: boolean): void;
  setExternalFrameCallback(callback: ((deltaSeconds: number) => void) | null): void;
  /** Stream and refine a destination before creating or relocating an aircraft. */
  prepareTerrain(options: TerrainPreparationOptions): Promise<TerrainPreparationResult>;
  /** Collision and placement queries against the currently displayed map mesh. */
  surface: SurfaceQuery;
  /** Engine-owned current local displayed query evidence and paused-safe subscriptions. */
  displayedSurface: CurrentDisplayedSurface;
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
  /** Google requested and camera-visible loaded geometric detail, in pixels. */
  getGoogleTerrainDetailState(): GoogleTerrainDetailState | null;
  /** Called when loaded Google detail changes after selection or a camera move. */
  onGoogleDetailFeedback(listener: () => void): () => void;
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
  /** The input mode wheel and gesture events are read with; a navigation lease's input reads them the same way. */
  getInputMode(): InputModePreference;
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
   * Render-on-demand controls: a frame is drawn only when one is asked for.
   * Meshes and lights entering or leaving the scene ask for theirs, and so does
   * a frame that skipped a mesh still compiling or loading, once it is ready
   * (sceneUpdates.ts). Any other change to what the scene shows - moving,
   * showing, hiding or recolouring something already in it - must call
   * requestRender() to be seen.
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
  /**
   * Takes navigation for one owner, such as a panorama scene: the globe's
   * input, point tracking and map selection pause until the lease ends.
   * Busy while another owner or a simulation holds the camera.
   */
  acquireNavigation(request: NavigationRequest): NavigationAcquisition;
  getNavigationState(): NavigationState | null;
  onNavigationChange(listener: (state: NavigationState | null) => void): () => void;
  /** The globe camera's whole state now, or null before it exists or in a simulation. */
  captureNavigationSnapshot(): NavigationSnapshot | null;
  /**
   * Puts the globe camera back exactly as captured: the orbit target's ECEF
   * position is used as saved, not re-derived from the surface. Refused
   * (false) while a lease other than `lease` holds navigation.
   */
  restoreNavigationSnapshot(snapshot: NavigationSnapshot, lease?: NavigationLease): boolean;
  /**
   * While `lease` holds navigation, puts the globe camera's eye at the view's
   * position, looking along its forward with its up and field of view: nearer
   * than the zoom limit, at any pitch and through the ground, as a flight into
   * a panorama's orb needs. The camera's limits and collisions return when a
   * snapshot is restored or the lease ends. Refused (false) otherwise.
   */
  placeNavigationCamera(lease: NavigationLease, view: NavigationPresentation): boolean;
  /**
   * What the globe camera holds to on its own: its tilt and distance limits
   * (`camera.pitchLimits`, `camera.zoomLimits`) and how much speed a glide
   * keeps each 60 Hz frame (`camera.inertiaDecay`). An owner that placed the
   * camera and hands it back moving brakes and settles it by these.
   */
  getCameraHandling(): CameraHandling;
  /**
   * Hands a placed camera back to the globe moving, before `lease` ends: at
   * `view`'s eye and look, orbiting the point where its line of sight comes
   * down to the orbit target's height near `pivot`, and gliding on at
   * `motion`'s velocity and turn as after a flick, slowing by
   * `camera.inertiaDecay`. Nearer that point than `camera.zoomLimits`
   * allows, it may come as near as its glide takes it, until it is out past
   * the limit. A tilt beyond `camera.pitchLimits` comes inside at once and
   * the roll levels; the field of view eases to `motion.fovRad` at the
   * glide's rate. When the lease ends, input begun since `motion.inputSince`
   * goes on moving the camera. Refused (false) unless `lease` holds navigation.
   */
  glideNavigationCamera(lease: NavigationLease, view: NavigationPresentation, pivot: EcefVector, motion: NavigationGlide): boolean;
  /** The current lease's presented view, or null while the globe camera's view is drawn. */
  getPresentationView(): NavigationPresentation | null;
  /**
   * The points zoom and rotation act about (`input.*.zoomAnchor`,
   * `input.*.orbitPivot`): what each kind of input last used and why, and the
   * session's pinned point, with Pick point, Pin compass target and Clear pin.
   */
  readonly navigationAnchors: GlobeNavigationAnchors;
  /**
   * Where controller intents go in a context other than "globe": the lease
   * holder's handler. Returns a function that removes it.
   */
  setNavigationIntentHandler(lease: NavigationLease, handler: (frame: ActionIntentFrame) => void): () => void;
  applyNavigationIntents(frame: ActionIntentFrame): void;
  /**
   * Increases on every WebGPU device loss. Resources made for an earlier
   * generation are gone; after `onDeviceRestored` they can be made again.
   */
  getDeviceGeneration(): number;
  onDeviceLost(listener: () => void): () => void;
  onDeviceRestored(listener: () => void): () => void;
  /**
   * The runtime's frame profiling, off until switched on. The runtime closes
   * each frame and times its own map work; a host adds its sections to
   * `frameProfile.profiler`. See foss-earth/perf.
   */
  frameProfile: FrameProfileSession;
  /**
   * The sky model (`sky.model`): the Sun's and the sky's light at the
   * viewpoint in lux and cd/m², and the exposure in use. An application
   * divides an emitter's luminance by `whiteLuminance` to write it to the
   * scene. Null while the model is off, when the application's own references
   * apply as before.
   */
  sky: Pick<SkyRuntime, "getEnvironment" | "subscribe" | "setGroundLights" | "setGroundLightReceiver">;
  destroy(): void;
}
/** Factory guarantee; legacy structural GlobeRuntime ports remain compatible. */
export interface SettledGlobeRuntime extends GlobeRuntime { whenSettled(): Promise<void> }


/** Source method/status compatibility types; construction now requires explicit borrowed owner ports. */
export type BabylonRuntime = GlobeRuntime;
export type GlobeRuntimeStatus = BabylonRuntimeStatus;
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

function createFallbackExperience(scene: Scene, worldRoot: TransformNode | null, ambientFillMultiplier: number, fillLightsOn: boolean, segments: number): FallbackExperience {
  scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;

  const light = new HemisphericLight("fallback-light", new Vector3(0, 1, 0), scene);
  let ownedMesh: AbstractMesh | null = null; let ownedMaterial: StandardMaterial | null = null;
  try {
  light.intensity = 0.95 * ambientFillMultiplier;
  light.setEnabled(fillLightsOn);

  const globeMesh = MeshBuilder.CreateSphere(
    "fallback-globe",
    { diameter: PLANET_RADIUS_METERS * 2, segments },
    scene,
  );
  ownedMesh = globeMesh;
  globeMesh.isPickable = false;
  // Incoming tiles compile while the fallback is still visible. Its light
  // must not enter their material variants, then disappear at the handoff.
  light.includedOnlyMeshes = [globeMesh];
  if (worldRoot) {
    globeMesh.parent = worldRoot;
  }

  const globeMaterial = new StandardMaterial("fallback-globe-material", scene);
  ownedMaterial = globeMaterial;
  globeMaterial.diffuseColor = Color3.FromHexString("#355f8f");
  globeMaterial.specularColor = Color3.FromHexString("#1f2937");
  globeMesh.material = globeMaterial;

  return { globeMesh, light };
  } catch (error) {
    finishOwnedCleanup([() => ownedMesh?.dispose(), () => ownedMaterial?.dispose(), () => light.dispose()], "Fallback allocation and resource cleanup failed.", [error]);
    throw error;
  }
}

/** How far toward a marked point the map surface is looked for: short of the point, which is on the surface it was picked from. */
const ANCHOR_OCCLUSION_REACH = 0.995;

export function createGlobeRuntime(canvas: HTMLCanvasElement, options: GlobeRuntimeOptions): SettledGlobeRuntime {
  const { renderer, scene, settings, clock, platform } = options;
  if (scene.getEngine() !== renderer.engine) throw new Error("Globe scene and renderer must borrow the same host device.");
  const authority = createBorrowedRuntimeAuthority(options.scheduler);
  const scheduler = authority.scheduler;
  let disposed = false;
  const mapDrains = new Set<Promise<void>>(), retirementErrors: unknown[] = [];
  const previousActiveCamera = scene.activeCamera;
  try {
  const savedGoogleKey = settings.get("map.source.googleKey");
  let normalizedApiKey = options.googleApiKey?.trim() || (typeof savedGoogleKey === "string" ? savedGoogleKey.trim() : "");
  const mapDebugEnabled = options.observations?.mapDebug === true;
  const mapDebugEvents: MapDebugEvent[] = [];
  const recordMapDebugEvent = (event: string, detail?: Record<string, unknown>): void => {
    if (!mapDebugEnabled || disposed) return;
    mapDebugEvents.push({ at: clock.nowMs(), event, detail });
    while (mapDebugEvents.length > Math.max(0, Math.floor(options.budgets.debugEventCapacity()))) mapDebugEvents.shift();
  };
  const hasGoogleApiKey = normalizedApiKey.length > 0;
  const shouldStartGoogle = hasGoogleApiKey && options.preferGoogleTiles !== false;
  const simMode = options.external !== undefined;
  // Relative display controls preserve the existing material-processing path.
  // They neither change physical source emission nor introduce a postprocess.
  scene.imageProcessingConfiguration.exposure = 2 ** settings.get<number>("renderer.exposureEV");
  let ambientFillMultiplier = settings.get<number>("renderer.ambientFillMultiplier");
  const frameProfile = options.frameProfile;
  const { profiler } = frameProfile;
  const terrainCapture = options.terrainPerformanceCapture;
  const cameraSettings = createCameraSettings(settings);
  const cameraFieldOfViewRad = cameraSettings.fieldOfViewRad;
  const cameraLimits = cameraSettings.limits;
  const groundFollow = cameraSettings.groundFollow;
  const inputRates = cameraSettings.inputRates;
  // A swipe or pinch over a panel or the HUD that none of them uses moves
  // whichever camera has the canvas, the globe's or the application's, and
  // never reaches the browser as Back or a page zoom.
  authority.own(passUnusedInputToWorld(canvas, platform.passToWorld));

  let simLight: HemisphericLight | null = null;
  authority.own(() => { simLight?.dispose(); simLight = null; });
  if (simMode) {
    scene.clearColor = new Color4(0.45, 0.65, 0.92, 1);
    simLight = new HemisphericLight("sim-light", new Vector3(0, 1, 0), scene);
    simLight.intensity = 1.1 * ambientFillMultiplier;
  }

  const downloadMeter = createMapDownloadMeter({ nowMs: clock.nowMs, after: (ms, callback) => clock.after(callback, ms) });
  authority.own(() => downloadMeter.destroy());
  let tilesRuntime: ReturnType<typeof createGoogleTilesRuntime> | null = null;
  let googleTerrainDetailTarget: number | null = null;
  const anchorForRefinement = (value: unknown): GoogleTerrainDetailAnchor => (value === "focus" ? "focus-point" : "camera");
  let googleTerrainDetailAnchor: GoogleTerrainDetailAnchor = anchorForRefinement(settings.get("map.focus.refineFrom"));
  let rasterTilesRuntime: ReturnType<typeof createRasterTilesRuntime> | null = null;
  let googleTilesStartupWatchdog: (() => void) | null = null;
  let fallbackExperienceCreated = false;
  let fallbackExperience: FallbackExperience | null = null;
  let googleLight: HemisphericLight | null = null;
  let clipping: ReturnType<typeof createCameraClipping> | null = null;
  let geospatialCamera: GeospatialCamera | null = null;
  let cameraController: CameraController | null = null;
  let inertialCameraController: InertialCameraController<HTMLCanvasElement> | null = null;
  let inputController: InputController | null = null;
  let orbitModeActive = false;
  // Where zoom and rotation act, the pin and Pick point (navigationAnchorService.ts), made with the camera, and their markers.
  let navigationAnchors: NavigationAnchorService | null = null;
  let anchorMarkers: NavigationAnchorMarkers | null = null;
  const anchorListeners = new Set<() => void>();
  let simRunning = simMode && options.external?.running !== false;
  let simTick: ((deltaSeconds: number) => void) | null = options.external?.onFrame ?? null;
  let simViewState: GlobeViewState | null = null;
  let preparationViewState: GlobeViewState | null = null;
  let preparationRadiusMeters = 0;
  let preparationCamera: UniversalCamera | null = null;
  let activePreparationCamera: Camera | null = null;
  let preparationPreviousCamera: Camera | null = null;
  let preparationTick: ((now: number) => void) | null = null;
  let cancelPreparation: ((error: Error) => void) | null = null;
  let activeRasterBaseMap = options.rasterBaseMap ?? null;
  let requestedRenderPause = false;
  // The maps can call this during initialization, before the query is created.
  let refreshCurrentSurface = (): void => {};
  let afterSurfaceSettlement: (() => void) | null = null;
  const currentSurfaceChanged = (change: SurfaceOwnerChange): void => {
    if (disposed) return;
    refreshCurrentSurface();
    if (disposed || change !== "loading" || afterSurfaceSettlement) return;
    // A single coalesced read after async owner queue/reservation cleanup;
    // this is the host clock, no loading/readiness polling or rendering loop.
    let finished = false, cancelled = false;
    let stop: (() => void) | null = null;
    const cancel = (): void => { cancelled = true; const owned = stop; stop = null; owned?.(); };
    afterSurfaceSettlement = cancel;
    try {
      stop = clock.after(() => {
        finished = true;
        if (afterSurfaceSettlement === cancel) afterSurfaceSettlement = null;
        if (!cancelled && !disposed) refreshCurrentSurface();
      }, 0);
    } catch (error) {
      if (afterSurfaceSettlement === cancel) afterSurfaceSettlement = null;
      finishOwnedCleanup([cancel], "Surface settlement scheduling and cleanup failed.", [error]);
    }
    if (finished || cancelled || disposed) {
      if (afterSurfaceSettlement === cancel) afterSurfaceSettlement = null;
      cancel();
    }
  };
  authority.own(() => { const stop = afterSurfaceSettlement; afterSurfaceSettlement = null; stop?.(); });
  const rememberMapDrain = (drain: Promise<void>): void => {
    mapDrains.add(drain);
    void drain.then(() => mapDrains.delete(drain), error => { mapDrains.delete(drain); retirementErrors.push(error); });
  };
  const startMap = <T>(create: () => T): T => {
    try { return create(); }
    catch (error) {
      // A hot source/key switch can recover into another map before this
      // partially created parser finishes. Its error still owns the real drain.
      if (error instanceof NativeMapStartupError) rememberMapDrain(error.whenSettled());
      throw error;
    }
  };
  const retireMap = (owner: { dispose(): void; whenSettled(): Promise<void> } | null): void => {
    if (!owner) return;
    let cleanupError: unknown;
    try { owner.dispose(); } catch (error) { cleanupError = error; retirementErrors.push(error); }
    rememberMapDrain(owner.whenSettled());
    if (cleanupError !== undefined) throw cleanupError;
  };
  authority.own(() => { retireMap(tilesRuntime); tilesRuntime = null; });
  authority.own(() => { retireMap(rasterTilesRuntime); rasterTilesRuntime = null; });
  authority.own(() => { inputController?.destroy(); inputController = null; });
  authority.own(() => { inertialCameraController?.cancel(); inertialCameraController = null; });
  authority.own(() => {
    // The pin, Pick point, gestures' anchors and markers go with the runtime; Controls says nothing of them after.
    const owned = navigationAnchors, markers = anchorMarkers;
    navigationAnchors = null; anchorMarkers = null;
    finishOwnedCleanup([() => owned?.dispose(), () => markers?.destroy(), () => setAnchorNotes(() => null), () => anchorListeners.clear()],
      "Navigation anchor cleanup failed.");
  });
  authority.own(() => {
    const ownedClipping = clipping, ownedCamera = geospatialCamera, ownedPreparation = preparationCamera;
    clipping = null; geospatialCamera = null; cameraController = null; preparationCamera = null;
    finishOwnedCleanup([
      () => { if (scene.activeCamera === ownedCamera || scene.activeCamera === ownedPreparation) scene.activeCamera = previousActiveCamera; },
      () => ownedClipping?.dispose(), () => ownedCamera?.dispose(), () => ownedPreparation?.dispose(),
    ], "Owned globe camera cleanup failed.");
  });
  authority.own(() => {
    const owned = fallbackExperience; fallbackExperience = null;
    finishOwnedCleanup([() => owned?.globeMesh.dispose(false, true), () => owned?.light.dispose()], "Fallback globe cleanup failed.");
  });
  authority.own(() => { googleLight?.dispose(); googleLight = null; });
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
  // From the start of a tick until its render: meshes added now are drawn by
  // that render, so they ask for no frame of their own (sceneUpdates.ts).
  let preparingFrame = false;
  let focusCache: { value: { x: number; y: number; z: number } | null } | null = null;
  const closeFrame = (): void => {
    const wasInFrame = inFrame;
    // Retire bookkeeping before invoking the supplied capture port. A
    // throwing or reentrant cleanup must not keep this frame/focus alive.
    inFrame = false; preparingFrame = false; focusCache = null;
    if (wasInFrame) terrainCapture?.endFrame();
  };
  authority.own(closeFrame);
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
  let lastRasterFrameAt = clock.nowMs();
  const worldRoot = options.external?.worldRoot ?? null;

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
  /** Everything a frame does before its render, the host's simulation last. */
  const prepareFrame = (frameNow: number): void => {
    // The frame boundary: everything below, the host's simulation included, is this frame's.
    if (disposed) return;
    if (inFrame) throw new Error("The host prepared the globe twice without closing its frame.");
    inFrame = true; preparingFrame = true; focusCache = null;
    try {
    frameProfile.frame(frameNow);
    profiler.tag("engine frame", renderer.engine.frameId);
    terrainCapture?.beginFrame(frameNow);
    let started = profiler.clock();
    if (!simMode) {
      inertialCameraController?.update();
      navigationCamera.stepFovReturn(frameNow);
    }
    updateTerrainPreparationCamera();
    profiler.add("map/camera", started);
    started = profiler.clock();
    tilesRuntime?.update();
    adoptGoogleCoverage();
    profiler.add("map/google tiles", started);
    started = profiler.clock();
    // Frames drawn while a lease holds navigation are not map frames.
    rasterTilesRuntime?.reportFrame(frameNow, frameNow - lastRasterFrameAt, platform.isHidden() || mapsSuspended);
    lastRasterFrameAt = frameNow;
    rasterTilesRuntime?.update();
    profiler.add("map/raster tiles", started);
    adoptRasterCoverage();
    refreshCurrentSurface();
    // The host renderer lifecycle has begun this frame before preparing it.
    const deltaSeconds = Math.max(renderer.engine.getDeltaTime() / 1000, 1 / 240);
    simTick?.(deltaSeconds);
    options.framePreparation?.prepare({ nowMs: frameNow, deltaSeconds, scene });
    if (disposed) return;
    // After the host has placed its camera and the world: the sky is seen from there.
    started = profiler.clock();
    sky.update();
    profiler.add("sky", started);
    } catch (error) {
      // A failed map operation can have partially changed actual triangles.
      // Publish that owner's new evidence before retiring this frame boundary.
      finishOwnedCleanup([refreshCurrentSurface, closeFrame], "Globe frame preparation and observation/capture cleanup failed.", [error]);
      throw error;
    }
    finally { preparingFrame = false; }
  };
  const afterFrame = (frameNow: number, rendered = true): void => {
    if (!inFrame) return;
    const failures: unknown[] = [];
    try {
      if (rendered) {
        const started = profiler.clock(); preparationTick?.(frameNow);
        profiler.add("map/terrain preparation", started);
        showAnchorMarkers();
        if (mapDebugEnabled) recordMapDebugEvent("scene-render", { mode: status.mode, enabledMeshes: scene.meshes.filter(mesh => mesh.isEnabled()).length });
      }
    } catch (error) { failures.push(error); }
    finally {
      try { closeFrame(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Globe frame completion and capture cleanup failed.");
  };
  /** The map's own surface: 2D map tiles and Google 3D Tiles. */
  const isMapSurface = (mesh: AbstractMesh): boolean => Boolean(mesh.metadata?.mapSurface)
    || Boolean(tilesRuntime && mesh.isDescendantOf(tilesRuntime.tiles.group));
  // The sky model: while it is on, the Sun's and the sky's light take the place
  // of the fill lights, which are relative and know no hour.
  const skyAttachment = options.sky.attach({
    isGround: mesh => isMapSurface(mesh) || mesh === fallbackExperience?.globeMesh,
    getWorldMatrix: worldMatrix,
    requestRender: scheduler.requestRender,
    onDownloadBytes: downloadMeter.addBytes,
    onLightingChange: active => {
      simLight?.setEnabled(!active);
      googleLight?.setEnabled(!active);
      fallbackExperience?.light.setEnabled(!active && fallbackExperience.globeMesh.isEnabled());
    },
  });
  authority.own(() => skyAttachment.detach());
  const sky = skyAttachment.runtime;
  // Credits are the shell's to show: the map source HUD links the basemap's,
  // and the Map tab the elevation provider's.
  const statusListeners = new Set<(status: BabylonRuntimeStatus) => void>();
  const rasterDetailListeners = new Set<() => void>();
  const googleDetailListeners = new Set<() => void>();
  let rasterDetailOffset = 0;
  const emitStatus = (): void => {
    if (disposed) return;
    refreshCurrentSurface();
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
      const stop = googleTilesStartupWatchdog;
      googleTilesStartupWatchdog = null;
      stop();
    }
  }

  let streamingHeld = false;
  // While a lease holds navigation the maps start nothing, so a load in
  // progress would hold continuous rendering until the lease ends.
  let mapsSuspended = false;
  const beginStreaming = (): void => {
    if (streamingHeld || mapsSuspended) return;
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

  function applyClipping(): void { clipping?.apply(); }
  function ensureGeospatialCamera(): GeospatialCamera {
    if (geospatialCamera) {
      // A host external-camera mode owns scene.activeCamera.
      // Map transitions only need the geospatial camera to exist; activating it
      // here replaces that flight camera (which has been disabled) and renders
      // an empty scene.
      if (!simMode || !scene.activeCamera) scene.activeCamera = geospatialCamera;
      return geospatialCamera;
    }

    geospatialCamera = createGeospatialGlobeCamera(scene);
    clipping = createCameraClipping(geospatialCamera, settings);
    geospatialCamera.fov = cameraFieldOfViewRad();
    applyClipping();
    if (!simMode || !scene.activeCamera) scene.activeCamera = geospatialCamera;
    cameraController = new CameraController(geospatialCamera, {
      nowMs: clock.nowMs, hasPickablePointAt: platform.hasPickablePointAt,
      // A grab pan holds the ground drawn under the pointer, as Pick point does; made below, before any input.
      groundAt: client => navigationAnchors?.groundAt(client)?.point ?? null,
    });
    cameraController.setLimits(cameraLimits());
    cameraController.setGroundFollow(groundFollow());
    const anchors = navigationAnchors = createNavigationAnchorService({
      scene, canvas, getCamera: () => geospatialCamera, getPose: () => cameraController?.getPose() ?? null,
      // Read when a gesture starts, once the runtime is built.
      surface: { raycast: (origin, direction, lengthMeters) => surface.raycast(origin, direction, lengthMeters), revision: () => surface.revision?.() ?? 0 },
      preferences: () => navigationAnchorsFromSettings(id => (settings.has(id) ? settings.get(id) : undefined)),
      tracking: () => orbitModeActive,
      pinningBlocked: anchorPinningBlocked,
      owner: () => navigation.state()?.owner ?? "globe",
      changed: navigationAnchorsChanged,
    });
    anchorMarkers = simMode ? null : platform.navigationAnchorMarkers?.(canvas) ?? null;
    inertialCameraController = createGlobeInertia(cameraController, { nowMs: clock.nowMs, decayPerFrame: () => settings.get<number>("camera.inertiaDecay"), renderer: scheduler, anchors,
      grabFollowMs: () => (settings.has(GRAB_FOLLOW_ID) ? settings.get<number>(GRAB_FOLLOW_ID) : DEFAULT_GRAB_FOLLOW_MS) });
    inputController = simMode
      ? null
      : createInputController(canvas, inertialCameraController, { ...platform.input, isOrbitMode: () => orbitModeActive, pointSelection: anchors.selection });
    inputController?.setRates(inputRates());

    return geospatialCamera;
  }

  /** Why Pick point and Pin compass target cannot be used now, or null. */
  function anchorPinningBlocked(): string | null {
    if (disposed) return "The globe has closed.";
    if (simMode) return "A simulation owns the camera.";
    if (navigation.state()) return "Another view, such as a 360\u00B0 image, holds the camera. Pinning is available again when it gives the camera back.";
    return geospatialCamera ? null : "The globe camera is not ready.";
  }

  /** What Controls says beside an anchor choice: what the last gesture used, and why when that was not what was asked. */
  function anchorNote(status: NavigationAnchorStatus, family: AnchorFamily, operation: AnchorOperation, requested: unknown): string | null {
    if (status.tracking) return `${ANCHOR_FALLBACK_MESSAGES.tracking}.`;
    if (requested === "pinned" && !status.pin) return `${ANCHOR_FALLBACK_MESSAGES["no-pin"]}.`;
    const last = status.last[family][operation];
    if (!last || last.requested !== requested) return null;
    // Tracking has ended: the next gesture uses the choice again.
    if (last.fallback === "tracking") return null;
    if (last.fallback) return `${ANCHOR_FALLBACK_MESSAGES[last.fallback]}.`;
    if (requested === "target") return null;
    const where = last.source === "pinned" ? "the pinned point"
      : last.source === "target" ? "the compass target"
        : `the point under ${family === "touch" ? "the fingers" : "the pointer"}${last.source === "ellipsoid" ? ", on the ellipsoid: no map surface was there" : ""}`;
    return `Last used ${where}.`;
  }

  function setAnchorNotes(note: (family: AnchorFamily, operation: AnchorOperation, requested: unknown) => string | null): void {
    for (const family of ANCHOR_FAMILIES) for (const operation of ANCHOR_OPERATIONS) {
      const id = navigationAnchorSettingId(family, operation);
      if (settings.has(id)) settings.setNote(id, note(family, operation, settings.get(id)));
    }
  }

  function updateAnchorNotes(): void {
    const status = globeNavigationAnchors.status();
    setAnchorNotes((family, operation, requested) => anchorNote(status, family, operation, requested));
  }

  function navigationAnchorsChanged(): void {
    if (disposed) return;
    updateAnchorNotes();
    for (const listener of [...anchorListeners]) listener();
    // Markers move with the frames drawn.
    scheduler.requestRender();
  }

  /** The anchors' public face, there before the camera is: its service once it is. */
  const globeNavigationAnchors: GlobeNavigationAnchors = {
    status: () => navigationAnchors?.status() ?? {
      pin: null, selection: "off", pinningBlocked: anchorPinningBlocked(), tracking: orbitModeActive,
      last: { mouse: {}, trackpad: {}, touch: {}, nonPointer: {} },
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      anchorListeners.add(listener);
      return () => { anchorListeners.delete(listener); };
    },
    togglePick: () => navigationAnchors?.togglePick() ?? false,
    armPick: () => navigationAnchors?.armPick() ?? false,
    cancelPick: () => navigationAnchors?.cancelPick(),
    pinTarget: () => navigationAnchors?.pinTarget() ?? false,
    clearPin: () => navigationAnchors?.clearPin(),
  };

  /**
   * Shows the grabbed ground and the points zoom and rotation act about where
   * the frame just drawn has them: none behind the eye or past the horizon,
   * and faint where the map surface is nearer the eye.
   */
  function showAnchorMarkers(): void {
    if (!anchorMarkers) return;
    const camera = geospatialCamera, pose = cameraController?.getPose() ?? null, anchors = navigationAnchors;
    const shown = !mapsSuspended && (!settings.has(SHOW_NAVIGATION_ANCHORS_ID) || settings.get(SHOW_NAVIGATION_ANCHORS_ID) !== false);
    const markers: NavigationAnchorMarkerView[] = [];
    if (camera && pose && anchors && shown) {
      for (const marker of anchors.markerPoints(inertialCameraController?.anchors() ?? { orbit: null, zoom: null })) {
        const point: [number, number, number] = [marker.point.x, marker.point.y, marker.point.z];
        if (pointInViewProblem(pose, point)) continue;
        const at = projectEcefToClient(ecefToVector3(marker.point), scene, camera, canvas);
        if (!at) continue;
        const toPoint = [point[0] - pose.eye[0], point[1] - pose.eye[1], point[2] - pose.eye[2]];
        const distance = Math.hypot(toPoint[0], toPoint[1], toPoint[2]);
        // Short of the point itself, which is on the surface it was picked from.
        const reach = distance * ANCHOR_OCCLUSION_REACH - 1;
        const occluded = reach > 0 && surface.raycast({ x: pose.eye[0], y: pose.eye[1], z: pose.eye[2] },
          { x: toPoint[0] / distance, y: toPoint[1] / distance, z: toPoint[2] / distance }, reach) !== null;
        markers.push({ x: at.x, y: at.y, zoom: marker.zoom, orbit: marker.orbit, grab: marker.grab, pinned: marker.pinned, occluded });
      }
    }
    anchorMarkers.show(markers);
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
      if (activePreparationCamera !== geospatial) {
        const center = geodeticToEcef(
          preparationViewState.latDeg * DEG_TO_RAD,
          preparationViewState.lonDeg * DEG_TO_RAD,
          0,
        );
        geospatial.center = new Vector3(center.x, center.y, center.z);
        geospatial.radius = Math.max(3000, preparationRadiusMeters * 3);
        geospatial.yaw = 0;
        geospatial.pitch = 0;
      }
      // Prepare the destination once. Later input and its inertia must remain
      // visible to the caller so it can cancel preparation without losing motion.
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
    const previousCamera = preparationPreviousCamera;
    activePreparationCamera = null;
    preparationPreviousCamera = null;
    const failures: unknown[] = [];
    try {
      if (camera && scene.activeCamera === camera) scene.activeCamera = previousCamera;
    } catch (error) { failures.push(error); }
    try { preparationCamera?.setEnabled(false); }
    catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Terrain preparation camera cleanup failed.");
  }

  function ensureFallbackExperience(): void {
    if (fallbackExperienceCreated) {
      scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;
      fallbackExperience?.globeMesh.setEnabled(true);
      fallbackExperience?.light.setEnabled(!sky.isLighting());
      recordMapDebugEvent("fallback-show");
      return;
    }

    fallbackExperience = createFallbackExperience(scene, worldRoot, ambientFillMultiplier, !sky.isLighting(), options.budgets.fallbackSegments());
    fallbackExperienceCreated = true;
    recordMapDebugEvent("fallback-create");
  }

  function hideFallbackExperience(): void {
    fallbackExperience?.globeMesh.setEnabled(false);
    fallbackExperience?.light.setEnabled(false);
    recordMapDebugEvent("fallback-hide");
  }

  function adoptGoogleCoverage(): void {
    if (status.mode !== "google-tiles" || !tilesRuntime?.tiles.visibleTiles.size) return;
    if (!startupHeld && !rasterTilesRuntime && !fallbackExperience?.globeMesh.isEnabled()) return;
    // Selection publishes drawable Google content before loading finishes.
    // Retire the previous surface in this same frame: retaining it until
    // load-end draws overlapping ground throughout ongoing streaming.
    hideFallbackExperience();
    if (rasterTilesRuntime) {
      recordMapDebugEvent("raster-runtime-dispose");
      retireMap(rasterTilesRuntime);
      rasterTilesRuntime = null;
    }
    clearGoogleWatchdog();
    releaseStartupHold();
  }

  function adoptRasterCoverage(): void {
    if (status.mode !== "raster-basemap" || (rasterTilesRuntime?.getMetrics().visibleTiles ?? 0) === 0) return;
    if (!tilesRuntime && !fallbackExperience?.globeMesh.isEnabled()) return;
    hideFallbackExperience();
    if (tilesRuntime) {
      recordMapDebugEvent("google-runtime-dispose");
      retireMap(tilesRuntime);
      tilesRuntime = null;
      googleLight?.dispose();
      googleLight = null;
    }
  }

  function enableFallbackMode(reason: string): void {
    if (disposed) return;
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
    retireMap(tilesRuntime);
    tilesRuntime = null;
    if (rasterTilesRuntime) recordMapDebugEvent("raster-runtime-dispose");
    retireMap(rasterTilesRuntime);
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

    options.log.warn("[runtime] Switching to fallback mode", { reason });
    emitStatus();
  }

  function enableRasterBaseMapMode(reason: string | null, recreate = false): void {
    if (disposed) return;
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
      retireMap(tilesRuntime);
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
      retireMap(rasterTilesRuntime);
      rasterTilesRuntime = startMap(() => createRasterTilesRuntime({
        ...options.mapPorts.raster, nowMs: clock.nowMs, after: clock.after,
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
          const why = decision.reason === "settings" ? "automatic-adjustment settings changed"
            : `frames averaged ${decision.meanFrameMs.toFixed(1)} ms against a ${decision.goalMs.toFixed(1)} ms goal`;
          const text = `${decision.to > decision.from ? "Coarsened" : "Refined"} 2D map detail to ${formatLevels(decision.to)} below the request: ${why}.`;
          options.log.info("[map auto]", text);
          recordMapDebugEvent("detail-adjusted", { ...decision });
          for (const listener of detailAdjustedListeners) listener(decision);
        },
        imagery: options.rasterImagery ?? (settings.get("map.detail.imageryPath") === "legacy" ? "legacy" : DEFAULT_RASTER_IMAGERY),
        onDetailFeedback: emitRasterDetailFeedback,
        onSurfaceChange: currentSurfaceChanged,
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
            adoptRasterCoverage();
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
      }));
    } else if (rasterTilesRuntime.source.id !== rasterBaseMap.id || rasterTilesRuntime.source.version !== rasterBaseMap.version
      || rasterTilesRuntime.source.urlTemplate !== keyedSource(rasterBaseMap).urlTemplate) {
      rasterTilesRuntime.setSource(keyedSource(rasterBaseMap));
    }
    rasterTilesRuntime.setSuspended(mapsSuspended);

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

    options.log.info("[runtime] Raster basemap runtime initialized", { source: rasterBaseMap.id, terrain: activeTerrainSource.id, reason });
    emitStatus();
  }

  function enableGoogleTilesMode(): void {
    if (disposed) return;
    recordMapDebugEvent("google-mode-select");
    releaseStartupHold();
    endStreaming();
    clearGoogleWatchdog();
    const retainRasterCoverage = (rasterTilesRuntime?.getMetrics().visibleTiles ?? 0) > 0;
    // Preserve the last usable raster surface until Google has visible tiles.
    if (!retainRasterCoverage) {
      if (rasterTilesRuntime) recordMapDebugEvent("raster-runtime-dispose");
      retireMap(rasterTilesRuntime);
      rasterTilesRuntime = null;
    }
    if (!normalizedApiKey) {
      if (activeRasterBaseMap) enableRasterBaseMapMode("Google 3D Tiles need an API key.");
      else enableFallbackMode("Google 3D Tiles need an API key.");
      return;
    }
    retireMap(tilesRuntime);
    tilesRuntime = null;
    googleLight?.dispose();
    googleLight = null;

    try {
      scene.clearColor = DEFAULT_GOOGLE_BACKGROUND;

      ensureGeospatialCamera();
      ensureFallbackExperience();
      if (retainRasterCoverage) hideFallbackExperience();
      scene.clearColor = DEFAULT_GOOGLE_BACKGROUND;

      googleLight = new HemisphericLight("google-tiles-light", new Vector3(0, 1, 0), scene);
      googleLight.intensity = ambientFillMultiplier;
      googleLight.setEnabled(!sky.isLighting());

      // Hold a continuous-render reference from startup until the first tiles
      // become visible. This ensures tiles.update() is called every frame so
      // the tile-load loop progresses without requiring a camera gesture.
      startupHeld = true;
      scheduler.beginContinuous();

      tilesRuntime = startMap(() => createGoogleTilesRuntime({
        ...options.mapPorts.google,
        onDownloadBytes: downloadMeter.addBytes,
        scene,
        apiKey: normalizedApiKey,
        onDetailFeedback: () => {
          if (status.mode === "google-tiles") for (const listener of [...googleDetailListeners]) listener();
        },
        onSurfaceChange: currentSurfaceChanged,
        // An external-camera host attaches its world to a floating-origin parent.
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
            adoptGoogleCoverage();
          }
        },
      }));

      if (googleTerrainDetailTarget !== null) {
        tilesRuntime.setTerrainDetailTarget(googleTerrainDetailTarget);
      }
      tilesRuntime.setSuspended(mapsSuspended);

      tilesRuntime.tiles.checkCollisions = true;
      if (worldRoot) {
        tilesRuntime.tiles.group.parent = worldRoot;
      }

      status.mode = "google-tiles";
      status.message = "Google Photorealistic 3D Tiles mode active.";
      status.lastError = null;
      emitStatus();

      googleTilesStartupWatchdog = clock.after(() => {
        if (status.mode !== "google-tiles") {
          return;
        }

        if (!tilesRuntime || tilesRuntime.tiles.visibleTiles.size === 0) {
          enableFallbackMode(
            "No Google tiles became visible after startup. Confirm your API key is valid, Maps Tiles API is enabled, and localhost is allowed in key restrictions.",
          );
        }
      }, options.budgets.googleStartupTimeoutMs(simMode));

      options.log.info("[runtime] Google tiles runtime initialized");
    } catch (error) {
      options.log.error("[runtime] Google tiles initialization failed, entering fallback mode", error);
      enableFallbackMode(getErrorMessage(error));
    }
  }

  authority.own(clearGoogleWatchdog);
  authority.own(() => { cancelPreparation?.(platform.abortError("Map runtime destroyed.")); });
  authority.own(endStreaming);
  authority.own(releaseStartupHold);
  authority.own(() => { statusListeners.clear(); rasterDetailListeners.clear(); googleDetailListeners.clear(); detailAdjustedListeners.clear(); streamingListenersRef.clear(); });
  const navigationCamera = createNavigationCameraAdapter({
    getCamera: () => geospatialCamera, getController: () => cameraController,
    getInertia: () => inertialCameraController, currentLease: () => navigation.current(),
    unavailable: () => simMode || disposed, scene, canvas, renderer: scheduler, settings, cameraLimits,
  });
  const { captureNavigationSnapshot, restoreNavigationSnapshot, placeNavigationCamera, glideNavigationCamera, restoreCameraLimits } = navigationCamera;
  let presentationMaskBefore: number | null = null;
  let streamingBeforeSuspension = false;
  let startupHoldBeforeSuspension = false;
  let intentHandler: { lease: NavigationLease; handler: (frame: ActionIntentFrame) => void } | null = null;
  const navigation = createNavigationOwner({
    ...platform.navigation,
    unavailable: () => (simMode ? "A simulation owns the camera." : geospatialCamera ? null : "The globe camera is not ready."),
    snapshot: captureNavigationSnapshot,
    suspend() {
      inputController?.setSuspended(true);
      navigationCamera.suspendCamera();
      // The owner's view is not the globe's: no gesture's anchors or Pick point outlast the lease. The pin does.
      navigationAnchors?.reset();
      mapsSuspended = true;
      streamingBeforeSuspension = streamingHeld;
      startupHoldBeforeSuspension = startupHeld;
      endStreaming();
      releaseStartupHold();
      tilesRuntime?.setSuspended(true);
      rasterTilesRuntime?.setSuspended(true);
      refreshCurrentSurface();
    },
    resume() {
      intentHandler = null;
      restoreCameraLimits();
      mapsSuspended = false;
      tilesRuntime?.setSuspended(false);
      rasterTilesRuntime?.setSuspended(false);
      inputController?.setSuspended(false, navigationCamera.takeInputHandback() ?? undefined);
      navigationAnchors?.refresh();
      // Continue a load the lease interrupted, if it still has work.
      const google = tilesRuntime?.getLoadingState();
      const googlePending = google ? google.queued + google.downloading + google.parsing + google.waitingToParse > 0 : false;
      const rasterPending = (rasterTilesRuntime?.getLoadingDiagnostics?.().pendingTiles ?? 0) > 0;
      if (streamingBeforeSuspension && (googlePending || rasterPending)) beginStreaming();
      if (startupHoldBeforeSuspension && tilesRuntime && tilesRuntime.tiles.visibleTiles.size === 0 && !startupHeld) {
        startupHeld = true;
        scheduler.beginContinuous();
      }
      streamingBeforeSuspension = false;
      startupHoldBeforeSuspension = false;
      refreshCurrentSurface();
    },
    present(view) {
      const camera = geospatialCamera;
      if (!camera) return;
      if (view) {
        if (presentationMaskBefore === null) presentationMaskBefore = camera.layerMask;
        camera.layerMask = NAVIGATION_PRESENTATION_LAYER;
      } else if (presentationMaskBefore !== null) {
        camera.layerMask = presentationMaskBefore;
        presentationMaskBefore = null;
      }
    },
    requestRender: () => scheduler.requestRender(),
    beginContinuous: () => scheduler.beginContinuous(),
    endContinuous: () => scheduler.endContinuous(),
  });

  authority.own(() => navigation.dispose());
  authority.own(options.lifecycle.onDeviceLost(() => { navigation.end("device-lost"); }));
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

    options.log.warn("[runtime] No Google Maps API key found. Starting without Google 3D tiles.");
  }

  function applyMapSource(source: "google" | RasterBaseMapSource): void {
    if (disposed) return;
    recordMapDebugEvent("map-source-selection", { source });
    if (source === "google") {
      if (status.mode !== "google-tiles") enableGoogleTilesMode();
      return;
    }
    if (activeRasterBaseMap?.id === source.id && activeRasterBaseMap.version === source.version
      && activeRasterBaseMap.urlTemplate === source.urlTemplate && status.mode === "raster-basemap") return;
    activeRasterBaseMap = source;
    enableRasterBaseMapMode(null);
  }

  function applyTerrainSource(source: TerrainSource): void {
    if (disposed) return;
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
  const watch: typeof settings.watch = (id, listener) => authority.own(settings.watch(id, listener));
  const subscribe: typeof settings.subscribe = listener => authority.own(settings.subscribe(listener));
  void [
    subscribe(changed => {
      let visibleChange = false;
      if (changed.has("renderer.exposureEV")) {
        const exposure = 2 ** settings.get<number>("renderer.exposureEV");
        if (scene.imageProcessingConfiguration.exposure !== exposure) {
          scene.imageProcessingConfiguration.exposure = exposure;
          visibleChange = true;
        }
      }
      if (changed.has("renderer.ambientFillMultiplier")) {
        ambientFillMultiplier = settings.get<number>("renderer.ambientFillMultiplier");
        // These relative baselines retain the established lighting across map
        // modes. Application-owned lights, including emitters, are untouched.
        for (const [light, baseline] of [[simLight, 1.1], [googleLight, 1], [fallbackExperience?.light, 0.95]] as const) {
          if (!light || light.intensity === baseline * ambientFillMultiplier) continue;
          light.intensity = baseline * ambientFillMultiplier;
          visibleChange ||= light.isEnabled();
        }
      }
      // Imports/presets can change both controls together: draw that change once.
      if (visibleChange) scheduler.requestRender();
    }),
    subscribe(changed => {
      // An import may save the key and source together in either order. Read
      // both committed values once, before constructing an authenticated session.
      const sourceChanged = changed.has("map.source.basemap");
      let keyChanged = false;
      if (changed.has("map.source.googleKey")) {
        const savedKey = settings.get("map.source.googleKey");
        const nextKey = typeof savedKey === "string" ? savedKey.trim() : "";
        keyChanged = nextKey !== normalizedApiKey;
        normalizedApiKey = nextKey;
        status.googleApiKeyProvided = normalizedApiKey.length > 0;
      }
      if (!sourceChanged && !keyChanged) return;
      const id = String(settings.get("map.source.basemap"));
      if (sourceChanged && isKnownRasterBaseMapId(id)) {
        applyMapSource(resolveRasterBaseMapSource(id));
      } else if (id === "google" || !sourceChanged && status.mode === "google-tiles") {
        // A newly saved key also retries a previously selected, unavailable
        // Google source. Replacement/clear retires the old tile session through
        // the same map lifecycle; it never recreates the host scene or device.
        if (keyChanged) enableGoogleTilesMode();
        else applyMapSource("google");
      } else if (keyChanged) {
        // Saving a credential while using a raster map does not select Google.
        emitStatus();
      }
    }),
    watch("map.source.elevation", value => applyTerrainSource(resolveTerrainSource(String(value)))),
    watch("map.focus.refineFrom", value => {
      googleTerrainDetailAnchor = anchorForRefinement(value);
      scheduler.requestRender();
    }),
    watch("map.source.cartoKey", () => {
      const source = activeRasterBaseMap;
      if (status.mode !== "raster-basemap" || !source?.apiKey || !rasterTilesRuntime) return;
      rasterTilesRuntime.setSource(keyedSource(source));
      scheduler.requestRender();
    }),
    // Both maps read the focus region each frame; a change needs one drawn.
    ...FOCUS_PARAMETER_IDS.map(id => watch(id, () => {
      focusCache = null;
      scheduler.requestRender();
    })),
    ...["renderer.clipping", "renderer.clipping.fixed"].map(id => watch(id, () => {
      applyClipping();
      scheduler.requestRender();
    })),
    watch("camera.fieldOfView", () => {
      navigationCamera.cancelFovReturn();
      if (geospatialCamera) geospatialCamera.fov = cameraFieldOfViewRad();
      scheduler.requestRender();
    }),
    ...["camera.pitchLimits", "camera.zoomLimits"].map(id => watch(id, () => {
      cameraController?.setLimits(cameraLimits());
      scheduler.requestRender();
    })),
    ...["camera.surfaceFollowSpeed", "camera.orbitTargetZoomStep"].map(id => watch(id, () => cameraController?.setGroundFollow(groundFollow()))),
    ...Object.values(INPUT_RATE_IDS).map(id => watch(id, () => inputController?.setRates(inputRates()))),
    // The notes under the anchor choices say what each choice last did; the markers follow the switch.
    ...NAVIGATION_ANCHOR_SETTING_IDS.filter(id => settings.has(id)).map(id => watch(id, updateAnchorNotes)),
    ...(settings.has(SHOW_NAVIGATION_ANCHORS_ID) ? [watch(SHOW_NAVIGATION_ANCHORS_ID, () => scheduler.requestRender())] : []),
  ];
  updateAnchorNotes();

  // The HTTP tile cache is shared by every map on the page; its limits are parameters.
  const MiB = 1024 * 1024;
  const settingNumber = (id: string): number => {
    const value = settings.get(id);
    return typeof value === "number" ? value : 0;
  };
  const applyMapCacheLimits = (): void => options.mapPorts.setCacheLimits({
    maxBytes: settingNumber("map.cache.httpBytes") * MiB,
    maxEntries: Math.round(settingNumber("map.cache.httpEntries")),
    maxTileBytes: settingNumber("map.cache.maxTileBytes") * MiB,
  });
  applyMapCacheLimits();
  void [
    watch("map.cache.httpBytes", applyMapCacheLimits),
    watch("map.cache.httpEntries", applyMapCacheLimits),
    watch("map.cache.maxTileBytes", applyMapCacheLimits),
  ];


  // Each budget shows what it bounds, read while its section is on screen.
  const mebibytes = (bytes: number): string => `${bytes >= 10 * MiB ? Math.round(bytes / MiB) : (bytes / MiB).toFixed(1)} MiB`;
  const imagery = () => (status.mode === "raster-basemap" ? rasterTilesRuntime?.getImageryDiagnostics().atlas ?? null : null);
  /** The limit of this kind on visible imagery, as the imagery runtime established it. */
  const imageryLimit = <C extends ImageryConstraintCause>(cause: C): Extract<ImageryConstraint, { cause: C }> | null =>
    (imagery()?.constraints.find(constraint => constraint.cause === cause) as Extract<ImageryConstraint, { cause: C }> | undefined) ?? null;
  /** A counted subject with its verb: "1 region needs", "3 regions need". */
  const counted = (value: number, one: string, singular: string, plural: string, many = `${one}s`): string => `${value} ${value === 1 ? one : many} ${value === 1 ? singular : plural}`;
  let uploadSample: { at: number; bytes: number } | null = null;
  const google = () => (status.mode === "google-tiles" ? tilesRuntime?.getLoadingState?.() ?? null : null);
  const raster = () => (status.mode === "raster-basemap" ? rasterTilesRuntime : null);
  const formatPx = (px: number): string => `${px >= 10 ? Math.round(px) : px.toFixed(1)} px`;
  const because = (decision: AutoDetailDecision | null): string => (decision
    ? decision.reason === "settings" ? ", since automatic-adjustment settings changed"
      : `, since frames averaged ${decision.meanFrameMs.toFixed(1)} ms against a ${decision.goalMs.toFixed(1)} ms goal`
    : "");
  const readings: Array<[string, () => string | null]> = [
    ["map.imagery.gpuBudget", () => {
      const atlas = imagery()?.atlas;
      if (!atlas) return null;
      const parts = [`${mebibytes(atlas.estimatedGpuBytes)} allocated, ${atlas.capacity - atlas.freeSlots} of ${atlas.capacity} pages in use`];
      const budget = imageryLimit("gpu-budget");
      if (budget) {
        parts.push(`selection uses ${budget.selectedPages} of the ${budget.selectablePages} pages it may use; ${counted(budget.regions, "visible region", "needs", "need")} at least ${budget.morePagesAtLeast} more`);
        if (budget.rendererCapped) parts.push("the renderer's texture size holds the atlas below this budget");
      }
      const full = imageryLimit("atlas-full");
      if (full) parts.push(`${counted(full.waitingImages, "downloaded image", "waits", "wait")} for a slot, ${full.pinnedPages} pages shown`);
      return parts.join("; ");
    }],
    ["map.imagery.pageTablePatches", () => {
      const diagnostics = imagery();
      if (!diagnostics?.atlas) return null;
      const configured = settings.get("map.imagery.pageTablePatches");
      const { tableBlocks } = diagnostics.atlas;
      const { tablesNeeded, fallbackPatches } = diagnostics.binding;
      const rounded = typeof configured === "number" && Math.round(configured) !== tableBlocks ? ` (the atlas layout rounds ${Math.round(configured)})` : "";
      return `${tableBlocks} available${rounded}, ${tablesNeeded} needed by visible patches${fallbackPatches > 0 ? `; ${counted(fallbackPatches, "patch", "draws", "draw", "patches")} one coarser page instead` : ""}`;
    }],
    ["map.imagery.pageTableDepth", () => {
      const depth = imageryLimit("binding-depth");
      if (!depth) return null;
      const parts: string[] = [];
      if (depth.regions > 0) {
        const levels = depth.levels;
        const at = levels === null ? "" : levels.min === levels.max ? ` at level ${levels.min}` : ` at levels ${levels.min} to ${levels.max}`;
        parts.push(`${counted(depth.regions, "visible region", "stops", "stop")} here${at}`);
      }
      if (depth.cappedPatches > 0) parts.push(counted(depth.cappedPatches, "patch", "shows coarser pages than it holds", "show coarser pages than they hold", "patches"));
      return parts.join("; ");
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
      const at = clock.nowMs();
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
      if (!plan) return null;
      const cap = imageryLimit("node-cap");
      return `${plan.nodesEvaluated} examined${plan.truncated ? ", limit reached" : ""}${cap ? `; ${counted(cap.regions, "visible region", "keeps", "keep")} coarser imagery` : ""}`;
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
  for (const [id, read] of readings) authority.own(settings.setReadingSource(id, read));

  if (mapDebugEnabled) {
    const debug: GlobeMapDebugSnapshot = {
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
    if (options.observations?.publishMapDebug) authority.own(options.observations.publishMapDebug(debug));
    recordMapDebugEvent("debug-ready");
  }

  // Kick the first frame so initial scene state paints.
  scheduler.requestRender();

  // Revisions never reset when a renderer is replaced or source mode changes.
  // Imagery-only selection changes its source generation, not terrain revision.
  let displayedRevision = 0, sourceGeneration = 0;
  let previousGoogle: ReturnType<typeof createGoogleTilesRuntime> | null = tilesRuntime, previousRaster: ReturnType<typeof createRasterTilesRuntime> | null = rasterTilesRuntime;
  const readGoogleRevision = (): number => tilesRuntime?.getRevision() ?? 0;
  const readRasterRevision = (): number => rasterTilesRuntime?.getRevision() ?? 0;
  let previousGoogleRevision = readGoogleRevision(), previousRasterRevision = readRasterRevision();
  let previousMode = status.mode, previousDisposed = disposed, previousSource = "";
  let previousRasterUrl: string | undefined;
  const readCurrentSurfaceState = (): CurrentSurfaceOwnerState => {
    const googleRevision = readGoogleRevision(), rasterRevision = readRasterRevision();
    if (previousGoogle !== tilesRuntime || previousRaster !== rasterTilesRuntime
      || previousGoogleRevision !== googleRevision || previousRasterRevision !== rasterRevision
      || previousMode !== status.mode || previousDisposed !== disposed) {
      displayedRevision += 1;
      previousGoogle = tilesRuntime; previousRaster = rasterTilesRuntime;
      previousGoogleRevision = googleRevision; previousRasterRevision = rasterRevision;
      previousMode = status.mode; previousDisposed = disposed;
    }
    const selectedSource = status.mode === "google-tiles" ? "google"
      : status.mode === "raster-basemap" ? `raster:${activeRasterBaseMap?.id ?? "unknown"}@${activeRasterBaseMap?.version ?? "unversioned"}:terrain:${activeTerrainSource.id}` : "fallback";
    const rasterUrl = status.mode === "raster-basemap" ? activeRasterBaseMap?.urlTemplate : undefined;
    if (selectedSource !== previousSource || rasterUrl !== previousRasterUrl) {
      sourceGeneration += 1; previousSource = selectedSource;
      previousRasterUrl = rasterUrl;
      const stop = afterSurfaceSettlement; afterSurfaceSettlement = null; stop?.();
    }
    const displayedSources = [
      ...((tilesRuntime?.tiles.visibleTiles.size ?? 0) > 0 ? ["google"] : []),
      ...((rasterTilesRuntime?.getMetrics().visibleTiles ?? 0) > 0 ? ["raster"] : []),
    ];
    const google = tilesRuntime?.getLoadingState(), raster = rasterTilesRuntime?.getLoadingDiagnostics?.();
    // These are workload diagnostics only. Local ready always requires hits.
    const loading = !disposed && (startupHeld || Boolean(google && google.queued + google.downloading + google.parsing
      + google.waitingToParse + google.preparingChildren > 0) || Boolean(raster && raster.activeElevationRequests
      + raster.queuedElevationRequests + raster.pendingTiles > 0));
    return { revision: displayedRevision, sourceGeneration, selectedSource, displayedSources,
      loading, paused: requestedRenderPause, simulationRunning: simMode ? simRunning : null,
      // Keep legacy status/debug diagnostics intact. The new loggable local
      // observation must not carry request URL credentials, signed paths,
      // query tokens or fragments from provider error text.
      suspended: mapsSuspended,
      error: status.lastError?.replace(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s)"'<>]+/gi, "[provider URL]") ?? null };
  };
  const surface = createSurfaceQuery(scene, () => worldRoot, isMapSurface,
    () => readCurrentSurfaceState().revision,
    (lat, lon) => {
      if (status.mode !== "raster-basemap" || !rasterTilesRuntime) return undefined;
      const hit = rasterTilesRuntime.sample(lat, lon);
      if (hit) return { ...hit, revision: hit.revision === rasterTilesRuntime.getRevision() ? readCurrentSurfaceState().revision : -1 };
      // A source transition can still display outgoing Google triangles. Query
      // those real triangles until the ordinary adoption path retires them.
      return (tilesRuntime?.tiles.visibleTiles.size ?? 0) > 0 ? undefined : null;
    });
  const displayedSurface = createCurrentDisplayedSurface(surface, readCurrentSurfaceState);
  refreshCurrentSurface = () => { readCurrentSurfaceState(); displayedSurface.refresh(); };
  authority.own(() => { refreshCurrentSurface = () => {}; displayedSurface.dispose(); });

  function prepareTerrain(request: TerrainPreparationOptions): Promise<TerrainPreparationResult> {
    if (disposed) return Promise.reject(platform.abortError("Globe runtime destroyed."));
    try { validateTerrainPreparation(request); } catch (error) { return Promise.reject(error); }
    cancelPreparation?.(platform.abortError("Terrain preparation was replaced by another destination."));
    if (request.signal?.aborted) return Promise.reject(platform.abortError("Terrain preparation cancelled."));
    const sourceMode = status.mode;
    if (sourceMode === "fallback") {
      if (status.lastError) return Promise.reject(new Error(status.lastError));
      try {
        const groundHeightMeters = options.getSurfaceHeightMeters?.(request.latDeg, request.lonDeg) ?? 0;
        request.onProgress?.({ phase: "ready", readySamples: 1, totalSamples: 1, progress: 1, message: "World ready." });
        return Promise.resolve(options.terrainPreparation.fallback(request, groundHeightMeters));
      } catch (error) { return Promise.reject(error); }
    }
    const radiusMeters = request.radiusMeters ?? 1000;
    const points = terrainReadinessSamples(request.latDeg, request.lonDeg, radiusMeters);
    let preparationStartedAt = 0;
    let lastTerrainProgressAt = 0;
    let lastTerrainSignature = "";
    let centerQuality: number | null = null;
    let settledChecks = 0;
    /**
     * Google tiles with work left: queued, downloading, parsing or with
     * children being prepared, which is all the renderer's own idle test
     * counts. Null when not on Google or not known.
     */
    const googlePendingTiles = (): number | null => {
      if (sourceMode !== "google-tiles") return null;
      const loading = tilesRuntime?.getLoadingState?.();
      return loading
        ? loading.queued + loading.downloading + loading.parsing + loading.waitingToParse + loading.preparingChildren
        : null;
    };
    let latestProgress: Parameters<NonNullable<TerrainPreparationOptions["onProgress"]>>[0] = {
      phase: "loading", readySamples: 0, totalSamples: points.length, progress: 0,
      message: "Waiting for terrain to cover the destination.",
    };
    const publishPreparationProgress = (progress: typeof latestProgress, failure?: Error): void => {
      const now = clock.nowMs();
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
          status: failure ? "failed" : progress.phase === "ready" ? "ready" : stalledForMs >= options.terrainPreparation.stalledAfterMs() ? "stalled" : "loading",
          provider: sourceMode === "google-tiles" ? "Google 3D Tiles" : activeTerrainSource.label,
          elapsedMs: now - preparationStartedAt,
          stalledForMs,
          timeoutMs: request.timeoutMs ?? options.terrainPreparation.timeoutMs(),
          activeElevationRequests: requests?.activeElevationRequests ?? null,
          queuedElevationRequests: requests?.queuedElevationRequests ?? null,
          pendingTiles: requests?.pendingTiles ?? googlePendingTiles(),
          visibleTiles,
          centerQuality,
          requiredQuality: sourceMode === "google-tiles" ? null : options.terrainPreparation.requiredRasterQuality(),
          lastError,
        },
      };
      request.onProgress?.(latestProgress);
    };
    return new Promise<TerrainPreparationResult>((resolve, reject) => {
      let settled = false;
      let preparationHeld = false;
      let timeout: (() => void) | null = null;
      let terminalFailure: { error: unknown } | null = null;
      let lastSampleAt = -Infinity;
      const abort = (): void => {
        try { finish({ error: platform.abortError("Terrain preparation cancelled.") }); }
        catch (error) { finish({ error }); }
      };
      function finish(failure: { error: unknown } | null, result?: TerrainPreparationResult, reportFailure = true): { error: unknown } | null {
        if (settled) return terminalFailure;
        settled = true;
        // Clear shared preparation state before any provided cleanup/progress
        // callback. A callback may throw, destroy, or start another request.
        preparationTick = null;
        cancelPreparation = null;
        preparationViewState = null;
        preparationRadiusMeters = 0;
        const failures: unknown[] = failure ? [failure.error] : [];
        const cleanup = (stop: () => void): void => {
          try { stop(); } catch (error) { failures.push(error); }
        };
        cleanup(endTerrainPreparationCamera);
        const stopTimeout = timeout; timeout = null;
        if (stopTimeout) cleanup(stopTimeout);
        cleanup(() => { request.signal?.removeEventListener("abort", abort); });
        if (preparationHeld) {
          preparationHeld = false;
          cleanup(() => scheduler.endContinuous());
        }
        if (failure && reportFailure) cleanup(() => {
          const error = failure.error instanceof Error ? failure.error : new Error(getErrorMessage(failure.error));
          publishPreparationProgress({ ...latestProgress, message: error.message }, error);
        });
        terminalFailure = failures.length > 1
          ? { error: new AggregateError(failures, "Terrain preparation and cleanup failed.") }
          : failures.length === 1 ? { error: failures[0] } : null;
        if (terminalFailure) reject(terminalFailure.error);
        else resolve(result!);
        return terminalFailure;
      }
      try {
        preparationRadiusMeters = radiusMeters;
        preparationViewState = { latDeg: request.latDeg, lonDeg: request.lonDeg, headingDeg: 0, pitchDeg: 90,
          zoomMeters: Math.max(2000, radiusMeters * 2) };
        beginTerrainPreparationCamera();
        preparationStartedAt = clock.nowMs();
        lastTerrainProgressAt = preparationStartedAt;
        preparationHeld = true;
        scheduler.beginContinuous();
        cancelPreparation = error => { finish({ error }); };
        // A supplied timer may call back while returning its cancellation
        // handle. Wait for that handle before closing/settling this request.
        let armingTimeout = true, timeoutDuringSetup = false;
        const timedOut = (): void => {
          if (armingTimeout) { timeoutDuringSetup = true; return; }
          finish({ error: new Error("Terrain near the destination did not become ready. Check the map connection and retry.") });
        };
        timeout = clock.after(timedOut, request.timeoutMs ?? options.terrainPreparation.timeoutMs());
        armingTimeout = false;
        if (timeoutDuringSetup) { timedOut(); return; }
        request.signal?.addEventListener("abort", abort, { once: true });
        if (settled) return;
        if (request.signal?.aborted) { abort(); return; }
        preparationTick = now => {
          if (settled || disposed) return;
          try {
            if (sourceMode !== status.mode) {
              finish({ error: new Error(status.lastError ?? "Map source changed while preparing the destination. Retry with the selected map.") });
              return;
            }
            if (now - lastSampleAt < options.terrainPreparation.sampleIntervalMs()) return;
            lastSampleAt = now;
            const samples = points.map(point => surface.sample(point.latDeg, point.lonDeg));
            centerQuality = samples[0]?.quality ?? null;
            // Google is ready once its renderer has loaded what it chose for the
            // preparation view, on two checks in a row: before that, its surface
            // can be a coarse tile far from the ground.
            const pending = googlePendingTiles();
            settledChecks = pending === 0 ? settledChecks + 1 : 0;
            const evaluation = options.terrainPreparation.evaluate(request, samples, sourceMode === "google-tiles", pending === null || settledChecks >= 2);
            if (settled || disposed) return;
            const result = evaluation.result;
            // A complete sample set is a coherent snapshot of displayed terrain.
            // Waiting for subsequent samples made normal tile eviction reset the
            // loading bar from 95% to zero before a flight could begin.
            if (result) {
              publishPreparationProgress({ ...evaluation.progress, phase: "ready", progress: 1, message: "Terrain ready for the destination." });
              finish(null, result);
              return;
            }
            publishPreparationProgress(evaluation.progress);
          } catch (error) {
            // The caller still sees the frame operation failure; preparation
            // is also rejected and fully retired, including cleanup failures.
            throw (finish({ error }, undefined, false) ?? { error }).error;
          }
        };
        publishPreparationProgress(latestProgress);
        if (!settled) scheduler.requestRender();
      } catch (error) { finish({ error }, undefined, false); }
    });
  }

  const applyGlobeNavigationIntents = createGlobeIntentMotion<HTMLCanvasElement>({
    blocked: () => disposed || simMode || navigation.current() !== null,
    target: () => inertialCameraController, canvasHeightPx: () => canvas.clientHeight || canvas.height || 1,
    rates: cameraSettings.intentRates,
  });
  const setExternalViewState = (partial: Partial<GlobeViewState>): void => {
    if (!simMode || disposed) return;
    const current = simViewState ?? { latDeg: DEFAULT_CAMERA_LAT_DEG, lonDeg: DEFAULT_CAMERA_LON_DEG, headingDeg: 0, pitchDeg: 0, zoomMeters: DEFAULT_CAMERA_ALTITUDE_METERS };
    simViewState = { ...current, ...partial }; rasterTilesRuntime?.update();
  };
  const setExternalRunning = (running: boolean): void => {
    if (!simMode || disposed || simRunning === running) return;
    simRunning = running; refreshCurrentSurface(); scheduler.requestRender();
  };
  const setExternalFrameCallback = (callback: ((deltaSeconds: number) => void) | null): void => { if (!disposed) simTick = callback; };
  return {
    prepareFrame, afterFrame, isPreparingFrame: () => preparingFrame,
    shouldKeepRendering: () => !disposed && (simRunning || (inertialCameraController?.isActive() ?? false) || navigationCamera.isFovReturning()),
    setExternalViewState, setExternalRunning, setExternalFrameCallback,
    surface,
    displayedSurface,
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
      // A view set from outside ends the gestures under way: their anchors with them.
      navigationAnchors?.retire();
      cameraController?.setViewState(partial);
      scheduler.requestRender();
    },
    configureOrbitTargetHeight(options: OrbitTargetHeightOptions | null): void {
      inertialCameraController?.cancel();
      navigationAnchors?.retire();
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
    onGoogleDetailFeedback(listener): () => void {
      if (disposed) return () => undefined;
      googleDetailListeners.add(listener);
      return () => { googleDetailListeners.delete(listener); };
    },
    setGoogleTerrainDetailTarget(errorTarget: number | null): void {
      googleTerrainDetailTarget = errorTarget;
      tilesRuntime?.setTerrainDetailTarget(errorTarget);
      scheduler.requestRender();
    },
    registerFocusPoint(point: FocusPoint): () => void {
      if (point.id === "orbit-target") throw new Error("The focus point id orbit-target is built in.");
      if (disposed) return () => undefined;
      focusPoints.set(point.id, point);
      syncFocusChoices();
      focusCache = null;
      scheduler.requestRender();
      return () => {
        if (disposed || focusPoints.get(point.id) !== point) return;
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
      if (disposed) return () => undefined;
      rasterDetailListeners.add(listener);
      return () => { rasterDetailListeners.delete(listener); };
    },
    subscribeStatus(listener: (status: BabylonRuntimeStatus) => void): () => void {
      if (disposed) return () => undefined;
      statusListeners.add(listener);
      return () => { statusListeners.delete(listener); };
    },
    setRasterBaseMap(source): void {
      if (disposed) return;
      if (activeRasterBaseMap?.id === source.id && activeRasterBaseMap.version === source.version
        && activeRasterBaseMap.urlTemplate === source.urlTemplate && status.mode === "raster-basemap") return;
      activeRasterBaseMap = source;
      enableRasterBaseMapMode(null);
    },
    setMapSource: applyMapSource,
    setTerrainSource: applyTerrainSource,
    onDetailAdjusted(listener): () => void {
      if (disposed) return () => undefined;
      detailAdjustedListeners.add(listener);
      return () => { detailAdjustedListeners.delete(listener); };
    },
    setOrbitMode(active: boolean): void {
      if (orbitModeActive === active) return;
      orbitModeActive = active;
      if (active) {
        // The tracked point is the centre of every zoom and rotation now: gestures under way
        // leave their own anchors, and what they set moving goes on about it.
        navigationAnchors?.retire();
        inertialCameraController?.rebaseTo({ orbit: null, zoom: null });
      }
      // The tracked point sets the target's height while it is followed; the ground does again after.
      cameraController?.setCenterFollowsGround(!active);
      navigationAnchors?.refresh();
    },
    setInputMode(mode: InputModePreference): void {
      inputController?.setMode(mode);
    },
    getInputMode(): InputModePreference {
      return inputController?.getMode() ?? "auto";
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
    minFrameIntervalMs(): number { const cap = settings.get("renderer.frameRateCap"); return typeof cap === "number" && cap > 0 ? 1000 / cap : 0; },
    beginContinuous(): void {
      scheduler.beginContinuous();
    },
    endContinuous(): void {
      scheduler.endContinuous();
    },
    setPaused(paused: boolean): void {
      if (disposed) return;
      requestedRenderPause = paused;
      scheduler.setPaused(paused);
      refreshCurrentSurface();
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
      if (disposed) return () => undefined;
      streamingListenersRef.add(listener);
      return () => {
        streamingListenersRef.delete(listener);
      };
    },
    getWorldRoot(): TransformNode | null {
      return worldRoot;
    },
    setSimViewState: setExternalViewState,
    setSimRunning: setExternalRunning,
    setSimTick: setExternalFrameCallback,
    acquireNavigation: request => navigation.acquire(request),
    getNavigationState: () => navigation.state(),
    onNavigationChange: listener => navigation.subscribe(listener),
    captureNavigationSnapshot,
    restoreNavigationSnapshot(snapshot, lease) {
      const restored = restoreNavigationSnapshot(snapshot, lease);
      // The view was replaced: gestures under way no longer act about their points.
      if (restored) navigationAnchors?.retire();
      return restored;
    },
    placeNavigationCamera,
    glideNavigationCamera,
    getCameraHandling(): CameraHandling {
      const decay = settings.get("camera.inertiaDecay");
      return { ...(cameraController?.getLimits() ?? cameraLimits()), glideKeepPerFrame: typeof decay === "number" ? decay : DEFAULT_INERTIA_DECAY_PER_FRAME };
    },
    getPresentationView: () => navigation.current()?.getPresentationView() ?? null,
    navigationAnchors: globeNavigationAnchors,
    setNavigationIntentHandler(lease, handler) {
      if (navigation.current() !== lease || lease.released) return () => {};
      const entry = { lease, handler };
      intentHandler = entry;
      return () => { if (intentHandler === entry) intentHandler = null; };
    },
    applyNavigationIntents(frame) {
      const entry = intentHandler;
      if (entry && navigation.current() === entry.lease) entry.handler(frame);
    },
    getDeviceGeneration: options.lifecycle.getDeviceGeneration,
    onDeviceLost(listener) { if (disposed) return () => undefined; return authority.own(options.lifecycle.onDeviceLost(listener)); },
    onDeviceRestored(listener) { if (disposed) return () => undefined; return authority.own(options.lifecycle.onDeviceRestored(listener)); },
    frameProfile,
    sky: { getEnvironment: sky.getEnvironment,
      subscribe(listener) { if (disposed) return () => undefined; return authority.own(sky.subscribe(listener)); },
      setGroundLights(lights) { if (!disposed) sky.setGroundLights(lights); },
      setGroundLightReceiver(receiver) { if (!disposed) sky.setGroundLightReceiver(receiver); } },
    destroy() {
      if (disposed) return; disposed = true;
      try { authority.dispose(); } catch (error) { retirementErrors.push(error); throw error; }
    },
    async whenSettled() {
      const current = [tilesRuntime?.whenSettled(), rasterTilesRuntime?.whenSettled()];
      const results = await Promise.allSettled(current);
      while (mapDrains.size) await Promise.allSettled([...mapDrains]);
      const failures = [...retirementErrors, ...results.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
      if (failures.length) throw new AggregateError(failures, "Globe native retirement failed.");
    },
  };
  } catch (error) {
    disposed = true;
    const failures: unknown[] = [error];
    try { authority.dispose(); } catch (cleanup) { failures.push(cleanup); }
    throw new NativeMapStartupError(failures, "Globe setup and cleanup failed.", async () => {
      const results = await Promise.allSettled([...(error instanceof NativeMapStartupError ? [error.whenSettled()] : []), ...mapDrains]);
      while (mapDrains.size) await Promise.allSettled([...mapDrains]);
      const errors = [...retirementErrors, ...results.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
      if (errors.length) throw new AggregateError(errors, "Globe startup retirement failed.");
    });
  }
}
