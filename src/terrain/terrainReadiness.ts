import { DEG_TO_RAD, WGS84_A } from "../camera/cameraMath";
import type { SurfaceHit } from "./surfaceQuery";

export interface TerrainPreparationOptions {
  latDeg: number;
  lonDeg: number;
  /** Desired height above the displayed terrain at the destination. */
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

/** Above this height, a missing local terrain sample cannot affect the aircraft. */
export const TERRAIN_CONTACT_IRRELEVANT_AGL_METERS = 100;

/** Center plus two rings. The rings are checked only when terrain is near enough to matter. */
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
  if (!Number.isFinite(options.latDeg) || Math.abs(options.latDeg) > 90
    || !Number.isFinite(options.lonDeg) || Math.abs(options.lonDeg) > 180) {
    throw new Error("A valid destination latitude and longitude are required.");
  }
  for (const value of [options.radiusMeters, options.clearanceMeters, options.altitudeAboveGroundMeters, options.timeoutMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Terrain preparation distances and timeout must be finite and nonnegative.");
  }
  if (options.altitudeMeters !== undefined && !Number.isFinite(options.altitudeMeters)) throw new Error("Destination altitude must be finite.");
}

/**
 * Require real displayed geometry before spawning. At 100 m AGL or more the
 * center sample is sufficient: terrain cannot touch the aircraft. Below that,
 * require the complete local rings at the renderer's selected LOD.
 */
export function evaluateTerrainReadiness(
  options: TerrainPreparationOptions,
  samples: readonly (SurfaceHit | null)[],
  googleTiles: boolean,
): { progress: TerrainPreparationProgress; result: TerrainPreparationResult | null } {
  const hasRenderedSurface = (hit: SurfaceHit | null): hit is SurfaceHit => Boolean(hit && Number.isFinite(hit.heightMeters));
  // Google geometricError is a renderer simplification metric, not a terrain
  // accuracy promise. Requiring a fixed value here conflicts with normal
  // camera-driven LOD and can leave preparation waiting indefinitely.
  const isReady = (hit: SurfaceHit | null): hit is SurfaceHit => Boolean(hasRenderedSurface(hit)
    && (googleTiles || hit.quality >= 10));
  const center = samples[0] ?? null;
  const centerReady = isReady(center);
  const altitudeFromTerrain = (groundHeightMeters: number, highestTerrainMeters: number): number => Math.max(
    options.altitudeMeters ?? -Infinity,
    groundHeightMeters + (options.altitudeAboveGroundMeters ?? (options.altitudeMeters === undefined ? 1524 : 0)),
    (options.clearanceMeters === 0 ? groundHeightMeters : highestTerrainMeters) + (options.clearanceMeters ?? 1000),
  );
  const centerAltitude = centerReady ? altitudeFromTerrain(center.heightMeters, center.heightMeters) : null;
  const needsLocalCoverage = !centerReady || centerAltitude === null
    || centerAltitude - center.heightMeters < TERRAIN_CONTACT_IRRELEVANT_AGL_METERS;
  const requiredSamples = needsLocalCoverage ? samples : samples.slice(0, 1);
  const readySamples = requiredSamples.filter(isReady).length;
  const present = requiredSamples.filter(Boolean).length;
  const ready = requiredSamples.length > 0 && readySamples === requiredSamples.length;
  const phase = ready ? "checking" : present ? "refining" : "loading";
  const progress: TerrainPreparationProgress = {
    phase, readySamples, totalSamples: requiredSamples.length,
    progress: requiredSamples.length ? (present * 0.2 + readySamples * 0.75) / requiredSamples.length : 0,
    message: ready ? "Checking terrain clearance…" : present
      ? `Refining nearby terrain (${readySamples}/${requiredSamples.length})…` : "Downloading terrain near your aircraft…",
  };
  if (!ready) return { progress, result: null };
  const groundHeightMeters = center!.heightMeters;
  const highestTerrain = needsLocalCoverage
    ? Math.max(...samples.map(sample => sample!.heightMeters))
    : groundHeightMeters;
  // Do not wait forever when the requested altitude is inside a real mountain:
  // move the spawn above the highest displayed local surface.
  const altitudeMeters = altitudeFromTerrain(groundHeightMeters, highestTerrain);
  return { progress, result: { groundHeightMeters, altitudeMeters } };
}
