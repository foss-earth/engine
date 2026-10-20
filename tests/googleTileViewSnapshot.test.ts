import { Camera, FreeCamera, Frustum, Matrix, NullEngine, Plane, Scene, Vector3, Viewport } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { TilesRenderer } from "3d-tiles-renderer/babylonjs";
import type { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
// @ts-expect-error The installed adapter's internal volume has no declaration file.
import { TileBoundingVolume } from "3d-tiles-renderer/src/babylonjs/renderer/math/TileBoundingVolume.js";
import { createGoogleTilesRuntime, type GoogleTilesRenderer } from "../src/babylon/createTilesRuntime.js";
import { createEngineSettings } from "../fixtures/composition/runtimeHost.js";

type Target = { inView: boolean; error: number; distanceFromCamera: number };
type MeasuredTile = { geometricError: number; engineData: { boundingVolume: {
  distanceToPoint(point: Vector3): number; intersectsFrustum?(planes: Plane[]): boolean;
} } };
type Adapter = GoogleTilesRenderer & { calculateTileViewError(tile: MeasuredTile, target: Target): void };
const target = (): Target => ({ inView: false, error: 0, distanceFromCamera: 0 });

function fixture(options: { enabled?: boolean; replaceCalculator?: boolean } = {}) {
  const engine = new NullEngine({ renderWidth: 960, renderHeight: 540, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 4 });
  const scene = new Scene(engine); scene.useRightHandedSystem = true;
  const camera = new FreeCamera("snapshot-test", new Vector3(0, 0, 1000), scene);
  camera.minZ = 1; camera.maxZ = 10000; camera.setTarget(Vector3.Zero()); scene.activeCamera = camera;
  const adapter = new TilesRenderer("fixture-only", scene) as unknown as Adapter;
  const original = adapter.calculateTileViewError.bind(adapter);
  const originalSpy = vi.spyOn(adapter, "calculateTileViewError");
  if (options.enabled !== false) adapter.nativeViewSnapshot = { adapter: "babylonjs-0.4.24", calculateTileViewError: adapter.calculateTileViewError };
  const custom = vi.fn((_tile: MeasuredTile, measured: Target) => Object.assign(measured, { inView: true, error: 123, distanceFromCamera: 456 }));
  if (options.replaceCalculator) adapter.calculateTileViewError = custom;
  let tiles: MeasuredTile[] = [], results: Target[] = [], before = () => {};
  adapter.update = () => {
    before();
    results = tiles.map(tile => { const measured = target(); adapter.calculateTileViewError(tile, measured); return measured; });
  };
  const runtime = createGoogleTilesRuntime({ scene, apiKey: "fixture-only", settings: createEngineSettings(),
    createTilesRenderer: () => adapter,
    createAuthPlugin: () => ({ name: "fixture-only", fetchData: async () => new Response("{}") }) as unknown as GoogleCloudAuthPlugin,
    createAbortController: () => new AbortController(), combineSignals: signals => AbortSignal.any([...signals]),
    whenMeshesReady: async () => {}, lighting: { followTerrainLight: () => false }, responseRealm: { Response, TransformStream },
    recordMapRequest: () => {}, resourceTiming: () => null, online: () => undefined, origin: () => undefined,
    log: { info: () => {}, error: () => {} },
  });
  const prepareCamera = () => { scene.activeCamera!.getViewMatrix(true); scene.activeCamera!.getProjectionMatrix(true); };
  prepareCamera(); adapter.group.computeWorldMatrix(true);
  return { engine, scene, camera, adapter, runtime, originalSpy, custom, original, prepareCamera,
    traverse(next: MeasuredTile[], onBefore = () => {}) { tiles = next; before = onBefore; runtime.update(); return results; },
    check(next: MeasuredTile[], onBefore = () => {}) {
      const actual = this.traverse(next, onBefore);
      const expected = next.map(tile => { const measured = target(); original(tile, measured); return measured; });
      expect(actual).toEqual(expected);
      return actual;
    },
    dispose() { runtime.dispose(); scene.dispose(); engine.dispose(); },
  };
}

function measuredTiles(): MeasuredTile[] {
  return Array.from({ length: 160 }, (_, index) => {
    const center = new Vector3((index % 10 - 5) * 230, (Math.floor(index / 10) % 4 - 2) * 300, (Math.floor(index / 40) - 1) * 900);
    const volume = new TileBoundingVolume();
    if (index % 2) volume.setSphereData(center.x, center.y, center.z, 100, Matrix.Identity());
    else volume.setObbData([center.x, center.y, center.z, 70, 0, 0, 0, 80, 0, 0, 0, 90], Matrix.Identity());
    return { geometricError: index % 9, engineData: { boundingVolume: volume } };
  });
}

describe("native Babylon tile view snapshots", () => {
  it("is exactly the installed calculator for perspective/orthographic and transformed tile groups", () => {
    const f = fixture(), tiles = measuredTiles();
    try {
      for (const mode of [Camera.PERSPECTIVE_CAMERA, Camera.ORTHOGRAPHIC_CAMERA]) {
        f.camera.mode = mode; f.camera.fov = 1.1;
        f.camera.orthoLeft = -700; f.camera.orthoRight = 700; f.camera.orthoTop = 500; f.camera.orthoBottom = -500;
        // Native screen-space error uses the full render size; preserve it for partial viewports too.
        f.camera.viewport = new Viewport(0.2, 0.1, 0.4, 0.6);
        for (let transform = 0; transform < 6; transform++) {
          f.adapter.group.position.set(transform * 100 - 250, transform * 37 - 80, transform * -41);
          f.adapter.group.rotation.set(transform * 0.08, transform * -0.12, transform * 0.03);
          f.adapter.group.scaling.set(1 + transform * 0.15, 0.6 + transform * 0.08, 1.2 + transform * 0.03);
          f.adapter.group.computeWorldMatrix(true);
          f.camera.position.set(100 - transform * 41, transform * 31, 1000 + transform * 20);
          f.camera.setTarget(new Vector3(transform * 10, 0, 0)); f.prepareCamera();
          f.check(tiles);
        }
      }
    } finally { f.dispose(); }
  });

  it("prepares once per traversal and follows active camera, projection, size, scaling and group changes next traversal", () => {
    const f = fixture(), tiles = measuredTiles();
    const width = vi.spyOn(f.engine, "getRenderWidth").mockReturnValue(960);
    const height = vi.spyOn(f.engine, "getRenderHeight").mockReturnValue(540);
    const scaling = vi.spyOn(f.engine, "getHardwareScalingLevel").mockReturnValue(1);
    const frustum = vi.spyOn(Frustum, "GetPlanesToRef");
    try {
      f.traverse(tiles);
      // Babylon itself also reads dimensions while preparing projection/aspect.
      expect(width.mock.calls.length).toBeLessThanOrEqual(3); expect(height.mock.calls.length).toBeLessThanOrEqual(3);
      expect(scaling).toHaveBeenCalledOnce(); expect(frustum).toHaveBeenCalledOnce();
      expect(f.originalSpy).not.toHaveBeenCalled();
      const other = new FreeCamera("replacement-camera", new Vector3(150, 75, -1000), f.scene);
      other.minZ = 0.5; other.maxZ = 20000; other.fov = 0.7; other.setTarget(Vector3.Zero());
      f.scene.activeCamera = other; width.mockReturnValue(1400); height.mockReturnValue(800); scaling.mockReturnValue(2);
      f.adapter.group.position.set(40, -10, 80); f.adapter.group.rotation.y = 0.3; f.adapter.group.computeWorldMatrix(true); f.prepareCamera();
      const first = f.check(tiles);
      other.mode = Camera.ORTHOGRAPHIC_CAMERA; other.orthoLeft = -300; other.orthoRight = 300; other.orthoTop = 200; other.orthoBottom = -200; f.prepareCamera();
      expect(f.check(tiles)).not.toEqual(first);
    } finally { frustum.mockRestore(); f.dispose(); }
  });

  it("captures after traversal preparation and delegates outside traversal, including after a thrown update", () => {
    const f = fixture(), tiles = measuredTiles();
    try {
      f.check(tiles, () => { f.camera.position.set(35, -20, 700); f.camera.fov = 0.5; f.camera.setTarget(Vector3.Zero()); f.prepareCamera(); });
      f.originalSpy.mockClear();
      f.adapter.calculateTileViewError(tiles[0], target());
      expect(f.originalSpy).toHaveBeenCalledOnce();
      expect(() => f.traverse(tiles, () => { throw new Error("traversal failure"); })).toThrow("traversal failure");
      f.adapter.calculateTileViewError(tiles[1], target());
      expect(f.originalSpy).toHaveBeenCalledTimes(2);
    } finally { f.dispose(); }
  });

  it("matches native cached-matrix behavior when camera position is dirty", () => {
    const fast = fixture(), native = fixture({ enabled: false }), tiles = measuredTiles();
    try {
      for (const f of [fast, native]) f.camera.position.set(135, -40, 800);
      // Do not force a view/world update: the standard Camera's transformation
      // getter multiplies cached matrices, so it leaves the previous eye intact.
      const actual = fast.traverse(tiles), expected = native.traverse(tiles);
      expect(actual).toEqual(expected);
      expect(fast.camera.globalPosition).toEqual(native.camera.globalPosition);
      expect(fast.traverse(tiles)).toEqual(native.traverse(tiles));
    } finally { fast.dispose(); native.dispose(); }
  });

  it("recaptures after a supplied camera getter updates its global eye during the first measurement", () => {
    const fast = fixture(), native = fixture({ enabled: false }), tile = measuredTiles()[1];
    const previous = fast.camera.globalPosition.clone();
    try {
      for (const f of [fast, native]) {
        const transformation = f.camera.getTransformationMatrix.bind(f.camera);
        vi.spyOn(f.camera, "getTransformationMatrix").mockImplementation(() => {
          f.camera.getViewMatrix(true); f.camera.getProjectionMatrix(); return transformation();
        });
        f.camera.position.set(135, -40, 800);
      }
      const actual = fast.traverse([tile, tile, tile]), expected = native.traverse([tile, tile, tile]);
      expect(fast.camera.globalPosition).not.toEqual(previous);
      expect(actual[0].distanceFromCamera).not.toBe(actual[1].distanceFromCamera);
      expect(actual).toEqual(expected);
      expect(actual[1]).toEqual(actual[2]);
    } finally { fast.dispose(); native.dispose(); }
  });

  it.each([false, true])("delegates when the port declines the capability or replaces its calculator (replacement=%s)", replaceCalculator => {
    const f = fixture({ enabled: replaceCalculator, replaceCalculator }), tiles = measuredTiles();
    try {
      const actual = f.traverse(tiles);
      if (replaceCalculator) {
        expect(f.custom).toHaveBeenCalledTimes(tiles.length);
        expect(actual.every(value => value.inView && value.error === 123 && value.distanceFromCamera === 456)).toBe(true);
      } else {
        expect(f.originalSpy).toHaveBeenCalledTimes(tiles.length);
        const expected = tiles.map(tile => { const measured = target(); f.original(tile, measured); return measured; });
        expect(actual).toEqual(expected);
      }
    } finally { f.dispose(); }
  });
});
