/**
 * Shows an aircraft's loading region in the world (`TerrainRegionLease.setVisible`):
 * its sphere as a faint shell with rings about the local vertical, its cone as
 * rings and lines from the aircraft, and an amber box around each map tile its
 * final detail still waits for. The map surface inside the region is tinted
 * red by the map materials' highlight (terrainRegionHighlight.ts).
 *
 * Nothing here is pickable or part of the map surface, so it changes neither
 * collisions nor readiness. Its meshes stand in the map's own coordinates,
 * under the host's world root when there is one, relative to the region's
 * center, so they follow the world without per-frame work.
 */
import { Color3, CreateLineSystem, CreateSphere, StandardMaterial, TransformNode, Vector3, type LinesMesh, type Mesh, type Scene } from "@babylonjs/core";
import { DEG_TO_RAD } from "../camera/cameraMath.js";
import type { TerrainRegionDisplay } from "../surface/terrainRegionController.js";
import { setTerrainRegionHighlight } from "./terrainRegionHighlight.js";

const ZONE = new Color3(0.25, 0.85, 1), PENDING = new Color3(1, 0.68, 0.12);
/** The sphere's shell: just enough to see its shape against the map. */
const SHELL_ALPHA = 0.07;
/** The most tile boxes drawn, the smallest first. */
export const TERRAIN_REGION_OVERLAY_MAX_BOXES = 512;
const RING_SEGMENTS = 48;

type Point = { x: number; y: number; z: number };

export interface TerrainRegionOverlay {
  /**
   * Shows the first of these regions, or nothing for none. Called before the
   * frame is drawn, after the host has placed the world.
   */
  update(displays: readonly TerrainRegionDisplay[]): void;
  dispose(): void;
}

export interface TerrainRegionOverlayOptions {
  /** The node whose local space is the map's (ECEF), or null when the scene's is. */
  parent: TransformNode | null;
  /** A map (ECEF) point in the scene's coordinates this frame. */
  ecefToScene(point: Point): Vector3;
}

/** Unit vectors in ECEF at a place: east, north and up. */
function localAxes(latDeg: number, lonDeg: number): { east: Vector3; north: Vector3; up: Vector3 } {
  const lat = latDeg * DEG_TO_RAD, lon = lonDeg * DEG_TO_RAD;
  const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  const east = new Vector3(-Math.sin(lon), Math.cos(lon), 0);
  return { east, north: Vector3.Cross(up, east), up };
}

/** Rings at five heights and eight half-circles from bottom to top, about the local vertical. */
export function terrainRegionSphereLines(region: TerrainRegionDisplay["demand"]["region"]): Vector3[][] {
  const { east, north, up } = localAxes(region.center.latDeg, region.center.lonDeg);
  const r = region.radiusMeters;
  const at = (azimuth: number, elevation: number): Vector3 => north.scale(Math.cos(azimuth) * Math.cos(elevation) * r)
    .addInPlace(east.scale(Math.sin(azimuth) * Math.cos(elevation) * r)).addInPlace(up.scale(Math.sin(elevation) * r));
  const lines: Vector3[][] = [];
  for (const elevationDeg of [-60, -30, 0, 30, 60]) {
    lines.push(Array.from({ length: RING_SEGMENTS + 1 }, (_, i) => at(i / RING_SEGMENTS * 2 * Math.PI, elevationDeg * DEG_TO_RAD)));
  }
  for (let k = 0; k < 8; k++) {
    lines.push(Array.from({ length: RING_SEGMENTS / 2 + 1 }, (_, i) => at(k / 8 * 2 * Math.PI, (i / (RING_SEGMENTS / 2) - 0.5) * Math.PI)));
  }
  return lines;
}

/** Rings at a third, two thirds and the end of the cone, and eight lines from its apex to its end. */
export function terrainRegionConeLines(region: TerrainRegionDisplay["demand"]["region"]): Vector3[][] {
  const cone = region.cone;
  if (!cone || !(cone.lengthMeters > 0)) return [];
  const axis = new Vector3(cone.directionEcef.x, cone.directionEcef.y, cone.directionEcef.z).normalize();
  const { east, up } = localAxes(region.center.latDeg, region.center.lonDeg);
  // Any unit vector across the axis: across the vertical, or across east for a vertical cone.
  const across = Vector3.Cross(axis, Math.abs(Vector3.Dot(axis, up)) < 0.99 ? up : east).normalize();
  const other = Vector3.Cross(axis, across);
  const tan = Math.tan(cone.halfAngleDeg * DEG_TO_RAD);
  const at = (distance: number, angle: number): Vector3 => axis.scale(distance)
    .addInPlace(across.scale(Math.cos(angle) * distance * tan)).addInPlace(other.scale(Math.sin(angle) * distance * tan));
  const lines: Vector3[][] = [];
  for (const fraction of [1 / 3, 2 / 3, 1]) {
    lines.push(Array.from({ length: RING_SEGMENTS + 1 }, (_, i) => at(fraction * cone.lengthMeters, i / RING_SEGMENTS * 2 * Math.PI)));
  }
  for (let k = 0; k < 8; k++) lines.push([Vector3.Zero(), at(cone.lengthMeters, k / 8 * 2 * Math.PI)]);
  return lines;
}

