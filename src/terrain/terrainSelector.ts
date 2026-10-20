import { ecefToGeodetic, WGS84_E2 } from "../camera/cameraMath.js";
import {
  isBelowHorizon,
  isSphereBelowHorizon,
  lonLatToMercator,
  sagittaMeters,
  positionOnTileBasis,
  tileAngularSpan,
  tileKey,
  tileLatDeg,
  type ImageryView,
  type TileId,
  type Vec3,
  type TileSurfaceBasis,
} from "./imagery/imageryGeometry.js";

const WGS84_A = 6378137;
// Geometry is independent of camera, heights and settings. Keep a bounded,
// direct-mapped cache across selections instead of recomputing stable grid
// trigonometry for every frame. Collisions only replace cached work.
const GEOMETRY_CACHE_SIZE = 8192;
let geometryCacheReady = false;
let geometryZ: Int32Array, geometryX: Int32Array, geometryY: Int32Array;
let geometryKeys: Array<string | undefined>;
let geometryMasks: Uint16Array;
let geometryBases: Float64Array, geometrySpans: Float64Array, geometryLifts: Float64Array;
let geometryWidths: Float64Array, geometryRadiusAngles: Float64Array;
let geometrySlot = -1;
let geometryOffset = 0;
/** Selection is synchronous; no sample, hull, clip or local-point objects escape a measurement. */
const hullScratch = new Float64Array(60);
const basisGridScratch = new Float64Array(45);
let basisGridStorage: Float64Array = basisGridScratch;
const latitudeScratch = new Float64Array(9);
const longitudeScratch = new Float64Array(6);
let basisGridMask = 0;
let latitudeMask = 0;
let longitudeMask = 0;
let tileScale = 1;
const basisScratch: TileSurfaceBasis = { primeVertical: 0, sinLat: 0, cosLat: 0, sinLon: 0, cosLon: 0 };
const positionScratch = { x: 0, y: 0, z: 0 };
const centerScratch = { x: 0, y: 0, z: 0 };
const localScratch = { u: 0, v: 0 };
const proximityScratch = { distance: Infinity, horizontal: Infinity, vertical: Infinity, sampleIndex: 10 };

function initializeGeometryCache(): void {
  if (geometryCacheReady) return;
  geometryZ = new Int32Array(GEOMETRY_CACHE_SIZE).fill(-1);
  geometryX = new Int32Array(GEOMETRY_CACHE_SIZE);
  geometryY = new Int32Array(GEOMETRY_CACHE_SIZE);
  geometryKeys = new Array<string | undefined>(GEOMETRY_CACHE_SIZE);
  geometryMasks = new Uint16Array(GEOMETRY_CACHE_SIZE);
  geometryBases = new Float64Array(GEOMETRY_CACHE_SIZE * 45);
  geometrySpans = new Float64Array(GEOMETRY_CACHE_SIZE);
  geometryLifts = new Float64Array(GEOMETRY_CACHE_SIZE);
  geometryWidths = new Float64Array(GEOMETRY_CACHE_SIZE);
  geometryRadiusAngles = new Float64Array(GEOMETRY_CACHE_SIZE);
  geometryCacheReady = true;
}

/**
 * The traversal's structure, not tuning: the level whose 16 tiles always cover
 * the globe, as for imagery, and the widest tile rejected point by point at
 * the horizon.
 */
export const TERRAIN_SELECTION_CONSTANTS = Object.freeze({
  rootLevel: 2,
  horizonTileSpan: Math.PI / 8,
});

/** A region of terrain to keep refined around a point, whatever the camera sees: `map.focus.*`. */
export interface TerrainFocus {
  mode: "around" | "both";
  /** ECEF metres. */
  position: Vec3;
  radiusMeters: number;
  /** The region is never measured nearer than this, the camera's distance to the point. */
  minDistanceMeters: number;
  horizonCull: boolean;
}

/**
 * A point the tiles the camera sees are measured from, never nearer than the
 * camera is to it: turning or tilting the camera around it changes no tile.
 */
export interface TerrainRefinePoint {
  /** ECEF metres. */
  position: Vec3;
  /** The camera's distance to the point. */
  minDistanceMeters: number;
}

export type TerrainProximityBlendMode = "max" | "power-norm" | "weighted-sum";

/** Independent visual and geometric detail; endpoints and optional forward are in ECEF metres. */
export interface TerrainProximityConfig {
  start: Vec3;
  end: Vec3;
  secondary?: { start: Vec3; end: Vec3 };
  coreMeters: number;
  radiusMeters: number;
  heightMeters: number;
  falloffExponent: number;
  proximityWeight: number;
  losWeight: number;
  losGazeExponent: number;
  losPeripheralFloor: number;
  blendMode: TerrainProximityBlendMode;
  blendPower: number;
  minProximityZoom: number;
  /** Defaults to the forward direction extracted from the view's projection. */
  forward?: Vec3;
}

export const TERRAIN_PROXIMITY_DEFAULTS = Object.freeze({
  coreMeters: 200,
  radiusMeters: 1500,
  heightMeters: 600,
  falloffExponent: 1,
  proximityWeight: 1,
  losWeight: 1,
  losGazeExponent: 0,
  losPeripheralFloor: 0.25,
  blendMode: "max" as TerrainProximityBlendMode,
  blendPower: 2,
  minProximityZoom: 14,
});

