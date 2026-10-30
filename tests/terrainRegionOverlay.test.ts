import { NullEngine, Scene, TransformNode, Vector3, type LinesMesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEG_TO_RAD } from "../src/camera/cameraMath.js";
import { createTerrainRegionDemand } from "../src/babylon/terrainRegionBounds.js";
import { getTerrainRegionHighlight } from "../src/babylon/terrainRegionHighlight.js";
import { createTerrainRegionOverlay, TERRAIN_REGION_OVERLAY_MAX_BOXES, terrainRegionBoxLines, terrainRegionConeLines,
  terrainRegionSphereLines } from "../src/babylon/terrainRegionOverlay.js";
import type { TerrainRegionDisplay } from "../src/surface/terrainRegionController.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
function scene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

const detail = { minimum: { googleErrorMeters: 8, rasterZoom: 14 }, final: { googleErrorMeters: 1, rasterZoom: 16 } };
const sphereDemand = () => createTerrainRegionDemand({ center: { latDeg: 45, lonDeg: 10, altitudeMeters: 100 }, radiusMeters: 15 }, detail.minimum, detail.final);
/** A box of 2 × 4 × 8 m in ECEF from `origin`, in outline order. */
const box = (origin: { x: number; y: number; z: number }, scale = 1) => Array.from({ length: 8 }, (_, i) => ({
  x: origin.x + (i & 4 ? 2 : 0) * scale, y: origin.y + (i & 2 ? 4 : 0) * scale, z: origin.z + (i & 1 ? 8 : 0) * scale }));
const linesOf = (target: Scene, name: string) => target.getMeshByName(name) as LinesMesh | null;

describe("the shown region's lines", () => {
  it("draws the sphere's rings level with the ground and its half-circles through the local vertical", () => {
    const region = sphereDemand().region;
    const lines = terrainRegionSphereLines(region);
    expect(lines).toHaveLength(13);
    for (const point of lines.flat()) expect(point.length()).toBeCloseTo(15, 6);
    const lat = 45 * DEG_TO_RAD, lon = 10 * DEG_TO_RAD;
    const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    // The third ring is level with the ground at the center.
    for (const point of lines[2]!) expect(Vector3.Dot(point, up)).toBeCloseTo(0, 6);
    // A half-circle runs from straight below to straight above.
    expect(Vector3.Dot(lines[5]![0]!, up)).toBeCloseTo(-15, 6);
    expect(Vector3.Dot(lines[5]!.at(-1)!, up)).toBeCloseTo(15, 6);
  });

  it("draws the cone's rings across its axis out to its end, and lines from the aircraft to its rim", () => {
    const region = { ...sphereDemand().region, cone: { directionEcef: { x: 0, y: 0, z: 2 }, lengthMeters: 300, halfAngleDeg: 15 } };
    const lines = terrainRegionConeLines(region);
    expect(lines).toHaveLength(11);
    const rim = lines[2]!;
    for (const point of rim) {
      expect(point.z).toBeCloseTo(300, 6);
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(300 * Math.tan(15 * DEG_TO_RAD), 6);
    }
    expect(lines[3]![0]!.length()).toBe(0);
    expect(terrainRegionConeLines(sphereDemand().region)).toEqual([]);
  });

  it("outlines each box by its twelve edges from the region's center, the smallest boxes first", () => {
    const origin = { x: 100, y: 200, z: 300 };
    const lines = terrainRegionBoxLines([box(origin)], origin);
    expect(lines).toHaveLength(12);
    expect(lines.map(([a, b]) => Vector3.Distance(a!, b!)).sort((a, b) => a - b)).toEqual([2, 2, 2, 2, 4, 4, 4, 4, 8, 8, 8, 8]);
    expect(lines[0]![0]!.asArray()).toEqual([0, 0, 0]);
    const many = Array.from({ length: TERRAIN_REGION_OVERLAY_MAX_BOXES + 1 }, (_, i) => box(origin, i + 1)).reverse();
    const capped = terrainRegionBoxLines(many, origin);
    expect(capped).toHaveLength(12 * TERRAIN_REGION_OVERLAY_MAX_BOXES);
    expect(Math.max(...capped.map(([a, b]) => Vector3.Distance(a!, b!)))).toBe(8 * TERRAIN_REGION_OVERLAY_MAX_BOXES);
    expect(terrainRegionBoxLines([box(origin).slice(0, 7)], origin)).toEqual([]);
  });
});

