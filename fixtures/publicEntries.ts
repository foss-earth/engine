/** Prepared installed-artifact declaration fixture; no private or checkout imports. */
import type { Scene, GeospatialCamera } from "@babylonjs/core";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { RenderScheduler } from "@foss-earth/renderer";
import { createTextureDevicePorts, createPendingImageTexture, createTextureTransferTracker, createCanvasTextureDevicePorts } from "@foss-earth/renderer/babylon";
import { createNavigationCameraAdapter, createMapTextureLoader, type ImageryAtlasDevicePorts, type RasterTilesRuntimeOptions,
  type GoogleTilesRuntimeOptions, createGlobeInertia, CameraController } from "@foss-earth/engine/babylon";
import { createCameraSettings, CONTROLS_PARAMETERS, MAP_LOADING_PARAMETERS } from "@foss-earth/engine/settings";
import { createInputController, type InputControllerOptions } from "@foss-earth/engine/browser";
import { createMapSourcePanel, createControlsPanel, type MapSourcePanelOptions, type ControlsPanelPorts } from "@foss-earth/engine/panels";
import { LocationPanel, type LocationPanelProps, type LocationPanelContribution } from "@foss-earth/engine/react";
import { createGlobeGamepadAdapter } from "@foss-earth/engine/gamepad";
import { createImageryResidency, type ImageryResourceLimits } from "@foss-earth/engine/imagery";
import { createGlobeIntentMotion, createLocationDraftStore, LOCATION_PLACE_DRAFT_KEY } from "@foss-earth/engine/core";
import { groundQueryPoint, groundRelativeMarker, captureRelativeMarker, type CaptureLocation } from "@foss-earth/engine";

declare const scene: Scene, camera: GeospatialCamera, settings: SettingsRegistry, renderer: RenderScheduler;
declare const nowMs: () => number;
declare const tracker: ReturnType<typeof createTextureTransferTracker>;
export const device = createTextureDevicePorts({ scene, transfer: tracker.transfer }) satisfies ImageryAtlasDevicePorts;
export const cameraSettings = createCameraSettings(settings);
export const controller = new CameraController(camera, { nowMs, hasPickablePointAt: () => false });
export const inertia = createGlobeInertia(controller, { nowMs, decayPerFrame: () => settings.get<number>("camera.inertiaDecay"), renderer });
export const applyGlobeNavigationIntents = createGlobeIntentMotion({ blocked: () => false, target: () => inertia,
  canvasHeightPx: () => 800, rates: cameraSettings.intentRates });
export const gamepad = createGlobeGamepadAdapter({ applyGlobeNavigationIntents });
export const mapTextureFactory: Parameters<typeof createMapTextureLoader>[0]["createPendingImageTexture"] = createPendingImageTexture;
export const controlsCatalogue = CONTROLS_PARAMETERS;
export const loadingCatalogue = MAP_LOADING_PARAMETERS;
export const placeDraft = createLocationDraftStore({ storage: null, key: LOCATION_PLACE_DRAFT_KEY });
export const queryDisplayedGround = groundQueryPoint;
export const placeDisplayedGround = groundRelativeMarker;
export const placeFromCapture = captureRelativeMarker;
export type PublicCaptureLocation = CaptureLocation;
export type PublicPorts = { raster: RasterTilesRuntimeOptions; google: GoogleTilesRuntimeOptions; input: InputControllerOptions;
  map: MapSourcePanelOptions; controls: ControlsPanelPorts; location: LocationPanelProps; contribution: LocationPanelContribution;
  imageryLimits: ImageryResourceLimits; navigation: Parameters<typeof createNavigationCameraAdapter>[0] };
export const publicFactories = [createInputController, createMapSourcePanel, createControlsPanel, LocationPanel, createImageryResidency];

