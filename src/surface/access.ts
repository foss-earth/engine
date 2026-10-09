import type { EcefCoord } from "../camera/cameraMath.js";
import type { SurfaceHit, SurfaceQuery } from "./contracts.js";

/** Readiness of the host's currently displayed map geometry, never a network estimate. */
export interface SurfaceReadiness {
  readonly state: "ready" | "loading" | "unavailable" | "failed";
  readonly revision: number;
  readonly message?: string;
}

/** Geometry's coordinate height does not establish the source's physical vertical datum. */
export interface DisplayedSurfaceHeight {
  readonly kind: "displayed-geometry";
  readonly datum: "wgs84-ellipsoid-coordinate";
  readonly meters: number;
  readonly physicalDatum: "unknown";
}

export type SurfaceMissingReason = "invalid-input" | "geometry-unavailable" | "no-displayed-hit" | "stale-revision";
export type DisplayedSurfaceResult =
  | { readonly status: "hit"; readonly hit: SurfaceHit; readonly height: DisplayedSurfaceHeight; readonly readiness: SurfaceReadiness }
  | { readonly status: "missing"; readonly reason: SurfaceMissingReason; readonly readiness: SurfaceReadiness };

export interface DisplayedSurfacePorts {
  /** Supplied by the map owner; query access creates no readiness loop or timer. */
  readiness(): SurfaceReadiness;
}

export interface DisplayedSurfaceAccess {
  sample(latDeg: number, lonDeg: number): DisplayedSurfaceResult;
  raycast(origin: EcefCoord, direction: EcefCoord, lengthMeters: number): DisplayedSurfaceResult;
  readiness(): SurfaceReadiness;
}

/** Adds explicit missing/readiness/datum semantics to the faithful nullable source query. */
export function createDisplayedSurfaceAccess(query: SurfaceQuery, ports: DisplayedSurfacePorts): DisplayedSurfaceAccess {
  const missing = (reason: SurfaceMissingReason, readiness: SurfaceReadiness): DisplayedSurfaceResult => ({ status: "missing", reason, readiness });
  const resolve = (valid: boolean, getHit: () => SurfaceHit | null): DisplayedSurfaceResult => {
    const before = ports.readiness();
    if (!valid) return missing("invalid-input", before);
    if (before.state === "unavailable" || before.state === "failed") return missing("geometry-unavailable", before);
    // Loading may retain drawable outgoing geometry; a hit is still useful and labelled loading.
    const hit = getHit();
    const after = ports.readiness();
    if (before.revision !== after.revision || (hit && hit.revision !== after.revision)) return missing("stale-revision", after);
    if (after.state === "unavailable" || after.state === "failed") return missing("geometry-unavailable", after);
    if (!hit) return missing("no-displayed-hit", after);
    return { status: "hit", hit, readiness: after,
      height: { kind: "displayed-geometry", datum: "wgs84-ellipsoid-coordinate", meters: hit.heightMeters, physicalDatum: "unknown" } };
  };
  return {
    readiness: () => ports.readiness(),
    sample: (latDeg, lonDeg) => resolve(Number.isFinite(latDeg) && Number.isFinite(lonDeg) && Math.abs(latDeg) <= 90, () => query.sample(latDeg, lonDeg)),
    raycast: (origin, direction, lengthMeters) => resolve(
      [origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, lengthMeters].every(Number.isFinite)
        && lengthMeters > 0 && Math.hypot(direction.x, direction.y, direction.z) > 0,
      () => query.raycast(origin, direction, lengthMeters)),
  };
}