describe("the shown region's overlay", () => {
  it("shows the first region under the world root, never pickable, and tints the map inside it", () => {
    const target = scene();
    const world = new TransformNode("world", target);
    world.position.set(-1000, 0, 0);
    const toScene = (point: { x: number; y: number; z: number }) => new Vector3(point.x - 1000, point.y, point.z);
    const overlay = createTerrainRegionOverlay(target, { parent: world, ecefToScene: toScene });
    overlay.update([]);
    expect(linesOf(target, "terrain-region-zone")).toBeNull();
    expect(getTerrainRegionHighlight(target)).toBeNull();

    const demand = sphereDemand(), center = demand.bounds[0]!.center;
    const display: TerrainRegionDisplay = { demand, outlines: [box(center)], revision: 1 };
    overlay.update([display, { demand: sphereDemand(), outlines: [], revision: 0 }]);
    const zone = linesOf(target, "terrain-region-zone")!, pending = linesOf(target, "terrain-region-pending-tiles")!;
    const shell = target.getMeshByName("terrain-region-shell")!;
    for (const mesh of [zone, pending, shell]) {
      expect(mesh.isPickable).toBe(false);
      expect(mesh.isEnabled()).toBe(true);
      expect(mesh.parent!.parent).toBe(world);
    }
    expect((mesh => mesh.parent as TransformNode)(zone).position.asArray()).toEqual(center.asArray());
    expect(pending.getTotalVertices()).toBe(24);
    expect(shell.material!.alpha).toBeLessThan(0.2);
    expect(getTerrainRegionHighlight(target)).toEqual({ center: { x: center.x - 1000, y: center.y, z: center.z }, radiusMeters: 15 });

    // Unchanged, nothing is rebuilt; new boxes replace the old.
    overlay.update([display]);
    expect(linesOf(target, "terrain-region-zone")).toBe(zone);
    expect(linesOf(target, "terrain-region-pending-tiles")).toBe(pending);
    overlay.update([{ ...display, outlines: [], revision: 2 }]);
    expect(pending.isDisposed()).toBe(true);
    expect(linesOf(target, "terrain-region-pending-tiles")).toBeNull();
    expect(linesOf(target, "terrain-region-zone")).toBe(zone);

    // A cone is drawn and tinted along its axis in the scene.
    const coned = createTerrainRegionDemand({ ...demand.region, cone: { directionEcef: { x: 0, y: 0, z: 5 }, lengthMeters: 400, halfAngleDeg: 15 } },
      detail.minimum, detail.final);
    overlay.update([{ demand: coned, outlines: [], revision: 0 }]);
    expect(zone.isDisposed()).toBe(true);
    const cone = getTerrainRegionHighlight(target)!.cone!;
    expect(cone).toMatchObject({ lengthMeters: 400, halfAngleDeg: 15 });
    expect(cone.axis.z).toBeCloseTo(1, 9);

    overlay.update([]);
    expect(linesOf(target, "terrain-region-zone")).toBeNull();
    expect(target.getMeshByName("terrain-region-shell")).toBeNull();
    expect(getTerrainRegionHighlight(target)).toBeNull();
    overlay.update([display]);
    expect(linesOf(target, "terrain-region-pending-tiles")!.getTotalVertices()).toBe(24);
    overlay.dispose(); overlay.dispose();
    expect(target.getTransformNodeByName("terrain-region-overlay")).toBeNull();
    expect(target.meshes).toHaveLength(0);
    expect(target.materials.filter(material => material.name.startsWith("terrain-region"))).toHaveLength(0);
    expect(getTerrainRegionHighlight(target)).toBeNull();
    overlay.update([display]);
    expect(target.meshes).toHaveLength(0);
  });
});
