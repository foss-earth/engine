import { measureMapResponse } from "./mapDownloadMeter";
import { recordBrowserMapRequest } from "../../terrain/mapCache";
import type { Scene, TransformNode } from "@babylonjs/core";
import type { Tile } from "3d-tiles-renderer/core";
import type { TerrainReadinessFocus } from "../../terrain/terrainReadiness";
import { createGoogleTerrainFocusRegion } from "./googleTerrainFocus";
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
  /** Refine this destination independently of the current render camera. */
  setReadinessFocus(focus: TerrainReadinessFocus | null): void;
  getReadinessError(): Error | null;
  update(): void;
  dispose(): void;
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
  let focus: TerrainReadinessFocus | null = null;
  let focusRegion: ReturnType<typeof createGoogleTerrainFocusRegion> | null = null;
  let readinessError: Error | null = null;

  tiles.registerPlugin({
    name: "FLIGHT_TERRAIN_READINESS",
    calculateTileViewError(tile: Tile, target: { inView: boolean; error: number; distance: number }) {
      if (!focus || !focusRegion?.intersects(tile)) return false;
      target.inView = true;
      // This composes with normal camera SSE. Stop only when the local mesh
      // has a physically meaningful error, even if it is outside the frustum.
      target.error = tile.geometricError > focus.maxGeometricErrorMeters ? tiles.errorTarget + 1 : 0;
      target.distance = 0;
      return true;
    },
  });

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

  const handleLoadError = (event: { error: Error; url: string | URL; tile?: Tile | null }): void => {
    if (focusRegion && (!event.tile || focusRegion.intersects(event.tile))) readinessError = event.error;
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
    setReadinessFocus(nextFocus) {
      focus = nextFocus;
      focusRegion = nextFocus ? createGoogleTerrainFocusRegion(nextFocus) : null;
      readinessError = null;
      if (nextFocus) tiles.resetFailedTiles();
    },
    getReadinessError() { return readinessError; },
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
