import { measureMapResponse } from "./mapDownloadMeter";
import { recordBrowserMapRequest } from "../../terrain/mapCache";
import type { Scene, TransformNode } from "@babylonjs/core";
import type { Tile } from "3d-tiles-renderer/core";
import { TilesRenderer } from "3d-tiles-renderer/babylonjs";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";

const GOOGLE_3D_TILES_ROOT_URL = "https://tile.googleapis.com/v1/3dtiles/root.json";

export interface GoogleTilesRuntimeOptions {
  scene: Scene;
  apiKey: string;
  onDownloadBytes?: (bytes: number) => void;
  onLoadError?: (error: Error, url: string) => void;
  onLoadStart?: () => void;
  onLoadEnd?: (visibleTiles: number, activeTiles: number) => void;
}

export interface GoogleTilesRuntime {
  tiles: TilesRenderer;
  /** The renderer's pixel-based detail target, optionally overridden for a session. */
  getTerrainDetailState(): GoogleTerrainDetailState;
  setTerrainDetailTarget(errorTarget: number | null): void;
  update(): void;
  dispose(): void;
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
}

const MIN_TERRAIN_ERROR_TARGET = 1;
const MAX_TERRAIN_ERROR_TARGET = 524_288;

function normaliseTerrainDetailTarget(errorTarget: number | null): number | null {
  if (errorTarget === null || !Number.isFinite(errorTarget)) return null;
  return Math.max(MIN_TERRAIN_ERROR_TARGET, Math.min(MAX_TERRAIN_ERROR_TARGET, errorTarget));
}

export function createGoogleTilesRuntime(options: GoogleTilesRuntimeOptions): GoogleTilesRuntime {
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

  const tiles = new TilesRenderer(GOOGLE_3D_TILES_ROOT_URL, scene);
  tiles.fetchOptions.mode = "cors";
  tiles.fetchOptions.cache = "default";

  const authPlugin = new GoogleCloudAuthPlugin({
    apiToken: apiKey,
    autoRefreshToken: true,
    useRecommendedSettings: true,
  });
  // The plugin owns authenticated fetch and retries. Wrap its existing response
  // rather than replacing authentication or patching global fetch.
  const downloader = authPlugin as GoogleCloudAuthPlugin & {
    fetchData(uri: string, options: RequestInit): Promise<Response>;
  };
  const fetchData = downloader.fetchData.bind(downloader);
  downloader.fetchData = async (uri, fetchOptions) => {
    recordBrowserMapRequest(uri);
    const response = await fetchData(uri, fetchOptions);
    return options.onDownloadBytes ? measureMapResponse(response, options.onDownloadBytes) : response;
  };
  tiles.registerPlugin(authPlugin);
  // GoogleCloudAuthPlugin applies its recommended 20 px target while it is
  // registered. Preserve that runtime default so "restore" is exact even if
  // the dependency changes it in a later release.
  const defaultErrorTarget = tiles.errorTarget;
  let overrideErrorTarget: number | null = null;

  const handleLoadStart = (): void => {
    console.info("[tiles] Google 3D tiles loading started");
    onLoadStart?.();
  };

  const handleLoadEnd = (): void => {
    const visibleTiles = tiles.visibleTiles.size;
    const activeTiles = tiles.activeTiles.size;

    console.info("[tiles] Google 3D tiles loading completed", {
      visibleTiles,
      activeTiles,
    });

    onLoadEnd?.(visibleTiles, activeTiles);
  };

  const handleLoadModel = (event: { scene: TransformNode; tile: Tile }): void => {
    for (const mesh of event.scene.getChildMeshes()) {
      mesh.metadata = { ...mesh.metadata, googleGeometricErrorMeters: event.tile.geometricError };
    }
  };

  const handleLoadError = (event: { error: Error; url: string | URL }): void => {
    const url = String(event.url);
    console.error("[tiles] Failed to load Google 3D tile resource", {
      url,
      error: event.error,
    });
    onLoadError?.(event.error, url);
  };

  tiles.addEventListener("tiles-load-start", handleLoadStart);
  tiles.addEventListener("tiles-load-end", handleLoadEnd);
  tiles.addEventListener("load-error", handleLoadError);
  tiles.addEventListener("load-model", handleLoadModel);

  return {
    tiles,
    getTerrainDetailState() {
      return { defaultErrorTarget, errorTarget: tiles.errorTarget, overrideErrorTarget };
    },
    setTerrainDetailTarget(nextErrorTarget) {
      overrideErrorTarget = normaliseTerrainDetailTarget(nextErrorTarget);
      tiles.errorTarget = overrideErrorTarget ?? defaultErrorTarget;
    },
    update() {
      tiles.update();
    },
    dispose() {
      tiles.removeEventListener("tiles-load-start", handleLoadStart);
      tiles.removeEventListener("tiles-load-end", handleLoadEnd);
      tiles.removeEventListener("load-error", handleLoadError);
      tiles.removeEventListener("load-model", handleLoadModel);
      tiles.dispose();
    },
  };
}
