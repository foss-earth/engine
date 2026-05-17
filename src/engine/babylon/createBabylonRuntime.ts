import {
  Color3,
  Color4,
  Engine,
  GeospatialCamera,
  HemisphericLight,
  type AbstractMesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
  WebGPUEngine,
} from "@babylonjs/core";
import { GeospatialClippingBehavior } from "@babylonjs/core/Behaviors/Cameras/geospatialClippingBehavior";

import { createRendererMode, type RendererSelection } from "./createRendererMode";
import { createGoogleTilesRuntime, type GoogleTilesRuntime } from "./createTilesRuntime";
import { geodeticToEcef, DEG_TO_RAD } from "../../camera/cameraMath";
import { CameraController, type OrbitTargetHeightOptions } from "../../camera/cameraState";
import { createInputController, type InputController } from "../../input/createInputController";
import { createInertialCameraController, type InertialCameraController } from "../../input/inertialCameraController";
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
  onStatusChange?: (status: BabylonRuntimeStatus) => void;
}

export type RuntimeMode = "google-tiles" | "fallback";

export interface BabylonRuntimeStatus {
  mode: RuntimeMode;
  message: string;
  googleApiKeyProvided: boolean;
  lastError: string | null;
}

export interface BabylonTileMetrics {
  visibleTiles: number;
  activeTiles: number;
}

