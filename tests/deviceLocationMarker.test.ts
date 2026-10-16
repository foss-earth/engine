import { describe, expect, it, vi } from "vitest";
import { FreeCamera, NullEngine, Scene, TransformNode, Vector3, type Sprite, type SpriteManager } from "@babylonjs/core";
import { createCanvasTextureDevicePorts } from "@foss-earth/renderer/babylon";
import { smoothSurfaceEcef } from "../src/terrain/smoothElevation.js";
import {
  accuracySpriteSize, DEVICE_LOCATION_ACCURACY_LIFT_M, DEVICE_LOCATION_ACCURACY_OPACITY, DEVICE_LOCATION_DOT_LIFT_M,
  DEVICE_LOCATION_DOT_PX, screenConstantSpriteSize,
} from "../src/location/deviceLocation.js";
import { drawCircleAtlasCell } from "../src/sprites/atlas.js";
import { createDeviceLocationMarker } from "../src/sprites/deviceLocationMarker.js";
import { DEFAULT_DOT_TEXTURE_SIZE, type MarkerStyle } from "../src/sprites/types.js";
import { canvasRealm } from "../fixtures/composition/canvasRealm.js";

function markerScene() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, 0), scene);
  camera.fov = Math.PI / 2;
  scene.activeCamera = camera;
  const requestRender = vi.fn();
  const device = createCanvasTextureDevicePorts({ scene, createCanvas: canvasRealm, transfer: (_bytes, _label, submit) => submit() });
  const sprite = (name: string): Sprite => {
    const found = scene.spriteManagers?.flatMap(manager => manager.sprites).find(item => item.name === name);
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  };
  return { engine, scene, camera, requestRender, device, sprite };
}