/** Shared by raster terrain and 3D Tiles so their tuning controls have the same meaning. */
export function blendTerrainErrors(los: number, proximity: number, mode: TerrainProximityBlendMode, power: number): number {
  if (mode === "weighted-sum") return los + proximity;
  if (mode === "power-norm") {
    // Scaling first avoids overflowing when the nearest surface is very close.
    const largest = Math.max(los, proximity);
    const p = Math.max(1, power);
    if (largest === Infinity) return Infinity;
    return largest === 0 ? 0 : largest * ((los / largest) ** p + (proximity / largest) ** p) ** (1 / p);
  }
  return Math.max(los, proximity);
}

export interface TerrainSelectionInput {
  /** The camera. Null when there is none: then only the root level is kept. */
  view: ImageryView | null;
  focus: TerrainFocus | null;
  /** Where the tiles the camera sees are measured from: `map.focus.refineBasemapFrom`. Null: the camera. */
  refineFrom?: TerrainRefinePoint | null;
  /** The screen-space error the mesh may show, in physical px. */
  targetPx: number;
  /** A tile's geometric error as a share of its vertex spacing: `map.terrain.errorPerSpacing`. */
  errorPerSpacing: number;
  /** Mesh segments along each side of a tile: `map.terrain.tileSegments`. */
  segments: number;
  minLevel: number;
  maxLevel: number;
  /** At most this many tiles cover the globe; the rest stay coarser. */
  maxTiles: number;
  /** An existing leaf splits past `refineAbove` times the target; a split tile merges under `coarsenBelow`. */
  hysteresis: { refineAbove: number; coarsenBelow: number };
  /** The last selection's split tiles and leaves, by key. */
  previous: { split: ReadonlySet<string>; leaves: ReadonlySet<string> } | null;
  /** The lowest and highest heights a tile may have, in metres. */
  boundsFor(tile: TileId): { min: number; max: number };
  /** Opt-in: Keep tiles directly under the camera eye refined so safe-space checks have fine elevation. */
  robustOrbitLOD?: boolean;
  proximity?: TerrainProximityConfig;
}

export interface TerrainLeaf {
  tile: TileId;
  key: string;
  /** Seen by the camera, or within the focus region. */
  needed: boolean;
  /** From the camera, the refine point or the focus point, whichever measured it; for load order. */
  distanceMeters: number;
  /** Its projected geometric error, px. */
  errorPx: number;
  inFrustum?: boolean;
  inProximity?: boolean;
  inCore?: boolean;
}

export interface TerrainSelection {
  /** Tiles covering the whole globe without overlap, nearest needed first. */
  leaves: TerrainLeaf[];
  split: Set<string>;
  rootLevel: number;
  /** True when `maxTiles` stopped refinement before every tile met the target. */
  truncated: boolean;
  nodes: number;
}

/**
 * A tile's geometric error: its vertex spacing at its centre's latitude times
 * `errorPerSpacing`, the share of a spacing the heights between vertices may
 * stray from the mesh. 0.25 is the share Cesium uses for heightmap terrain.
 */
export function terrainTileErrorMeters(tile: TileId, segments: number, errorPerSpacing: number): number {
  const lat = (tileLatDeg(tile.z, tile.y + 0.5) * Math.PI) / 180;
  const width = (2 * Math.PI * WGS84_A * Math.cos(lat)) / 2 ** tile.z;
  return (errorPerSpacing * width) / segments;
}

type Measured = TerrainLeaf;

/** The point of a tile nearest a point's zoom-0 Mercator position (lonLatToMercator), in tile-local u and v. */
function nearestLocal(tile: TileId, world: { x: number; y: number }): typeof localScratch {
  const n = 2 ** tile.z;
  // lonLatToTileXY's bits at this zoom; the point's trigonometry is done once per selection.
  // Longitude wraps: take the tile-local u nearest the tile's own span.
  let u = world.x * n - tile.x;
  if (u > n / 2) u -= n;
  if (u < -n / 2) u += n;
  localScratch.u = Math.max(0, Math.min(1, u));
  localScratch.v = Math.max(0, Math.min(1, world.y * n - tile.y));
  return localScratch;
}

/**
 * The lowest the ground of a tile may be, seen from a point at `altitude`.
 * Coarse heights can put the ground above a camera that is really above it,
 * in a valley the coarse grid fills in; then the ground is taken to reach as
 * far below the camera as the coarse relief spans, so it still refines.
 */
