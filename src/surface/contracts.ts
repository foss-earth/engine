import type { EcefCoord } from "../camera/cameraMath.js";

export interface SurfaceHit {
  point: EcefCoord;
  normal: EcefCoord;
  distanceMeters: number;
  /** WGS84 ellipsoid-coordinate height; raster samples can use finer resident decoded heights. */
  heightMeters: number;
  meshId: string;
  /** Changes when queryable map geometry or decoded elevation residency changes. */
  revision: number;
  quality: number;
  /** Geometric error advertised by the Google 3D tile owning this triangle. */
  geometricErrorMeters?: number;
}

export interface SurfaceQuery {
  raycast(origin: EcefCoord, direction: EcefCoord, lengthMeters: number): SurfaceHit | null;
  sample(latDeg: number, lonDeg: number): SurfaceHit | null;
  /** The queryable surface's revision; optional so a host's own query can leave it out. */
  revision?(): number;
}
