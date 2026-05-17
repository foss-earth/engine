import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  Engine,
  GeospatialCamera,
  HemisphericLight,
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
import { CameraController } from "../../camera/cameraState";
import { createInputController, type InputController } from "../../input/createInputController";
import type { GlobeViewState } from "../types";

const PLANET_RADIUS_METERS = 6_378_137;
const DEFAULT_FALLBACK_BACKGROUND = new Color4(0.01, 0.02, 0.05, 1);
const DEFAULT_GOOGLE_BACKGROUND = new Color4(0.04, 0.05, 0.07, 1);
const DEFAULT_CAMERA_LAT_DEG = 40.782773;
const DEFAULT_CAMERA_LON_DEG = -73.965363;
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

export interface BabylonRuntime {
  engine: Engine | WebGPUEngine;
  scene: Scene;
  renderer: RendererSelection;
  status: BabylonRuntimeStatus;
  /** Return the current camera state. Returns null in fallback mode. */
  getViewState(): GlobeViewState | null;
  /** Merge partial overrides into the current camera state. No-op in fallback mode. */
  setViewState(partial: Partial<GlobeViewState>): void;
  destroy(): void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createFallbackExperience(scene: Scene): Camera {
  scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;

  const camera = new ArcRotateCamera(
    "fallback-camera",
    -Math.PI / 2,
    Math.PI / 2.8,
    18,
    Vector3.Zero(),
    scene,
  );
  camera.minZ = 0.1;
  camera.attachControl(true);

  const light = new HemisphericLight("fallback-light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.95;

  const globeMesh = MeshBuilder.CreateSphere(
    "fallback-globe",
    { diameter: 10, segments: 64 },
    scene,
  );
  const globeMaterial = new StandardMaterial("fallback-globe-material", scene);
  globeMaterial.diffuseColor = Color3.FromHexString("#355f8f");
  globeMaterial.specularColor = Color3.FromHexString("#1f2937");
  globeMesh.material = globeMaterial;

  return camera;
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
  const renderer = await createRendererMode(canvas);
  const scene = new Scene(renderer.engine);
  scene.useRightHandedSystem = true;

  const normalizedApiKey = options.googleApiKey?.trim() ?? "";
  const hasGoogleApiKey = normalizedApiKey.length > 0;

  let tilesRuntime: GoogleTilesRuntime | null = null;
  let tilesUpdateObserver: ReturnType<typeof scene.onBeforeRenderObservable.add> | null = null;
  let googleTilesStartupWatchdog: number | null = null;
  let fallbackCamera: Camera | null = null;
  let googleLight: HemisphericLight | null = null;
  let cameraController: CameraController | null = null;
  let inputController: InputController | null = null;

  const status: BabylonRuntimeStatus = {
    mode: "fallback",
    message: "Fallback mode active.",
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

  function ensureFallbackExperience(): Camera {
    if (fallbackCamera) {
      return fallbackCamera;
    }

    fallbackCamera = createFallbackExperience(scene);
    return fallbackCamera;
  }

  function enableFallbackMode(reason: string): void {
    if (status.mode === "fallback" && fallbackCamera) {
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

    scene.clearColor = DEFAULT_FALLBACK_BACKGROUND;
    scene.activeCamera = ensureFallbackExperience();

    console.warn("[runtime] Switching to fallback mode", { reason });
    emitStatus();
  }

  emitStatus();

  if (hasGoogleApiKey) {
    try {
      scene.clearColor = DEFAULT_GOOGLE_BACKGROUND;

      const geospatialCamera = createGeospatialCamera(scene);
      scene.activeCamera = geospatialCamera;
      cameraController = new CameraController(geospatialCamera);
      inputController = createInputController(canvas, cameraController);

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
    scene.activeCamera = ensureFallbackExperience();
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
    getViewState(): GlobeViewState | null {
      return cameraController?.getViewState() ?? null;
    },
    setViewState(partial: Partial<GlobeViewState>): void {
      cameraController?.setViewState(partial);
    },
    destroy() {
      if (tilesUpdateObserver) {
        scene.onBeforeRenderObservable.remove(tilesUpdateObserver);
        tilesUpdateObserver = null;
      }

      clearGoogleWatchdog();

      tilesRuntime?.dispose();
      tilesRuntime = null;

      inputController?.destroy();
      inputController = null;

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
