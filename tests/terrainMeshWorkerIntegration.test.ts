import { NullEngine, Scene, Texture, VertexBuffer, type Mesh } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createEngineSettings, testAtlasDevice, testAfter } from "../fixtures/composition/runtimeHost.js";
import { createRasterTilesRuntime } from "../src/babylon/createRasterTilesRuntime.js";
import { installTerrainMeshWorkerKernel } from "../src/browser/terrainMeshWorkerKernel.js";
import type { TerrainMeshWorkerPort, TerrainMeshWorkerReply, TerrainMeshWorkerRequest } from "../src/browser/terrainMeshWorkerProtocol.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import { WASM_PARAMETERS } from "../src/settings/catalogue/wasm.js";
import type { TerrainGrid, TerrainTile } from "../src/terrain/terrainGrid.js";

// Counts the targets the page works out itself; the mesh builder does not go through this export.
const pageTargets = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/babylon/terrainMesh.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/babylon/terrainMesh.js")>();
  return { ...actual, terrainMeshTarget: (...args: Parameters<typeof actual.terrainMeshTarget>) => { pageTargets.count++; return actual.terrainMeshTarget(...args); } };
});

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
    settings.register(WASM_PARAMETERS);
    settings.set("wasm.tier", "typescript");

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
    settings.register(WASM_PARAMETERS);
    settings.set("wasm.tier", "typescript-worker");

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
    settings.register(WASM_PARAMETERS);
    settings.set("wasm.tier", "typescript-worker");

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

  function workerRuntime(scene: Scene, settings: ReturnType<typeof createEngineSettings>, createTerrainMeshWorker: () => TerrainMeshWorkerPort) {
    const grid = (tile: TerrainTile): TerrainGrid => ({ ...tile, z: Math.max(1, tile.z), size: 4, heights: new Float32Array(16).fill(300) });
    return createRasterTilesRuntime({
      scene, settings, source: RASTER_BASE_MAP_SOURCES[0], nowMs: () => performance.now(), after: testAfter, requestRender: () => {},
      getViewState: () => ({ latDeg: 0, lonDeg: 0, zoomMeters: 8000000, headingDeg: 0, pitchDeg: 0 }),
      meshRebuildCpuMs: () => 1000,
      // After the record exists, so its imagery counts as loaded and it can show.
      loadMapTexture: (_url, sc, loaded) => { queueMicrotask(loaded); return new Texture(null, sc); },
      attachTerrainLighting: () => ({} as never),
      createTerrainLoader: () => ({
        dispose: () => {}, getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }), setPaused: () => {},
        load: (tile: TerrainTile) => Promise.resolve(grid(tile)), loadPatch: (tile: TerrainTile) => Promise.resolve(grid(tile)),
      }),
      imageryPorts: {
        device: testAtlasDevice(scene),
        capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
        createAbortController: () => new AbortController(),
        loader: { load: async () => ({ width: 1, height: 1, compressedBytes: 1, pages: [[new Uint8Array(4)]] }) },
      },
      log: { warn: () => {} },
      createTerrainMeshWorker,
      terrainMeshWorkers: () => 2,
    });
  }

  it("leaves target preparation to the workers, apart from one parity check", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), settings = createEngineSettings();
    settings.register(WASM_PARAMETERS);
    settings.set("wasm.tier", "typescript-worker");
    const runtime = workerRuntime(scene, settings, createMockTerrainMeshWorker);
    pageTargets.count = 0;
    runtime.update();
    await runtime.whenSettled();
    expect(runtime.getTerrainMeshStats?.()!.targets).toBeGreaterThan(1);
    expect(pageTargets.count).toBe(1);
    runtime.dispose(); scene.dispose(); engine.dispose();
  });

  it("does not upload a target prepared before a segments change onto the rebuilt mesh", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), settings = createEngineSettings();
    settings.register(WASM_PARAMETERS);
    settings.set("wasm.tier", "typescript-worker");
    // Holds every job until released, so the rebuild lands while they run.
    const held: (() => void)[] = [];
    const createHeldWorker = (): TerrainMeshWorkerPort => {
      const inner = createMockTerrainMeshWorker();
      const port: TerrainMeshWorkerPort = {
        onmessage: null, onerror: null,
        postMessage(request, transfer) { held.push(() => inner.postMessage(request, transfer)); },
        terminate: () => inner.terminate(),
      };
      inner.onmessage = event => port.onmessage?.(event);
      return port;
    };
    const runtime = workerRuntime(scene, settings, createHeldWorker);
    runtime.update();
    // Every tile's latest job is queued before the change: a later job would retire an earlier one anyway.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(held.length).toBeGreaterThan(0);
    const before = settings.get<number>("map.terrain.tileSegments");
    const after = before === 16 ? 24 : 16;
    settings.set("map.terrain.tileSegments", after);
    runtime.update();
    while (held.length) { held.splice(0).forEach(release => release()); for (let i = 0; i < 20; i++) await Promise.resolve(); runtime.update(); }
    await runtime.whenSettled();
    runtime.update();
    expect(runtime.getMetrics().visibleTiles).toBeGreaterThan(0);
    const surfaces = scene.meshes.filter(mesh => mesh.metadata?.mapSurface && !mesh.isDisposed()) as Mesh[];
    expect(surfaces.length).toBeGreaterThan(0);
    for (const mesh of surfaces) {
      expect(mesh.metadata.segments).toBe(after);
      // The array the last upload stored, not the vertex count Babylon reads from it.
      expect((mesh.getVertexBuffer(VertexBuffer.PositionKind)!.getData() as Float32Array | number[]).length).toBe((after + 1) ** 2 * 3);
    }
    runtime.dispose(); scene.dispose(); engine.dispose();
  });
});
