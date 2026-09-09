import { DEG_TO_RAD, WGS84_A } from "../camera/cameraMath";
import type { SurfaceHit } from "./surfaceQuery";

export interface TerrainPreparationOptions {
  latDeg: number;
  lonDeg: number;
  /** Desired height above the refined terrain at the destination. */
  altitudeAboveGroundMeters?: number;
  /** Optional minimum ellipsoid-coordinate altitude. */
  altitudeMeters?: number;
  radiusMeters?: number;
  /** Minimum vertical clearance above the highest sampled local surface. */
  clearanceMeters?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TerrainPreparationProgress) => void;
}

export interface TerrainPreparationProgress {
  phase: "loading" | "refining" | "checking" | "ready";
  readySamples: number;
  totalSamples: number;
  progress: number;
  message: string;
}

export interface TerrainPreparationResult {
  groundHeightMeters: number;
  altitudeMeters: number;
}

export interface TerrainReadinessFocus {
  latDeg: number;
  lonDeg: number;
  radiusMeters: number;
  maxGeometricErrorMeters: number;
}

export const GOOGLE_FLIGHT_GEOMETRIC_ERROR_METERS = 25;

/** Center plus two rings: readiness is local coverage, never global network idle. */
export function terrainReadinessSamples(latDeg: number, lonDeg: number, radiusMeters: number) {
  const samples = [{ latDeg, lonDeg }];
  // Great-circle offsets work at the dateline and poles as well as Minneapolis.
  const lat = latDeg * DEG_TO_RAD, lon = lonDeg * DEG_TO_RAD;
  for (const [radius, count] of [[radiusMeters / 2, 8], [radiusMeters, 16]]) {
    if (radius === 0) continue;
    const distance = radius / WGS84_A;
    for (let i = 0; i < count; i++) {
      const bearing = i * 2 * Math.PI / count;
      const nextLat = Math.asin(Math.sin(lat) * Math.cos(distance)
        + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing));
      const nextLon = lon + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat),
        Math.cos(distance) - Math.sin(lat) * Math.sin(nextLat));
      samples.push({ latDeg: nextLat / DEG_TO_RAD, lonDeg: ((nextLon / DEG_TO_RAD + 540) % 360) - 180 });
    }
  }
  return samples;
}

export function validateTerrainPreparation(options: TerrainPreparationOptions): void {
  if (!Number.isFinite(options.latDeg) || Math.abs(options.latDeg) > 90 || !Number.isFinite(options.lonDeg)) {
    throw new Error("A valid destination latitude and longitude are required.");
  }
  for (const value of [options.radiusMeters, options.clearanceMeters, options.altitudeAboveGroundMeters, options.timeoutMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Terrain preparation distances and timeout must be finite and nonnegative.");
  }
  if (options.altitudeMeters !== undefined && !Number.isFinite(options.altitudeMeters)) throw new Error("Destination altitude must be finite.");
}

/** Require real displayed geometry and reject even visible, downloadable coarse Google tiles. */
export function evaluateTerrainReadiness(
  options: TerrainPreparationOptions,
  samples: readonly (SurfaceHit | null)[],
  googleTiles: boolean,
): { progress: TerrainPreparationProgress; result: TerrainPreparationResult | null } {
  const isRefined = (hit: SurfaceHit | null): hit is SurfaceHit => Boolean(hit && Number.isFinite(hit.heightMeters)
    && (googleTiles
      ? Number.isFinite(hit.geometricErrorMeters) && hit.geometricErrorMeters! <= GOOGLE_FLIGHT_GEOMETRIC_ERROR_METERS
      : hit.quality >= 10));
  const readySamples = samples.filter(isRefined).length;
  const present = samples.filter(Boolean).length;
  const ready = samples.length > 0 && readySamples === samples.length;
  const phase = ready ? "checking" : present ? "refining" : "loading";
  const progress: TerrainPreparationProgress = {
    phase, readySamples, totalSamples: samples.length,
    progress: samples.length ? (present * 0.2 + readySamples * 0.75) / samples.length : 0,
    message: ready ? "Checking terrain clearance…" : present
      ? `Refining nearby terrain (${readySamples}/${samples.length})…` : "Downloading terrain near your aircraft…",
  };
  if (!ready) return { progress, result: null };
  const groundHeightMeters = samples[0]!.heightMeters;
  const highestTerrain = Math.max(...samples.map(sample => sample!.heightMeters));
  // Do not wait forever when the requested altitude is inside a real mountain:
  // move the spawn up once precision is sufficient to distinguish it from LOD.
  const geometricMargin = googleTiles && (options.clearanceMeters ?? 1000) > 0 ? GOOGLE_FLIGHT_GEOMETRIC_ERROR_METERS : 0;
  const altitudeMeters = Math.max(
    options.altitudeMeters ?? -Infinity,
    groundHeightMeters + (options.altitudeAboveGroundMeters ?? (options.altitudeMeters === undefined ? 1524 : 0)),
    (options.clearanceMeters === 0 ? groundHeightMeters : highestTerrain) + (options.clearanceMeters ?? 1000) + geometricMargin,
  );
  return { progress, result: { groundHeightMeters, altitudeMeters } };
}
