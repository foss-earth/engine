import { Vector3 } from "@babylonjs/core";
import { ecefToGeodetic, geodeticToEcef, DEG_TO_RAD, WGS84_A } from "../camera/cameraMath.js";
import { tileLatDeg, tileLonDeg, type TileId } from "../terrain/imagery/imageryGeometry.js";
import type { TerrainRegion, TerrainRegionDetail } from "../surface/terrainRegion.js";

export interface TerrainRegionDemand {
  region: TerrainRegion;
  minimum: TerrainRegionDetail;
  final: TerrainRegionDetail;
  /** Conservative spheres covering the volume; first is the exact aircraft sphere. */
  bounds: readonly { center: Vector3; altitudeMeters: number; radiusMeters: number; priority: number }[];
  /** Minimum-detail center-height discovery, separate from the formal safe volume. */
  supportBounds: TerrainRegionDemand["bounds"];
  supportRequired: boolean;
}

/**
 * Receives the box around a map tile a region still waits for: eight ECEF
 * points, the corner with index bit 4 set at the box's x maximum, bit 2 its
 * y and bit 1 its z, as 3d-tiles-renderer's OBB orders them. Copy what is kept.
 */
export type TerrainRegionOutlineSink = (corners: readonly { x: number; y: number; z: number }[]) => void;

/** Use Babylon vectors to assemble temporary loading volumes; no camera or settings writes. */
export function createTerrainRegionDemand(region: TerrainRegion, minimum: TerrainRegionDetail, final: TerrainRegionDetail): TerrainRegionDemand {
  const point = geodeticToEcef(region.center.latDeg * DEG_TO_RAD, region.center.lonDeg * DEG_TO_RAD, region.center.altitudeMeters);
  const center = new Vector3(point.x, point.y, point.z);
  const bounds = [{ center, altitudeMeters: region.center.altitudeMeters, radiusMeters: region.radiusMeters, priority: 0 }];
  if (region.cone && region.cone.lengthMeters > 0) {
    const cone = region.cone;
    const direction = new Vector3(cone.directionEcef.x, cone.directionEcef.y, cone.directionEcef.z).normalize();
    // Each sphere encloses a complete cone slice, including its end disks.
    // Their union conservatively covers the continuous cone, rather than sampling its axis.
    const slices = 16, step = cone.lengthMeters / slices;
    for (let i = 0; i < slices; i++) {
      const reach = (i + 1) * step;
      const sliceCenter = center.add(direction.scale(reach - step / 2));
      bounds.push({ center: sliceCenter, altitudeMeters: ecefToGeodetic(sliceCenter.x, sliceCenter.y, sliceCenter.z).altMeters,
        radiusMeters: Math.hypot(step / 2, reach * Math.tan(cone.halfAngleDeg * DEG_TO_RAD)), priority: (i + 1) / slices });
    }
  }
  // A narrow vertical support column finds the center height even when an
  // absolute provisional spawn is far above/below the actual surface. It is
  // streamed only at minimum detail, and is not evidence for the safe volume.
  const supportBounds = [];
  const low = -12_000, high = 12_000, count = 32, step = (high - low) / count;
  for (let i = 0; i < count; i++) {
    const point = geodeticToEcef(region.center.latDeg * DEG_TO_RAD, region.center.lonDeg * DEG_TO_RAD, low + (i + .5) * step);
    supportBounds.push({ center: new Vector3(point.x, point.y, point.z), altitudeMeters: low + (i + .5) * step, radiusMeters: Math.hypot(step / 2, 1), priority: 0 });
  }
  return { region, minimum, final, bounds, supportBounds, supportRequired: true };
}

/** null excludes a tile; 0 prioritizes the aircraft, then increasing cone arrival distance. */
export function terrainRegionPriority(demand: TerrainRegionDemand, distanceToPoint: (point: Vector3) => number, heights?: { min: number; max: number }): number | null {
  let priority: number | null = null;
  for (const bound of demand.bounds) {
    // Geodetic height is distance along the ellipsoid normal: changing it by
    // more than a sphere's radius is outside that sphere. A metre of margin
    // covers conversion rounding. Unknown/wide terrain ranges still refine.
    if (heights && bound.altitudeMeters - bound.radiusMeters > heights.max + 1) continue;
    if (distanceToPoint(bound.center) <= bound.radiusMeters) {
      priority = Math.min(priority ?? Infinity, bound.priority);
      if (priority === 0) break;
    }
  }
  return priority;
}

export function terrainRegionSpherePriority(demand: TerrainRegionDemand, center: { x: number; y: number; z: number }, radius: number, heights?: { min: number; max: number }): number | null {
  const point = new Vector3(center.x, center.y, center.z);
  return terrainRegionPriority(demand, location => Math.max(0, Vector3.Distance(location, point) - radius), heights);
}

/** Conservative curved geographic cell bounds, including its full height interval. */
export function terrainRegionTilePriority(demand: TerrainRegionDemand, tile: TileId, heights: { min: number; max: number }): number | null {
  const north = tileLatDeg(tile.z, tile.y), south = tileLatDeg(tile.z, tile.y + 1);
  const west = tileLonDeg(tile.z, tile.x), east = tileLonDeg(tile.z, tile.x + 1);
  const center = geodeticToEcef((north + south) / 2 * DEG_TO_RAD, (east + west) / 2 * DEG_TO_RAD, (heights.min + heights.max) / 2);
  // The sum of latitude/longitude arc lengths bounds every curved point in
  // this cell, including dateline cells, at any allowed terrain height.
  const radius = (WGS84_A * 1.01 + Math.max(Math.abs(heights.min), Math.abs(heights.max)))
    * (north - south + east - west) / 2 * DEG_TO_RAD + (heights.max - heights.min) / 2;
  return terrainRegionSpherePriority(demand, center, radius, heights);
}

/** A geographic cell's corners in `TerrainRegionOutlineSink` order: west/east, south/north, its lowest/highest ground. */
export function terrainRegionCellCorners(tile: TileId, heights: { min: number; max: number }): { x: number; y: number; z: number }[] {
  const west = tileLonDeg(tile.z, tile.x), east = tileLonDeg(tile.z, tile.x + 1);
  const north = tileLatDeg(tile.z, tile.y), south = tileLatDeg(tile.z, tile.y + 1);
  const corners = [];
  for (const lon of [west, east]) for (const lat of [south, north]) for (const height of [heights.min, heights.max]) {
    corners.push(geodeticToEcef(lat * DEG_TO_RAD, lon * DEG_TO_RAD, height));
  }
  return corners;
}

export function terrainRegionSupportPriority(demand: TerrainRegionDemand, distanceToPoint: (point: Vector3) => number): number | null {
  return demand.supportRequired && demand.supportBounds.some(bound => distanceToPoint(bound.center) <= bound.radiusMeters) ? 0 : null;
}

export function terrainRegionSupportTilePriority(demand: TerrainRegionDemand, tile: TileId, heights: { min: number; max: number }): number | null {
  if (!demand.supportRequired) return null;
  return terrainRegionTilePriority({ ...demand, bounds: demand.supportBounds }, tile, heights);
}
