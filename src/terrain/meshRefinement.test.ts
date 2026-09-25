import { Mesh, NullEngine, Scene, TransformNode, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { advanceRefinement, inheritParent, meshPositions, patchPoint, patchesForGeometryCommit, refineMesh, stitchTerrainEdges, type TerrainPatch } from "./meshRefinement";
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

function placePatches(patches: TerrainPatch[], placement: "frozen" | "parented"): void {
  const origin = new Vector3(-1_945_532, -4_792_825, 3_719_025);
  const parent = placement === "parented" ? new TransformNode("terrain-root", patches[0].mesh.getScene()) : null;
  if (parent) parent.position.copyFrom(origin);
  for (const { mesh } of patches) {
    if (parent) {
      mesh.parent = parent;
      mesh.computeWorldMatrix(true);
    } else {
      mesh.position.copyFrom(origin);
      mesh.freezeWorldMatrix();
    }
    // Reading the initial bounds models the first culling pass. Later vertex
    // writes must preserve their world transform even when it stays cached.
    expectWorldBounds(mesh);
  }
}

function expectWorldBounds(mesh: Mesh): void {
  const bounds = mesh.getBoundingInfo();
  const world = mesh.getWorldMatrix();
  expect(bounds.boundingSphere.centerWorld.asArray()).toEqual(Vector3.TransformCoordinates(bounds.boundingSphere.center, world).asArray());
  expect(bounds.boundingBox.centerWorld.asArray()).toEqual(Vector3.TransformCoordinates(bounds.boundingBox.center, world).asArray());
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
  it.each(["frozen", "parented"] as const)("keeps world bounds transformed during refinement (%s)", placement => {
    const scene = setup(), terrain = patch(scene, 14, 3090, 6439, 100);
    placePatches([terrain], placement);
    const target = meshPositions(terrain.mesh).map((value, index) => index % 3 === 1 ? value + 200 : value);
    const refinement = refineMesh(terrain.mesh, target, 0, 1000);
    expect(advanceRefinement(terrain.mesh, refinement, 500)).toBe(true);
    expectWorldBounds(terrain.mesh);
    expect(advanceRefinement(terrain.mesh, refinement, 1000)).toBe(false);
    expectWorldBounds(terrain.mesh);
  });
  it.each([
    { contact: "edge", fineY: 2 },
    { contact: "corner", fineY: 4 },
  ])("keeps frozen world bounds transformed after $contact stitching", ({ fineY }) => {
    const scene = setup(), coarse = patch(scene, 2, 1, 1, 100), fine = patch(scene, 3, 4, fineY, 400);
    placePatches([coarse, fine], "frozen");
    const counters = { geometryWrites: 0, seamPasses: 0 };
    stitchTerrainEdges([coarse, fine], counters);
    expect(counters.geometryWrites).toBeGreaterThan(0);
    expect(patchPoint(fine, 4, fineY, 3)[1]).toBeCloseTo(coarse.mesh.position.y + 100);
    expectWorldBounds(coarse.mesh);
    expectWorldBounds(fine.mesh);
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
  it("restitches a committed tile and the tiles that read it, and leaves a remote tile out", () => {
    const scene = setup();
    const coarse = patch(scene, 2, 1, 1, 100);
    const fineTop = patch(scene, 3, 4, 2, 400);
    const fineBottom = patch(scene, 3, 4, 3, 700);
    const remote = patch(scene, 3, 0, 0, 50);
    const visible = [coarse, fineTop, fineBottom, remote];
    const selected = patchesForGeometryCommit(visible, new Set(["2/1/1"]));
    expect(selected.map(item => `${item.tile.z}/${item.tile.x}/${item.tile.y}`).sort()).toEqual(["2/1/1", "3/4/2", "3/4/3"]);
    stitchTerrainEdges(selected);
    for (const fine of [fineTop, fineBottom]) {
      expect(patchPoint(fine, 4, fine.tile.y, 3)[1]).toBeCloseTo(100);
    }
    expect(meshPositions(remote.mesh)[1]).toBe(50);
  });
  it("uploads only corners needing repair and repairs a corner changed by a later terrain commit", () => {
    const scene = setup();
    // These two patches meet only at a corner, so the edge pass cannot repair it.
    const coarse = patch(scene, 2, 1, 1, 100), fine = patch(scene, 3, 4, 4, 400);
    const remote = patch(scene, 3, 6, 6, 700);
    const coarseBefore = meshPositions(coarse.mesh), remoteBefore = meshPositions(remote.mesh);
    const target = meshPositions(fine.mesh);
    const expected = [...target]; expected[1] = 100;
    const counters = { geometryWrites: 0, seamPasses: 0 };

    stitchTerrainEdges([remote, fine, coarse], counters);
    expect(counters.geometryWrites).toBe(1);
    expect(meshPositions(fine.mesh)).toEqual(expected);
    expect(meshPositions(coarse.mesh)).toEqual(coarseBefore);
    expect(meshPositions(remote.mesh)).toEqual(remoteBefore);

    counters.geometryWrites = 0;
    stitchTerrainEdges([coarse, fine, remote], counters);
    expect(counters.geometryWrites).toBe(0);
    expect(meshPositions(fine.mesh)).toEqual(expected);

    // Restoring unstitched source geometry must still trigger a corner repair.
    fine.mesh.updateVerticesData(VertexBuffer.PositionKind, target, true);
    stitchTerrainEdges([coarse, fine, remote], counters);
    expect(counters.geometryWrites).toBe(1);
    expect(meshPositions(fine.mesh)).toEqual(expected);
  });
  it("contains a finite real global fallback with mountainous relief", () => {
    expect(GLOBAL_TERRAIN.heights).toHaveLength(4096);
    expect([...GLOBAL_TERRAIN.heights].every(Number.isFinite)).toBe(true);
    expect(Math.max(...GLOBAL_TERRAIN.heights)).toBeGreaterThan(3000);
    expect(Math.min(...GLOBAL_TERRAIN.heights)).toBeLessThanOrEqual(0);
  });
});
