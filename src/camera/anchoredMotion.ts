/**
 * Zooming toward a point and orbiting about one, wherever it is on screen:
 * the globe camera's anchored motion, as pure ECEF float64 math.
 *
 * The globe camera draws from its eye along its look, level: its right is
 * horizontal at the eye, square to the geocentric vertical there. The eye and
 * the look therefore decide the whole view, and the camera's centre, yaw,
 * pitch and radius are one way of writing them down: every centre on the line
 * of sight writes the same view. A point keeps its place on screen while its
 * direction from the eye, in the camera's own axes, stays the same; the field
 * of view and the canvas only scale that direction into pixels.
 */
import { DEG_TO_RAD, RAD_TO_DEG, WGS84_A, WGS84_B, ecefToGeodetic } from "./cameraMath.js";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "./geographicFrames.js";
import { orbitAngles, orbitLook } from "./orbitMath.js";

/** Where the camera is and where it looks: all that decides its view. ECEF metres and a unit vector. */
export interface CameraPose {
  readonly eye: Vec3;
  readonly forward: Vec3;
}

/**
 * Where a point is on screen, as its direction from the eye in the camera's
 * axes: right and up, each over the distance ahead. The centre of the view is
 * (0, 0); the field of view and the canvas scale it into pixels.
 */
export interface ViewDirection {
  readonly x: number;
  readonly y: number;
}

/** The globe camera's own description of a pose: Babylon's `GeospatialCamera` centre, yaw, pitch and radius. */
export interface OrbitFields {
  readonly center: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
}

/** A point further from the line of sight than this, as a share of its distance, is not ahead of the camera. */
const AHEAD_EPSILON = 1e-6;

/** The camera's right, up and ahead. Right is horizontal at the eye; null when the look runs along the vertical. */
export function cameraAxes(pose: CameraPose): { right: Vec3; up: Vec3; forward: Vec3 } | null {
  const across = cross(pose.forward, pose.eye);
  const size = length(across);
  if (!(size > 1e-12 * length(pose.eye))) return null;
  const right = scale(across, 1 / size);
  return { right, up: cross(right, pose.forward), forward: pose.forward };
}

/** Where `point` is on screen from `pose`; null unless it is ahead of the eye. */
export function viewDirection(pose: CameraPose, point: Vec3): ViewDirection | null {
  const axes = cameraAxes(pose);
  if (!axes) return null;
  const toPoint = sub(point, pose.eye);
  const ahead = dot(toPoint, axes.forward);
  if (!(ahead > AHEAD_EPSILON * length(toPoint))) return null;
  return { x: dot(toPoint, axes.right) / ahead, y: dot(toPoint, axes.up) / ahead };
}

/**
 * The level look from `eye` that shows `point` at `view` on screen. Two
 * headings can, one each side; this is the one whose look is on the same side
 * as `near`. Null when no level camera at `eye` can show the point there.
 */
export function levelLookAt(eye: Vec3, point: Vec3, view: ViewDirection, near: Vec3): Vec3 | null {
  const up = normalize(eye);
  let east = cross([0, 0, 1], up);
  if (length(east) < 1e-12) east = cross([1, 0, 0], up);
  east = normalize(east);
  const north = cross(up, east);
  const toPoint = sub(point, eye);
  const toEast = dot(toPoint, east), toNorth = dot(toPoint, north), toUp = dot(toPoint, up);
  const x = view.x, y = view.y;
  const k = 1 + y * y;
  // The point's distance along the look's heading, squared, that puts it at `view`.
  const along2 = ((toEast * toEast + toNorth * toNorth) * k - x * x * toUp * toUp) / (k + x * x);
  if (!(along2 >= 0)) return null;
  const nearAlong = dot(near, east) * toEast + dot(near, north) * toNorth;
  const along = (nearAlong < 0 ? -1 : 1) * Math.sqrt(along2);
  const ahead = Math.sqrt((toUp * toUp + along * along) / k);
  const heading = Math.atan2(toNorth, toEast) + Math.atan2(x * ahead, along);
  // The look's cosine and sine of elevation, to one scale.
  const level = along + y * toUp;
  const rise = toUp - y * along;
  if (!(level > 0)) return null;
  const size = Math.hypot(level, rise);
  const horizontal = add(scale(east, Math.cos(heading)), scale(north, Math.sin(heading)));
  const look = normalize(add(scale(horizontal, level / size), scale(up, rise / size)));
  return look.every(Number.isFinite) ? look : null;
}