export interface BabylonRuntime {
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
  /** Return current Google 3D tile counts, or null in fallback mode. */
  getTileMetrics(): BabylonTileMetrics | null;
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

function createFallbackExperience(scene: Scene): FallbackExperience {
  scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;

  const light = new HemisphericLight("fallback-light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.95;

  const globeMesh = MeshBuilder.CreateSphere(
    "fallback-globe",
    { diameter: PLANET_RADIUS_METERS * 2, segments: 96 },
    scene,
  );
  globeMesh.isPickable = false;

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
  const normalizedApiKey = options.googleApiKey?.trim() ?? "";
  const hasGoogleApiKey = normalizedApiKey.length > 0;
  const renderer = await createRendererMode(canvas, { forceWebGl: hasGoogleApiKey });
  const scene = new Scene(renderer.engine);
  scene.useRightHandedSystem = true;

  let tilesRuntime: GoogleTilesRuntime | null = null;
  let tilesUpdateObserver: ReturnType<typeof scene.onBeforeRenderObservable.add> | null = null;
  let inputUpdateObserver: ReturnType<typeof scene.onBeforeRenderObservable.add> | null = null;
  let googleTilesStartupWatchdog: number | null = null;
  let fallbackExperienceCreated = false;
  let fallbackExperience: FallbackExperience | null = null;
  let googleLight: HemisphericLight | null = null;
  let geospatialCamera: GeospatialCamera | null = null;
  let cameraController: CameraController | null = null;
  let inertialCameraController: InertialCameraController | null = null;
  let inputController: InputController | null = null;

  const status: BabylonRuntimeStatus = {
    mode: hasGoogleApiKey ? "google-tiles" : "fallback",
    message: hasGoogleApiKey
      ? "Google Photorealistic 3D Tiles are initializing."
      : "Fallback mode active.",
    googleApiKeyProvided: hasGoogleApiKey,
    lastError: null,
  };

  const emitStatus = (): void => {
    options.onStatusChange?.({ ...status });
  };

  function clearGoogleWatchdog(): void {
    if (googleTilesStartupWatchdog !== null) {
      window.clearTimeout(googleTilesStartupWatchdog);
      googleTilesStartupWatchdog = null;
    }
  }

  function ensureGeospatialCamera(): GeospatialCamera {
    if (geospatialCamera) {
      scene.activeCamera = geospatialCamera;
      return geospatialCamera;
    }

    geospatialCamera = createGeospatialCamera(scene);
    scene.activeCamera = geospatialCamera;
    cameraController = new CameraController(geospatialCamera);
    inertialCameraController = createInertialCameraController(cameraController);
    inputController = createInputController(canvas, inertialCameraController);
    inputUpdateObserver = scene.onBeforeRenderObservable.add(() => {
      inertialCameraController?.update();
    });

    return geospatialCamera;
  }

  function ensureFallbackExperience(): void {
    if (fallbackExperienceCreated) {
      scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;
      fallbackExperience?.globeMesh.setEnabled(true);
      fallbackExperience?.light.setEnabled(true);
      return;
    }

    fallbackExperience = createFallbackExperience(scene);
    fallbackExperienceCreated = true;
  }

  function hideFallbackExperience(): void {
    fallbackExperience?.globeMesh.setEnabled(false);
    fallbackExperience?.light.setEnabled(false);
  }

  function enableFallbackMode(reason: string): void {
    if (status.mode === "fallback" && fallbackExperienceCreated) {
      status.lastError = reason;
      status.message = "Fallback mode active due to Google tiles load failure.";
      emitStatus();
      return;
    }

    if (tilesUpdateObserver) {
      scene.onBeforeRenderObservable.remove(tilesUpdateObserver);
      tilesUpdateObserver = null;
    }

    clearGoogleWatchdog();

    tilesRuntime?.dispose();
    tilesRuntime = null;

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

  emitStatus();

  if (hasGoogleApiKey) {
    try {
      scene.clearColor = DEFAULT_GOOGLE_BACKGROUND;

      ensureGeospatialCamera();
      ensureFallbackExperience();
      scene.clearColor = DEFAULT_GOOGLE_BACKGROUND;

      googleLight = new HemisphericLight("google-tiles-light", new Vector3(0, 1, 0), scene);
      googleLight.intensity = 1.0;

      tilesRuntime = createGoogleTilesRuntime({
        scene,
        apiKey: normalizedApiKey,
        onLoadError: (error, url) => {
          status.lastError = `${error.message} (${url})`;
          status.message = "Google tiles reported load errors.";
          emitStatus();

          if (!tilesRuntime || tilesRuntime.tiles.visibleTiles.size === 0) {
            enableFallbackMode(
              `Google 3D tiles could not be loaded (${error.message}). Check key permissions and API access for tile.googleapis.com.`,
            );
          }
        },
        onLoadStart: () => {
          status.message = "Google tiles are loading.";
          emitStatus();
        },
        onLoadEnd: (visibleTiles, activeTiles) => {
          status.lastError = null;
          status.message = `Google tiles loaded (visible: ${visibleTiles}, active: ${activeTiles}).`;
          emitStatus();

          if (visibleTiles > 0) {
            hideFallbackExperience();
            clearGoogleWatchdog();
          }
        },
      });

      tilesRuntime.tiles.checkCollisions = true;

      tilesUpdateObserver = scene.onBeforeRenderObservable.add(() => {
        tilesRuntime?.update();
      });

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
      }, 10_000);

      console.info("[runtime] Google tiles runtime initialized");
    } catch (error) {
      console.error("[runtime] Google tiles initialization failed, entering fallback mode", error);
      enableFallbackMode(getErrorMessage(error));
    }
  } else {
    ensureGeospatialCamera();
    ensureFallbackExperience();
    status.message = "Fallback mode active: missing Google Maps API key.";
    emitStatus();

    console.warn("[runtime] No Google Maps API key found. Starting in fallback mode.");
  }

  const handleResize = () => {
    renderer.engine.resize();
  };
  window.addEventListener("resize", handleResize);

  renderer.engine.runRenderLoop(() => {
    scene.render();
  });

  return {
    engine: renderer.engine,
    scene,
    renderer,
    status,
    get geospatialCamera(): GeospatialCamera | null {
      return geospatialCamera;
    },
    getViewState(): GlobeViewState | null {
      return cameraController?.getViewState() ?? null;
    },
    setViewState(partial: Partial<GlobeViewState>): void {
      inertialCameraController?.cancel();
      cameraController?.setViewState(partial);
    },
    configureOrbitTargetHeight(options: OrbitTargetHeightOptions | null): void {
      inertialCameraController?.cancel();
      cameraController?.configureOrbitTargetHeight(options);
    },
    getTileMetrics(): BabylonTileMetrics | null {
      if (!tilesRuntime) {
        return null;
      }
      return {
        visibleTiles: tilesRuntime.tiles.visibleTiles.size,
        activeTiles: tilesRuntime.tiles.activeTiles.size,
      };
    },
    destroy() {
      if (tilesUpdateObserver) {
        scene.onBeforeRenderObservable.remove(tilesUpdateObserver);
        tilesUpdateObserver = null;
      }

      if (inputUpdateObserver) {
        scene.onBeforeRenderObservable.remove(inputUpdateObserver);
        inputUpdateObserver = null;
      }

      clearGoogleWatchdog();

      tilesRuntime?.dispose();
      tilesRuntime = null;

      inputController?.destroy();
      inputController = null;

      inertialCameraController?.cancel();
      inertialCameraController = null;

      if (googleLight) {
        googleLight.dispose();
        googleLight = null;
      }

      window.removeEventListener("resize", handleResize);
      scene.dispose();
      renderer.engine.dispose();
    },
  };
}
