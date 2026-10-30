import type { TerrainPreparationSignal } from "./terrainPreparation.js";

/** Aircraft-owned streaming demand, independent of the view camera and saved map focus. */
export interface TerrainRegion {
  center: { latDeg: number; lonDeg: number; altitudeMeters: number };
  radiusMeters: number;
  cone?: { directionEcef: { x: number; y: number; z: number }; lengthMeters: number; halfAngleDeg: number };
}
export interface TerrainRegionDetail { googleErrorMeters: number; rasterZoom: number }
export interface TerrainRegionOptions {
  region: TerrainRegion;
  minimum: TerrainRegionDetail;
  final: TerrainRegionDetail;
  signal?: TerrainPreparationSignal;
  onProgress?(progress: TerrainRegionProgress): void;
}
export interface TerrainRegionProgress {
  state: "loading" | "minimum" | "ready" | "unavailable";
  minimumReady: boolean;
  finalReady: boolean;
  readyTiles: number;
  totalTiles: number;
  pendingTiles: number;
  estimatedRemainingMs: number | null;
  reason: string | null;
  groundHeightMeters: number | null;
  sourceGeneration: number;
}
export interface TerrainRegionLease {
  update(region: TerrainRegion): void;
  read(): TerrainRegionProgress;
  /**
   * Shows the region in the world: its sphere and cone, the map surface inside
   * them tinted red, and the box of each map tile its final detail still waits
   * for. Hidden by default.
   */
  setVisible(visible: boolean): void;
  release(): void;
}

export function validateTerrainRegion(options: Pick<TerrainRegionOptions, "region" | "minimum" | "final">): void {
  const { center, radiusMeters, cone } = options.region;
  if (!Number.isFinite(center.latDeg) || Math.abs(center.latDeg) > 90 || !Number.isFinite(center.lonDeg)
    || Math.abs(center.lonDeg) > 180 || !Number.isFinite(center.altitudeMeters)
    || !Number.isFinite(radiusMeters) || radiusMeters <= 0) throw new RangeError("A terrain region requires a finite geographic center and positive radius.");
  if (cone && (!Number.isFinite(cone.lengthMeters) || cone.lengthMeters < 0 || !Number.isFinite(cone.halfAngleDeg)
    || cone.halfAngleDeg <= 0 || cone.halfAngleDeg >= 90
    || !Object.values(cone.directionEcef).every(Number.isFinite) || Math.hypot(cone.directionEcef.x, cone.directionEcef.y, cone.directionEcef.z) === 0)) {
    throw new RangeError("A terrain cone requires a finite direction, length and half-angle between 0 and 90 degrees.");
  }
  for (const target of [options.minimum, options.final]) if (!Number.isFinite(target.googleErrorMeters) || target.googleErrorMeters <= 0
    || !Number.isInteger(target.rasterZoom) || target.rasterZoom < 0 || target.rasterZoom > 30) throw new RangeError("Invalid regional detail target.");
  if (options.final.googleErrorMeters > options.minimum.googleErrorMeters || options.final.rasterZoom < options.minimum.rasterZoom) {
    throw new RangeError("Final regional detail must be at least as fine as minimum detail.");
  }
}

/** Owner evidence for the complete intersecting tile hierarchy, never a download percentage. */
export interface TerrainRegionCoverage { readyTiles: number; totalTiles: number; pendingTiles: number; unavailable: boolean; reason?: string }
