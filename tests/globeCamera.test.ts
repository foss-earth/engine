import { GeospatialCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { expect, it, vi } from "vitest";
import { createGeospatialGlobeCamera } from "../src/babylon/globeCamera.js";
import { createGlobeInertia } from "../src/babylon/globeInertia.js";
import { CameraController } from "../src/babylon/cameraState.js";
it("creates one supplied-scene globe camera with built-in gestures removed and host activation explicit", () => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const existing = new GeospatialCamera("host-active-camera", scene, { planetRadius: 6378137 }); scene.activeCamera = existing;
  try {
    const camera = createGeospatialGlobeCamera(scene, { latitudeDeg: 0, longitudeDeg: 0, radiusMeters: 600, yawRad: 0, pitchRad: 1 });
    expect(scene.activeCamera).toBe(existing);
    const inputs = Object.values(camera.inputs.attached).map(input => input.getClassName());
    expect(inputs).not.toContain("GeospatialCameraPointersInput");
    expect(inputs).not.toContain("GeospatialCameraMouseWheelInput");
    expect(camera.center.equals(new Vector3(6378137, 0, 0))).toBe(true);
    expect(camera.radius).toBe(600); camera.dispose();
  } finally { scene.dispose(); engine.dispose(); }
});
it("wakes only the supplied renderer and lets the same inertial target carry the motion", () => {
  const engine = new NullEngine(); const scene = new Scene(engine); scene.useRightHandedSystem = true;
  const camera = createGeospatialGlobeCamera(scene, { latitudeDeg: 0, longitudeDeg: 0, radiusMeters: 600, yawRad: 0, pitchRad: 1 });
  let now = 0; const controller = new CameraController(camera, { nowMs: () => now, hasPickablePointAt: () => false });
  const pan = vi.spyOn(controller, "panBy"), requestRender = vi.fn();
  const inertia = createGlobeInertia(controller, { nowMs: () => now, decayPerFrame: () => 0.82, renderer: { requestRender } });
  try {
    inertia.panBy(2, 3, 800); expect(requestRender).toHaveBeenCalledOnce(); expect(pan).not.toHaveBeenCalled();
    inertia.update(); now += 16; inertia.update(); expect(pan).toHaveBeenCalled(); expect(inertia.isActive()).toBe(true);
    inertia.cancel(); expect(inertia.isActive()).toBe(false);
  } finally { camera.dispose(); scene.dispose(); engine.dispose(); }
});
