import type { DetailLimit } from "../terrain/mapDetailPolicy.js";
import type { ImageryConstraint } from "../terrain/imagery/imageryConstraints.js";
import type { AutoDetailState } from "../terrain/autoDetail.js";
import type { RasterBaseMapSource } from "./rasterBaseMaps.js";
import type { TerrainSource } from "../terrain/terrainGrid.js";

export interface MapRuntimeStatus {
  mode: "google-tiles" | "raster-basemap" | "fallback";
  rasterBaseMap: RasterBaseMapSource | null;
  terrainSource?: TerrainSource | null;
  displayedRasterBaseMap?: RasterBaseMapSource | null;
  lastError?: string | null;
}

/** How the runtime is delivering the requested raster detail. */
export interface RasterDetailFeedback {
  support: "ready" | "unavailable";
  /** Why detail is unavailable, for the rail and the Map tab. */
  reason?: string;
  pending: boolean;
  limits: readonly DetailLimit[];
  /** The current policy offset, including automatic adjustment, not achieved detail. */
  activeTarget?: number | null;
  /** Visible-area estimate of imagery actually bound to terrain, in detail offsets. */
  loadedTarget?: number | null;
  /** The one delivered offset when every region meets the request, otherwise null. */
  effectiveTarget: number | null;
  /** The source delivery is for, while imagery is supported. */
  source?: { id: string; version: string; label: string } | null;
  /** What limits visible imagery, from the decisions that applied each limit. Automatic adjustment is not among them. */
  constraints?: readonly ImageryConstraint[];
}

export interface RasterTerrainState {
  /** The mesh's screen-space error target in use, px, after the link and automatic adjustment. */
  targetPx: number;
  /** The target before automatic adjustment, px. */
  requestedTargetPx: number;
  /** Tiles the last selection chose, those the camera or focus region needs, and whether the limit cut it short. */
  selectedTiles: number;
  neededTiles: number;
  truncated: boolean;
}

export interface RasterAutoDetailState extends AutoDetailState {
  terrainEnabled: boolean;
  imageryEnabled: boolean;
  /** The imagery offset requested and the one in use. */
  requestedOffset: number;
  offset: number;
}

export interface RasterTileMetrics {
  visibleTiles: number;
  activeTiles: number;
}

