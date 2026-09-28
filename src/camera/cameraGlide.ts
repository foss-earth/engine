/**
 * Handing the globe camera back moving, from a view its lease's owner put
 * anywhere (`glideNavigationCamera`): the orbit that holds that eye and look,
 * and the rates of the globe's own pan, orbit and zoom that carry the eye's
 * velocity and the look's turn on, so its glide slows them as it slows a
 * flick. ECEF metres and unit vectors, float64.
 */
import { DEG_TO_RAD, RAD_TO_DEG, ecefToGeodetic, geodeticToEcef } from "./cameraMath";

export type GlideVec3 = readonly [number, number, number];

const dot = (a: GlideVec3, b: GlideVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: GlideVec3, b: GlideVec3): GlideVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: GlideVec3, b: GlideVec3): GlideVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: GlideVec3, s: number): GlideVec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: GlideVec3, b: GlideVec3): GlideVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: GlideVec3): number => Math.sqrt(dot(a, a));
const normalize = (a: GlideVec3): GlideVec3 => scale(a, 1 / length(a));

/** A turn this small, radians, measures the look's rate of turning. */
const TURN_PROBE_RAD = 1e-6;

/**
 * `forward` tilted into the globe's tilt limits, degrees down from the
 * horizon about the geocentric `up`: unchanged when inside them.
 */
export function withinTilt(forward: GlideVec3, up: GlideVec3, pitchDeg: { min: number; max: number }, fallback: GlideVec3): GlideVec3 {
  const down = Math.asin(Math.max(-1, Math.min(1, -dot(forward, up)))) * RAD_TO_DEG;
  const allowed = Math.max(pitchDeg.min, Math.min(pitchDeg.max, down));
  if (allowed === down) return forward;
  const across = sub(forward, scale(up, dot(forward, up)));
  const level = length(across) > 1e-9 ? normalize(across) : normalize(sub(fallback, scale(up, dot(fallback, up))));
  const tilt = allowed * DEG_TO_RAD;
  return normalize(sub(scale(level, Math.cos(tilt)), scale(up, Math.sin(tilt))));
}

/**
 * The point an eye looking along `forward` orbits: where its line of sight
 * comes down to `targetHeightMeters` over `pivot`, the height the globe
 * keeps its orbit target at there, so ground following has nothing to
 * correct. When the line never comes down to it, the line's nearest point
 * to `pivot`; a null height is `pivot`'s own.
 */
export function orbitCenterOnSight(eye: GlideVec3, forward: GlideVec3, pivot: GlideVec3, targetHeightMeters: number | null): GlideVec3 {
  const place = ecefToGeodetic(pivot[0], pivot[1], pivot[2]);
  const target = geodeticToEcef(place.latRad, place.lonRad, targetHeightMeters ?? place.altMeters);
  // The height as a sphere through the target: over the few hundred metres of a flight, within centimetres of the ellipsoid's.
  const reach = length([target.x, target.y, target.z]);
  const along = dot(eye, forward);
  const above = (length(eye) - reach) * (length(eye) + reach);
  const disc = along * along - above;
  if (above > 0 && disc >= 0) {
    const t = -along - Math.sqrt(disc);
    if (t > 0) return add(eye, scale(forward, t));
  }
  return add(eye, scale(forward, Math.max(1, dot(sub(pivot, eye), forward))));
}

/** Per second, what the globe's `panBy`, `orbitBy` and `zoomBy` take. */
export interface OrbitGlideRates {
  /** Screen pixels the orbit target moves, right and down. */
  panPx: { x: number; y: number };
  /** Degrees: tilt down, and heading clockwise. */
  orbitDeg: { pitch: number; heading: number };
  /** The orbit distance's natural logarithm. */
  zoomLog: number;
}

/**
 * The globe's pan, orbit and zoom rates that move an eye orbiting `center`
 * at `radius`, looking along `forward`, at `velocity` (m/s) while its look
 * turns at `turn` (its derivative, 1/s). The turn is the orbit's. Of the
 * eye's velocity, less what the orbit moves it, the part along the look is
 * the zoom's and the part across the ground the pan's; a vertical part with
 * a level look has no zoom to carry it, and is lost. `anglesOf` gives the
 * globe camera's yaw and pitch of a look at a centre.
 */
export function orbitGlideRates(
  orbit: { center: GlideVec3; forward: GlideVec3; radius: number; verticalFovRad: number; canvasHeightPx: number },
  velocity: GlideVec3,
  turn: GlideVec3,
  anglesOf: (forward: GlideVec3, center: GlideVec3) => { yaw: number; pitch: number },
): OrbitGlideRates {
  const { center, forward, radius } = orbit;
  const up = normalize(center);
  // The orbit: the rate the look's yaw and pitch change, measured over a tiny turn.
  const speed = length(turn);
  let orbitDeg = { pitch: 0, heading: 0 };
  if (speed > 0) {
    const dt = TURN_PROBE_RAD / speed;
    const from = anglesOf(forward, center);
    const to = anglesOf(normalize(add(forward, scale(turn, dt))), center);
    const yaw = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
    // Babylon's pitch grows toward the horizon; the globe's tilt grows downward.
    orbitDeg = { pitch: (-(to.pitch - from.pitch) / dt) * RAD_TO_DEG, heading: (yaw / dt) * RAD_TO_DEG };
  }
  // eye = center − forward·radius, so its velocity is the target's, less the turn's sweep, less the zoom along the look.
  const moved = add(velocity, scale(turn, radius));
  const lookUp = dot(forward, up);
  const radial = Math.abs(lookUp) > 1e-6 ? -dot(moved, up) / lookUp : 0;
  let across = add(moved, scale(forward, radial));
  across = sub(across, scale(up, dot(across, up)));
  const horizontal = sub(forward, scale(up, lookUp));
  const ahead = length(horizontal) > 1e-9 ? normalize(horizontal) : normalize(cross(up, [0, 0, 1]));
  const right = cross(ahead, up);
  const metresPerPixel = (2 * radius * Math.tan(orbit.verticalFovRad / 2)) / Math.max(1, orbit.canvasHeightPx);
  return {
    panPx: { x: dot(across, right) / metresPerPixel, y: -dot(across, ahead) / metresPerPixel },
    orbitDeg,
    zoomLog: radial / radius,
  };
}