function lowestGround(bounds: { min: number; max: number }, altitude: number): number {
  return altitude > bounds.min ? bounds.min : altitude - Math.max(100, bounds.max - bounds.min);
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Each absolute component is a lower bound on Euclidean distance. */
function cannotImproveDistance(a: Vec3, b: Vec3, best: number): boolean {
  return Math.abs(a.x - b.x) > best || Math.abs(a.y - b.y) > best || Math.abs(a.z - b.z) > best;
}

/** Same operation order as tileSurfaceBasis, writing into synchronous selection scratch. */
function fillBasis(tile: TileId, u: number, v: number): TileSurfaceBasis {
  const onGrid = (u === 0 || u === 0.5 || u === 1) && (v === 0 || v === 0.5 || v === 1);
  const index = onGrid ? v * 6 + u * 2 : -1;
  const offset = geometryOffset + index * 5;
  if (onGrid && (basisGridMask & (1 << index))) {
    basisScratch.primeVertical = basisGridStorage[offset];
    basisScratch.sinLat = basisGridStorage[offset + 1];
    basisScratch.cosLat = basisGridStorage[offset + 2];
    basisScratch.sinLon = basisGridStorage[offset + 3];
    basisScratch.cosLon = basisGridStorage[offset + 4];
    return basisScratch;
  }
  // The nine grid points share three latitudes and three longitudes. Reuse
  // their exact computed values; nearest points can reuse either axis too.
  const row = v === 0 ? 0 : v === 0.5 ? 1 : v === 1 ? 2 : -1;
  const latitudeOffset = row * 3;
  if (row >= 0 && (latitudeMask & (1 << row))) {
    basisScratch.primeVertical = latitudeScratch[latitudeOffset];
    basisScratch.sinLat = latitudeScratch[latitudeOffset + 1];
    basisScratch.cosLat = latitudeScratch[latitudeOffset + 2];
  } else {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + v)) / tileScale)));
    const sinLat = Math.sin(lat);
    basisScratch.primeVertical = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    basisScratch.sinLat = sinLat;
    basisScratch.cosLat = Math.cos(lat);
    if (row >= 0) {
      latitudeMask |= 1 << row;
      latitudeScratch[latitudeOffset] = basisScratch.primeVertical;
      latitudeScratch[latitudeOffset + 1] = basisScratch.sinLat;
      latitudeScratch[latitudeOffset + 2] = basisScratch.cosLat;
    }
  }
  const column = u === 0 ? 0 : u === 0.5 ? 1 : u === 1 ? 2 : -1;
  const longitudeOffset = column * 2;
  if (column >= 0 && (longitudeMask & (1 << column))) {
    basisScratch.sinLon = longitudeScratch[longitudeOffset];
    basisScratch.cosLon = longitudeScratch[longitudeOffset + 1];
  } else {
    const lonDeg = ((tile.x + u) / tileScale) * 360 - 180;
    const lon = lonDeg * (Math.PI / 180);
    basisScratch.sinLon = Math.sin(lon);
    basisScratch.cosLon = Math.cos(lon);
    if (column >= 0) {
      longitudeMask |= 1 << column;
      longitudeScratch[longitudeOffset] = basisScratch.sinLon;
      longitudeScratch[longitudeOffset + 1] = basisScratch.cosLon;
    }
  }
  if (onGrid) {
    basisGridMask |= 1 << index;
    if (geometrySlot >= 0) geometryMasks[geometrySlot] = basisGridMask;
    basisGridStorage[offset] = basisScratch.primeVertical;
    basisGridStorage[offset + 1] = basisScratch.sinLat;
    basisGridStorage[offset + 2] = basisScratch.cosLat;
    basisGridStorage[offset + 3] = basisScratch.sinLon;
    basisGridStorage[offset + 4] = basisScratch.cosLon;
  }
  return basisScratch;
}

/** All cache values retain the original arithmetic and float64 precision. */
function geometryIndex(tile: TileId): number {
  return (Math.imul(tile.x, 73856093) ^ Math.imul(tile.y, 19349663) ^ Math.imul(tile.z, 83492791)) & (GEOMETRY_CACHE_SIZE - 1);
}

function cachedTileKey(tile: TileId): string {
  const slot = geometryIndex(tile);
  return tile.z <= 26 && geometryZ[slot] === tile.z && geometryX[slot] === tile.x && geometryY[slot] === tile.y
    ? geometryKeys[slot]! : tileKey(tile);
}

function prepareTileGeometry(tile: TileId, key: string): void {
  tileScale = 2 ** tile.z;
  latitudeMask = 0;
  longitudeMask = 0;
  if (tile.z > 26) {
    geometrySlot = -1;
    geometryOffset = 0;
    basisGridStorage = basisGridScratch;
    basisGridMask = 0;
    return;
  }
  geometrySlot = geometryIndex(tile);
  geometryOffset = geometrySlot * 45;
  basisGridStorage = geometryBases;
  if (geometryZ[geometrySlot] === tile.z && geometryX[geometrySlot] === tile.x && geometryY[geometrySlot] === tile.y) {
    basisGridMask = geometryMasks[geometrySlot];
  } else {
    geometryZ[geometrySlot] = tile.z;
    geometryX[geometrySlot] = tile.x;
    geometryY[geometrySlot] = tile.y;
    geometryKeys[geometrySlot] = key;
    geometryMasks[geometrySlot] = 0;
    basisGridMask = 0;
    const span = tileAngularSpan(tile);
    geometrySpans[geometrySlot] = span;
    geometryLifts[geometrySlot] = sagittaMeters(span / 2);
    const lat = tileLatDeg(tile.z, tile.y + 0.5) * Math.PI / 180;
    geometryWidths[geometrySlot] = (2 * Math.PI * WGS84_A * Math.cos(lat)) / tileScale;
    const north = tileLatDeg(tile.z, tile.y) * (Math.PI / 180);
    const south = tileLatDeg(tile.z, tile.y + 1) * (Math.PI / 180);
    const maxCos = north >= 0 && south <= 0 ? 1 : Math.max(Math.cos(north), Math.cos(south));
    geometryRadiusAngles[geometrySlot] = Math.max(north - lat, lat - south) + Math.PI / tileScale * maxCos;
  }
  // A full cached grid also supplies the exact row/column values needed by
  // clamped nearest points whose other coordinate varies with the camera.
  if (basisGridMask === 0x1ff) {
    latitudeMask = 7;
    longitudeMask = 7;
    for (let i = 0; i < 3; i++) {
      const row = geometryOffset + i * 15;
      latitudeScratch[i * 3] = geometryBases[row];
      latitudeScratch[i * 3 + 1] = geometryBases[row + 1];
      latitudeScratch[i * 3 + 2] = geometryBases[row + 2];
      const column = geometryOffset + i * 5;
      longitudeScratch[i * 2] = geometryBases[column + 3];
      longitudeScratch[i * 2 + 1] = geometryBases[column + 4];
    }
  }
}

