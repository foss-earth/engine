import { NullEngine, Scene, Texture } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createEngineSettings, testAtlasDevice, testAfter } from "../fixtures/composition/runtimeHost.js";
import { createRasterTilesRuntime } from "../src/babylon/createRasterTilesRuntime.js";
import { installTerrainMeshWorkerKernel } from "../src/browser/terrainMeshWorkerKernel.js";
import type { TerrainMeshWorkerPort, TerrainMeshWorkerReply, TerrainMeshWorkerRequest } from "../src/browser/terrainMeshWorkerProtocol.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import { NATIVE_PARAMETERS } from "../src/settings/catalogue/native.js";
import type { TerrainGrid, TerrainTile } from "../src/terrain/terrainGrid.js";

function createMockTerrainMeshWorker(): TerrainMeshWorkerPort {
  const scope = {
    onmessage: null as ((event: MessageEvent<TerrainMeshWorkerRequest>) => void) | null,
    postMessage(reply: TerrainMeshWorkerReply) {
      queueMicrotask(() => port.onmessage?.({ data: reply } as MessageEvent<TerrainMeshWorkerReply>));
    },
  };
  const port: TerrainMeshWorkerPort = {
    onmessage: null,
    onerror: null,
    postMessage(request) {
      queueMicrotask(() => scope.onmessage?.({ data: request } as MessageEvent<TerrainMeshWorkerRequest>));
    },
    terminate: () => kernel.dispose(),
  };
  const kernel = installTerrainMeshWorkerKernel({
    scope,
    onError: () => {},
  });
  return port;
}

describe("terrain mesh worker integration at applyGrid seam", () => {
  it("uses synchronous on-page preparation when tier is typescript", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const settings = createEngineSettings();
    settings.register(NATIVE_PARAMETERS);
    settings.set("native.tier", "typescript");

    const workerFactory = vi.fn(createMockTerrainMeshWorker);

    const runtime = createRasterTilesRuntime({
      scene,
      settings,
      source: RASTER_BASE_MAP_SOURCES[0],
      nowMs: () => performance.now(),
      after: testAfter,
      requestRender: () => {},
      meshRebuildCpuMs: () => 10,
      loadMapTexture: (_url, sc, loaded) => { loaded(); return new Texture(null, sc); },
      attachTerrainLighting: () => ({} as never),
      createTerrainLoader: () => ({
        dispose: () => {},
        getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }),
        setPaused: () => {},
        load: () => new Promise<TerrainGrid>(() => {}),
        loadPatch: () => new Promise<TerrainGrid>(() => {}),
      }),
      imageryPorts: {
        device: testAtlasDevice(scene),
        capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
        createAbortController: () => new AbortController(),
        loader: { load: async () => ({ width: 1, height: 1, compressedBytes: 1, pages: [[new Uint8Array(4)]] }) },
      },
      log: { warn: () => {} },
      createTerrainMeshWorker: workerFactory,
      terrainMeshWorkers: () => 2,
    });

    runtime.update();
    expect(workerFactory).not.toHaveBeenCalled();
    expect(runtime.getTerrainMeshStats?.()).toBeNull();

    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("dispatches target preparation to mesh workers and achieves parity with terrainMeshTarget", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const settings = createEngineSettings();
    settings.register(NATIVE_PARAMETERS);
    settings.set("native.tier", "typescript-worker");

    const workerFactory = vi.fn(createMockTerrainMeshWorker);

    const runtime = createRasterTilesRuntime({
      scene,
      settings,
      source: RASTER_BASE_MAP_SOURCES[0],
      nowMs: () => performance.now(),
      after: testAfter,
      requestRender: () => {},
      meshRebuildCpuMs: () => 10,
      loadMapTexture: (_url, sc, loaded) => { loaded(); return new Texture(null, sc); },
      attachTerrainLighting: () => ({} as never),
      createTerrainLoader: () => ({
        dispose: () => {},
        getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }),
        setPaused: () => {},
        load: (tile: TerrainTile) => Promise.resolve({
          ...tile,
          z: Math.max(1, tile.z),
          size: 4,
          heights: new Float32Array(16).fill(100),
        }),
        loadPatch: (tile: TerrainTile) => Promise.resolve({
          ...tile,
          z: Math.max(1, tile.z),
          size: 4,
          heights: new Float32Array(16).fill(100),
        }),
      }),
      imageryPorts: {
        device: testAtlasDevice(scene),
        capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
        createAbortController: () => new AbortController(),
        loader: { load: async () => ({ width: 1, height: 1, compressedBytes: 1, pages: [[new Uint8Array(4)]] }) },
      },
      log: { warn: () => {} },
      createTerrainMeshWorker: workerFactory,
      terrainMeshWorkers: () => 2,
    });

    runtime.update();

    // Wait for microtasks and worker promise to resolve
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const stats = runtime.getTerrainMeshStats?.();
    expect(stats).not.toBeNull();
    expect(stats!.targets).toBeGreaterThanOrEqual(1);
    expect(stats!.actualBackend).toBe("typescript");
    expect(stats!.parity).toBe("not compared");

    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("settles only after worker targets have been prepared and applied", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const settings = createEngineSettings();
    settings.register(NATIVE_PARAMETERS);
    settings.set("native.tier", "typescript-worker");

    const runtime = createRasterTilesRuntime({
      scene,
      settings,
      source: RASTER_BASE_MAP_SOURCES[0],
      nowMs: () => performance.now(),
      after: testAfter,
      requestRender: () => {},
      meshRebuildCpuMs: () => 10,
      loadMapTexture: (_url, sc, loaded) => { loaded(); return new Texture(null, sc); },
      attachTerrainLighting: () => ({} as never),
      createTerrainLoader: () => ({
        dispose: () => {},
        getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }),
        setPaused: () => {},
        load: (tile: TerrainTile) => Promise.resolve({
          ...tile,
          z: Math.max(1, tile.z),
          size: 4,
          heights: new Float32Array(16).fill(200),
        }),
        loadPatch: (tile: TerrainTile) => Promise.resolve({
          ...tile,
          z: Math.max(1, tile.z),
          size: 4,
          heights: new Float32Array(16).fill(200),
        }),
      }),
      imageryPorts: {
        device: testAtlasDevice(scene),
        capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
        createAbortController: () => new AbortController(),
        loader: { load: async () => ({ width: 1, height: 1, compressedBytes: 1, pages: [[new Uint8Array(4)]] }) },
      },
      log: { warn: () => {} },
      createTerrainMeshWorker: createMockTerrainMeshWorker,
      terrainMeshWorkers: () => 2,
    });

    runtime.update();
    await runtime.whenSettled();

    const stats = runtime.getTerrainMeshStats?.();
    expect(stats).not.toBeNull();
    expect(stats!.targets).toBeGreaterThanOrEqual(1);

    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });
});