/**
 * The pose after zooming by `factor` toward `anchor`: the eye moves along its
 * line to the anchor to `factor` of its distance, and the anchor stays where
 * it is on screen. Below 1 approaches, above 1 recedes. Null when the anchor
 * is not ahead of the camera.
 */
export function zoomAbout(pose: CameraPose, anchor: Vec3, factor: number): CameraPose | null {
  if (!(factor > 0) || !Number.isFinite(factor)) return null;
  const view = viewDirection(pose, anchor);
  if (!view) return null;
  const eye = add(anchor, scale(sub(pose.eye, anchor), factor));
  const forward = levelLookAt(eye, anchor, view, pose.forward);
  return forward ? { eye, forward } : null;
}

/** The WGS84 vertical through a point: the ellipsoid's normal there. */
export function geodeticVertical(point: Vec3): Vec3 {
  const { latRad, lonRad } = ecefToGeodetic(point[0], point[1], point[2]);
  const cosLat = Math.cos(latRad);
  return [cosLat * Math.cos(lonRad), cosLat * Math.sin(lonRad), Math.sin(latRad)];
}

/** `v` turned by `angleRad` about the unit `axis`, right-handed. */
export function rotateAbout(v: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/**
 * The pose after orbiting `pivot`. The heading turns clockwise seen from
 * above about the pivot's WGS84 vertical, then the tilt turns the view down
 * about the camera's right after that heading, as the globe's own orbit turns
 * (`pitchDeltaDeg` down, `headingDeltaDeg` clockwise). The eye keeps its
 * distance to the pivot and the pivot its place on screen; the look is then
 * levelled again, which leaves both. Where no level look can show the pivot
 * there, which happens when it is nearly under the eye, the heading turns
 * instead about the vertical through the Earth's centre, about 0.19° from the
 * WGS84 one at most: a level look turned about that axis stays level, so a
 * turn never stalls. Null when the pivot is not ahead.
 */
export function orbitAbout(pose: CameraPose, pivot: Vec3, pitchDeltaDeg: number, headingDeltaDeg: number): CameraPose | null {
  const view = viewDirection(pose, pivot);
  if (!view) return null;
  const turned = orbitAboutAxis(pose, pivot, view, pitchDeltaDeg, headingDeltaDeg, geodeticVertical(pivot));
  if (turned || headingDeltaDeg === 0) return turned;
  return orbitAboutAxis(pose, pivot, view, pitchDeltaDeg, headingDeltaDeg, normalize(pivot));
}

function orbitAboutAxis(pose: CameraPose, pivot: Vec3, view: ViewDirection, pitchDeltaDeg: number, headingDeltaDeg: number, vertical: Vec3): CameraPose | null {
  let eye = pose.eye, forward = pose.forward;
  if (headingDeltaDeg !== 0) {
    const angle = -headingDeltaDeg * DEG_TO_RAD;
    eye = add(pivot, rotateAbout(sub(eye, pivot), vertical, angle));
    forward = rotateAbout(forward, vertical, angle);
  }
  if (pitchDeltaDeg !== 0) {
    const axes = cameraAxes({ eye, forward });
    if (!axes) return null;
    const angle = -pitchDeltaDeg * DEG_TO_RAD;
    eye = add(pivot, rotateAbout(sub(eye, pivot), axes.right, angle));
    forward = rotateAbout(forward, axes.right, angle);
  }
  const look = levelLookAt(eye, pivot, view, forward);
  return look ? { eye, forward: look } : null;
}

/**
 * The pose after turning the heading about the vertical through the Earth's
 * centre and `pivot`, clockwise seen from above. A level look turned about
 * that axis stays level, so the view turns exactly as far as asked, as a
 * twist of two fingers does, even looking straight down, where turning about
 * the WGS84 vertical (`orbitAbout`) also rolls the look a little, and
 * levelling it again turns it further. The pivot keeps its place on screen.
 * Null when the pivot is not ahead.
 */
export function turnAbout(pose: CameraPose, pivot: Vec3, headingDeltaDeg: number): CameraPose | null {
  if (!viewDirection(pose, pivot)) return null;
  const axis = normalize(pivot);
  const angle = -headingDeltaDeg * DEG_TO_RAD;
  return { eye: add(pivot, rotateAbout(sub(pose.eye, pivot), axis, angle)), forward: rotateAbout(pose.forward, axis, angle) };
}

/** How far a look dips below the horizontal at `point`, degrees: the globe's tilt there, 0 level and 90 straight down. */
export function tiltAt(point: Vec3, forward: Vec3): number {
  return Math.asin(Math.max(-1, Math.min(1, -dot(forward, normalize(point))))) * RAD_TO_DEG;
}

/**
 * Where a ray first comes down to `heightMeters` above the WGS84 ellipsoid,
 * taking that height as the ellipsoid grown by it. Null when the ray starts
 * at or below that height, or never comes down to it.
 */
export function rayToHeight(origin: Vec3, direction: Vec3, heightMeters: number): Vec3 | null {
  const a = WGS84_A + heightMeters, b = WGS84_B + heightMeters;
  if (!(a > 0 && b > 0)) return null;
  const ox = origin[0] / a, oy = origin[1] / a, oz = origin[2] / b;
  const dx = direction[0] / a, dy = direction[1] / a, dz = direction[2] / b;
  const qa = dx * dx + dy * dy + dz * dz;
  const qb = 2 * (ox * dx + oy * dy + oz * dz);
  const qc = ox * ox + oy * oy + oz * oz - 1;
  if (!(qc > 0) || !(qb < 0)) return null;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  // The nearer root, written without cancelling for an eye close to that height.
  const t = (2 * qc) / (-qb + Math.sqrt(disc));
  return t > 0 && Number.isFinite(t) ? add(origin, scale(direction, t)) : null;
}

/**
 * Where the line of sight comes down to the height `heightAt` gives where it
 * lands (the ground and the orbit target's offset there), found again at each
 * landing until it settles. `startHeightMeters` is the first guess. Null when
 * the line never comes down to it.
 */
export function lineOfSightTarget(
  pose: CameraPose,
  heightAt: (latDeg: number, lonDeg: number) => number | null,
  startHeightMeters: number,
): { point: Vec3; heightMeters: number } | null {
  let wanted = startHeightMeters;
  let grown = startHeightMeters;
  let landing: { point: Vec3; heightMeters: number } | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const point = rayToHeight(pose.eye, pose.forward, grown);
    if (!point) return landing;
    const place = ecefToGeodetic(point[0], point[1], point[2]);
    landing = { point, heightMeters: place.altMeters };
    const there = heightAt(place.latRad * RAD_TO_DEG, place.lonRad * RAD_TO_DEG);
    if (there !== null && Number.isFinite(there)) wanted = there;
    const miss = wanted - place.altMeters;
    // A hundredth of a millimetre: a miss left here is carried into the next step's start height.
    if (Math.abs(miss) < 1e-5) break;
    grown += miss;
  }
  return landing;
}

