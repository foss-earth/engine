/** Pure geographic subset; no image structures or viewer authority. */
import { DEG_TO_RAD, RAD_TO_DEG, geodeticToEcef, ecefToGeodetic, type EcefCoord } from "./cameraMath.js";

export type Vec3 = readonly [number, number, number];
/** Row-major 3×3: `m[row][column]`, applied to column vectors. */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / length(a));
/** The angle between two directions, degrees, stable for small and large angles alike. */
export const angleDeg = (a: Vec3, b: Vec3): number => Math.atan2(length(cross(a, b)), dot(a, b)) * RAD_TO_DEG;
export const vec3 = (p: EcefCoord): Vec3 => [p.x, p.y, p.z];
export const ecef = (v: Vec3): EcefCoord => ({ x: v[0], y: v[1], z: v[2] });

export interface EnuFrame {
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

export function enuFrame(longitudeDeg: number, latitudeDeg: number): EnuFrame {
  const lon = longitudeDeg * DEG_TO_RAD;
  const lat = latitudeDeg * DEG_TO_RAD;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  return {
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

/** Rows east, north, up: ECEF direction → ENU components. */
export function ecefToEnuMatrix(frame: EnuFrame): Mat3 {
  return [frame.east, frame.north, frame.up];
}

export function geodeticPoint(longitudeDeg: number, latitudeDeg: number, heightMeters: number): Vec3 {
  return vec3(geodeticToEcef(latitudeDeg * DEG_TO_RAD, longitudeDeg * DEG_TO_RAD, heightMeters));
}

export function pointGeodetic(point: Vec3): { longitudeDeg: number; latitudeDeg: number; heightMeters: number } {
  const { latRad, lonRad, altMeters } = ecefToGeodetic(point[0], point[1], point[2]);
  return { longitudeDeg: lonRad * RAD_TO_DEG, latitudeDeg: latRad * RAD_TO_DEG, heightMeters: altMeters };
}

/** A heading clockwise from north and a pitch above the horizon, as an ENU direction. */
export function enuDirection(headingDeg: number, pitchDeg: number): Vec3 {
  const h = headingDeg * DEG_TO_RAD, p = pitchDeg * DEG_TO_RAD;
  return [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
}

/**
 * The heading and pitch of an ENU direction. At a vertical look the heading is
 * undefined; `fallbackHeadingDeg` keeps the last defined one, as §5 requires.
 */
export function enuHeadingPitch(direction: Vec3, fallbackHeadingDeg = 0): { headingDeg: number; pitchDeg: number } {
  const horizontal = Math.hypot(direction[0], direction[1]);
  const pitchDeg = Math.atan2(direction[2], horizontal) * RAD_TO_DEG;
  if (horizontal < 1e-12) return { headingDeg: fallbackHeadingDeg, pitchDeg };
  const heading = Math.atan2(direction[0], direction[1]) * RAD_TO_DEG;
  return { headingDeg: (heading + 360) % 360, pitchDeg };
}

export interface CaptureLocation {
  longitudeDeg: number;
  latitudeDeg: number;
}

/**
 * Where a ground-relative marker's surface is sampled: the ENU anchor on the
 * ellipsoid (a computational height of zero, never a capture height), moved
 * east and north in ECEF, back to longitude and latitude.
 */
export function groundQueryPoint(capture: CaptureLocation, eastMeters: number, northMeters: number): { longitudeDeg: number; latitudeDeg: number } {
  const frame = enuFrame(capture.longitudeDeg, capture.latitudeDeg);
  const anchor = geodeticPoint(capture.longitudeDeg, capture.latitudeDeg, 0);
  const moved = add(anchor, add(scale(frame.east, eastMeters), scale(frame.north, northMeters)));
  const { longitudeDeg, latitudeDeg } = pointGeodetic(moved);
  return { longitudeDeg, latitudeDeg };
}

/** A ground-relative marker's centre once the displayed surface height there is known. */
export function groundRelativeMarker(queryPoint: { longitudeDeg: number; latitudeDeg: number }, surfaceHeightMeters: number, offsetMeters: number): Vec3 {
  return geodeticPoint(queryPoint.longitudeDeg, queryPoint.latitudeDeg, surfaceHeightMeters + offsetMeters);
}

/** A capture-relative marker's centre: the known capture point, moved in its ENU frame. */
export function captureRelativeMarker(capture: CaptureLocation, captureHeightMeters: number, eastMeters: number, northMeters: number, offsetMeters: number): Vec3 {
  const frame = enuFrame(capture.longitudeDeg, capture.latitudeDeg);
  const origin = geodeticPoint(capture.longitudeDeg, capture.latitudeDeg, captureHeightMeters);
  return add(origin, add(scale(frame.east, eastMeters), add(scale(frame.north, northMeters), scale(frame.up, offsetMeters))));
}