describe("device location marker", () => {
  it("draws a blue dot and a translucent accuracy disc above the ground", () => {
    const { engine, scene, camera, requestRender, device, sprite } = markerScene();
    const marker = createDeviceLocationMarker({ scene, device, requestRender });
    try {
      marker.show({ latDeg: 44.97, lonDeg: -93.23, accuracyMeters: 30 });
      const dot = sprite("device-location");
      const accuracy = sprite("device-location-accuracy");
      const surface = smoothSurfaceEcef(44.97, -93.23, 0);
      const radial = Math.hypot(surface.x, surface.y, surface.z);
      expect(Math.hypot(dot.position.x, dot.position.y, dot.position.z)).toBeCloseTo(radial + DEVICE_LOCATION_DOT_LIFT_M, 2);
      expect(Math.hypot(accuracy.position.x, accuracy.position.y, accuracy.position.z)).toBeCloseTo(radial + DEVICE_LOCATION_ACCURACY_LIFT_M, 2);
      expect(accuracy.size).toBeCloseTo(accuracySpriteSize(30, DEFAULT_DOT_TEXTURE_SIZE));
      expect(accuracy.color.a).toBe(DEVICE_LOCATION_ACCURACY_OPACITY);
      expect(dot.color.a).toBe(1);
      expect(accuracy.cellIndex).toBe(0);
      expect(dot.cellIndex).toBe(1);
      expect(accuracy.isPickable).toBe(false);
      expect(dot.isPickable).toBe(false);
      expect(dot.isVisible).toBe(true);
      const manager = scene.spriteManagers?.[0] as SpriteManager | undefined;
      expect(manager?.disableDepthWrite).toBe(true);
      expect(manager?.renderingGroupId).toBe(3);
      expect(scene.getAutoClearDepthStencilSetup(3)).toMatchObject({ autoClear: true, depth: true });
      const distance = Vector3.Distance(camera.globalPosition, dot.position);
      expect(dot.size).toBeCloseTo(screenConstantSpriteSize(distance, camera.fov, engine.getRenderHeight(), DEVICE_LOCATION_DOT_PX), 3);
      expect(requestRender).toHaveBeenCalledTimes(1);
      marker.show({ latDeg: 44.97, lonDeg: -93.23, accuracyMeters: 0 });
      expect(sprite("device-location-accuracy").isVisible).toBe(false);
      expect(sprite("device-location").isVisible).toBe(true);
      marker.show(null);
      expect(sprite("device-location").isVisible).toBe(false);
      expect(scene.getAutoClearDepthStencilSetup(3).autoClear).toBe(false);
      expect(requestRender).toHaveBeenCalledTimes(3);
      marker.show(null);
      expect(requestRender).toHaveBeenCalledTimes(3);
      marker.destroy();
      marker.destroy();
      expect(scene.spriteManagers ?? []).toHaveLength(0);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("follows a sampled surface, a floating origin and the camera", () => {
    const { engine, scene, camera, requestRender, device, sprite } = markerScene();
    const root = new TransformNode("origin", scene);
    root.position.set(100, -20, 5);
    let revision = 1;
    let point = { x: 10, y: 0, z: 0 };
    const normal = { x: 1, y: 0, z: 0 };
    let samples = 0;
    const marker = createDeviceLocationMarker({
      scene, device, requestRender,
      getWorldRoot: () => root,
      sampleSurface: () => { samples += 1; return { point, normal }; },
      surfaceRevision: () => revision,
    });
    try {
      marker.show({ latDeg: 1, lonDeg: 2, accuracyMeters: 8 });
      const expected = (meters: number) => Vector3.TransformCoordinates(
        new Vector3(point.x + meters, point.y, point.z), root.computeWorldMatrix(true));
      const dot = sprite("device-location");
      const accuracy = sprite("device-location-accuracy");
      const placed = expected(DEVICE_LOCATION_DOT_LIFT_M);
      expect(dot.position.asArray()).toEqual([placed.x, placed.y, placed.z]);
      expect(accuracy.position.x).toBeCloseTo(expected(DEVICE_LOCATION_ACCURACY_LIFT_M).x, 4);
      expect(samples).toBe(1);
      point = { x: 40, y: 0, z: 0 };
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(samples).toBe(1);
      expect(dot.position.x).toBeCloseTo(placed.x, 4);
      revision = 2;
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(samples).toBe(2);
      expect(dot.position.x).toBeCloseTo(expected(DEVICE_LOCATION_DOT_LIFT_M).x, 4);
      const before = dot.size;
      camera.position.copyFrom(dot.position);
      camera.position.y += 250;
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(dot.size).not.toBe(before);
      const distance = Vector3.Distance(camera.globalPosition, dot.position);
      expect(dot.size).toBeCloseTo(screenConstantSpriteSize(distance, camera.fov, engine.getRenderHeight(), DEVICE_LOCATION_DOT_PX), 3);
    } finally { marker.destroy(); scene.dispose(); engine.dispose(); }
  });

  it("paints an X on the dot when the ground hides it", () => {
    const { engine, scene, camera, requestRender, device, sprite } = markerScene();
    const root = new TransformNode("origin", scene);
    root.position.set(100, -20, 5);
    camera.position.set(100, -20, 5);
    let hidden = true;
    let reach = 0;
    let eye = { x: Number.NaN, y: Number.NaN, z: Number.NaN };
    const marker = createDeviceLocationMarker({
      scene, device, requestRender,
      getWorldRoot: () => root,
      sampleSurface: () => ({ point: { x: 10, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }),
      raycastSurface: (origin, _direction, length) => {
        eye = origin;
        reach = length;
        return hidden ? { hit: true } : null;
      },
    });
    try {
      marker.show({ latDeg: 1, lonDeg: 2, accuracyMeters: 8 });
      const dot = sprite("device-location");
      expect(dot.cellIndex).toBe(2);
      expect(eye.x).toBeCloseTo(0, 4);
      expect(eye.y).toBeCloseTo(0, 4);
      expect(eye.z).toBeCloseTo(0, 4);
      expect(reach).toBeCloseTo(10 * 0.995 - 1, 4);
      expect(reach).toBeLessThan(10);
      hidden = false;
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(dot.cellIndex).toBe(1);
    } finally { marker.destroy(); scene.dispose(); engine.dispose(); }
  });

  it("keeps the solid dot when a ground query fails", () => {
    const { engine, scene, requestRender, device, sprite } = markerScene();
    const marker = createDeviceLocationMarker({
      scene, device, requestRender,
      raycastSurface: () => { throw new Error("surface busy"); },
    });
    try {
      marker.show({ latDeg: 44.97, lonDeg: -93.23, accuracyMeters: 12 });
      expect(sprite("device-location").cellIndex).toBe(1);
      expect(sprite("device-location").isVisible).toBe(true);
    } finally { marker.destroy(); scene.dispose(); engine.dispose(); }
  });
});

describe("occluded location ink", () => {
  it("draws the anchor X over the fill and leaves an ordinary disc plain", () => {
    const record = (): { ctx: CanvasRenderingContext2D; calls: string[] } => {
      const calls: string[] = [];
      const ctx = {
        save: () => calls.push("save"), restore: () => calls.push("restore"), translate() {}, clearRect() {},
        beginPath: () => calls.push("begin"), arc: () => calls.push("arc"), fill: () => calls.push("fill"),
        stroke: () => calls.push("stroke"), clip: () => calls.push("clip"),
        moveTo: () => calls.push("move"), lineTo: () => calls.push("line"),
        fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "",
      };
      return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
    };
    const plain = record();
    drawCircleAtlasCell(plain.ctx, { fill: [66, 133, 244], stroke: [255, 255, 255] }, 0, 0, 64);
    expect(plain.calls).not.toContain("clip");
    const hidden = record();
    const style: MarkerStyle = { fill: [66, 133, 244], stroke: [255, 255, 255], obscuredSizePx: 36 };
    drawCircleAtlasCell(hidden.ctx, style, 0, 0, 64);
    expect(hidden.calls).toContain("clip");
    expect(hidden.calls.filter(call => call === "move").length).toBeGreaterThan(4);
    const clipAt = hidden.calls.indexOf("clip");
    const strokeAt = hidden.calls.lastIndexOf("stroke");
    expect(clipAt).toBeGreaterThan(-1);
    expect(strokeAt).toBeGreaterThan(clipAt);
  });
});