/**
 * The twelve edges of each box, relative to `origin`: corners whose indices
 * differ in one bit, as `TerrainRegionOutlineSink` orders them. At most
 * `TERRAIN_REGION_OVERLAY_MAX_BOXES`, the smallest first.
 */
export function terrainRegionBoxLines(outlines: readonly (readonly Point[])[], origin: Point): Vector3[][] {
  const boxes = outlines.filter(corners => corners.length === 8)
    .map(corners => corners.map(corner => new Vector3(corner.x - origin.x, corner.y - origin.y, corner.z - origin.z)))
    .map(corners => ({ corners, size: Vector3.Distance(corners[0], corners[7]) }))
    .sort((a, b) => a.size - b.size)
    .slice(0, TERRAIN_REGION_OVERLAY_MAX_BOXES);
  const lines: Vector3[][] = [];
  for (const { corners } of boxes) {
    for (let i = 0; i < 8; i++) for (const bit of [4, 2, 1]) if (!(i & bit)) lines.push([corners[i], corners[i | bit]]);
  }
  return lines;
}

export function createTerrainRegionOverlay(scene: Scene, options: TerrainRegionOverlayOptions): TerrainRegionOverlay {
  const root = new TransformNode("terrain-region-overlay", scene);
  root.parent = options.parent;
  root.setEnabled(false);
  const shellMaterial = new StandardMaterial("terrain-region-shell", scene);
  shellMaterial.disableLighting = true;
  shellMaterial.emissiveColor = ZONE;
  shellMaterial.alpha = SHELL_ALPHA;
  // The far side's rings still show through it.
  shellMaterial.disableDepthWrite = true;
  let zone: LinesMesh | null = null, boxes: LinesMesh | null = null, shell: Mesh | null = null;
  let shownDemand: TerrainRegionDisplay["demand"] | null = null, shownRevision = -1, disposed = false;

  const lines = (name: string, points: Vector3[][], color: Color3): LinesMesh | null => {
    if (points.length === 0) return null;
    const mesh = CreateLineSystem(name, { lines: points }, scene);
    mesh.color = color;
    mesh.isPickable = false;
    mesh.parent = root;
    return mesh;
  };
  const clear = (): void => {
    zone?.dispose(); boxes?.dispose(); shell?.dispose(false, false);
    zone = boxes = shell = null;
    shownDemand = null; shownRevision = -1;
  };

  return {
    update(displays) {
      if (disposed) return;
      const display = displays[0];
      if (!display) {
        if (shownDemand) { clear(); root.setEnabled(false); }
        setTerrainRegionHighlight(scene, null);
        return;
      }
      const { demand } = display, center = demand.bounds[0]!.center;
      if (demand !== shownDemand) {
        clear();
        root.position.set(center.x, center.y, center.z);
        zone = lines("terrain-region-zone", [...terrainRegionSphereLines(demand.region), ...terrainRegionConeLines(demand.region)], ZONE);
        shell = CreateSphere("terrain-region-shell", { diameter: 2 * demand.region.radiusMeters, segments: 24 }, scene);
        shell.material = shellMaterial;
        shell.isPickable = false;
        shell.parent = root;
        shownDemand = demand;
      }
      if (display.revision !== shownRevision) {
        boxes?.dispose();
        boxes = lines("terrain-region-pending-tiles", terrainRegionBoxLines(display.outlines, center), PENDING);
        shownRevision = display.revision;
      }
      if (!root.isEnabled()) root.setEnabled(true);
      // The tint is in the scene's coordinates, which follow the world's placement each frame.
      const sceneCenter = options.ecefToScene(center);
      const cone = demand.region.cone;
      let axis: Vector3 | null = null;
      if (cone && cone.lengthMeters > 0) {
        const direction = new Vector3(cone.directionEcef.x, cone.directionEcef.y, cone.directionEcef.z).normalize();
        axis = options.ecefToScene(center.add(direction)).subtractInPlace(sceneCenter).normalize();
      }
      setTerrainRegionHighlight(scene, { center: sceneCenter, radiusMeters: demand.region.radiusMeters,
        ...(cone && axis ? { cone: { axis, lengthMeters: cone.lengthMeters, halfAngleDeg: cone.halfAngleDeg } } : {}) });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      root.dispose();
      shellMaterial.dispose();
      setTerrainRegionHighlight(scene, null);
    },
  };
}
