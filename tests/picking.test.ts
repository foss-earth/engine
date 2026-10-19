import { afterEach, describe, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { hasPickablePointAt } from "../src/sprites/picking.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** A tile filling the view, carrying `metadata`, and the viewport point at its centre. */
function viewOf(metadata: unknown) {
  const engine = new NullEngine({ renderWidth: 400, renderHeight: 300, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", new Vector3(0, 0, -100), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const tile = MeshBuilder.CreatePlane("tile", { size: 400 }, scene);
  tile.metadata = metadata;
  scene.render();
  return { scene, x: engine.getRenderWidth() / 2, y: engine.getRenderHeight() / 2 };
}

describe("hasPickablePointAt", () => {
  // A twist or a grab begins only where no point of interest is under the fingers.
  it("does not take a Google tile for a point of interest, whatever its glTF loader recorded", () => {
    for (const metadata of [
      { googleGeometricErrorMeters: 4 },
      // Babylon's glTF loader keeps a node's extras in metadata.gltf.extras.
      { gltf: { extras: { fixture: true } }, googleGeometricErrorMeters: 4 },
      // Tiles prepared in a worker recorded their glTF pointer there, and a twist over them did not turn the view.
      { gltf: { pointers: ["/nodes/0"] }, googleGeometricErrorMeters: 4 },
      { mapSurface: true, terrainZoom: 12 },
    ]) {
      const { scene, x, y } = viewOf(metadata);
      expect(hasPickablePointAt(scene, x, y), JSON.stringify(metadata)).toBe(false);
    }
  });

  it("finds a point of interest, including one loaded from glTF", () => {
    for (const metadata of [{ poiId: "museum" }, { poiId: "museum", gltf: { pointers: ["/nodes/0"] } }]) {
      const { scene, x, y } = viewOf(metadata);
      expect(hasPickablePointAt(scene, x, y), JSON.stringify(metadata)).toBe(true);
    }
  });
});