import { createLayerRegistry, createBabylonLayer, createPoiTracking } from "@foss-earth/engine/layers";
import { makeCircularMarkerAtlas, createPointSpriteManager, hasPickablePointAt } from "@foss-earth/engine/sprites";
import { createOrbitCompass } from "@foss-earth/engine/compass";
import { createPoiSpriteSizeTuner, createCompassScaleTuner, type VisualizationTunerPorts } from "@foss-earth/engine/visualization-tuners";
import { createBoundedMapTextureLoader, type BoundedMapTexturePorts } from "@foss-earth/engine/babylon";
import { ENGINE_VISUALIZATION_PARAMETERS, ENGINE_POINT_RESOURCE_PARAMETERS } from "@foss-earth/engine/settings";
declare const createCanvas: (width: number, height: number) => HTMLCanvasElement;
export const canvasDevice = createCanvasTextureDevicePorts({ scene, createCanvas, transfer: tracker.transfer });
export const pointAtlas = () => makeCircularMarkerAtlas(canvasDevice, "host-points", [{ fill: [255,0,0], stroke: [255,255,255] }], 64);
export const pointPickingProbe = hasPickablePointAt;
export const compass = () => createOrbitCompass(scene, { device: canvasDevice, requestRender: () => renderer.requestRender() });
export const boundedMaps = (ports: BoundedMapTexturePorts) => createBoundedMapTextureLoader(ports);
export const tunerPorts = (ports: VisualizationTunerPorts) => ports;
export const visualizationCatalogue = [...ENGINE_VISUALIZATION_PARAMETERS, ...ENGINE_POINT_RESOURCE_PARAMETERS];
export const visualizationFactories = [createLayerRegistry,createBabylonLayer,createPoiTracking,createPointSpriteManager,createPoiSpriteSizeTuner,createCompassScaleTuner];

import { createGlobeRuntime, type GlobeRuntimeOptions, type GlobeRuntime } from "@foss-earth/engine/babylon";
import { createGlobeRuntimeBudgets, GLOBE_RUNTIME_PARAMETERS } from "@foss-earth/engine/settings";
import { bindSkyReadingsAndNotes, createSkyRuntime } from "@foss-earth/sky/babylon";
export const globeRuntimeFactory = createGlobeRuntime;
export const runtimeBudgets = createGlobeRuntimeBudgets;
export const runtimeCatalogue = GLOBE_RUNTIME_PARAMETERS;
export type BorrowedRuntimePublicPorts = GlobeRuntimeOptions;
/** Host supplies actual Sky options; detach only the UI bindings. Sky.dispose remains host teardown. */
export const skyBinding = (options: Parameters<typeof createSkyRuntime>[0]) => {
  const sky = createSkyRuntime(options);
  return { runtime: sky, detach: bindSkyReadingsAndNotes({ settings: options.settings, sky }) };
};
export const hostGlobeFrame = (runtime: GlobeRuntime, lifecycle: import("@foss-earth/renderer/babylon").BabylonRendererLifecycle, nowMs: number) => {
  // A host render failure must still close engine sampling/capture boundary.
  let rendered = false;
  try { lifecycle.renderFrame(() => runtime.prepareFrame(nowMs)); rendered = true; }
  finally { runtime.afterFrame(nowMs, rendered); }
};

import { createLocationLookupCache,createLocationLookupTransport,createAirportLookup,createLocationSearch,createLocationSearchTuning,type LocationSearchPorts } from "@foss-earth/engine/location-provider";
import { LOCATION_LOOKUP_PARAMETERS } from "@foss-earth/engine/settings";
export const locationTuning = createLocationSearchTuning(settings);
export const locationLookupCatalogue = LOCATION_LOOKUP_PARAMETERS;
export const locationFactories = [createLocationLookupCache,createLocationLookupTransport,createAirportLookup,createLocationSearch];
export type PublicLocationProviderPorts = LocationSearchPorts;