/** The globe camera's centre, yaw, pitch and radius that draw `pose`, centred at `center` on its line of sight. */
export function orbitFieldsOf(pose: CameraPose, center: Vec3, fallbackYaw: number): OrbitFields {
  const { yaw, pitch } = orbitAngles(center, pose.forward, fallbackYaw);
  return { center, yaw, pitch, radius: length(sub(center, pose.eye)) };
}

/** The pose the globe camera's centre, yaw, pitch and radius draw. */
export function poseOfOrbit(fields: OrbitFields): CameraPose {
  const forward = orbitLook(fields.center, fields.yaw, fields.pitch);
  return { eye: sub(fields.center, scale(forward, fields.radius)), forward };
}

/**
 * Whether `target` is in view from `eye` at all: ahead of the look, a usable
 * distance away, and on this side of the Earth, its line from the eye not
 * passing through the ground first. A point on terrain below the ellipsoid
 * counts as on this side. The reason it is not, or null.
 */
export function pointInViewProblem(pose: CameraPose, target: Vec3, minimumDistanceMeters = 0.01): "not-finite" | "too-near" | "behind" | "beyond-horizon" | null {
  if (!target.every(Number.isFinite) || !pose.eye.every(Number.isFinite)) return "not-finite";
  const toTarget = sub(target, pose.eye);
  const distance = length(toTarget);
  if (!(distance > minimumDistanceMeters)) return "too-near";
  if (!(dot(toTarget, pose.forward) > AHEAD_EPSILON * distance)) return "behind";
  // An ellipsoid a metre under the lower of the target and the ellipsoid: the line reaching it first went through the Earth.
  const below = Math.min(0, ecefToGeodetic(target[0], target[1], target[2]).altMeters) - 1;
  const ground = rayToHeight(pose.eye, scale(toTarget, 1 / distance), below);
  if (ground && length(sub(ground, pose.eye)) < distance) return "beyond-horizon";
  return null;
}
