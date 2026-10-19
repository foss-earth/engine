import type { AbstractMesh, Matrix, Scene, TransformNode } from "@babylonjs/core";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { RendererSelection, BabylonRendererLifecycle, FrameProfileSession } from "@foss-earth/renderer/babylon";
import type { SkyRuntime } from "@foss-earth/sky/babylon";
import type { NavigationHost } from "../navigation/navigationLease.js";
import type { RasterBaseMapSource } from "../map/rasterBaseMaps.js";
import type { TerrainSource } from "../terrain/terrainGrid.js";
import type { TerrainPreparationPolicy } from "../surface/terrainPreparation.js";
import type { TerrainPerformanceCapture } from "../terrain/terrainPerformanceCapture.js";
import type { InputControllerOptions } from "../browser/createInputController.js";
import type { PassToWorldOptions } from "../browser/passToWorld.js";
import type { MapCacheLimits } from "../browser/mapCache.js";
import type { GoogleTilesRuntimeOptions } from "./createTilesRuntime.js";
import type { RasterTilesRuntimeOptions } from "./createRasterTilesRuntime.js";
import type { BabylonRuntimeStatus } from "./createGlobeRuntime.js";
import type { BorrowedGlobeScheduler } from "./borrowedRuntimeAuthority.js";
import type { NavigationAnchorMarkers } from "../browser/navigationAnchorMarkers.js";

/** The globe draws and reads the sky; where the host evaluates it is the host's to report. */
export type BorrowedGlobeSky = Omit<SkyRuntime, "dispose" | "getEvaluation">;
export interface GlobeSkyContext {
  isGround(mesh: AbstractMesh): boolean;
  getWorldMatrix(): Matrix | null;
  requestRender(): void;
  onDownloadBytes(bytes: number): void;
  onLightingChange(active: boolean): void;
}
export interface GlobeSkyPort {
  /** Host creates/binds its actual Sky instance; it remains host-owned. */
  attach(context: GlobeSkyContext): { runtime: BorrowedGlobeSky; /** Detach bindings/readings only; never dispose Sky. */ detach(): void };
}
export interface GlobeRuntimeClock { nowMs(): number; after(callback: () => void, delayMs: number): () => void }
export interface GlobeRuntimePlatform {
  isHidden(): boolean;
  abortError(message: string): Error;
  input: Omit<InputControllerOptions, "isOrbitMode">;
  passToWorld: PassToWorldOptions;
  hasPickablePointAt: NonNullable<import("./cameraState.js").CameraControllerPorts>["hasPickablePointAt"];
  navigation: Pick<NavigationHost, "focusReturn" | "createAbortController" | "abortReason">;
  /** Markers for the grabbed ground and the points zoom acts about, over the canvas (`input.showNavigationAnchors`); none without it. */
  navigationAnchorMarkers?(canvas: HTMLCanvasElement): NavigationAnchorMarkers;
}
export type GlobeRasterPorts = Pick<RasterTilesRuntimeOptions, "loadMapTexture" | "asyncMapTextures" | "attachTerrainLighting" | "createTerrainLoader" | "createTerrainMeshWorker" | "terrainMeshWorkers" | "createTerrainHeightWorker" | "imageryPorts" | "meshRebuildCpuMs" | "log">;
export type GlobeGooglePorts = Pick<GoogleTilesRuntimeOptions, "createTilesRenderer" | "createAuthPlugin" | "createAbortController" | "combineSignals" | "whenMeshesReady" | "lighting" | "responseRealm" | "recordMapRequest" | "resourceTiming" | "online" | "origin" | "log"> & {
  /** For a host that loads the 3D Tiles code on demand: null once createTilesRenderer and createAuthPlugin can be
   * called, otherwise a promise that settles when they can. Google mode waits for it, keeping the map it shows. */
  ready?(): Promise<void> | null;
};
export interface GlobeMapPorts { raster: GlobeRasterPorts; google: GlobeGooglePorts; setCacheLimits(limits: MapCacheLimits): void }
export interface GlobeExternalCamera {
  /** Borrowed host root, e.g. moved by a generic floating-origin adapter. */
  worldRoot: TransformNode | null;
  running?: boolean;
  /** Called once on the existing host frame, after map work. No loop/physics is constructed. */
  onFrame?: (deltaSeconds: number) => void;
}
export interface GlobeFramePreparation {
  /** The current host frame timestamp in monotonic milliseconds. */
  nowMs: number;
  /** Existing renderer delta in seconds, retaining the legacy 1/240s floor. */
  deltaSeconds: number;
  /** Borrowed host scene; this contribution may prepare content, never render it. */
  scene: Scene;
}
export interface GlobeMapDebugSnapshot {
  readonly runtimeMode: "google-tiles" | "raster-basemap" | "fallback";
  readonly sceneMeshCount: number; readonly enabledMeshCount: number;
  readonly rasterVisibleTiles: number; readonly rasterActiveTiles: number;
  readonly fallbackEnabled: boolean; readonly activeCamera: string | null;
  readonly schedulerActive: boolean; readonly pendingTextureCount: number; readonly readyTextureCount: number;
  readonly recentEvents: readonly { at: number; event: string; detail?: Record<string, unknown> }[];
}
export interface GlobeRuntimeOptions {
  renderer: RendererSelection;
  scene: Scene;
  scheduler: BorrowedGlobeScheduler;
  frameProfile: FrameProfileSession;
  lifecycle: Pick<BabylonRendererLifecycle, "getDeviceGeneration" | "onDeviceLost" | "onDeviceRestored">;
  settings: SettingsRegistry;
  clock: GlobeRuntimeClock;
  platform: GlobeRuntimePlatform;
  mapPorts: GlobeMapPorts;
  sky: GlobeSkyPort;
  /** Runs once after map work and the legacy external callback, before Sky.
   * Ordinary globe hosts need no external/simulation mode. Method invocation
   * preserves the supplied contribution object's receiver. */
  framePreparation?: { prepare(frame: GlobeFramePreparation): void };
  /** Borrowed optional index/query service; the host owns its worker lifetime. */
  groundAcceleration?: import("./groundAcceleration.js").GroundAcceleration;
  /** Explicit acceptance/placement policy, never a hidden aircraft default. */
  terrainPreparation: TerrainPreparationPolicy;
  budgets: { fallbackSegments(): number; googleStartupTimeoutMs(external: boolean): number; debugEventCapacity(): number };
  external?: GlobeExternalCamera;
  /** Startup credential; later map.source.googleKey saves/clears replace it live. */
  googleApiKey?: string | null;
  preferGoogleTiles?: boolean;
  rasterBaseMap?: RasterBaseMapSource | null;
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
  terrainSource?: TerrainSource;
  /** Retired quality profiles are ignored for compatibility. */ rasterQuality?: unknown;
  rasterImagery?: "atlas" | "legacy";
  terrainPerformanceCapture?: TerrainPerformanceCapture;
  onStatusChange?: (status: BabylonRuntimeStatus) => void;
  /** Optional host observations; no query activation, Window assignment or capture construction. */
  observations?: { mapDebug?: boolean; publishMapDebug?(snapshot: GlobeMapDebugSnapshot): () => void };
  log: { info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };
}
