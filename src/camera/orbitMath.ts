/** Globe GeospatialCamera conventions split from the mixed viewer flight module. */
import { DEG_TO_RAD } from "./cameraMath.js";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "./geographicFrames.js";

/** The globe camera's basis at `center`: geocentric up, then east and north as Babylon's right-handed globe has them. */
export function orbitBasis(center: Vec3): { up: Vec3; east: Vec3; north: Vec3 } {
  const up = normalize(center);
  let east = cross([0, 0, 1], up);
  // At a pole, Babylon crosses with +x instead.
  if (length(east) < 1e-12) east = cross([1, 0, 0], up);
  east = normalize(east);
  return { up, east, north: cross(up, east) };
}

/** The look after a clockwise heading and a downward tilt, about `origin`. */
export function turnLook(origin: Vec3, forward: Vec3, headingDeg: number, pitchDownDeg: number, fallbackYaw: number): Vec3 {
  const angles = orbitAngles(origin, forward, fallbackYaw);
  return orbitLook(origin, angles.yaw + headingDeg * DEG_TO_RAD, angles.pitch - pitchDownDeg * DEG_TO_RAD);
}

/** The look direction of orbit angles at `center`. */
export function orbitLook(center: Vec3, yaw: number, pitch: number): Vec3 {
  const { up, east, north } = orbitBasis(center);
  const horizontal = add(scale(north, Math.cos(yaw)), scale(east, Math.sin(yaw)));
  return normalize(sub(scale(horizontal, Math.sin(pitch)), scale(up, Math.cos(pitch))));
}

/** The orbit angles of a look direction at `center`; a vertical look keeps `fallbackYaw`. */
export function orbitAngles(center: Vec3, forward: Vec3, fallbackYaw: number): { yaw: number; pitch: number } {
  const { up, east, north } = orbitBasis(center);
  const vertical = dot(forward, up);
  const pitch = Math.acos(Math.max(-1, Math.min(1, -vertical)));
  const horizontal = sub(forward, scale(up, vertical));
  if (length(horizontal) < 1e-12) return { yaw: fallbackYaw, pitch };
  return { yaw: Math.atan2(dot(horizontal, east), dot(horizontal, north)), pitch };
}

/** The up that holds `forward` level about `vertical`: the part of `vertical` across `forward`, or of `fallback` when they are parallel. */
export function levelUp(forward: Vec3, vertical: Vec3, fallback: Vec3): Vec3 {
  const across = sub(vertical, scale(forward, dot(vertical, forward)));
  if (length(across) > 1e-9) return normalize(across);
  return normalize(sub(fallback, scale(forward, dot(fallback, forward))));
}

