/**
 * Pure math helpers for camera state and geodetic conversions.
 * These are engine-neutral and fully testable without any Babylon dependency.
 */

// ─── WGS84 Ellipsoid Constants ──────────────────────────────────────
export const WGS84_A = 6_378_137.0; // semi-major axis (m)
export const WGS84_F = 1 / 298.257223563; // flattening
export const WGS84_B = WGS84_A * (1 - WGS84_F); // semi-minor axis (m)
export const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // first eccentricity squared
export const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2); // second eccentricity squared

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

// ─── Geodetic Types ─────────────────────────────────────────────────

export interface EcefCoord {
  x: number;
  y: number;
  z: number;
}

export interface GeodeticCoord {
  latRad: number;
  lonRad: number;
  altMeters: number;
}

// ─── ECEF ↔ Geodetic ────────────────────────────────────────────────

/**
 * Convert geodetic (WGS84) coordinates to ECEF Cartesian.
 * @param latRad Geodetic latitude in radians
 * @param lonRad Geodetic longitude in radians
 * @param altMeters Height above the WGS84 ellipsoid in metres
 */
export function geodeticToEcef(latRad: number, lonRad: number, altMeters: number): EcefCoord {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (N + altMeters) * cosLat * cosLon,
    y: (N + altMeters) * cosLat * sinLon,
    z: (N * (1 - WGS84_E2) + altMeters) * sinLat,
  };
}

/**
 * Convert ECEF Cartesian coordinates to geodetic (WGS84).
 * Uses Bowring's non-iterative closed-form method, accurate to ~1 mm.
 */
export function ecefToGeodetic(x: number, y: number, z: number): GeodeticCoord {
  const p = Math.sqrt(x * x + y * y);
  const lonRad = Math.atan2(y, x);

  // Bowring's auxiliary latitude
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const latRad = Math.atan2(
    z + WGS84_EP2 * WGS84_B * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta,
  );

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const altMeters =
    Math.abs(cosLat) > 1e-10
      ? p / cosLat - N
      : Math.abs(z) / Math.abs(sinLat) - N * (1 - WGS84_E2);

  return { latRad, lonRad, altMeters };
}

// ─── Angle Utilities ─────────────────────────────────────────────────

/** Shortest signed delta between two angles in degrees, result in [-180, 180). */
export function shortestAngleDeltaDeg(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Shortest signed delta between two angles in radians, result in [-π, π). */
export function normalizeAngleDeltaRad(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

/** Normalize an arbitrary heading in degrees to [0, 360). */
export function normalizeHeadingDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

// ─── Two-Touch Gesture Math (used by Phase 3 input handlers) ─────────

export interface ScreenTouchPoint {
  x: number;
  y: number;
}

export interface TwoPointGestureMetrics {
  angleRad: number;
  distancePx: number;
  centroidX: number;
  centroidY: number;
}

export type TwoPointGestureIntent = "swipe" | "pinch" | null;

/** Compute distance, angle, and centroid for a two-touch gesture. */
export function computeTwoPointGestureMetrics(
  firstPoint: ScreenTouchPoint,
  secondPoint: ScreenTouchPoint,
): TwoPointGestureMetrics {
  const dx = secondPoint.x - firstPoint.x;
  const dy = secondPoint.y - firstPoint.y;
  return {
    angleRad: Math.atan2(dy, dx),
    distancePx: Math.hypot(dx, dy),
    centroidX: (firstPoint.x + secondPoint.x) * 0.5,
    centroidY: (firstPoint.y + secondPoint.y) * 0.5,
  };
}

/**
 * Classify a two-finger gesture as swipe (centroid translation dominant)
 * or pinch (distance change dominant). Returns null while still ambiguous.
 */
export function classifyTwoPointGestureIntent(
  centroidTranslationPx: number,
  distanceDeltaPx: number,
  hasTwoMovingTouches = true,
  touchesMovingTogether = false,
  allowSingleTouchPinch = false,
): TwoPointGestureIntent {
  const distanceDeltaAbsPx = Math.abs(distanceDeltaPx);

  if (!hasTwoMovingTouches) {
    return allowSingleTouchPinch && distanceDeltaAbsPx >= 24 ? "pinch" : null;
  }

  const pinchDistanceThresholdPx = 8;

  if (
    distanceDeltaAbsPx >= pinchDistanceThresholdPx
    && (!touchesMovingTogether || distanceDeltaAbsPx >= centroidTranslationPx * 1.5)
  ) {
    return "pinch";
  }

  if (
    hasTwoMovingTouches
    && touchesMovingTogether
    && centroidTranslationPx >= 8
    && centroidTranslationPx >= distanceDeltaAbsPx * 0.75
  ) {
    return "swipe";
  }

  return null;
}

/**
 * Compute surface-relative pitch in degrees from view direction dot surface normal.
 * Returns 90 looking straight down, 0 at the horizon, negative looking away.
 */
export function computeSurfaceRelativePitchDeg(viewDirectionDotSurfaceNormal: number): number {
  const clamped = Math.min(1, Math.max(-1, viewDirectionDotSurfaceNormal));
  return (Math.asin(-clamped) * 180) / Math.PI;
}

/** Compensate heading by 180° when the camera looks away from the globe. */
export function compensateInvertedHeading(headingDeg: number, isLookingAway: boolean): number {
  return isLookingAway ? (headingDeg + 180) % 360 : headingDeg;
}
