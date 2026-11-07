/**
 * Draws the selected areas in the world: the footprint on the ground, and,
 * when a height is set, the walls up to it. Nothing here is pickable or part
 * of the map surface.
 */
import { Color3, CreateLineSystem, Mesh, StandardMaterial, TransformNode, Vector3, VertexData, type Scene } from "@babylonjs/core";
import type { EarthAreaDrawing } from "../area/earthArea.js";
import { earthAreaMesh, type EarthAreaMesh } from "../area/earthAreaGeometry.js";

export type { EarthAreaDrawing };

export interface EarthAreaOverlay {
  show(drawings: readonly EarthAreaDrawing[]): void;
  dispose(): void;
}

export interface EarthAreaOverlayOptions {
  /** The node whose local space is the map's (ECEF), or null when the scene's is. */
  parent: TransformNode | null;
  requestRender(): void;
}

const ACTIVE = new Color3(0.98, 0.62, 0.16);
const QUIET = new Color3(0.35, 0.62, 0.86);

function signature(drawings: readonly EarthAreaDrawing[]): string {
  return JSON.stringify(drawings.map(drawing => ({
    active: drawing.active,
    height: drawing.area.heightMeters ?? null,
    points: drawing.area.points.map(point => [point.latDeg, point.lonDeg]),
    ground: drawing.groundMeters.map(meters => Math.round(meters)),
  })));
}

function vectors(points: readonly { x: number; y: number; z: number }[]): Vector3[] {
  return points.map(point => new Vector3(point.x, point.y, point.z));
}

function wallMesh(name: string, walls: EarthAreaMesh["walls"], material: StandardMaterial, scene: Scene): Mesh | null {
  if (walls.length === 0) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  walls.forEach((quad, index) => {
    const base = index * 4;
    for (const point of quad) positions.push(point.x, point.y, point.z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}

export function createEarthAreaOverlay(scene: Scene, options: EarthAreaOverlayOptions): EarthAreaOverlay {
  const root = new TransformNode("earth-area-overlay", scene);
  root.parent = options.parent;
  root.setEnabled(false);
  const materials = [ACTIVE, QUIET].map((color, index) => {
    const material = new StandardMaterial(`earth-area-wall-${index}`, scene);
    material.disableLighting = true;
    material.emissiveColor = color;
    material.alpha = index === 0 ? 0.28 : 0.14;
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    return material;
  });
  let shown = "";
  let disposed = false;
  const nodes: TransformNode[] = [];

  const clear = (): void => {
    for (const node of nodes) node.dispose(false, false);
    nodes.length = 0;
    shown = "";
    root.setEnabled(false);
  };

  return {
    show(drawings) {
      if (disposed) return;
      const key = signature(drawings);
      if (key === shown) return;
      // Nothing to draw, and nothing drawn: don't ask for a frame just to show the absence.
      if (nodes.length === 0 && !drawings.some(drawing => drawing.area.points.length > 0)) { shown = key; return; }
      clear();
      shown = key;
      drawings.forEach((drawing, index) => {
        const mesh = earthAreaMesh(drawing.area, drawing.groundMeters);
        if (!mesh) return;
        const node = new TransformNode(`earth-area-${index}`, scene);
        node.parent = root;
        node.position.set(mesh.origin.x, mesh.origin.y, mesh.origin.z);
        nodes.push(node);
        const lines: Vector3[][] = [];
        if (mesh.footprint.length >= 2) lines.push(vectors(mesh.footprint));
        if (mesh.cap.length >= 2) lines.push(vectors(mesh.cap));
        for (const [bottom, top] of mesh.uprights) lines.push(vectors([bottom, top]));
        if (lines.length > 0) {
          const drawn = CreateLineSystem(`earth-area-lines-${index}`, { lines }, scene);
          drawn.color = drawing.active ? ACTIVE : QUIET;
          drawn.alpha = drawing.active ? 1 : 0.7;
          drawn.isPickable = false;
          drawn.parent = node;
        }
        const walls = wallMesh(`earth-area-walls-${index}`, mesh.walls, materials[drawing.active ? 0 : 1]!, scene);
        if (walls) walls.parent = node;
      });
      root.setEnabled(nodes.length > 0);
      options.requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      for (const material of materials) material.dispose();
      root.dispose();
    },
  };
}
