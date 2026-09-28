/**
 * The globe camera's flights into and out of a panorama's orb
 * (docs/proposals/panorama-scenes.md, "Flying in and out";
 * `scene.panorama.flightDuration`). The eye moves along a line through the
 * marker, its distance changing by the same factor in every moment, so the
 * orb grows or shrinks on screen at a steady rate. A flight ends or starts
 * inside the orb's sphere, where every ray is covered and shows the image
 * itself (docs/validation/panorama-visual-contract.md), so the handoff to or
 * from the fullscreen image is exact.
 *
 * Orbit angles follow the globe camera's convention (Babylon's
 * GeospatialCamera): at a centre, up is the geocentric direction, yaw turns
 * clockwise from north, and pitch runs from 0 looking straight down to π/2
 * at the horizon. Pure: ECEF metres and unit vectors in float64.
 */
import type { NavigationSnapshot } from "../engine/babylon/navigationLease";
import { add, cross, dot, length, normalize, pointGeodetic, RAD_TO_DEG, scale, sub, type Vec3, type ViewBasis } from "./panoramaMath";

/** Where the eye is and how it looks: a navigation presentation's quantities. */
export interface FlightPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  verticalFovRad: number;
}

export interface Flight {
  /** The sphere the flight passes through, drawn at this radius throughout, metres. */
  radiusMeters: number;
  /** The pose at eased progress `s`, from 0 to 1. */
  pose(s: number): FlightPose;
}

/** How far inside the sphere a flight ends or starts, as a share of its radius: well inside, where every ray is covered. */
export const INSIDE_SHARE = 0.5;

/** The globe camera's basis at `center`: geocentric up, then east and north as Babylon's right-handed globe has them. */
export function orbitBasis(center: Vec3): { up: Vec3; east: Vec3; north: Vec3 } {
  const up = normalize(center);
  let east = cross([0, 0, 1], up);
  // At a pole, Babylon crosses with +x instead.
  if (length(east) < 1e-12) east = cross([1, 0, 0], up);
  east = normalize(east);
  return { up, east, north: cross(up, east) };
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

/** The signed angle about the unit `axis` that turns `from` to `to`, both across it, radians. */
function angleAbout(from: Vec3, to: Vec3, axis: Vec3): number {
  return Math.atan2(dot(cross(from, to), axis), dot(from, to));
}

/** `v`, across the unit `axis`, turned about it by `angle` radians. */
function turnAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  return add(scale(v, Math.cos(angle)), scale(cross(axis, v), Math.sin(angle)));
}

/** Part way along the great circle from `a` to `b`; opposite directions turn about `pivot`. */
function slerp(a: Vec3, b: Vec3, s: number, pivot: Vec3): Vec3 {
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  if (angle < 1e-9) return normalize(add(scale(a, 1 - s), scale(b, s)));
  let axis = cross(a, b);
  if (length(axis) < 1e-9) axis = sub(pivot, scale(a, dot(pivot, a)));
  return normalize(turnAbout(a, normalize(axis), angle * s));
}

/** Distance part way from `from` to `to` by the same factor each moment: steady growth on screen. */
const geometric = (from: number, to: number, s: number): number => from * Math.pow(to / from, s);

/** A pose's view for the coverage tests, with the viewport's aspect. */
export function poseView(pose: FlightPose, aspect: number): ViewBasis {
  return { forward: pose.forward, up: pose.up, right: normalize(cross(pose.forward, pose.up)), verticalFovRad: pose.verticalFovRad, aspect };
}

/**
 * Into an orb from where the camera is: straight at its marker while turning
 * to face it, to `INSIDE_SHARE` of the radius inside a sphere of
 * `radiusMeters`. The roll the view starts with, relative to level, unwinds
 * on the way. Null when the eye is already inside the sphere.
 */
export function flightIn(start: FlightPose, marker: Vec3, radiusMeters: number): Flight | null {
  const rel = sub(marker, start.position);
  const distance = length(rel);
  if (!(radiusMeters > 0) || !(distance > radiusMeters)) return null;
  const axis = scale(rel, 1 / distance);
  const vertical = normalize(marker);
  const roll = angleAbout(levelUp(start.forward, vertical, start.up), start.up, start.forward);
  const inside = radiusMeters * INSIDE_SHARE;
  return {
    radiusMeters,
    pose(s) {
      const forward = slerp(start.forward, axis, s, start.up);
      return {
        position: sub(marker, scale(axis, geometric(distance, inside, s))),
        forward,
        up: turnAbout(levelUp(forward, vertical, start.up), forward, roll * (1 - s)),
        verticalFovRad: start.verticalFovRad,
      };
    },
  };
}

/**
 * Out of an orb, backing away from the way the view faces: from
 * `INSIDE_SHARE` of the radius inside a sphere of `radiusMeters` to the view
 * that keeps the heading and looks at the marker with the saved overview's
 * pitch, distance and field of view. `end` is that view as the globe
 * camera's snapshot, centred on the marker. The view's roll unwinds on the
 * way. Null when that view would be inside the sphere.
 */
export function flightOut(start: Omit<FlightPose, "position">, marker: Vec3, radiusMeters: number, overview: NavigationSnapshot["camera"]): (Flight & { end: NavigationSnapshot }) | null {
  const far = overview.radius;
  if (!(radiusMeters > 0) || !(far > radiusMeters)) return null;
  const vertical = normalize(marker);
  const { yaw, pitch } = orbitAngles(marker, start.forward, overview.yaw);
  const roll = angleAbout(levelUp(start.forward, vertical, start.up), start.up, start.forward);
  const inside = radiusMeters * INSIDE_SHARE;
  const place = pointGeodetic(marker);
  return {
    radiusMeters,
    pose(s) {
      const forward = orbitLook(marker, yaw, pitch + (overview.pitch - pitch) * s);
      return {
        position: sub(marker, scale(forward, geometric(inside, far, s))),
        forward,
        up: turnAbout(levelUp(forward, vertical, start.up), forward, roll * (1 - s)),
        verticalFovRad: start.verticalFovRad + (overview.fov - start.verticalFovRad) * s,
      };
    },
    end: {
      version: 1,
      view: {
        latDeg: place.latitudeDeg,
        lonDeg: place.longitudeDeg,
        headingDeg: (((yaw * RAD_TO_DEG) % 360) + 360) % 360,
        pitchDeg: 90 * (1 - (2 * overview.pitch) / Math.PI),
        zoomMeters: far,
      },
      camera: { center: { x: marker[0], y: marker[1], z: marker[2] }, yaw, pitch: overview.pitch, radius: far, fov: overview.fov },
    },
  };
}
