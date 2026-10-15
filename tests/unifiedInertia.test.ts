import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createGeospatialGlobeCamera } from "../src/babylon/globeCamera.js";
import { CameraController } from "../src/babylon/cameraState.js";
import { createGlobeInertia } from "../src/babylon/globeInertia.js";

function globe() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = createGeospatialGlobeCamera(scene, { latitudeDeg: 44.97, longitudeDeg: -93.26, radiusMeters: 600, yawRad: 0.4, pitchRad: 1 });
  const controller = new CameraController(camera, { nowMs: () => 0, hasPickablePointAt: () => false });
  return { engine, scene, camera, controller };
}

describe("unified inertia", () => {
  it("scales the same pan, turn and zoom, and at force 1 a pan matches the usual one", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const slide = (unified: boolean, pan = 1) => {
      const camera = createGeospatialGlobeCamera(scene, { latitudeDeg: 0, longitudeDeg: 0, radiusMeters: 600, yawRad: 0, pitchRad: 1 });
      const controller = new CameraController(camera, { nowMs: () => 0, hasPickablePointAt: () => false });
      const inertia = createGlobeInertia(controller, {
        nowMs: () => 0, decayPerFrame: () => 0, renderer: { requestRender() {} },
        unified: () => unified, forces: () => ({ pan, orbit: 1, zoom: 1 }),
      });
      inertia.panBy(12, -4, 800);
      inertia.update(0);
      const centre = camera.center.clone();
      camera.dispose();
      return centre;
    };
    const usualCamera = createGeospatialGlobeCamera(scene, { latitudeDeg: 0, longitudeDeg: 0, radiusMeters: 600, yawRad: 0, pitchRad: 1 });
    const usual = new CameraController(usualCamera, { nowMs: () => 0, hasPickablePointAt: () => false });
    try {
      usual.panBy(12, -4, 800);
      expect(slide(false).subtract(usualCamera.center).length()).toBeLessThan(0.05);
      expect(slide(true, 1).subtract(usualCamera.center).length()).toBeLessThan(0.05);
      expect(slide(true, 2).subtract(usualCamera.center).length()).toBeGreaterThan(1);
    } finally {
      usualCamera.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("keeps a turn about the compass and a zoom on the same ground point", () => {
    const { engine, scene, camera, controller } = globe();
    const orbit = vi.spyOn(controller, "orbitBy");
    const zoom = vi.spyOn(controller, "zoomBy");
    const inertia = createGlobeInertia(controller, {
      nowMs: () => 0, decayPerFrame: () => 0, renderer: { requestRender() {} },
      unified: () => true, forces: () => ({ pan: 1, orbit: 2, zoom: 2 }),
    });
    try {
      const before = controller.getViewState();
      inertia.orbitBy(0, 4);
      inertia.update(0);
      const turned = controller.getViewState();
      expect(orbit).toHaveBeenCalledWith(0, 8);
      expect(turned.latDeg).toBeCloseTo(before.latDeg, 5);
      expect(turned.lonDeg).toBeCloseTo(before.lonDeg, 5);
      expect(turned.zoomMeters).toBeCloseTo(before.zoomMeters, 5);
      inertia.zoomBy(0.98);
      inertia.update(16);
      const zoomed = controller.getViewState();
      expect(zoom).toHaveBeenCalledWith(expect.closeTo(0.98 ** 2, 6));
      expect(zoomed.latDeg).toBeCloseTo(turned.latDeg, 5);
      expect(zoomed.lonDeg).toBeCloseTo(turned.lonDeg, 5);
      expect(zoomed.zoomMeters).toBeLessThan(turned.zoomMeters);
    } finally {
      camera.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("turns in place only when that setting is on", () => {
    const { engine, scene, camera, controller } = globe();
    try {
      const before = controller.getPose();
      const centre = camera.center.clone();
      controller.orbitBy(0, 8);
      expect(camera.center.subtract(centre).length()).toBeLessThan(0.05);
      controller.setOrbitInPlace(true);
      const eye = controller.getPose().eye;
      controller.orbitBy(0, 8);
      const after = controller.getPose();
      const eyeShift = new Vector3(after.eye[0] - eye[0], after.eye[1] - eye[1], after.eye[2] - eye[2]).length();
      expect(eyeShift).toBeLessThan(1);
      expect(new Vector3(...after.forward).subtract(new Vector3(...before.forward)).length()).toBeGreaterThan(0.05);
    } finally {
      camera.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
