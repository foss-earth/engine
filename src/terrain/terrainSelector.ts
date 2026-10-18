import { ecefToGeodetic } from "../camera/cameraMath.js";
import {
  isBelowHorizon,
  isSphereBelowHorizon,
  lonLatToMercator,
  outcode,
  sagittaMeters,
  positionOnTileBasis,
  tileAngularSpan,
  tileSurfaceBasis,
  tileSurfacePosition,
  tileKey,
  tileLatDeg,
  toClip,
  type ImageryView,
  type TileId,
  type Vec3,
} from "./imagery/imageryGeometry.js";

const WGS84_A = 6378137;
const GRID = [0, 0.5, 1];
/** The nine sample points of every tile. The tenth, nearest the viewer, is computed per tile. */
const GRID_POINTS = GRID.flatMap(v => GRID.map(u => ({ u, v })));
/** Reused by distance checks. Hull points are kept, so they get their own objects. */
const positionScratch = { x: 0, y: 0, z: 0 };

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

interface Measured {
  tile: TileId;
  key: string;
  needed: boolean;
  distanceMeters: number;
  errorPx: number;
}

/** The point of a tile nearest a point's zoom-0 Mercator position (lonLatToMercator), in tile-local u and v. */
function nearestLocal(tile: TileId, world: { x: number; y: number }): { u: number; v: number } {
  const n = 2 ** tile.z;
  // lonLatToTileXY's bits at this zoom; the point's trigonometry is done once per selection.
  const at = { x: world.x * n, y: world.y * n };
  // Longitude wraps: take the tile-local u nearest the tile's own span.
  let u = at.x - tile.x;
  if (u > n / 2) u -= n;
  if (u < -n / 2) u += n;
  return { u: Math.max(0, Math.min(1, u)), v: Math.max(0, Math.min(1, at.y - tile.y)) };
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

function tileContainsMercator(tile: TileId, world: { x: number; y: number }): boolean {
  const n = 2 ** tile.z;
  const tx = Math.floor(world.x * n);
  const ty = Math.floor(world.y * n);
  const maxCoord = n - 1;
  const clampedTx = Math.max(0, Math.min(maxCoord, tx));
  const clampedTy = Math.max(0, Math.min(maxCoord, ty));
  return tile.x === clampedTx && tile.y === clampedTy;
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
  /** The refine point's distance to a tile's ground, taken at the point's own height within the tile's bounds. */
  const refineDistance = (tile: TileId, bounds: { min: number; max: number }, points: ReadonlyArray<{ u: number; v: number }>): number => {
    const height = Math.min(bounds.max, Math.max(lowestGround(bounds, refineGeo!.altMeters), refineGeo!.altMeters));
    let nearest = Infinity;
    for (const point of [...points, nearestLocal(tile, refineWorld!)]) {
      nearest = Math.min(nearest, distance(tileSurfacePosition(tile, point.u, point.v, height, positionScratch), refine!.position));
    }
    return nearest;
  };
  let nodes = 0;

  function measure(tile: TileId): Measured {
    nodes += 1;
    const key = tileKey(tile);
    const result: Measured = { tile, key, needed: false, distanceMeters: Infinity, errorPx: 0 };
    if (!view || pixelAngle <= 0) return result;
    const error = terrainTileErrorMeters(tile, input.segments, input.errorPerSpacing);
    const bounds = input.boundsFor(tile);
    const span = tileAngularSpan(tile);
    const lift = sagittaMeters(span / 2);

    if (focus?.mode !== "around") {
      const low = lowestGround(bounds, cameraGeo!.altMeters);
      const nearest = nearestLocal(tile, cameraWorld!);
      const groundHeight = Math.min(bounds.max, Math.max(low, cameraGeo!.altMeters));
      let allOutside = 0b11111;
      let anyAboveHorizon = false;
      let nearestDistance = Infinity;
      const hull: Vec3[] = [];
      const visit = (u: number, v: number): void => {
        // One latitude and longitude for the hull's two heights and the ground.
        const basis = tileSurfaceBasis(tile, u, v);
        for (const height of [low, bounds.max + lift]) {
          const position = positionOnTileBasis(basis, height);
          hull.push(position);
          allOutside &= outcode(view, toClip(view.ecefToClip, position));
          if (!anyAboveHorizon && !isBelowHorizon(view.camera, position)) anyAboveHorizon = true;
        }
        nearestDistance = Math.min(nearestDistance, distance(positionOnTileBasis(basis, groundHeight, positionScratch), view.camera));
      };
      for (const point of GRID_POINTS) visit(point.u, point.v);
      visit(nearest.u, nearest.v);
      const center = hull.reduce((sum, p) => ({ x: sum.x + p.x / hull.length, y: sum.y + p.y / hull.length, z: sum.z + p.z / hull.length }), { x: 0, y: 0, z: 0 });
      const radius = Math.max(...hull.map(p => distance(p, center))) * 1.1;
      const underEye = Boolean(
        input.robustOrbitLOD &&
        cameraWorld &&
        tileContainsMercator(tile, cameraWorld) &&
        !isSphereBelowHorizon(view.camera, center, radius)
      );
      const hidden = !underEye && (allOutside !== 0
        || (!anyAboveHorizon && span < TERRAIN_SELECTION_CONSTANTS.horizonTileSpan)
        || isSphereBelowHorizon(view.camera, center, radius));
      if (!hidden && refine) {
        // Seen by the camera, measured from the point: its distance alone sets the level.
        const nearest = refineDistance(tile, bounds, GRID_POINTS);
        result.needed = true;
        result.distanceMeters = nearest;
        result.errorPx = error / (Math.max(1, nearest, refine.minDistanceMeters) * pixelAngle);
      } else if (!hidden) {
        result.needed = true;
        result.distanceMeters = nearestDistance;
        result.errorPx = error / (Math.max(1, nearestDistance) * pixelAngle);
      }
    }

    if (focus && focusLonLat && focusViewer) {
      const nearestPoint = nearestLocal(tile, focusWorld!);
      const low = lowestGround(bounds, focusGeo!.altMeters);
      const groundHeight = Math.min(bounds.max, Math.max(low, focusGeo!.altMeters));
      let nearest = Infinity;
      const hull: Vec3[] = [];
      const visit = (u: number, v: number): void => {
        const basis = tileSurfaceBasis(tile, u, v);
        nearest = Math.min(nearest, distance(positionOnTileBasis(basis, groundHeight, positionScratch), focus.position));
        if (focus.horizonCull) for (const height of [low, bounds.max + lift]) hull.push(positionOnTileBasis(basis, height));
      };
      for (const point of GRID_POINTS) visit(point.u, point.v);
      visit(nearestPoint.u, nearestPoint.v);
      let within = nearest <= focus.radiusMeters;
      if (within && focus.horizonCull) {
        const center = hull.reduce((sum, p) => ({ x: sum.x + p.x / hull.length, y: sum.y + p.y / hull.length, z: sum.z + p.z / hull.length }), { x: 0, y: 0, z: 0 });
        const radius = Math.max(...hull.map(p => distance(p, center))) * 1.1;
        if (isSphereBelowHorizon(focusViewer, center, radius)) within = false;
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
    return result;
  }

  const root = Math.max(input.minLevel, Math.min(TERRAIN_SELECTION_CONSTANTS.rootLevel, input.maxLevel));
  const count = 2 ** root;
  const heap: Measured[] = [];
  const push = (item: Measured): void => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].errorPx >= heap[index].errorPx) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
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
        if (left < heap.length && heap[left].errorPx > heap[largest].errorPx) largest = left;
        if (right < heap.length && heap[right].errorPx > heap[largest].errorPx) largest = right;
        if (largest === index) break;
        [heap[largest], heap[index]] = [heap[index], heap[largest]];
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
    const wants = node.needed && node.errorPx > input.targetPx * threshold && node.tile.z < input.maxLevel;
    if (wants && leafCount + 3 > input.maxTiles) truncated = true;
    if (!wants || leafCount + 3 > input.maxTiles) {
      leaves.push(node);
      continue;
    }
    split.add(node.key);
    leafCount += 3;
    const { z, x, y } = node.tile;
    for (const child of [{ z: z + 1, x: x * 2, y: y * 2 }, { z: z + 1, x: x * 2 + 1, y: y * 2 }, { z: z + 1, x: x * 2, y: y * 2 + 1 }, { z: z + 1, x: x * 2 + 1, y: y * 2 + 1 }]) {
      push(measure(child));
    }
  }
  leaves.sort((a, b) => Number(b.needed) - Number(a.needed) || a.distanceMeters - b.distanceMeters);
  return {
    leaves: leaves.map(({ tile, key, needed, distanceMeters, errorPx }) => ({ tile, key, needed, distanceMeters, errorPx })),
    split,
    rootLevel: root,
    truncated,
    nodes,
  };
}
