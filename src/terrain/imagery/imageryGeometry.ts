/**
 * Web Mercator tiles on the WGS84 ellipsoid and their projection into a view.
 * Everything here is pure float64 math so the imagery selector can be tested
 * without a renderer.
 */

import { ecefToGeodetic, WGS84_A, WGS84_B, WGS84_E2 } from "../../camera/cameraMath";

export const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;
const DEG = Math.PI / 180;

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function tileKey(tile: TileId): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

export function parentTile(tile: TileId): TileId {
  return { z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 };
}

export function childTiles(tile: TileId): TileId[] {
  const z = tile.z + 1, x = tile.x * 2, y = tile.y * 2;
  return [{ z, x, y }, { z, x: x + 1, y }, { z, x, y: y + 1 }, { z, x: x + 1, y: y + 1 }];
}

/** True when `ancestor` is `tile` or contains it. */
export function tileContains(ancestor: TileId, tile: TileId): boolean {
  if (tile.z < ancestor.z) return false;
  const shift = tile.z - ancestor.z;
  return tile.x >> shift === ancestor.x && tile.y >> shift === ancestor.y;
}

export function tileLonDeg(z: number, x: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileLatDeg(z: number, y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / DEG;
}

/** Fractional tile coordinates of a point, with longitude wrapped into the tile grid. */
export function lonLatToTileXY(lonDeg: number, latDeg: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-WEB_MERCATOR_MAX_LAT_DEG, Math.min(WEB_MERCATOR_MAX_LAT_DEG, latDeg)) * DEG;
  const wrapped = ((((lonDeg + 180) % 360) + 360) % 360) / 360;
  return {
    x: wrapped * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}

/**
 * A point on a tile with its tangents. `du` and `dv` are the ECEF change per
 * unit of tile-local u (east) and v (south), each spanning the whole tile.
 */
export interface SurfaceSample {
  position: Vec3;
  du: Vec3;
  dv: Vec3;
  latDeg: number;
  lonDeg: number;
}

/**
 * ECEF position and tangents at local (u, v) of a tile, at `height` metres.
 * `slopeU`/`slopeV` are height changes per unit u/v, added along the normal.
 */
export function sampleTileSurface(
  tile: TileId,
  u: number,
  v: number,
  height: number,
  slopeU = 0,
  slopeV = 0,
): SurfaceSample {
  const n = 2 ** tile.z;
  const lonDeg = ((tile.x + u) / n) * 360 - 180;
  const s = Math.PI * (1 - (2 * (tile.y + v)) / n);
  const lat = Math.atan(Math.sinh(s));
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const w = Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const primeVertical = WGS84_A / w;
  const meridian = (WGS84_A * (1 - WGS84_E2)) / (w * w * w);
  const position = {
    x: (primeVertical + height) * cosLat * cosLon,
    y: (primeVertical + height) * cosLat * sinLon,
    z: (primeVertical * (1 - WGS84_E2) + height) * sinLat,
  };
  // d(lon)/du and d(lat)/dv for Web Mercator tiles, in radians.
  const dLonDu = (2 * Math.PI) / n;
  const dLatDv = (-2 * Math.PI * cosLat) / n;
  const east = (primeVertical + height) * cosLat * dLonDu;
  const north = (meridian + height) * dLatDv;
  const normal = { x: cosLat * cosLon, y: cosLat * sinLon, z: sinLat };
  return {
    position,
    du: {
      x: -east * sinLon + normal.x * slopeU,
      y: east * cosLon + normal.y * slopeU,
      z: normal.z * slopeU,
    },
    dv: {
      x: -north * sinLat * cosLon + normal.x * slopeV,
      y: -north * sinLat * sinLon + normal.y * slopeV,
      z: north * cosLat + normal.z * slopeV,
    },
    latDeg: lat / DEG,
    lonDeg,
  };
}

/** Geographic span of a tile in radians, for curvature bounds. */
export function tileAngularSpan(tile: TileId): number {
  const n = 2 ** tile.z;
  const north = tileLatDeg(tile.z, tile.y) * DEG;
  const south = tileLatDeg(tile.z, tile.y + 1) * DEG;
  const widthAtEquatorSide = ((2 * Math.PI) / n) * Math.max(Math.cos(north), Math.cos(south));
  return Math.max(widthAtEquatorSide, north - south);
}

/**
 * How far a spherical surface bulges above the chord between two points
 * `angle` radians apart. Lifting hull points by this keeps them conservative.
 */
export function sagittaMeters(angle: number): number {
  return WGS84_A * (1 - Math.cos(Math.min(Math.PI, angle) / 2));
}

/**
 * A view in ECEF: `ecefToClip` maps ECEF metres to clip space in Babylon's
 * row-vector layout (clip = [x y z 1] * M), including any floating-origin or
 * world-root transform. Viewport sizes are the actual render buffer
 * (physical) and the CSS viewport (logical).
 */
export interface ImageryView {
  ecefToClip: ArrayLike<number>;
  /** The near plane as `z * nearPlane.z + w * nearPlane.w >= 0` in clip space. */
  nearPlane: { z: number; w: number };
  camera: Vec3;
  renderWidth: number;
  renderHeight: number;
  logicalWidth: number;
  logicalHeight: number;
}

export interface Clip {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Row-vector matrix product in Babylon's layout: applying the result is applying `a`, then `b`. */
export function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[row * 4 + k] * b[k * 4 + col];
    out[row * 4 + col] = sum;
  }
  return out;
}