/** Five clip half-spaces; normal lengths are fixed for one selection. */
function prepareClipPlanes(view: ImageryView): Float64Array {
  const planes = new Float64Array(25), m = view.ecefToClip;
  for (let i = 0; i < 5; i++) {
    const offset = i * 5;
    for (let axis = 0; axis < 4; axis++) {
      const row = axis * 4;
      planes[offset + axis] = i === 0 ? m[row] + m[row + 3]
        : i === 1 ? m[row + 3] - m[row]
          : i === 2 ? m[row + 1] + m[row + 3]
            : i === 3 ? m[row + 3] - m[row + 1]
              : m[row + 2] * view.nearPlane.z + m[row + 3] * view.nearPlane.w;
    }
    planes[offset + 4] = Math.hypot(planes[offset], planes[offset + 1], planes[offset + 2]);
  }
  return planes;
}

function verticalIntervalOutsideClipPlanes(planes: Float64Array, position: Vec3, nx: number, ny: number, nz: number, halfHeight: number, horizontalRadius: number): boolean {
  for (let i = 0; i < 25; i += 5) {
    const projectedHeight = Math.abs(nx * planes[i] + ny * planes[i + 1] + nz * planes[i + 2]) * halfHeight;
    if (position.x * planes[i] + position.y * planes[i + 1] + position.z * planes[i + 2] + planes[i + 3] + projectedHeight < -horizontalRadius * planes[i + 4]) return true;
  }
  return false;
}

function sameTrajectory(a: { start: Vec3; end: Vec3 }, b: { start: Vec3; end: Vec3 }): boolean {
  return a.start.x === b.start.x && a.start.y === b.start.y && a.start.z === b.start.z
    && a.end.x === b.end.x && a.end.y === b.end.y && a.end.z === b.end.z;
}

function pointOutcode(view: ImageryView, point: Vec3): number {
  const m = view.ecefToClip;
  const x = point.x * m[0] + point.y * m[4] + point.z * m[8] + m[12];
  const y = point.x * m[1] + point.y * m[5] + point.z * m[9] + m[13];
  const z = point.x * m[2] + point.y * m[6] + point.z * m[10] + m[14];
  const w = point.x * m[3] + point.y * m[7] + point.z * m[11] + m[15];
  let code = 0;
  if (x < -w) code |= 1;
  if (x > w) code |= 2;
  if (y < -w) code |= 4;
  if (y > w) code |= 8;
  if (z * view.nearPlane.z + w * view.nearPlane.w < 0) code |= 16;
  return code;
}

function hullRadius(): number {
  let radius = 0;
  for (let i = 0; i < hullScratch.length; i += 3) {
    radius = Math.max(radius, Math.hypot(hullScratch[i] - centerScratch.x, hullScratch[i + 1] - centerScratch.y, hullScratch[i + 2] - centerScratch.z));
  }
  return radius * 1.1;
}

function groundDistance(tile: TileId, bounds: { min: number; max: number }, position: Vec3, altitude: number, world: { x: number; y: number }): number {
  const nearest = nearestLocal(tile, world);
  const u = nearest.u, v = nearest.v;
  const height = Math.min(bounds.max, Math.max(lowestGround(bounds, altitude), altitude));
  let result = distance(positionOnTileBasis(fillBasis(tile, u, v), height, positionScratch), position);
  for (let i = 0; i < 9; i++) {
    const basis = fillBasis(tile, (i % 3) / 2, Math.floor(i / 3) / 2);
    const sample = positionOnTileBasis(basis, height, positionScratch);
    if (!cannotImproveDistance(sample, position, result)) result = Math.min(result, distance(sample, position));
  }
  return result;
}

