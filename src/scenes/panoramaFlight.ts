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
 * A flight the person cuts short does not jump to either end: it brakes
 * along its own path as the globe camera's glide brakes a flick, and settles
 * into the globe camera's own orbit where it stops (`coast`).
 *
 * Orbit angles follow the globe camera's convention (Babylon's
 * GeospatialCamera): at a centre, up is the geocentric direction, yaw turns
 * clockwise from north, and pitch runs from 0 looking straight down to π/2
 * at the horizon. Pure: ECEF metres and unit vectors in float64.
 */
import type { NavigationSnapshot } from "../engine/babylon/navigationLease";
import { add, cross, DEG_TO_RAD, dot, length, normalize, pointGeodetic, RAD_TO_DEG, scale, sub, type Vec3, type ViewBasis } from "./panoramaMath";

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

/** What the globe camera holds to on its own, which a coast settles into. */
export interface GlobeHold {
  /** The globe camera's field of view: the overview's. */
  verticalFovRad: number;
  /** Its tilt limits, degrees down from the horizon (`camera.pitchLimits`). */
  pitchDeg: { min: number; max: number };
  /** The nearest it orbits a point, metres (`camera.zoomLimits`). */
  zoomMinMeters: number;
  /** The share of its speed a glide keeps each 60 Hz frame (`camera.inertiaDecay`). */
  glideKeepPerFrame: number;
}

export interface Coast {
  durationMs: number;
  /** How much of the braking is done at `ms`, from 0 to 1. */
  settled(ms: number): number;
  /** The flight's eased progress along its path at `ms`. */
  progress(ms: number): number;
  pose(ms: number): FlightPose;
  /** The globe camera's orbit where the coast ends. */
  end: NavigationSnapshot;
}

/** The frame the glide's decay is given per. */
const GLIDE_FRAME_MS = 1000 / 60;
/** A coast has settled once this share of its motion is left: nothing on screen still moves. */
const COAST_REST_SHARE = 0.001;

/**
 * The globe camera's own orbit holding `pose`'s eye and look: about the
 * point on its line of sight nearest `pivot`, or at the zoom limit if that
 * is farther, with the globe's field of view. Its up is level; a tilt
 * outside the limits is the globe camera's to clamp.
 */
export function orbitHolding(pose: FlightPose, pivot: Vec3, hold: GlobeHold, fallbackYaw: number): NavigationSnapshot {
  const reach = Math.max(hold.zoomMinMeters, dot(sub(pivot, pose.position), pose.forward));
  const center = add(pose.position, scale(pose.forward, reach));
  const { yaw, pitch } = orbitAngles(center, pose.forward, fallbackYaw);
  const place = pointGeodetic(center);
  return {
    version: 1,
    view: {
      latDeg: place.latitudeDeg,
      lonDeg: place.longitudeDeg,
      headingDeg: (((yaw * RAD_TO_DEG) % 360) + 360) % 360,
      pitchDeg: 90 * (1 - (2 * pitch) / Math.PI),
      zoomMeters: reach,
    },
    camera: { center: { x: center[0], y: center[1], z: center[2] }, yaw, pitch, radius: reach, fov: hold.verticalFovRad },
  };
}

/** `forward` tilted into the tilt limits about `vertical`, degrees down from the horizon. */
function withinTilt(forward: Vec3, vertical: Vec3, pitchDeg: { min: number; max: number }, fallback: Vec3): Vec3 {
  const down = Math.asin(Math.max(-1, Math.min(1, -dot(forward, vertical)))) * RAD_TO_DEG;
  const allowed = Math.max(pitchDeg.min, Math.min(pitchDeg.max, down));
  if (allowed === down) return forward;
  const across = sub(forward, scale(vertical, dot(forward, vertical)));
  const level = length(across) > 1e-9 ? normalize(across) : normalize(sub(fallback, scale(vertical, dot(fallback, vertical))));
  const tilt = allowed * DEG_TO_RAD;
  return normalize(sub(scale(level, Math.cos(tilt)), scale(vertical, Math.sin(tilt))));
}

/**
 * A flight cut short at eased progress `s`, moving at `rate` progress per
 * ms: it brakes along its own path, keeping `hold.glideKeepPerFrame` of its
 * speed each 60 Hz frame as the globe camera's glide does. Meanwhile, and at
 * the same rate, what the globe camera cannot hold turns into what it can:
 * the field of view to the globe's, the roll to level, a tilt outside the
 * limits to the nearest inside. It ends as the globe camera's orbit about
 * the point on its line of sight nearest `pivot`, the flight's marker, so
 * nothing moves at the handover.
 */
export function coast(flight: Flight, s: number, rate: number, pivot: Vec3, hold: GlobeHold, fallbackYaw: number): Coast {
  const keep = Math.max(0, Math.min(0.999, hold.glideKeepPerFrame));
  // Speed falls as exp(−decay·ms); a glide that keeps nothing stops at once.
  const decay = keep > 0 ? -Math.log(keep) / GLIDE_FRAME_MS : Number.POSITIVE_INFINITY;
  const durationMs = Number.isFinite(decay) ? Math.log(1 / COAST_REST_SHARE) / decay : 0;
  // Braking from `rate`, progress goes on by rate/decay in all; the coast ends with the last share of it left.
  const onward = Number.isFinite(decay) ? (Math.max(0, rate) / decay) * (1 - COAST_REST_SHARE) : 0;
  const vertical = normalize(pivot);
  const settled = (ms: number): number => (ms >= durationMs ? 1 : (1 - Math.exp(-decay * Math.max(0, ms))) / (1 - COAST_REST_SHARE));
  const progress = (ms: number): number => Math.min(1, s + onward * settled(ms));
  const pose = (ms: number): FlightPose => {
    const w = settled(ms);
    const path = flight.pose(progress(ms));
    const roll = angleAbout(levelUp(path.forward, vertical, path.up), path.up, path.forward);
    const forward = slerp(path.forward, withinTilt(path.forward, vertical, hold.pitchDeg, path.up), w, path.up);
    return {
      position: path.position,
      forward,
      up: turnAbout(levelUp(forward, vertical, path.up), forward, roll * (1 - w)),
      verticalFovRad: path.verticalFovRad + (hold.verticalFovRad - path.verticalFovRad) * w,
    };
  };
  return { durationMs, settled, progress, pose, end: orbitHolding(pose(durationMs), pivot, hold, fallbackYaw) };
}