export function toClip(m: ArrayLike<number>, p: Vec3): Clip {
  return {
    x: p.x * m[0] + p.y * m[4] + p.z * m[8] + m[12],
    y: p.x * m[1] + p.y * m[5] + p.z * m[9] + m[13],
    z: p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14],
    w: p.x * m[3] + p.y * m[7] + p.z * m[11] + m[15],
  };
}

export function nearDistance(view: ImageryView, clip: Clip): number {
  return clip.z * view.nearPlane.z + clip.w * view.nearPlane.w;
}

/** Bit mask of the clip planes a point is outside: left, right, bottom, top, near. */
export function outcode(view: ImageryView, clip: Clip): number {
  let code = 0;
  if (clip.x < -clip.w) code |= 1;
  if (clip.x > clip.w) code |= 2;
  if (clip.y < -clip.w) code |= 4;
  if (clip.y > clip.w) code |= 8;
  if (nearDistance(view, clip) < 0) code |= 16;
  return code;
}

/**
 * The largest stretch of one image pixel on screen, in viewport pixels of the
 * given size, at a surface sample: the largest singular value of the Jacobian
 * from image pixels to screen pixels. `imageWidth`/`imageHeight` are the
 * image's pixel counts across the tile. Null behind the near plane.
 */
export function projectedPixelFootprint(
  view: ImageryView,
  sample: SurfaceSample,
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): number | null {
  const m = view.ecefToClip;
  const c = toClip(m, sample.position);
  if (nearDistance(view, c) < 0 || c.w <= 0) return null;
  const jacobianColumn = (t: Vec3, pixels: number): [number, number] => {
    const dx = t.x * m[0] + t.y * m[4] + t.z * m[8];
    const dy = t.x * m[1] + t.y * m[5] + t.z * m[9];
    const dw = t.x * m[3] + t.y * m[7] + t.z * m[11];
    const inv = 1 / (c.w * c.w * pixels);
    return [
      (viewportWidth / 2) * (dx * c.w - c.x * dw) * inv,
      (viewportHeight / 2) * (dy * c.w - c.y * dw) * inv,
    ];
  };
  const [a, cc] = jacobianColumn(sample.du, imageWidth);
  const [b, d] = jacobianColumn(sample.dv, imageHeight);
  const sum = a * a + b * b + cc * cc + d * d;
  const det = a * d - b * cc;
  return Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2);
}

/**
 * Conservative horizon test against a sphere inside the ellipsoid everywhere.
 * Returns true only when the point is certainly hidden by the globe.
 */
export function isBelowHorizon(camera: Vec3, point: Vec3, occluderRadius = WGS84_B - 1000): boolean {
  const cx = camera.x / occluderRadius, cy = camera.y / occluderRadius, cz = camera.z / occluderRadius;
  const vh = cx * cx + cy * cy + cz * cz - 1;
  // A camera inside the occluder cannot rely on it.
  if (vh <= 0) return false;
  const tx = point.x / occluderRadius - cx, ty = point.y / occluderRadius - cy, tz = point.z / occluderRadius - cz;
  const tDotC = -(tx * cx + ty * cy + tz * cz);
  const tLengthSquared = tx * tx + ty * ty + tz * tz;
  return tDotC > vh && (tDotC * tDotC) / tLengthSquared > vh;
}