import { MapCachePanel, type MapCachePanelProps } from "@foss-earth/engine/react";
import { createMapCachePresentationPolicy, MAP_CACHE_PRESENTATION_PARAMETERS } from "@foss-earth/engine/settings";
export const publicMapCachePanel = MapCachePanel;
export const publicMapCachePolicy = createMapCachePresentationPolicy(settings);
export const publicMapCacheCatalogue = MAP_CACHE_PRESENTATION_PARAMETERS;
export const publicMapCachePorts = (ports: MapCachePanelProps) => ports;

import type { GlobeFramePreparation, AsyncRasterMapTextures, RasterMapTextureMetadata } from "@foss-earth/engine/babylon";
export const ordinaryFrameContribution = (prepare: (frame: GlobeFramePreparation) => void): NonNullable<GlobeRuntimeOptions["framePreparation"]> => ({ prepare });
export const asyncRasterPorts = (ports: AsyncRasterMapTextures) => ports;
export type ActualRasterMetadata = RasterMapTextureMetadata;

import { createBoundedAtlasImageryLoader, type BoundedAtlasImageryLoaderOptions, type BrowserImageryLoader } from "@foss-earth/engine/browser";
import { ImageryOwnedUploadUnsupportedError, type RetainedPreparedImage } from "@foss-earth/engine/imagery";
export const boundedAtlasFactory = (ports: BoundedAtlasImageryLoaderOptions): BrowserImageryLoader => createBoundedAtlasImageryLoader(ports);
export const retainedAtlasInput = (image: RetainedPreparedImage) => ({ image, end: image.retain() });
export const unsupportedManagedAtlasUpload = ImageryOwnedUploadUnsupportedError;

import { createImageryAtlas, type ManagedImageryAtlasResources, type OwnedImageryTableJob } from "@foss-earth/engine/babylon";
import { prepareManagedPatchTable, type OwnedImageryUploadJob } from "@foss-earth/engine/imagery";
export const ownedAtlasDevice = createTextureDevicePorts({ scene, transfer: tracker.transfer, tryAdmit: tracker.tryAdmit }) satisfies ImageryAtlasDevicePorts;
export const managedAtlasResources = (ports: ManagedImageryAtlasResources) => ports;
export const ownedAtlasFactories = [createImageryAtlas, prepareManagedPatchTable];
export type CompletionOwnedAtlasJobs = { page: OwnedImageryUploadJob; table: OwnedImageryTableJob };
export type ManagedRuntimeHostPorts = Pick<RasterTilesRuntimeOptions["imageryPorts"], "managedAtlas" | "restoreManagedDevice">;


import { createTerrainImageDecoder, createAtlasImageryWorkerBridge, installAtlasImageryWorkerKernel,
  type TerrainImageDecoderPorts, type AtlasImageryWorkerBridgeOptions, type AtlasImageryWorkerKernelPorts,
  type AtlasImageryWorkerPort, type AtlasImageryWorkerScope } from "@foss-earth/engine/browser";
import { createTerrainImageDecodeLimits, TERRAIN_IMAGE_DECODE_PARAMETERS, POSITION_GEOID_PARAMETERS,
  POSITION_SEA_LEVEL_GRID_ID } from "@foss-earth/engine/settings";
export const nativeTerrainDecoder = (ports: TerrainImageDecoderPorts) => createTerrainImageDecoder(ports);
export const nativeTerrainLimits = createTerrainImageDecodeLimits(settings);
export const nativeTerrainCatalogue = TERRAIN_IMAGE_DECODE_PARAMETERS;
export const engineSeaLevelCatalogue = POSITION_GEOID_PARAMETERS;
export const seaLevelGridId = POSITION_SEA_LEVEL_GRID_ID;
export const atlasWorkerBridge = (ports: AtlasImageryWorkerBridgeOptions) => createAtlasImageryWorkerBridge(ports);
export const atlasWorkerKernel = (ports: AtlasImageryWorkerKernelPorts) => installAtlasImageryWorkerKernel(ports);
export type NativeWorkerHostPorts = { worker: AtlasImageryWorkerPort; scope: AtlasImageryWorkerScope };
