import type { SurfaceHit } from "./contracts.js";

/** Structural cancellation keeps core declarations independent of a browser realm. */
export interface TerrainPreparationSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

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
  signal?: TerrainPreparationSignal;
  onProgress?: (progress: TerrainPreparationProgress) => void;
}

export interface TerrainPreparationProgress {
  phase: "loading" | "refining" | "checking" | "ready";
  readySamples: number;
  totalSamples: number;
  progress: number;
  message: string;
  /** Live startup telemetry, retained by hosts even if preparation fails. */
  diagnostics?: {
    status: "loading" | "stalled" | "ready" | "failed";
    provider: string;
    elapsedMs: number;
    stalledForMs: number;
    timeoutMs: number;
    activeElevationRequests: number | null;
    queuedElevationRequests: number | null;
    pendingTiles: number | null;
    visibleTiles: number;
    centerQuality: number | null;
    requiredQuality: number | null;
    lastError: string | null;
  };
}

export interface TerrainPreparationResult {
  groundHeightMeters: number;
  altitudeMeters: number;
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

/** Host-owned acceptance/placement policy; engine only streams/samples displayed geometry. */
export interface TerrainPreparationPolicy {
  evaluate(options: TerrainPreparationOptions, samples: readonly (SurfaceHit | null)[], googleTiles: boolean, rendererSettled: boolean): { progress: TerrainPreparationProgress; result: TerrainPreparationResult | null };
  fallback(options: TerrainPreparationOptions, groundHeightMeters: number): TerrainPreparationResult;
  requiredRasterQuality(): number | null;
  sampleIntervalMs(): number;
  stalledAfterMs(): number;
  timeoutMs(): number;
}
