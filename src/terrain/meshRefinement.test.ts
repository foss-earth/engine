import { Mesh, NullEngine, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { advanceRefinement, inheritParent, meshPositions, patchPoint, refineMesh, stitchTerrainEdges, type TerrainPatch } from "./meshRefinement";
import { GLOBAL_TERRAIN } from "./globalTerrain";

const engines: NullEngine[] = [];
afterEach(() => engines.splice(0).forEach(engine => engine.dispose()));
function setup() { const engine = new NullEngine(); engines.push(engine); return new Scene(engine); }
function patch(scene: Scene, z: number, x: number, y: number, height: number): TerrainPatch {
  const mesh = new Mesh(`${z}/${x}/${y}`, scene), segments = 8;
  const positions: number[] = [], indices: number[] = [];
  for (let r = 0; r <= segments; r++) for (let c = 0; c <= segments; c++) {
    positions.push((x + c / segments) / 2 ** z, height, (y + r / segments) / 2 ** z);
    if (c < segments && r < segments) { const i = r * (segments + 1) + c; indices.push(i, i + segments + 1, i + 1, i + 1, i + segments + 1, i + segments + 2); }
  }
  const data = new VertexData(); data.positions = positions; data.indices = indices; data.applyToMesh(mesh, true);
  mesh.metadata = { segments }; mesh.position = Vector3.Zero();
  return { mesh, tile: { z, x, y } };
}

describe("shared visible/collision refinement geometry", () => {
  it("starts on the old triangles and moves monotonically to the refined geometry", () => {
    const scene = setup(), parent = patch(scene, 2, 1, 1, 100), child = patch(scene, 3, 2, 2, 400);
    const target = meshPositions(child.mesh);
    child.mesh.updateVerticesData(VertexBuffer.PositionKind, inheritParent(child, parent), true);
    const refinement = refineMesh(child.mesh, target, 0, 1000);
    expect(patchPoint(child, 2.5, 2.5, 3)[1]).toBe(100);
    expect(advanceRefinement(child.mesh, refinement, 500)).toBe(true);
    expect(patchPoint(child, 2.5, 2.5, 3)[1]).toBe(250);
    expect(advanceRefinement(child.mesh, refinement, 1000)).toBe(false);
    expect(patchPoint(child, 2.5, 2.5, 3)[1]).toBe(400);
  });
  it("stitches fine/coarse and same-level seams, including the T-junction corner", () => {
    const scene = setup();
    const coarse = patch(scene, 2, 1, 1, 100);
    const fineTop = patch(scene, 3, 4, 2, 400), fineBottom = patch(scene, 3, 4, 3, 700);
    stitchTerrainEdges([fineBottom, coarse, fineTop]);
    for (const fine of [fineTop, fineBottom]) for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      expect(patchPoint(fine, 4, fine.tile.y + fraction, 3)[1]).toBeCloseTo(100);
    }
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      expect(patchPoint(fineTop, 4 + fraction, 3, 3)[1]).toBeCloseTo(patchPoint(fineBottom, 4 + fraction, 3, 3)[1]);
    }
    expect(patchPoint(fineBottom, 4.75, 3.5, 3)[1]).toBeGreaterThan(500);
  });
  it("contains a finite real global fallback with mountainous relief", () => {
    expect(GLOBAL_TERRAIN.heights).toHaveLength(4096);
    expect([...GLOBAL_TERRAIN.heights].every(Number.isFinite)).toBe(true);
    expect(Math.max(...GLOBAL_TERRAIN.heights)).toBeGreaterThan(3000);
    expect(Math.min(...GLOBAL_TERRAIN.heights)).toBeLessThanOrEqual(0);
  });
});