/**
 * Conservative horizon test for a bounding sphere: true only when every point
 * of the sphere lies behind the occluder, within its shadow cone and past the
 * distance at which rays graze it.
 */
export function isSphereBelowHorizon(camera: Vec3, center: Vec3, radius: number, occluderRadius = WGS84_B - 1000): boolean {
  const distance = Math.hypot(camera.x, camera.y, camera.z);
  if (distance <= occluderRadius) return false;
  const tx = center.x - camera.x, ty = center.y - camera.y, tz = center.z - camera.z;
  const toCenter = Math.hypot(tx, ty, tz);
  if (toCenter <= radius) return false;
  // Angle between the ray to the sphere's centre and the ray to the globe's centre.
  const cosAxis = -(tx * camera.x + ty * camera.y + tz * camera.z) / (toCenter * distance);
  const axisAngle = Math.acos(Math.max(-1, Math.min(1, cosAxis)));
  const sphereAngle = Math.asin(Math.min(1, radius / toCenter));
  const coneAngle = Math.asin(occluderRadius / distance);
  const grazing = Math.sqrt(distance * distance - occluderRadius * occluderRadius);
  return axisAngle + sphereAngle < coneAngle && toCenter - radius > grazing;
}

/** The inverse of a 4×4 matrix in Babylon's layout, or null when singular. */
export function invertMatrix(m: ArrayLike<number>): number[] | null {
  const a = Array.from(m);
  const inv = new Array<number>(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  return inv.map(value => value / det);
}

/**
 * Where a grid of screen rays meets a sphere of the given radius: ground
 * points spread over the view, in geographic degrees. Rays that miss are left
 * out.
 */
export function screenGroundPoints(view: ImageryView, radius: number, columns = 5, rows = 3): Array<{ latDeg: number; lonDeg: number }> {
  const inverse = invertMatrix(view.ecefToClip);
  if (!inverse) return [];
  const unproject = (x: number, y: number, z: number): Vec3 | null => {
    const w = x * inverse[3] + y * inverse[7] + z * inverse[11] + inverse[15];
    if (Math.abs(w) < 1e-12) return null;
    return {
      x: (x * inverse[0] + y * inverse[4] + z * inverse[8] + inverse[12]) / w,
      y: (x * inverse[1] + y * inverse[5] + z * inverse[9] + inverse[13]) / w,
      z: (x * inverse[2] + y * inverse[6] + z * inverse[10] + inverse[14]) / w,
    };
  };
  const points: Array<{ latDeg: number; lonDeg: number }> = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const nx = -0.95 + (1.9 * col) / Math.max(1, columns - 1);
    const ny = -0.95 + (1.9 * row) / Math.max(1, rows - 1);
    // Two depths between the planes in either depth convention lie on the ray.
    const a = unproject(nx, ny, 0.2), b = unproject(nx, ny, 0.8);
    if (!a || !b) continue;
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const dd = d.x * d.x + d.y * d.y + d.z * d.z;
    const ad = a.x * d.x + a.y * d.y + a.z * d.z;
    const aa = a.x * a.x + a.y * a.y + a.z * a.z - radius * radius;
    const disc = ad * ad - dd * aa;
    if (disc < 0 || dd === 0) continue;
    // The nearer crossing ahead of the camera along the ray from a toward b.
    const roots = [(-ad - Math.sqrt(disc)) / dd, (-ad + Math.sqrt(disc)) / dd].sort((p, q) => p - q);
    const t = roots.find(root => root >= -10) ?? null;
    if (t === null) continue;
    const geo = ecefToGeodetic(a.x + d.x * t, a.y + d.y * t, a.z + d.z * t);
    points.push({ latDeg: (geo.latRad * 180) / Math.PI, lonDeg: (geo.lonRad * 180) / Math.PI });
  }
  return points;
}

/** Screen position in viewport pixels, or null behind the near plane. */
export function toScreen(view: ImageryView, clip: Clip, width: number, height: number): { x: number; y: number } | null {
  if (nearDistance(view, clip) < 0 || clip.w <= 0) return null;
  return { x: ((clip.x / clip.w + 1) / 2) * width, y: ((1 - clip.y / clip.w) / 2) * height };
}