interface PreparedCapsule {
  start: Vec3;
  dx: number;
  dy: number;
  dz: number;
  lengthSquared: number;
  minAltitude: number;
  startWorld: { x: number; y: number };
  endWorld: { x: number; y: number };
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

function prepareCapsule(start: Vec3, end: Vec3, radius: number, height: number): PreparedCapsule {
  const a = ecefToGeodetic(start.x, start.y, start.z);
  const stationary = start.x === end.x && start.y === end.y && start.z === end.z;
  const b = stationary ? a : ecefToGeodetic(end.x, end.y, end.z);
  const startWorld = lonLatToMercator(a.lonRad * 180 / Math.PI, a.latRad * 180 / Math.PI);
  const endWorld = stationary ? startWorld : lonLatToMercator(b.lonRad * 180 / Math.PI, b.latRad * 180 / Math.PI);
  // Keep the trajectory continuous when it crosses longitude +/-180 degrees.
  if (endWorld.x - startWorld.x > 0.5) endWorld.x -= 1;
  if (endWorld.x - startWorld.x < -0.5) endWorld.x += 1;
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const center = stationary ? a : ecefToGeodetic((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
  // A sphere around the segment's midpoint conservatively contains the whole
  // capsule, including its vertical band. Bound its projection once, not per tile.
  const angular = Math.min(Math.PI, (Math.sqrt(lengthSquared) / 2 + Math.hypot(radius, height)) / Math.max(1, 6_300_000 + Math.min(0, center.altMeters)));
  const minLat = Math.max(-Math.PI / 2, center.latRad - angular);
  const maxLat = Math.min(Math.PI / 2, center.latRad + angular);
  const centerU = ((center.lonRad / (2 * Math.PI) + 0.5) % 1 + 1) % 1;
  const deltaU = Math.abs(minLat) === Math.PI / 2 || Math.abs(maxLat) === Math.PI / 2
    ? 1 : Math.min(1, angular / (2 * Math.PI * Math.cos(Math.max(Math.abs(minLat), Math.abs(maxLat)))));
  return {
    start, dx, dy, dz, lengthSquared,
    minAltitude: Math.min(a.altMeters, b.altMeters), startWorld, endWorld,
    minU: centerU - deltaU, maxU: centerU + deltaU,
    minV: lonLatToMercator(0, maxLat * 180 / Math.PI).y,
    maxV: lonLatToMercator(0, minLat * 180 / Math.PI).y,
  };
}

function capsuleIntersectsTile(capsule: PreparedCapsule, tile: TileId): boolean {
  const n = 2 ** tile.z;
  const minU = tile.x / n, maxU = (tile.x + 1) / n;
  return tile.y / n <= capsule.maxV && (tile.y + 1) / n >= capsule.minV
    && ((maxU >= capsule.minU && minU <= capsule.maxU)
      || (maxU + 1 >= capsule.minU && minU + 1 <= capsule.maxU)
      || (maxU - 1 >= capsule.minU && minU - 1 <= capsule.maxU));
}

/** Nearest tile-local point to the projected path; includes crossings between its endpoints. */
function capsuleNearestLocal(capsule: PreparedCapsule, tile: TileId): typeof localScratch {
  const n = 2 ** tile.z;
  let ax = capsule.startWorld.x * n - tile.x;
  if (ax > n / 2) ax -= n;
  if (ax < -n / 2) ax += n;
  const ay = capsule.startWorld.y * n - tile.y;
  const dx = (capsule.endWorld.x - capsule.startWorld.x) * n;
  const dy = (capsule.endWorld.y - capsule.startWorld.y) * n;
  let enter = 0, exit = 1;
  if (dx === 0) {
    if (ax < 0 || ax > 1) exit = -1;
  } else {
    const a = -ax / dx, b = (1 - ax) / dx;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  if (dy === 0) {
    if (ay < 0 || ay > 1) exit = -1;
  } else {
    const a = -ay / dy, b = (1 - ay) / dy;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  if (enter <= exit) {
    const t = (enter + exit) / 2;
    localScratch.u = Math.max(0, Math.min(1, ax + dx * t));
    localScratch.v = Math.max(0, Math.min(1, ay + dy * t));
    return localScratch;
  }
  let best = Infinity, bestU = 0, bestV = 0;
  const lengthSquared = dx * dx + dy * dy;
  // The closest pair lies at an endpoint or the projection of a rectangle corner.
  for (let i = 0; i < 6; i++) {
    const cornerU = i % 2, cornerV = Math.floor(i / 2) % 2;
    const t = i < 2 ? i : lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((cornerU - ax) * dx + (cornerV - ay) * dy) / lengthSquared));
    const x = ax + dx * t, y = ay + dy * t;
    const u = Math.max(0, Math.min(1, x)), v = Math.max(0, Math.min(1, y));
    const d = (x - u) ** 2 + (y - v) ** 2;
    if (d < best) { best = d; bestU = u; bestV = v; }
  }
  localScratch.u = bestU;
  localScratch.v = bestV;
  return localScratch;
}

/** Exact segment-to-segment distance to one sampled vertical terrain interval. */
function measureCapsuleSample(capsule: PreparedCapsule, basis: TileSurfaceBasis, low: number, high: number, sampleIndex: number): void {
  const point = positionOnTileBasis(basis, low, positionScratch);
  const nx = basis.cosLat * basis.cosLon, ny = basis.cosLat * basis.sinLon, nz = basis.sinLat;
  const range = high - low;
  const vx = nx * range, vy = ny * range, vz = nz * range;
  const rx = capsule.start.x - point.x, ry = capsule.start.y - point.y, rz = capsule.start.z - point.z;
  const a = capsule.lengthSquared, e = vx * vx + vy * vy + vz * vz;
  const c = capsule.dx * rx + capsule.dy * ry + capsule.dz * rz;
  const f = vx * rx + vy * ry + vz * rz;
  let t = 0, s = 0;
  if (a <= 1e-12) {
    if (e > 1e-12) s = Math.max(0, Math.min(1, f / e));
  } else if (e <= 1e-12) {
    t = Math.max(0, Math.min(1, -c / a));
  } else {
    const b = capsule.dx * vx + capsule.dy * vy + capsule.dz * vz;
    const denominator = a * e - b * b;
    if (denominator > 0) t = Math.max(0, Math.min(1, (b * f - c * e) / denominator));
    s = (b * t + f) / e;
    if (s < 0) { s = 0; t = Math.max(0, Math.min(1, -c / a)); }
    else if (s > 1) { s = 1; t = Math.max(0, Math.min(1, (b - c) / a)); }
  }
  const dx = rx + capsule.dx * t - vx * s;
  const dy = ry + capsule.dy * t - vy * s;
  const dz = rz + capsule.dz * t - vz * s;
  if (Math.abs(dx) > proximityScratch.distance || Math.abs(dy) > proximityScratch.distance || Math.abs(dz) > proximityScratch.distance) return;
  const nearest = Math.hypot(dx, dy, dz);
  if (nearest < proximityScratch.distance || (nearest === proximityScratch.distance && sampleIndex < proximityScratch.sampleIndex)) {
    const vertical = Math.abs(dx * nx + dy * ny + dz * nz);
    proximityScratch.distance = nearest;
    proximityScratch.horizontal = Math.sqrt(Math.max(0, nearest * nearest - vertical * vertical));
    proximityScratch.vertical = vertical;
    proximityScratch.sampleIndex = sampleIndex;
  }
}

/**
 * Chooses the terrain tiles to show: from the root level, a tile splits while
 * its geometric error, projected from the camera, exceeds the target. Tiles
 * the camera cannot see (outside the view or below the horizon) stay as they
 * are. With a refine point, the tiles the camera sees are measured from it,
 * never nearer than the camera is to it. Around a focus point, tiles within
 * the radius are measured from the point instead, in every direction and
 * never nearer than the camera is to it, so turning the camera changes nothing
 * there; with the view as well, a tile takes the finer of the two.
 */
export function selectTerrain(input: TerrainSelectionInput): TerrainSelection {
  initializeGeometryCache();
  const { view, focus } = input;
  const pixelAngle = view?.pixelAngle ?? (view ? 1 / view.renderHeight : 0);
  const cameraGeo = view ? ecefToGeodetic(view.camera.x, view.camera.y, view.camera.z) : null;
  const camera = cameraGeo && { lonDeg: (cameraGeo.lonRad * 180) / Math.PI, latDeg: (cameraGeo.latRad * 180) / Math.PI };
  const cameraWorld = camera && lonLatToMercator(camera.lonDeg, camera.latDeg);
  const focusGeo = focus ? ecefToGeodetic(focus.position.x, focus.position.y, focus.position.z) : null;
  const focusLonLat = focusGeo && { lonDeg: (focusGeo.lonRad * 180) / Math.PI, latDeg: (focusGeo.latRad * 180) / Math.PI };
  const focusWorld = focusLonLat && lonLatToMercator(focusLonLat.lonDeg, focusLonLat.latDeg);
  const focusViewer = focus && (() => {
    const lift = 1 + focus.minDistanceMeters / (Math.hypot(focus.position.x, focus.position.y, focus.position.z) || 1);
    return { x: focus.position.x * lift, y: focus.position.y * lift, z: focus.position.z * lift };
  })();
  const refine = input.refineFrom ?? null;
  const refineGeo = refine ? ecefToGeodetic(refine.position.x, refine.position.y, refine.position.z) : null;
  const refineLonLat = refineGeo && { lonDeg: (refineGeo.lonRad * 180) / Math.PI, latDeg: (refineGeo.latRad * 180) / Math.PI };
  const refineWorld = refineLonLat && lonLatToMercator(refineLonLat.lonDeg, refineLonLat.latDeg);
  const proximity = input.proximity ?? (input.robustOrbitLOD && view
    ? { ...TERRAIN_PROXIMITY_DEFAULTS, start: view.camera, end: view.camera } : null);
  const capsules = proximity ? [prepareCapsule(proximity.start, proximity.end, proximity.radiusMeters, proximity.heightMeters)] : [];
  if (proximity?.secondary && !sameTrajectory(proximity, proximity.secondary)) capsules.push(prepareCapsule(proximity.secondary.start, proximity.secondary.end, proximity.radiusMeters, proximity.heightMeters));
  const clipPlanes = proximity && view ? prepareClipPlanes(view) : null;
  const focusCoverage = proximity && focus ? prepareCapsule(focus.position, focus.position, focus.radiusMeters, 0) : null;
  const m = view?.ecefToClip;
  // Perspective clip W is distance along the camera's forward axis. In an
  // orthographic projection, clip Z carries that direction instead.
  let forwardX = proximity?.forward?.x ?? m?.[3] ?? 0;
  let forwardY = proximity?.forward?.y ?? m?.[7] ?? 0;
  let forwardZ = proximity?.forward?.z ?? m?.[11] ?? 0;
  let forwardLength = Math.hypot(forwardX, forwardY, forwardZ);
  if (forwardLength === 0 && m) {
    forwardX = m[2]; forwardY = m[6]; forwardZ = m[10];
    forwardLength = Math.hypot(forwardX, forwardY, forwardZ);
  }
  if (forwardLength > 0) { forwardX /= forwardLength; forwardY /= forwardLength; forwardZ /= forwardLength; }
  let nodes = 0;

  function measure(tile: TileId): Measured {
    nodes += 1;
    const key = cachedTileKey(tile);
    const result: Measured = { tile, key, needed: false, distanceMeters: Infinity, errorPx: 0 };
    if (proximity) { result.inFrustum = false; result.inProximity = false; result.inCore = false; }
    if (!view || pixelAngle <= 0) return result;
    const bounds = input.boundsFor(tile);
    prepareTileGeometry(tile, key);
    const error = geometrySlot < 0 ? terrainTileErrorMeters(tile, input.segments, input.errorPerSpacing)
      : input.errorPerSpacing * geometryWidths[geometrySlot] / input.segments;
    const span = geometrySlot < 0 ? tileAngularSpan(tile) : geometrySpans[geometrySlot];
    const lift = geometrySlot < 0 ? sagittaMeters(span / 2) : geometryLifts[geometrySlot];

    if (proximity || focus?.mode !== "around") {
      const low = lowestGround(bounds, cameraGeo!.altMeters);
      let sphereHidden = false;
      if (clipPlanes && geometrySlot >= 0) {
        const high = bounds.max + lift;
        const basis = fillBasis(tile, 0.5, 0.5);
        const center = positionOnTileBasis(basis, (low + high) / 2, positionScratch);
        // Bound the whole curved height interval with its maximum surface
        // derivative, then its height half-range. The millimetre margin keeps
        // floating point rounding conservative at clip-plane boundaries.
        const horizontalRadius = (WGS84_A / (1 - WGS84_E2) + Math.max(Math.abs(low), Math.abs(high))) * geometryRadiusAngles[geometrySlot] + 0.001;
        const halfHeight = (high - low) / 2;
        sphereHidden = verticalIntervalOutsideClipPlanes(clipPlanes, center, basis.cosLat * basis.cosLon, basis.cosLat * basis.sinLon, basis.sinLat, halfHeight, horizontalRadius)
          || (span < TERRAIN_SELECTION_CONSTANTS.horizonTileSpan && isSphereBelowHorizon(view.camera, center, horizontalRadius + halfHeight));
      }
      if (!sphereHidden) {
        const nearest = nearestLocal(tile, cameraWorld!);
        const nearestU = nearest.u, nearestV = nearest.v;
        const groundHeight = Math.min(bounds.max, Math.max(low, cameraGeo!.altMeters));
        let allOutside = 0b11111;
        let anyAboveHorizon = false;
        const nearestPosition = positionOnTileBasis(fillBasis(tile, nearestU, nearestV), groundHeight, positionScratch);
        let nearestDistance = distance(nearestPosition, view.camera);
        let centerX = 0, centerY = 0, centerZ = 0;
        let nearestX = nearestPosition.x, nearestY = nearestPosition.y, nearestZ = nearestPosition.z;
        let nearestIndex = 9;
        for (let i = 0; i < 10; i++) {
          // One latitude and longitude for the hull's two heights and the ground.
          const basis = fillBasis(tile, i < 9 ? (i % 3) / 2 : nearestU, i < 9 ? Math.floor(i / 3) / 2 : nearestV);
          for (let j = 0; j < 2; j++) {
            const position = positionOnTileBasis(basis, j === 0 ? low : bounds.max + lift, positionScratch);
            const offset = i * 6 + j * 3;
            hullScratch[offset] = position.x; hullScratch[offset + 1] = position.y; hullScratch[offset + 2] = position.z;
            centerX += position.x / 20; centerY += position.y / 20; centerZ += position.z / 20;
            if (allOutside !== 0) allOutside &= pointOutcode(view, position);
            if (!anyAboveHorizon && !isBelowHorizon(view.camera, position)) anyAboveHorizon = true;
          }
          if (i < 9) {
            const position = positionOnTileBasis(basis, groundHeight, positionScratch);
            if (!cannotImproveDistance(position, view.camera, nearestDistance)) {
              const d = distance(position, view.camera);
              if (d < nearestDistance || (d === nearestDistance && i < nearestIndex)) {
                nearestDistance = d;
                nearestX = position.x; nearestY = position.y; nearestZ = position.z;
                nearestIndex = i;
              }
            }
          }
        }
        centerScratch.x = centerX; centerScratch.y = centerY; centerScratch.z = centerZ;
        const hidden = allOutside !== 0
          || (!anyAboveHorizon && span < TERRAIN_SELECTION_CONSTANTS.horizonTileSpan)
          || isSphereBelowHorizon(view.camera, centerScratch, hullRadius());
        if (proximity) result.inFrustum = !hidden;
        if (!hidden && focus?.mode !== "around" && refine) {
          // Seen by the camera, measured from the point: its distance alone sets the level.
          const nearest = groundDistance(tile, bounds, refine.position, refineGeo!.altMeters, refineWorld!);
          result.needed = true;
          result.distanceMeters = nearest;
          result.errorPx = error / (Math.max(1, nearest, refine.minDistanceMeters) * pixelAngle);
        } else if (!hidden && focus?.mode !== "around") {
          result.needed = true;
          result.distanceMeters = nearestDistance;
          result.errorPx = error / (Math.max(1, nearestDistance) * pixelAngle);
        }
        if (proximity && result.needed) {
          let gaze = 1;
          if (proximity.losGazeExponent > 0 && nearestDistance > 0) {
            const cosTheta = ((nearestX - view.camera.x) * forwardX + (nearestY - view.camera.y) * forwardY + (nearestZ - view.camera.z) * forwardZ) / nearestDistance;
            gaze = Math.max(proximity.losPeripheralFloor, Math.min(1, Math.max(0, cosTheta)) ** proximity.losGazeExponent);
          }
          result.errorPx *= proximity.losWeight * gaze;
        }
      }
    }

    if (focus && focusLonLat && focusViewer && (!focusCoverage || capsuleIntersectsTile(focusCoverage, tile))) {
      const nearestPoint = nearestLocal(tile, focusWorld!);
      const nearestU = nearestPoint.u, nearestV = nearestPoint.v;
      const low = lowestGround(bounds, focusGeo!.altMeters);
      const groundHeight = Math.min(bounds.max, Math.max(low, focusGeo!.altMeters));
      let nearest = distance(positionOnTileBasis(fillBasis(tile, nearestU, nearestV), groundHeight, positionScratch), focus.position);
      let centerX = 0, centerY = 0, centerZ = 0;
      for (let i = 0; i < 10; i++) {
        const basis = fillBasis(tile, i < 9 ? (i % 3) / 2 : nearestU, i < 9 ? Math.floor(i / 3) / 2 : nearestV);
        if (i < 9) {
          const position = positionOnTileBasis(basis, groundHeight, positionScratch);
          if (!cannotImproveDistance(position, focus.position, nearest)) nearest = Math.min(nearest, distance(position, focus.position));
        }
        if (focus.horizonCull) for (let j = 0; j < 2; j++) {
          const position = positionOnTileBasis(basis, j === 0 ? low : bounds.max + lift, positionScratch);
          const offset = i * 6 + j * 3;
          hullScratch[offset] = position.x; hullScratch[offset + 1] = position.y; hullScratch[offset + 2] = position.z;
          centerX += position.x / 20; centerY += position.y / 20; centerZ += position.z / 20;
        }
      }
      let within = nearest <= focus.radiusMeters;
      if (within && focus.horizonCull) {
        centerScratch.x = centerX; centerScratch.y = centerY; centerScratch.z = centerZ;
        if (isSphereBelowHorizon(focusViewer, centerScratch, hullRadius())) within = false;
      }
      if (within) {
        const errorPx = error / (Math.max(1, nearest, focus.minDistanceMeters) * pixelAngle);
        result.needed = true;
        if (errorPx >= result.errorPx) {
          result.errorPx = errorPx;
          result.distanceMeters = Math.min(result.distanceMeters, nearest);
        }
      }
    }
    if (proximity) {
      let proximityError = 0;
      for (let anchor = 0; anchor < capsules.length; anchor++) {
        const capsule = capsules[anchor];
        // This constant-time wrapped Mercator rejection also handles hidden
        // tiles, before any capsule/surface distance work is attempted.
        if (!capsuleIntersectsTile(capsule, tile)) continue;
        const nearest = capsuleNearestLocal(capsule, tile);
        const u = nearest.u, v = nearest.v;
        proximityScratch.distance = Infinity;
        proximityScratch.horizontal = Infinity;
        proximityScratch.vertical = Infinity;
        proximityScratch.sampleIndex = 10;
        const low = lowestGround(bounds, capsule.minAltitude);
        for (let sample = 0; sample < 10; sample++) {
          const i = sample === 0 ? 9 : sample - 1;
          const basis = fillBasis(tile, i < 9 ? (i % 3) / 2 : u, i < 9 ? Math.floor(i / 3) / 2 : v);
          measureCapsuleSample(capsule, basis, low, bounds.max, i);
        }
        const dh = proximityScratch.horizontal, dv = proximityScratch.vertical;
        if (dh > proximity.radiusMeters || dv > proximity.heightMeters) continue;
        const uh = Math.max(0, Math.min(1, (dh - proximity.coreMeters) / Math.max(1, proximity.radiusMeters - proximity.coreMeters)));
        const uv = Math.max(0, Math.min(1, dv / Math.max(1, proximity.heightMeters)));
        const falloff = (1 - uh ** proximity.falloffExponent) * (1 - uv ** proximity.falloffExponent);
        proximityError = Math.max(proximityError, proximity.proximityWeight * falloff * error / (Math.max(1, proximityScratch.distance) * pixelAngle));
        result.needed = true;
        result.inProximity = true;
        result.inCore ||= dh <= proximity.coreMeters;
        result.distanceMeters = Math.min(result.distanceMeters, proximityScratch.distance);
      }
      result.errorPx = blendTerrainErrors(result.errorPx, proximityError, proximity.blendMode, proximity.blendPower);
    }
    return result;
  }

  const root = Math.max(input.minLevel, Math.min(TERRAIN_SELECTION_CONSTANTS.rootLevel, input.maxLevel));
  const count = 2 ** root;
  const heap: Measured[] = [];
  const higherPriority = (a: Measured, b: Measured): boolean => Boolean(a.inCore) !== Boolean(b.inCore) ? Boolean(a.inCore) : a.errorPx > b.errorPx;
  const push = (item: Measured): void => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!higherPriority(heap[index], heap[parent])) break;
      const swap = heap[parent]; heap[parent] = heap[index]; heap[index] = swap;
      index = parent;
    }
  };
  const pop = (): Measured | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1, right = left + 1;
        let largest = index;
        if (left < heap.length && higherPriority(heap[left], heap[largest])) largest = left;
        if (right < heap.length && higherPriority(heap[right], heap[largest])) largest = right;
        if (largest === index) break;
        const swap = heap[largest]; heap[largest] = heap[index]; heap[index] = swap;
        index = largest;
      }
    }
    return top;
  };
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) push(measure({ z: root, x, y }));

  const leaves: Measured[] = [];
  const split = new Set<string>();
  let leafCount = count * count;
  let truncated = false;
  const previous = input.previous;
  for (let node = pop(); node; node = pop()) {
    const threshold = previous?.split.has(node.key) ? input.hysteresis.coarsenBelow
      : previous?.leaves.has(node.key) ? input.hysteresis.refineAbove : 1;
    const wants = node.tile.z < input.maxLevel && ((node.needed && node.errorPx > input.targetPx * threshold)
      || (node.inCore && node.tile.z < Math.min(input.maxLevel, proximity!.minProximityZoom)));
    if (wants && leafCount + 3 > input.maxTiles) truncated = true;
    if (!wants || leafCount + 3 > input.maxTiles) {
      leaves.push(node);
      continue;
    }
    split.add(node.key);
    leafCount += 3;
    const { z, x, y } = node.tile;
    for (let child = 0; child < 4; child++) {
      push(measure({ z: z + 1, x: x * 2 + child % 2, y: y * 2 + Math.floor(child / 2) }));
    }
  }
  leaves.sort((a, b) => Number(b.needed) - Number(a.needed) || a.distanceMeters - b.distanceMeters);
  return {
    leaves,
    split,
    rootLevel: root,
    truncated,
    nodes,
  };
}
