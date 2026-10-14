import { ecefToGeodetic } from "../camera/cameraMath.js";

/** Letter height as seen from the camera. Large enough to read against the sky at any altitude. */
export const HORIZON_COMPASS_ANGULAR_SIZE = (2.6 * Math.PI) / 180;
/** How far above the geometric horizon the baseline of each letter sits. */
export const HORIZON_COMPASS_LIFT = (1.4 * Math.PI) / 180;
const EARTH_RADIUS_METERS = 6_378_137;

export interface HorizonVec3 { x: number; y: number; z: number }

export interface HorizonLetterPlacement {
  id: "N" | "E" | "S" | "W";
  position: HorizonVec3;
  /** Edge length in metres. At `angularSize` it covers the same angle from the camera. */
  sizeMeters: number;
}

const CARDINALS = [
  { id: "N", east: 0, north: 1 },
  { id: "E", east: 1, north: 0 },
  { id: "S", east: 0, north: -1 },
  { id: "W", east: -1, north: 0 },
] as const;

function add(a: HorizonVec3, b: HorizonVec3): HorizonVec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: HorizonVec3, b: HorizonVec3): HorizonVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: HorizonVec3, factor: number): HorizonVec3 {
  return { x: a.x * factor, y: a.y * factor, z: a.z * factor };
}

function dot(a: HorizonVec3, b: HorizonVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(a: HorizonVec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

function normalize(a: HorizonVec3): HorizonVec3 | null {
  const span = length(a);
  if (!(span > 0) || !Number.isFinite(span)) return null;
  return scale(a, 1 / span);
}

function cross(a: HorizonVec3, b: HorizonVec3): HorizonVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function projectOntoPlane(vector: HorizonVec3, normal: HorizonVec3): HorizonVec3 | null {
  const projected = sub(vector, scale(normal, dot(vector, normal)));
  if (length(projected) < 1e-4) return null;
  return normalize(projected);
}

/**
 * N, E, S and W just above the earth's horizon, as seen from the camera.
 * Letters grow with distance so each one keeps the same size on screen.
 * Returns null when the camera position cannot define a horizon.
 */
export function horizonCompassPlacements(
  camera: HorizonVec3,
  options?: { radiusMeters?: number; liftRadians?: number; angularSizeRadians?: number },
): HorizonLetterPlacement[] | null {
  const radius = options?.radiusMeters ?? EARTH_RADIUS_METERS;
  const lift = options?.liftRadians ?? HORIZON_COMPASS_LIFT;
  const angular = options?.angularSizeRadians ?? HORIZON_COMPASS_ANGULAR_SIZE;
  const distance = length(camera);
  if (!(distance > 1) || !(radius > 1) || !Number.isFinite(distance)) return null;
  const up = normalize(camera);
  if (!up) return null;

  const geo = ecefToGeodetic(camera.x, camera.y, camera.z);
  const sinLat = Math.sin(geo.latRad);
  const cosLat = Math.cos(geo.latRad);
  const sinLon = Math.sin(geo.lonRad);
  const cosLon = Math.cos(geo.lonRad);
  let north = projectOntoPlane({ x: -sinLat * cosLon, y: -sinLat * sinLon, z: cosLat }, up);
  let east = projectOntoPlane({ x: -sinLon, y: cosLon, z: 0 }, up);
  if (!north || !east) {
    const axis = Math.abs(up.z) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    east = normalize(cross(axis, up));
    north = east ? normalize(cross(up, east)) : null;
  }
  if (!north || !east) return null;

  const outside = distance > radius + 1;
  const cosAlpha = outside ? Math.min(1, radius / distance) : 0;
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));
  const slant = outside
    ? Math.sqrt(Math.max(1, distance * distance - radius * radius))
    : Math.max(5_000, radius * 0.01);

  return CARDINALS.map(({ id, east: eastShare, north: northShare }) => {
    const horizontal = normalize(add(scale(east, eastShare), scale(north, northShare))) ?? north;
    let direction = horizontal;
    if (outside) {
      const tangent = add(scale(up, radius * cosAlpha), scale(horizontal, radius * sinAlpha));
      const horizonDir = normalize(sub(tangent, camera));
      if (horizonDir) {
        const sky = normalize(sub(up, scale(horizonDir, dot(up, horizonDir)))) ?? up;
        direction = normalize(add(scale(horizonDir, Math.cos(lift)), scale(sky, Math.sin(lift)))) ?? horizonDir;
      }
    } else {
      direction = normalize(add(scale(horizontal, Math.cos(lift)), scale(up, Math.sin(lift)))) ?? horizontal;
    }
    const sizeMeters = Math.max(1, slant * angular);
    const sky = normalize(sub(up, scale(direction, dot(up, direction)))) ?? up;
    const position = add(add(camera, scale(direction, slant)), scale(sky, sizeMeters * 0.5));
    return { id, position, sizeMeters };
  });
}
