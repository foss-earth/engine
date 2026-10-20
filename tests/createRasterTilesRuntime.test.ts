import { Frustum, GeospatialCamera, GeospatialClippingBehavior, NullEngine, Scene, StandardMaterial, Texture, VertexBuffer } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCameraController as CameraController } from "../fixtures/composition/runtimeHost.js";
import { ecefToGeodetic } from "../src/camera/cameraMath.js";
import * as refinement from "../src/babylon/meshRefinement.js";
import * as selector from "../src/terrain/terrainSelector.js";
import * as meshWorkerRuntime from "../src/browser/terrainMeshWorkers.js";
import * as imageryRuntimeModule from "../src/babylon/imagery/createImageryRuntime.js";
import { readImageryView } from "../src/babylon/imagery/imageryView.js";
import { NATIVE_PARAMETERS } from "../src/settings/catalogue/native.js";
import { createTerrainMesh, terrainMeshTarget } from "../src/babylon/terrainMesh.js";
import { createTerrainLightingFixture } from "../fixtures/composition/terrainLightHost.js";
import { GROUND_LIGHT_LEAST_SINE, GROUND_LIGHT_SAMPLES, GROUND_LIGHT_TABLE, MERCATOR_MAX_LAT_DEG, NIGHT_RADIANCE_UNITS, groundLightAt } from "@foss-earth/sky";
import { createTerrainPerformanceCapture } from "../src/terrain/terrainPerformanceCapture.js";
import type { TerrainGrid, TerrainTile } from "../src/terrain/terrainGrid.js";
import type { TerrainInterest } from "../src/terrain/terrainLoader.js";
import { createRasterTilesRuntime as createCoreRaster, type RasterTilesRuntimeOptions } from "../src/babylon/createRasterTilesRuntime.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import { createEngineSettings, testAtlasDevice, testAfter } from "../fixtures/composition/runtimeHost.js";
let settings = createEngineSettings();
const getAppSettings = () => settings;

const pending = vi.hoisted(() => ({
  imagery: [] as Array<() => void>,
  imageryErrors: [] as Array<(message?: string) => void>,
  terrain: [] as Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void; reject(error: Error): void; interest?: TerrainInterest; prioritize?: boolean }>,
  dispose: vi.fn(),
}));
function createRasterTilesRuntime(options: Partial<RasterTilesRuntimeOptions> & Pick<RasterTilesRuntimeOptions, "scene" | "source">) {
  return createCoreRaster({
    settings, nowMs: () => performance.now(), after: testAfter, requestRender: () => {},
    meshRebuildCpuMs: () => settings.get<number>("map.terrain.meshRebuildTimePerFrame"),
    loadMapTexture: (_url, scene, loaded, failed) => { pending.imagery.push(loaded); pending.imageryErrors.push(failed); return new Texture(null, scene); },
    attachTerrainLighting: () => ({}) as ReturnType<RasterTilesRuntimeOptions["attachTerrainLighting"]>,
    createTerrainLoader: () => ({ dispose: pending.dispose,
      getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }), setPaused: vi.fn(),
      load: (tile: TerrainTile) => new Promise<TerrainGrid>((resolve, reject) => pending.terrain.push({ tile, resolve, reject })),
      loadPatch: (tile: TerrainTile, interest?: TerrainInterest, prioritize?: boolean) => new Promise<TerrainGrid>((resolve, reject) => {
        pending.terrain.push({ tile, resolve, reject, interest, prioritize });
        // As the loader does with a tile no claim still wants.
        interest?.onRelease(() => reject(Object.assign(new Error("Terrain request withdrawn"), { name: "TerrainWithdrawn" })));
      }),
    }),
    imageryPorts: { device: testAtlasDevice(options.scene), capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
      createAbortController: () => new AbortController(), loader: { async load(_url, { width, height }) {
        return { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
      } } },
    log: { warn: () => {} }, ...options,
  });
}
beforeEach(() => { settings = createEngineSettings(); pending.imagery = []; pending.imageryErrors = []; pending.terrain = []; pending.dispose.mockClear(); });
afterEach(() => vi.restoreAllMocks());
const view = { latDeg: 0, lonDeg: 0, zoomMeters: 8000000, headingDeg: 0, pitchDeg: 0 };
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
async function resolveFirstDetail(): Promise<void> {
  const first = pending.terrain[0];
  first.resolve({ ...first.tile, size: 2, heights: new Float32Array([100, 100, 100, 100]) });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const detail = pending.terrain.find(item => item.tile.z > 0)!;
  expect(detail).toBeDefined();
  detail.resolve({ ...detail.tile, size: 2, heights: new Float32Array([250, 250, 250, 250]) });
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("raster imagery and terrain lifecycle", () => {
  it("refreshes representative owners when an off-frustum imagery retry recreates the same tile key", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const tile = { z: 2, x: 2, y: 1 }, key = "2/2/1";
    vi.spyOn(selector, "selectTerrain").mockReturnValue({ leaves: [{ tile, key, needed: false, distanceMeters: 20,
      errorPx: 10, inCore: false, inProximity: false, inFrustum: false }], rootLevel: 2, split: new Set(), nodes: 1, truncated: false });
    let now = 0;
    const engine = new NullEngine(), scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], nowMs: () => now });
    try {
      runtime.update();
      const failed = scene.meshes.find(mesh => mesh.name.endsWith(key))!;
      pending.imageryErrors[0]("temporary imagery failure");
      runtime.update();
      expect(failed.isDisposed()).toBe(true);
      now = 60_000;
      runtime.update();
      const replacement = scene.meshes.find(mesh => mesh.name.endsWith(key))!;
      expect(replacement).not.toBe(failed);
      pending.imagery.at(-1)!();
      runtime.update();
      expect(replacement.isEnabled()).toBe(true);
      expect(runtime.getMetrics().visibleTiles).toBe(1);
      expect(runtime.sample(1, 1)).not.toBeNull();
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("does not resurrect decoded contact grids after a mesh disposer throws", async () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const tile = { z: 2, x: 2, y: 1 }, key = "2/2/1";
    vi.spyOn(selector, "selectTerrain").mockReturnValue({ leaves: [{ tile, key, needed: true, distanceMeters: 20,
      errorPx: 10, inCore: true, inProximity: true, inFrustum: false }], rootLevel: 2, split: new Set(), nodes: 1, truncated: false });
    const loads: Array<{ tile: TerrainTile; resolve: (grid: TerrainGrid) => void }> = [];
    const engine = new NullEngine(), scene = new Scene(engine), requestRender = vi.fn();
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], requestRender,
      createTerrainLoader: () => ({ setPaused() {}, dispose() {}, getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }),
        load: requested => new Promise(resolve => loads.push({ tile: requested, resolve })),
        loadPatch: requested => new Promise(resolve => loads.push({ tile: requested, resolve })) }) });
    try {
      runtime.update();
      const mesh = scene.meshes.find(mesh => mesh.name.endsWith(key))!;
      vi.spyOn(mesh, "dispose").mockImplementationOnce(() => { throw new Error("Mesh cleanup failed"); });
      expect(() => runtime.dispose()).toThrow("Mesh cleanup failed");
      expect(mesh.isDisposed()).toBe(false);
      const requests = requestRender.mock.calls.length, revision = runtime.getRevision();
      for (const load of loads) load.resolve({ ...load.tile, size: 2, heights: new Float32Array([250, 250, 250, 250]) });
      await flush();
      expect(runtime.sampleHeight!(1, 1)).toBeNull();
      expect(runtime.getRevision()).toBe(revision);
      expect(requestRender).toHaveBeenCalledTimes(requests);
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("invalidates imagery heights only when adopted grids, bounds, or coverage change", async () => {
    settings.register(NATIVE_PARAMETERS);
    settings.set("native.tier", "typescript-worker");
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.tileSegments", 8);
    let surface!: imageryRuntimeModule.ImageryRuntimeOptions["surface"];
    vi.spyOn(imageryRuntimeModule, "createImageryRuntime").mockImplementation(options => {
      surface = options.surface;
      return { supported: true, attachPatch() {}, detachPatch() {}, setPatchVisible() {}, hasCoverage: () => true,
        update() {}, dispose() {}, setOffset() {}, setSource() {} } as unknown as imageryRuntimeModule.ImageryRuntime;
    });
    const tile = { z: 2, x: 2, y: 1 }, key = "2/2/1";
    const leaves = [{ tile, key, needed: true, distanceMeters: 20, errorPx: 10, inCore: true, inProximity: true, inFrustum: true }];
    vi.spyOn(selector, "selectTerrain").mockImplementation(() => ({ leaves, rootLevel: 2, split: new Set(), nodes: 1, truncated: false }));
    const jobs: Array<{ input: Parameters<ReturnType<typeof meshWorkerRuntime.createTerrainMeshWorkers>["prepare"]>[0]; resolve: (value: Awaited<ReturnType<ReturnType<typeof meshWorkerRuntime.createTerrainMeshWorkers>["prepare"]>>) => void }> = [];
    const prepare = vi.fn<ReturnType<typeof meshWorkerRuntime.createTerrainMeshWorkers>["prepare"]>(input => new Promise(resolve => jobs.push({ input, resolve })));
    vi.spyOn(meshWorkerRuntime, "createTerrainMeshWorkers").mockReturnValue({ prepare, stats: () => ({}) as never, dispose() {} });
    const engine = new NullEngine(), scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], imagery: "atlas",
      createTerrainMeshWorker: () => null, createTerrainHeightWorker: () => null });
    try {
      runtime.update();
      const beforeDecoded = surface.getRevision!(), contactRevision = runtime.getRevision(), originalHeight = surface.heightAt(1, 1);
      const grid = { ...tile, size: 2, heights: new Float32Array([250, 250, 250, 250]) };
      pending.terrain.find(request => request.tile.z === 2)!.resolve(grid);
      await flush();
      expect(runtime.getRevision()).toBeGreaterThan(contactRevision);
      expect(runtime.sampleHeight!(1, 1)).toEqual({ heightMeters: 250, quality: 2 });
      expect(surface.getRevision!()).toBe(beforeDecoded);
      expect(surface.heightAt(1, 1)).toBe(originalHeight);
      const target = terrainMeshTarget({ segments: 8 }, tile, grid);
      jobs[0].resolve({ geometry: { segments: 8, targetPositions: target.positions, heightBounds: target.heightBounds } } as never);
      await flush();
      expect(surface.getRevision!()).toBeGreaterThan(beforeDecoded);
      expect(surface.heightAt(1, 1)).toBe(250);
      expect(scene.meshes.find(mesh => mesh.name.endsWith(key))!.metadata.terrainZoom).toBe(0);
      const adoptedRevision = surface.getRevision!();
      runtime.update();
      expect(surface.getRevision!()).toBe(adoptedRevision);
      expect(scene.meshes.find(mesh => mesh.name.endsWith(key))!.metadata.terrainZoom).toBe(2);
      const coordinates = new Float64Array([1, 1, 10, 10, 1, 181, 0, 0, 85, 360]);
      const expected = Float64Array.from({ length: coordinates.length / 2 }, (_, i) => surface.heightAt(coordinates[i * 2], coordinates[i * 2 + 1]) ?? NaN);
      expect(surface.heightsAt!(coordinates)).toEqual(expected);
      runtime.setTerrainSource({ id: "new-source", label: "New source", provider: "test", urlTemplate: "https://terrain.test/{z}/{x}/{y}.png", maxZoom: 15, attribution: "test" });
      expect(surface.getRevision!()).toBe(adoptedRevision);
      // A tile created after a source-generation change starts directly in
      // that generation and exposes decoded contacts before worker adoption.
      leaves[0] = { ...leaves[0], tile: { z: 2, x: 3, y: 1 }, key: "2/3/1" };
      settings.set("map.terrain.proximityWeight", 2);
      runtime.update();
      expect(surface.getRevision!()).toBeGreaterThan(adoptedRevision);
      const requests = pending.terrain.filter(request => request.tile.z === 2 && request.tile.x === 3);
      expect(requests).toHaveLength(1);
      requests[0].resolve({ z: 2, x: 3, y: 1, size: 2, heights: new Float32Array([350, 350, 350, 350]) });
      await flush();
      expect(runtime.sampleHeight!(1, 100)).toEqual({ heightMeters: 350, quality: 2 });
      runtime.update();
      expect(pending.terrain.filter(request => request.tile.z === 2 && request.tile.x === 3)).toHaveLength(1);
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("settles off-frustum proximity elevation without imagery and acquires imagery when it enters view", async () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const tile = { z: 2, x: 2, y: 1 }, key = "2/2/1";
    const leaf = { tile, key, needed: true, distanceMeters: 20, errorPx: 23, inCore: true, inProximity: true, inFrustum: false };
    vi.spyOn(selector, "selectTerrain").mockImplementation(() => ({ leaves: [leaf], rootLevel: 2, split: new Set(), nodes: 1, truncated: false }));
    const engine = new NullEngine(), scene = new Scene(engine);
    const texture = vi.fn<NonNullable<RasterTilesRuntimeOptions["loadMapTexture"]>>((_url, targetScene, loaded) => { pending.imagery.push(loaded); return new Texture(null, targetScene); });
    const runtime = createRasterTilesRuntime({ scene, source: { ...RASTER_BASE_MAP_SOURCES[0], urlTemplate: "https://map.test/{z}/{x}/{y}.png" }, loadMapTexture: texture });
    try {
      runtime.update();
      expect(texture.mock.calls.some(([url]) => url === "https://map.test/2/2/1.png")).toBe(false);
      expect(pending.terrain.find(request => request.tile.z === 2)!.prioritize).toBe(true);
      const revision = runtime.getRevision();
      for (const request of pending.terrain.splice(0)) request.resolve({ ...request.tile, size: 2, heights: new Float32Array([250, 250, 250, 250]) });
      await flush();
      expect(runtime.getRevision()).toBeGreaterThan(revision);
      expect(runtime.sample(1, 1)).toMatchObject({ quality: 2, heightMeters: 250 });
      const decodedRevision = runtime.getRevision();
      settings.set("map.terrain.robustOrbitLOD", false);
      expect(runtime.getRevision()).toBeGreaterThan(decodedRevision);
      expect(runtime.sample(1, 1)).toBeNull();
      const disabledRevision = runtime.getRevision();
      settings.set("map.terrain.robustOrbitLOD", true);
      expect(runtime.getRevision()).toBeGreaterThan(disabledRevision);
      expect(runtime.sample(1, 1)).toMatchObject({ quality: 2, heightMeters: 250 });
      pending.imagery.splice(0).forEach(loaded => loaded());
      runtime.update();
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBe(0);
      const mesh = scene.meshes.find(mesh => mesh.name.endsWith(key))!;
      expect(mesh.metadata.terrainZoom).toBe(2);
      expect(mesh.isEnabled()).toBe(false);
      leaf.inFrustum = true;
      settings.set("map.terrain.proximityWeight", 2);
      runtime.update();
      expect(texture.mock.calls.filter(([url]) => url === "https://map.test/2/2/1.png")).toHaveLength(1);
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBe(1);
      expect(mesh.isEnabled()).toBe(false);
      pending.imagery.splice(0).forEach(loaded => loaded());
      runtime.update();
      expect(mesh.isEnabled()).toBe(true);
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBe(0);
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("prioritizes safety-core workers, publishes decoded shared heights before preparation, and aborts retired jobs", async () => {
    settings.register(NATIVE_PARAMETERS);
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("native.tier", "typescript-worker");
    const tile = { z: 4, x: 8, y: 7 }, key = "4/8/7";
    vi.spyOn(selector, "selectTerrain").mockReturnValue({ leaves: [{ tile, key, needed: true, distanceMeters: 20,
      errorPx: 42.7, inCore: true, inProximity: true, inFrustum: false }], rootLevel: 2, split: new Set(), nodes: 1, truncated: false });
    const prepare = vi.fn<ReturnType<typeof meshWorkerRuntime.createTerrainMeshWorkers>["prepare"]>((_input, request) => new Promise<never>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
    }));
    vi.spyOn(meshWorkerRuntime, "createTerrainMeshWorkers").mockReturnValue({ prepare, stats: () => ({}) as never, dispose: () => {} });
    const engine = new NullEngine(), scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], createTerrainMeshWorker: () => null });
    try {
      runtime.update();
      const heights = new Float32Array(new SharedArrayBuffer(16)); heights.fill(275);
      const request = pending.terrain.find(request => request.tile.z === 4)!;
      request.resolve({ ...tile, size: 2, heights });
      await flush();
      const call = prepare.mock.calls.find(([input]) => input.tile.z === 4)!;
      expect(call[1]).toMatchObject({ priority: 1_000_043 });
      expect(call[1]!.signal!.aborted).toBe(false);
      expect(runtime.sample(1, 1)).toMatchObject({ quality: 4, heightMeters: 275 });
      pending.terrain.find(request => request.tile.z === 0)!.resolve({ z: 0, x: 0, y: 0, size: 2, heights: new Float32Array([500, 500, 500, 500]) });
      await flush();
      // A slower coarse arrival cannot cancel or replace the already queued
      // fine preparation, even before that worker has published its target.
      expect(prepare.mock.calls.filter(([input]) => input.tile.z === 4)).toHaveLength(1);
      expect(call[1]!.signal!.aborted).toBe(false);
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBeGreaterThan(0);
      runtime.setTerrainSource({ id: "replacement", label: "Replacement", provider: "test", urlTemplate: "https://terrain.test/{z}/{x}/{y}.png", maxZoom: 15, attribution: "test" });
      await flush();
      expect(call[1]!.signal!.aborted).toBe(true);
      // Cancellation does not run a page fallback and publish the retired grid.
      expect(scene.meshes.find(mesh => mesh.name.endsWith(key))!.metadata.terrainZoom).toBe(0);
      const replacement = pending.terrain.filter(request => request.tile.z === 4).at(-1)!;
      replacement.resolve({ ...tile, size: 2, heights });
      await flush();
      const latest = prepare.mock.calls.filter(([input]) => input.tile.z === 4).at(-1)!;
      expect(latest[1]!.signal!.aborted).toBe(false);
      runtime.dispose();
      expect(latest[1]!.signal!.aborted).toBe(true);
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("tracks independent eye/focus lookahead, caps speed, resets teleports, and live-applies tuning", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    settings.set("map.terrain.reselectWhileMoving", 0);
    const select = vi.spyOn(selector, "selectTerrain").mockReturnValue({ leaves: [], rootLevel: 2, split: new Set(), nodes: 0, truncated: false });
    const engine = new NullEngine(), scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new GeospatialCamera("proximity-camera", scene, { planetRadius: 6378137 });
    camera.addBehavior(new GeospatialClippingBehavior());
    const controller = new CameraController(camera);
    let now = 0;
    const focus = { x: 6378137, y: 0, z: 0 };
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], nowMs: () => now, getProximityFocusPoint: () => focus });
    const current = { latDeg: 0, lonDeg: 0, zoomMeters: 200, pitchDeg: 30, headingDeg: 0 };
    const update = () => { controller.applyViewState(current); scene.render(); runtime.update(); return select.mock.calls.at(-1)![0].proximity!; };
    try {
      let proximity = update();
      expect(proximity.start).toEqual(proximity.end);
      expect(proximity.secondary!.start).toEqual(focus);
      now = 100; current.lonDeg = 0.0001; focus.y += 10;
      proximity = update();
      expect(proximity.start).toEqual(readImageryView(scene, null)!.camera);
      expect(proximity.end).not.toEqual(proximity.start);
      expect(proximity.secondary!.end.y - proximity.secondary!.start.y).toBeCloseTo(150);
      now = 101; current.lonDeg += 0.001;
      proximity = update();
      expect(Math.hypot(proximity.end.x - proximity.start.x, proximity.end.y - proximity.start.y, proximity.end.z - proximity.start.z)).toBeCloseTo(1500, 3);
      now = 201; current.lonDeg = 2;
      proximity = update();
      expect(proximity.end).toEqual(proximity.start);
      settings.set("map.terrain.proximityAnchor", "focus");
      settings.set("map.terrain.proximityBlendMode", "power-norm");
      settings.set("map.terrain.losWeight", 0.5);
      settings.set("map.terrain.proximityRadiusMeters", 2500);
      now += 100;
      proximity = update();
      expect(proximity).toMatchObject({ start: focus, blendMode: "power-norm", losWeight: 0.5, radiusMeters: 2500 });
      expect(proximity.secondary).toBeUndefined();
      settings.set("map.terrain.robustOrbitLOD", false);
      update();
      expect(select.mock.calls.at(-1)![0].proximity).toBeUndefined();
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("requeues an ordinary pending mesh at safety-core priority without publishing its aborted result", async () => {
    settings.register(NATIVE_PARAMETERS);
    settings.set("native.tier", "typescript-worker");
    settings.set("map.terrain.robustOrbitLOD", true);
    const tile = { z: 2, x: 2, y: 1 }, key = "2/2/1";
    const leaf = { tile, key, needed: true, distanceMeters: 20, errorPx: 42.7, inCore: false, inProximity: true, inFrustum: false };
    vi.spyOn(selector, "selectTerrain").mockReturnValue({ leaves: [leaf], rootLevel: 2, split: new Set(), nodes: 1, truncated: false });
    const prepare = vi.fn<ReturnType<typeof meshWorkerRuntime.createTerrainMeshWorkers>["prepare"]>((_input, request) => new Promise<never>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
    }));
    vi.spyOn(meshWorkerRuntime, "createTerrainMeshWorkers").mockReturnValue({ prepare, stats: () => ({}) as never, dispose: () => {} });
    const engine = new NullEngine(), scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], createTerrainMeshWorker: () => null });
    try {
      runtime.update();
      pending.terrain.find(request => request.tile.z === 2)!.resolve({ ...tile, size: 2, heights: new Float32Array([275, 275, 275, 275]) });
      await flush();
      expect(prepare.mock.calls[0][1]!.priority).toBe(43);
      leaf.inCore = true;
      settings.set("map.terrain.proximityWeight", 2);
      runtime.update();
      await flush();
      expect(prepare.mock.calls).toHaveLength(2);
      expect(prepare.mock.calls[0][1]!.signal!.aborted).toBe(true);
      expect(prepare.mock.calls[1][1]!.priority).toBe(1_000_043);
      expect(prepare.mock.calls[1][1]!.signal!.aborted).toBe(false);
      expect(scene.meshes.find(mesh => mesh.name.endsWith(key))!.metadata.terrainZoom).toBe(0);
      for (const inCore of [false, true, false, true]) {
        leaf.inCore = inCore;
        settings.set("map.terrain.proximityWeight", inCore ? 3 : 4);
        runtime.update();
        await flush();
      }
      // Once promoted, an outstanding task keeps its safety priority across
      // capsule-boundary oscillation instead of restarting every crossing.
      expect(prepare.mock.calls).toHaveLength(2);
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("reuses stationary proximity inputs and tuning without reselecting or rebuilding terrain", () => {
    settings.set("map.terrain.robustOrbitLOD", true);
    const select = vi.spyOn(selector, "selectTerrain").mockReturnValue({ leaves: [], rootLevel: 2, split: new Set(), nodes: 0, truncated: false });
    const engine = new NullEngine(), scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new GeospatialCamera("stationary-proximity", scene, { planetRadius: 6378137 });
    camera.addBehavior(new GeospatialClippingBehavior());
    const controller = new CameraController(camera);
    controller.applyViewState({ latDeg: 36.1, lonDeg: -112.14, zoomMeters: 300, pitchDeg: 20, headingDeg: 0 });
    scene.render();
    let now = 0;
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], nowMs: () => now });
    try {
      runtime.update();
      const read = vi.spyOn(settings, "get"), write = vi.spyOn(refinement, "updateTerrainPositions");
      select.mockClear();
      for (let i = 0; i < 50; i++) { now += 16; runtime.update(); }
      expect(select).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(read.mock.calls.filter(([id]) => id.startsWith("map.terrain.proximity") || id.startsWith("map.terrain.los"))).toHaveLength(0);
      settings.set("map.terrain.proximityWeight", 2);
      runtime.update();
      expect(select).toHaveBeenCalledOnce();
      expect(select.mock.calls[0][0].proximity!.proximityWeight).toBe(2);
    } finally { runtime.dispose(); engine.dispose(); }
  });

  it("keeps fine raster tiles in the camera frustum after zooming in and committing terrain", async () => {
    // Select the zoomed view at once, however fast the test runs.
    getAppSettings().set("map.terrain.reselectWhileMoving", 0);
    const engine = new NullEngine(); const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new GeospatialCamera("raster-camera", scene, { planetRadius: 6378137 });
    camera.addBehavior(new GeospatialClippingBehavior());
    const controller = new CameraController(camera);
    const currentView = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 80_000_000, pitchDeg: 55, headingDeg: 0 };
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => currentView });
    try {
      for (const zoomMeters of [80_000_000, 1200]) {
        currentView.zoomMeters = zoomMeters;
        controller.applyViewState(currentView);
        // The clipping behaviour sets the near plane for the new view as a frame renders.
        scene.render();
        runtime.update();
        pending.imagery.splice(0).forEach(loaded => loaded());
        runtime.update();
        scene.render();
      }
      const fineTiles = scene.meshes.filter(mesh => mesh.isEnabled() && Number(mesh.name.split("-").at(-1)!.split("/")[0]) >= 14);
      expect(fineTiles.length).toBeGreaterThan(0);
      const assertFineCoverage = () => {
        const planes = Frustum.GetPlanes(camera.getTransformationMatrix());
        expect(fineTiles.some(mesh => mesh.isInFrustum(planes))).toBe(true);
        for (const mesh of fineTiles) {
          const bounds = mesh.getBoundingInfo();
          // Each fine tile's local origin is its ECEF center on the globe.
          expect(bounds.boundingSphere.centerWorld.subtract(mesh.position).length()).toBeLessThan(10_000);
        }
      };
      assertFineCoverage();
      const coarse = pending.terrain.find(item => item.tile.z >= 10)!;
      expect(coarse).toBeDefined();
      coarse.resolve({ ...coarse.tile, size: 2, heights: new Float32Array([100, 100, 100, 100]) });
      await flush();
      const detail = pending.terrain.find(item => item.tile.z >= 14)!;
      expect(detail).toBeDefined();
      detail.resolve({ ...detail.tile, size: 2, heights: new Float32Array([250, 250, 250, 250]) });
      await flush();
      runtime.update();
      scene.render();
      assertFineCoverage();
    } finally {
      runtime.dispose(); engine.dispose();
    }
  });
  it("captures asynchronous preparation and queries when requested", async () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const capture = createTerrainPerformanceCapture(4);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view,
      performanceCapture: capture });
    capture.beginFrame(0); runtime.update(); capture.endFrame();
    pending.imagery.forEach(loaded => loaded());
    await resolveFirstDetail();
    expect(capture.counters.preparationCpuMs).toBeGreaterThan(0);
    capture.beginFrame(16); runtime.update();
    const hit = runtime.sample(0.1, 0.1);
    expect(hit).not.toBeNull();
    capture.endFrame();
    const snapshot = capture.snapshot();
    expect(snapshot.metrics.samples.max).toBe(1);
    expect(snapshot.metrics.seamPasses.max).toBe(1);
    expect(snapshot.metrics.sampleCpuMs.max).toBeGreaterThan(0);
    expect(snapshot.resources?.cachedTriangles).toBeGreaterThan(0);
    runtime.dispose(); engine.dispose();
  });
  it("displays real global fallback and refines the same mesh when terrain arrives", async () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    runtime.update();
    pending.imagery.forEach(loaded => loaded());
    expect(runtime.getMetrics().visibleTiles).toBe(0);
    runtime.update();
    expect(runtime.getMetrics().visibleTiles).toBeGreaterThan(0);
    const beforeRevision = runtime.getRevision();
    const beforeMeshes = scene.meshes.filter(mesh => mesh.isEnabled());
    expect(beforeMeshes.every(mesh => mesh.metadata?.terrainZoom === 0)).toBe(true);
    await resolveFirstDetail();
    runtime.update();
    expect(runtime.getRevision()).toBeGreaterThan(beforeRevision);
    expect(beforeMeshes.every(mesh => !mesh.isDisposed())).toBe(true);
    expect(scene.meshes.filter(mesh => mesh.isEnabled()).every(mesh => mesh.metadata?.mapSurface)).toBe(true);
    const clock = vi.spyOn(performance, "now");
    expect(runtime.sample(0.1, 0.1)).not.toBeNull();
    expect(clock).not.toHaveBeenCalled();
    runtime.dispose();
    expect(scene.meshes).toHaveLength(0);
    engine.dispose();
  });
  it("shows the positions and measures the height range the tile builder gives arriving terrain", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), select = vi.spyOn(selector, "selectTerrain");
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    try {
      runtime.update(); pending.imagery.forEach(loaded => loaded()); runtime.update();
      // Uneven heights on fine grids, so a stale or unrounded target cannot pass.
      const grids = new Map<string, TerrainGrid>();
      for (let round = 0; round < 4 && pending.terrain.length; round++) {
        for (const { tile, resolve } of pending.terrain.splice(0)) {
          const grid = { ...tile, size: 64, heights: Float32Array.from({ length: 64 * 64 }, (_, index) => ((index * 7919 + tile.x * 31 + tile.y) % 4000) / 4 - 300) };
          grids.set(`${tile.z}/${tile.x}/${tile.y}`, grid); resolve(grid);
        }
        await flush(); runtime.update();
      }
      const shown = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface);
      const checked = shown.filter(mesh => grids.get(mesh.name.split("-").at(-1)!)?.z === mesh.metadata.terrainZoom);
      expect(checked.length).toBeGreaterThan(0);
      for (const mesh of checked) {
        const grid = grids.get(mesh.name.split("-").at(-1)!)!, segments = mesh.metadata.segments as number;
        const reference = createTerrainMesh({ scene, source: RASTER_BASE_MAP_SOURCES[0], nowMs: () => 0, segments }, grid, grid);
        const expected = refinement.meshPositions(reference), actual = mesh.getVerticesData(VertexBuffer.PositionKind)!;
        // Seams move vertices up to four in from an edge; the rest are the builder's.
        for (let row = 4; row <= segments - 4; row++) for (let col = 4; col <= segments - 4; col++) for (let axis = 0; axis < 3; axis++) {
          const index = (row * (segments + 1) + col) * 3 + axis;
          if (!Object.is(actual[index], expected[index])) expect.fail(`${mesh.name} vertex ${row},${col} axis ${axis}: ${actual[index]} is not ${expected[index]}`);
        }
        const bounds = reference.metadata.heightBounds as { min: number; max: number };
        expect(select.mock.calls.at(-1)![0].boundsFor(grid)).toEqual({ min: bounds.min - 50, max: bounds.max + 50 });
        reference.dispose();
      }
    } finally {
      runtime.dispose(); engine.dispose();
    }
  });
  it("draws terrain under the terrain light with a shader that reads no vertex normals", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const light = createTerrainLightingFixture({ GROUND_LIGHT_TABLE, GROUND_LIGHT_SAMPLES, GROUND_LIGHT_LEAST_SINE, MERCATOR_MAX_LAT_DEG, NIGHT_RADIANCE_UNITS, groundLightAt });
    light.setTerrainLighting(scene, { perPoint: true, centre: [0, 0, 0], sunDirection: [0, 0, 1], moonDirection: [0, 0, -1], sunScale: [1, 1, 1],
      moonScale: [0, 0, 0], ambient: [0.001, 0.001, 0.001], table: new Float32Array(GROUND_LIGHT_SAMPLES * 4) });
    light.setTerrainLocalLights(scene, [{ position: [1, 2, 3], direction: [0, -1, 0], cosInner: 0.9, cosOuter: 0.8, factor: [4, 5, 6] }]);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view,
      attachTerrainLighting: material => light.createMaterialPlugin(material) });
    try {
      runtime.update(); pending.imagery.forEach(loaded => loaded()); runtime.update();
      await resolveFirstDetail(); runtime.update();
      const tiles = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface);
      expect(tiles.length).toBeGreaterThan(0);
      for (const mesh of tiles) {
        const material = mesh.material as StandardMaterial;
        const plugin = material.pluginManager?.getPlugin("TerrainLight") as { prepareDefines(defines: Record<string, unknown>): void; getCustomCode(shaderType: string): Record<string, string> | null } | null;
        expect(plugin, mesh.name).toBeTruthy();
        const defines = { TERRAIN_LIGHT: false, TERRAIN_LIGHT_PER_POINT: false, TERRAIN_LOCAL_LIGHTS: 0, TERRAIN_NIGHT_LIGHTS: false };
        plugin!.prepareDefines(defines);
        // The light is on, including a local light, and it never injects a vertex shader.
        expect(defines, mesh.name).toEqual({ TERRAIN_LIGHT: true, TERRAIN_LIGHT_PER_POINT: true, TERRAIN_LOCAL_LIGHTS: 1, TERRAIN_NIGHT_LIGHTS: false });
        expect(plugin!.getCustomCode("vertex"), mesh.name).toBeNull();
        const fragment = Object.values(plugin!.getCustomCode("fragment") ?? {}).join("\n");
        expect(fragment, mesh.name).not.toMatch(/\bvNormal\b|normalW/);
        expect(fragment, mesh.name).toContain("vPositionW");
        // Scene lighting is off, so Babylon does not ask for a normal attribute, and the mesh has none.
        expect(material.disableLighting, mesh.name).toBe(true);
        expect(mesh.isVerticesDataPresent(VertexBuffer.NormalKind), mesh.name).toBe(false);
      }
    } finally {
      runtime.dispose(); engine.dispose();
    }
  });
  it("hot-swaps imagery without requesting elevation again or revising the surface", async () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    runtime.update();
    pending.imagery.forEach(loaded => loaded());
    await resolveFirstDetail();
    runtime.update();
    const elevationRequests = pending.terrain.length;
    const revision = runtime.getRevision();
    const meshes = scene.meshes.filter(mesh => mesh.metadata?.mapSurface);
    const previousTextures = meshes.map(mesh => (mesh.material as StandardMaterial).diffuseTexture);
    const initialImageRequests = pending.imagery.length;
    runtime.setSource({ ...RASTER_BASE_MAP_SOURCES[0], id: "test-hot-swap", urlTemplate: "https://example.test/{z}/{x}/{y}.png" });
    expect(runtime.source.id).toBe("test-hot-swap");
    expect(pending.terrain).toHaveLength(elevationRequests);
    // The old texture stays bound while its replacement is still loading, so a
    // flat-to-flat switch cannot expose the background clear colour.
    expect(meshes.map(mesh => (mesh.material as StandardMaterial).diffuseTexture)).toEqual(previousTextures);
    expect(pending.imagery.length).toBeGreaterThan(initialImageRequests);
    pending.imagery.slice(initialImageRequests).forEach(loaded => loaded());
    runtime.update();
    expect(runtime.getRevision()).toBe(revision);
    expect(meshes.every(mesh => !mesh.isDisposed())).toBe(true);
    expect(meshes.some((mesh, index) => (mesh.material as StandardMaterial).diffuseTexture !== previousTextures[index])).toBe(true);
    runtime.dispose(); engine.dispose();
  });
  describe("coarser elevation", () => {
    const keyOf = (tile: TerrainTile) => `${tile.z}/${tile.x}/${tile.y}`;
    const up = (tile: TerrainTile, levels: number): TerrainTile => {
      const shift = Math.min(levels, tile.z);
      return { z: tile.z - shift, x: Math.floor(tile.x / 2 ** shift), y: Math.floor(tile.y / 2 ** shift) };
    };
    const fine = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 30_000, headingDeg: 0, pitchDeg: 40 };
    function start() {
      settings.set("map.terrain.reselectWhileMoving", 0);
      const engine = new NullEngine(), scene = new Scene(engine), view = { ...fine };
      scene.useRightHandedSystem = true;
      const camera = new GeospatialCamera("raster-camera", scene, { planetRadius: 6378137 });
      camera.addBehavior(new GeospatialClippingBehavior());
      const controller = new CameraController(camera);
      controller.applyViewState(view);
      scene.render();
      const select = vi.spyOn(selector, "selectTerrain");
      const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
      runtime.update();
      const tiles = scene.meshes.filter(mesh => mesh.metadata?.mapSurface).map(mesh => {
        const [z, x, y] = mesh.name.split("-").at(-1)!.split("/").map(Number);
        return { z, x, y };
      });
      expect(Math.max(...tiles.map(tile => tile.z))).toBeGreaterThan(8);
      const leaves = () => select.mock.results.at(-1)!.value.leaves.map((leaf: { tile: TerrainTile }) => leaf.tile) as TerrainTile[];
      const move = (zoomMeters: number) => { view.zoomMeters = zoomMeters; controller.applyViewState(view); scene.render(); runtime.update(); };
      return { engine, scene, runtime, tiles, leaves, move };
    }
    /** Resolves elevation as it is asked for, until no more is, and returns what was asked for. */
    async function resolveAll(): Promise<string[]> {
      const asked: string[] = [];
      for (let round = 0; round < 4 && pending.terrain.length; round++) {
        for (const { tile, resolve } of pending.terrain.splice(0)) { asked.push(keyOf(tile)); resolve({ ...tile, size: 2, heights: new Float32Array([100, 100, 100, 100]) }); }
        await flush();
      }
      return asked;
    }
    function expectShownFrom(scene: Scene, runtime: ReturnType<typeof createRasterTilesRuntime>, levels: number): void {
      pending.imagery.splice(0).forEach(loaded => loaded());
      runtime.update();
      const shown = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface);
      expect(shown.length).toBeGreaterThan(0);
      for (const mesh of shown) {
        const z = Number(mesh.name.split("-").at(-1)!.split("/")[0]);
        expect(mesh.metadata.terrainZoom, mesh.name).toBe(z - Math.min(levels, z));
      }
    }
    it.each([0, 1, 3])("asks for each tile's elevation %i levels above it, and the patch four levels above that", async levels => {
      if (levels) settings.set("map.terrain.coarserElevation", levels);
      const { engine, scene, runtime, tiles } = start();
      try {
        const expected = new Set(tiles.flatMap(tile => {
          const elevation = up(tile, levels);
          return elevation.z ? [keyOf(up(elevation, 4)), keyOf(elevation)] : [keyOf(elevation)];
        }));
        expect(new Set(await resolveAll())).toEqual(expected);
        expectShownFrom(scene, runtime, levels);
      } finally { runtime.dispose(); engine.dispose(); }
    });
    it("asks again for what the view needs and shows when the levels change, keeping the shown terrain until it arrives", async () => {
      const { engine, scene, runtime, leaves, move } = start();
      try {
        // Choices that the arriving heights change settle first.
        for (let round = 0; round < 4 && (await resolveAll()).length; round++) runtime.update();
        expect(pending.terrain).toHaveLength(0);
        // Nothing is shown yet: each tile the view needs asks for its new elevation tile, without the coarse patch first.
        settings.set("map.terrain.coarserElevation", 2);
        const again = pending.terrain.map(load => keyOf(load.tile));
        expect(again.sort()).toEqual(leaves().map(tile => keyOf(up(tile, 2))).sort());
        // A note, or the same value, asks for nothing.
        settings.setNote("map.terrain.coarserElevation", "noted"); settings.set("map.terrain.coarserElevation", 2);
        expect(pending.terrain).toHaveLength(again.length);
        // Choosing again asks for the coarser tiles kept above them too.
        runtime.update();
        expect(pending.terrain.length).toBeGreaterThan(again.length);
        await resolveAll();
        expectShownFrom(scene, runtime, 2);
        // Closer in, the tiles shown until finer ones arrive ask again too.
        move(fine.zoomMeters / 8);
        const shown = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface).map(mesh => mesh.name.split("-").at(-1)!);
        const needed = new Set(leaves().map(keyOf));
        expect(shown.some(key => !needed.has(key))).toBe(true);
        const before = pending.terrain.length;
        settings.set("map.terrain.coarserElevation", 0);
        const asked = new Set(pending.terrain.slice(before).map(load => keyOf(load.tile)));
        for (const key of [...shown, ...needed]) expect(asked.has(key), key).toBe(true);
        runtime.update();
        // The tiles kept above ask for their own elevation and the coarse patch together, as new tiles do.
        const records = scene.meshes.filter(mesh => mesh.metadata?.mapSurface).map(mesh => mesh.name.split("-").at(-1)!.split("/").map(Number));
        const own = new Set(records.flatMap(([z, x, y]) => [keyOf({ z, x, y }), keyOf(up({ z, x, y }, 4))]));
        for (const key of await resolveAll()) expect(own.has(key), key).toBe(true);
        expectShownFrom(scene, runtime, 0);
      } finally { runtime.dispose(); engine.dispose(); }
    });
  });
  it("does not publish incoming DEM quality or geometry until the displayed buffer commit", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), changes = vi.fn();
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], onSurfaceChange: changes });
    try {
      runtime.update(); pending.imagery.forEach(loaded => loaded()); runtime.update();
      const displayed = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface);
      expect(displayed.length).toBeGreaterThan(0);
      const before = displayed.map(mesh => ({ mesh, quality: mesh.metadata.terrainZoom,
        positions: [...mesh.getVerticesData(VertexBuffer.PositionKind)!] }));
      const hit = runtime.sample(0.1, 0.1), revision = runtime.getRevision(); expect(hit).not.toBeNull(); changes.mockClear();
      await resolveFirstDetail();
      expect(runtime.getRevision()).toBe(revision); expect(runtime.sample(0.1, 0.1)).toEqual(hit);
      for (const record of before) {
        expect(record.mesh.metadata.terrainZoom).toBe(record.quality);
        expect([...record.mesh.getVerticesData(VertexBuffer.PositionKind)!]).toEqual(record.positions);
        expect(record.mesh.isVerticesDataPresent(VertexBuffer.NormalKind)).toBe(false);
      }
      expect(changes).toHaveBeenCalledWith("loading"); runtime.update();
      expect(runtime.getRevision()).toBeGreaterThan(revision);
      expect(before.some(record => record.mesh.metadata.terrainZoom > record.quality)).toBe(true);
      expect(changes).toHaveBeenLastCalledWith("geometry");
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it("discards superseded elevation completions and notifies terminal owner disposal", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), changes = vi.fn();
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], onSurfaceChange: changes });
    try {
      runtime.update(); pending.imagery.forEach(loaded => loaded()); runtime.update();
      const oldLoads = [...pending.terrain], revision = runtime.getRevision();
      const displayed = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface);
      const before = displayed.map(mesh => ({ mesh, positions: [...mesh.getVerticesData(VertexBuffer.PositionKind)!], quality: mesh.metadata.terrainZoom }));
      runtime.setTerrainSource({ id: "replacement-fixture", label: "Replacement", provider: "fixture", urlTemplate: "https://fixture.invalid/{z}/{x}/{y}", maxZoom: 15, attribution: "Fixture" });
      for (const load of oldLoads) load.resolve({ ...load.tile, size: 2, heights: new Float32Array([500, 500, 500, 500]) }); await flush();
      expect(runtime.getRevision()).toBe(revision);
      for (const record of before) { expect([...record.mesh.getVerticesData(VertexBuffer.PositionKind)!]).toEqual(record.positions); expect(record.mesh.metadata.terrainZoom).toBe(record.quality); }
      runtime.setSuspended(true); expect(changes).toHaveBeenLastCalledWith("status");
      runtime.dispose(); expect(changes).toHaveBeenLastCalledWith("disposed"); expect(runtime.sample(0.1, 0.1)).toBeNull();
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it("settles tiles whose first elevation a provider switch supersedes once the replacement arrives", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), loadEnd = vi.fn();
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view, onLoadEnd: loadEnd });
    const resolveAll = async () => { for (const load of pending.terrain.splice(0)) load.resolve({ ...load.tile, size: 2, heights: new Float32Array([100, 100, 100, 100]) }); await flush(); };
    try {
      runtime.update(); pending.imagery.splice(0).forEach(loaded => loaded()); runtime.update();
      const superseded = pending.terrain.splice(0);
      expect(superseded.length).toBeGreaterThan(0);
      runtime.setTerrainSource({ id: "test-elevation", label: "Test elevation", provider: "test", urlTemplate: "https://example.test/{z}/{x}/{y}.png", maxZoom: 15, attribution: "https://example.test" });
      for (const load of superseded) load.resolve({ ...load.tile, size: 2, heights: new Float32Array([500, 500, 500, 500]) });
      await flush(); runtime.update();
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBeGreaterThan(0);
      for (let round = 0; round < 4; round++) { await resolveAll(); pending.imagery.splice(0).forEach(loaded => loaded()); runtime.update(); }
      expect(pending.terrain).toHaveLength(0);
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBe(0);
      expect(loadEnd).toHaveBeenCalled();
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it("drops tiles that leave the selection before their elevation arrives, with the downloads they wait for", async () => {
    getAppSettings().set("map.terrain.reselectWhileMoving", 0);
    const engine = new NullEngine(), scene = new Scene(engine), loadEnd = vi.fn();
    scene.useRightHandedSystem = true;
    const camera = new GeospatialCamera("raster-camera", scene, { planetRadius: 6378137 });
    camera.addBehavior(new GeospatialClippingBehavior());
    const controller = new CameraController(camera);
    const current = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 20_000, pitchDeg: 0, headingDeg: 0 };
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => current, onLoadEnd: loadEnd });
    const look = (latDeg: number, lonDeg: number) => {
      Object.assign(current, { latDeg, lonDeg });
      controller.applyViewState(current);
      scene.render(); runtime.update();
    };
    const tiles = () => new Set(scene.meshes.filter(mesh => mesh.name.startsWith("raster-basemap-tile-") && !mesh.isDisposed()).map(mesh => mesh.name.split("-").at(-1)!));
    try {
      look(36.1, -112.14);
      const first = pending.terrain.splice(0), firstTiles = tiles();
      expect(first.length).toBeGreaterThan(0);
      look(-33.9, 151.2);
      await flush();
      // The first view's own tiles are gone and their claims withdrawn; what both views need stays and still loads.
      const left = [...firstTiles].filter(key => !tiles().has(key));
      expect(left.length).toBeGreaterThan(0);
      expect(left.every(key => Number(key.split("/")[0]) > 2)).toBe(true);
      const withdrawn = first.filter(load => load.interest?.released);
      expect(withdrawn.length).toBeGreaterThan(0);
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBe(runtime.getMetrics().activeTiles);
      // The second view settles and the load cycle ends without the first view's tiles.
      const live = first.filter(load => !load.interest?.released);
      for (let round = 0; round < 6; round++) {
        for (const load of [...live.splice(0), ...pending.terrain.splice(0)]) load.resolve({ ...load.tile, size: 2, heights: new Float32Array([100, 100, 100, 100]) });
        await flush(); pending.imagery.splice(0).forEach(loaded => loaded()); scene.render(); runtime.update();
      }
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBe(0);
      expect(loadEnd).toHaveBeenCalled();
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it("goes on to a tile's own elevation when it arrives before the coarse patch, and drops the coarse patch", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const patches: Array<{ tile: TerrainTile; interest?: TerrainInterest; resolve(grid: TerrainGrid): void }> = [];
    const holds: Array<{ tile: TerrainTile; interest: TerrainInterest }> = [];
    const arrivals = new Map<string, { arrive(): void; interest: TerrainInterest }>();
    const key = (tile: TerrainTile) => `${tile.z}/${tile.x}/${tile.y}`;
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view,
      createTerrainLoader: () => ({ dispose() {}, setPaused() {}, getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }),
        load: () => new Promise<TerrainGrid>(() => {}),
        loadPatch: (tile: TerrainTile, interest?: TerrainInterest) => new Promise<TerrainGrid>((resolve, reject) => {
          patches.push({ tile, interest, resolve });
          interest?.onRelease(() => reject(Object.assign(new Error("Terrain request withdrawn"), { name: "TerrainWithdrawn" })));
        }),
        holdPatch: (tile: TerrainTile, interest: TerrainInterest) => { holds.push({ tile, interest }); },
        whenLoaded: (tile: TerrainTile, interest: TerrainInterest) => new Promise<void>(arrive => { arrivals.set(key(tile), { arrive, interest }); }),
      }) });
    const grid = (tile: TerrainTile): TerrainGrid => ({ ...tile, size: 2, heights: new Float32Array([100, 100, 100, 100]) });
    try {
      runtime.update(); pending.imagery.splice(0).forEach(loaded => loaded()); runtime.update();
      // Every tile asks for its own elevation and its coarse patch together. Here the coarse patch is level 0.
      expect(patches.length).toBeGreaterThan(1);
      expect(patches.some(patch => patch.tile.z === 0)).toBe(true);
      expect(patches.some(patch => patch.tile.z > 0)).toBe(true);
      const meshOf = (tile: string) => scene.meshes.find(mesh => mesh.name.split("-").at(-1) === tile);
      const [own, { arrive, interest: coarse }] = [...arrivals].find(([tile]) => meshOf(tile))!;
      const mesh = meshOf(own)!;
      // Each tile holds its own patch for itself and its coarse patch for as long as it waits for its own elevation.
      const coarsePatch = patches.find(patch => patch.interest === coarse)!;
      expect(holds.some(hold => key(hold.tile) === key(coarsePatch.tile) && hold.interest === coarse)).toBe(true);
      expect(holds.some(hold => key(hold.tile) === own && hold.interest !== coarse && !hold.interest.released)).toBe(true);
      arrive(); await flush();
      expect(coarse.released).toBe(true);
      const detail = patches.find(patch => key(patch.tile) === own)!;
      expect(detail).toBeDefined();
      detail.resolve(grid(detail.tile)); await flush(); runtime.update();
      expect(mesh.metadata.terrainZoom).toBe(detail.tile.z);
      // The coarse patch arriving later changes nothing.
      for (const patch of patches.filter(patch => patch.tile.z === 0)) patch.resolve(grid(patch.tile));
      await flush(); runtime.update();
      expect(mesh.metadata.terrainZoom).toBe(detail.tile.z);
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it("settles tiles whose elevation fails, before or after a provider switch", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), loadEnd = vi.fn(), errors = vi.fn();
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view, onLoadEnd: loadEnd, onLoadError: errors, nowMs: () => 0 });
    const failAll = async () => { for (const load of pending.terrain.splice(0)) load.reject(new Error("Synthetic elevation failure")); await flush(); };
    try {
      runtime.update(); pending.imagery.splice(0).forEach(loaded => loaded()); runtime.update();
      const superseded = pending.terrain.splice(0);
      runtime.setTerrainSource({ id: "test-elevation", label: "Test elevation", provider: "test", urlTemplate: "https://example.test/{z}/{x}/{y}.png", maxZoom: 15, attribution: "https://example.test" });
      for (const load of superseded) load.reject(new Error("Superseded elevation failure"));
      await failAll(); runtime.update();
      for (let round = 0; round < 4; round++) { await failAll(); pending.imagery.splice(0).forEach(loaded => loaded()); runtime.update(); }
      expect(errors).toHaveBeenCalled();
      expect(errors.mock.calls.every(([error]) => error.message === "Synthetic elevation failure")).toBe(true);
      expect(runtime.getLoadingDiagnostics!().pendingTiles).toBe(0);
      expect(loadEnd).toHaveBeenCalled();
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it("keeps the displayed terrain alive while an elevation provider switches", async () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    runtime.update();
    pending.imagery.forEach(loaded => loaded());
    await resolveFirstDetail();
    runtime.update();
    const revision = runtime.getRevision();
    const meshes = scene.meshes.filter(mesh => mesh.metadata?.mapSurface);
    pending.dispose.mockClear();
    runtime.setTerrainSource({ id: "test-elevation", label: "Test elevation", provider: "test", urlTemplate: "https://example.test/{z}/{x}/{y}.png", maxZoom: 15, attribution: "https://example.test" });
    expect(pending.dispose).toHaveBeenCalledOnce();
    expect(meshes.every(mesh => !mesh.isDisposed())).toBe(true);
    runtime.update();
    expect(runtime.getRevision()).toBe(revision);
    runtime.dispose(); engine.dispose();
  });
  it("invalidates retained revisions and notifies when a terrain commit fails after a write", async () => {
    const engine = new NullEngine(), scene = new Scene(engine), changes = vi.fn();
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], onSurfaceChange: changes });
    try {
      runtime.update(); pending.imagery.forEach(loaded => loaded()); runtime.update(); await resolveFirstDetail();
      const revision = runtime.getRevision(); changes.mockClear();
      const stitch = vi.spyOn(refinement, "stitchTerrainEdges").mockImplementationOnce(() => { throw new Error("Synthetic seam commit failed"); });
      expect(() => runtime.update()).toThrow("Synthetic seam commit failed");
      expect(runtime.getRevision()).toBeGreaterThan(revision); expect(changes).toHaveBeenLastCalledWith("geometry");
      stitch.mockRestore(); runtime.update(); expect(runtime.getRevision()).toBeGreaterThan(revision + 1);
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it("versions a visible mesh replacement and retains its outgoing owner when disposal fails", () => {
    const engine = new NullEngine(), scene = new Scene(engine), changes = vi.fn();
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], onSurfaceChange: changes,
      nowMs: () => 0, meshRebuildCpuMs: () => 2 });
    try {
      runtime.update(); pending.imagery.forEach(loaded => loaded()); runtime.update();
      const outgoing = scene.meshes.find(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface)!;
      expect(outgoing).toBeDefined(); const revision = runtime.getRevision();
      vi.spyOn(outgoing, "dispose").mockImplementationOnce(() => { throw new Error("Synthetic mesh release failed"); });
      settings.set("map.terrain.tileSegments", 32); changes.mockClear();
      expect(() => runtime.update()).toThrow("Synthetic mesh release failed");
      expect(runtime.getRevision()).toBeGreaterThan(revision); expect(changes).toHaveBeenLastCalledWith("geometry");
      expect(outgoing.isEnabled()).toBe(false); expect(outgoing.isDisposed()).toBe(false);
      runtime.dispose(); expect(outgoing.isDisposed()).toBe(true);
    } finally { runtime.dispose(); engine.dispose(); }
  });
  it.each([false, true])("commits terrain once and idles when settled (alwaysRefresh=%s)", async alwaysRefresh => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stitch = vi.spyOn(refinement, "stitchTerrainEdges");
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], alwaysRefresh,
      getViewState: () => view });
    runtime.update();
    pending.imagery.forEach(loaded => loaded());
    await resolveFirstDetail();
    // Load callbacks only enqueue adoption; no seam pass between frames.
    expect(stitch).not.toHaveBeenCalled();
    now = 600;
    runtime.update();
    expect(stitch).toHaveBeenCalledOnce();
    const revision = runtime.getRevision();
    now = 1300;
    runtime.update();
    expect(stitch).toHaveBeenCalledOnce();
    expect(runtime.getRevision()).toBe(revision);
    const settled = runtime.getRevision();
    const writes = scene.meshes.map(mesh => vi.spyOn(mesh, "updateVerticesData"));
    now = 2000;
    runtime.update(); runtime.update();
    expect(stitch).toHaveBeenCalledOnce();
    expect(runtime.getRevision()).toBe(settled);
    expect(writes.every(write => write.mock.calls.length === 0)).toBe(true);
    runtime.dispose(); engine.dispose();
  });
  // Terrain preparation holds the camera still. A failed load must still be
  // asked for again, or the readiness gate waits on coarse terrain forever.
  it("retries failed detail elevation while the camera holds still", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    runtime.update();
    pending.imagery.forEach(loaded => loaded());
    const detail = pending.terrain.find(item => item.tile.z > 0)!;
    detail.reject(new Error("Terrain request failed (503)"));
    await flush();
    const requests = pending.terrain.length;
    runtime.update();
    expect(pending.terrain).toHaveLength(requests);
    now = 60_000;
    runtime.update();
    const retried = pending.terrain.slice(requests).find(item => item.tile.z === detail.tile.z
      && item.tile.x === detail.tile.x && item.tile.y === detail.tile.y);
    expect(retried).toBeDefined();
    retried!.resolve({ ...retried!.tile, size: 2, heights: new Float32Array([250, 250, 250, 250]) });
    await flush();
    // Incoming grid metadata becomes displayed quality only with its positions.
    runtime.update();
    expect(scene.meshes.some(mesh => mesh.metadata?.terrainZoom === detail.tile.z)).toBe(true);
    runtime.dispose(); engine.dispose();
  });
  it("retries failed imagery while the camera holds still", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    runtime.update();
    const requests = pending.imagery.length;
    expect(requests).toBeGreaterThan(0);
    pending.imageryErrors.forEach(fail => fail("503"));
    runtime.update();
    expect(pending.imagery).toHaveLength(requests);
    now = 60_000;
    runtime.update();
    expect(pending.imagery.length).toBeGreaterThan(requests);
    runtime.dispose(); engine.dispose();
  });
  it("ignores late terrain completions after disposal", async () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    runtime.update(); runtime.dispose();
    for (const item of pending.terrain) item.resolve({ ...item.tile, size: 1, heights: new Float32Array([100]) });
    await Promise.resolve(); await Promise.resolve();
    expect(scene.meshes).toHaveLength(0);
    expect(pending.dispose).toHaveBeenCalledOnce();
    engine.dispose();
  });

  describe("orbiting LOD retention, local uniformity, and safe space", () => {
    const tileKeyOfMesh = (meshName: string) => meshName.split("-").at(-1)!;
    const zoomOfKey = (key: string) => Number(key.split("/")[0]);
    const createHdEngine = () => {
      const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 });
      Object.assign(engine, { updateTextureData: vi.fn() });
      return engine;
    };

    it("does not overwrite a tile's own HD elevation with its z-4 coarse stand-in when both resolve before mesh commit", async () => {
      getAppSettings().set("map.terrain.reselectWhileMoving", 0);
      getAppSettings().set("map.terrain.robustOrbitLOD", true);
      const engine = createHdEngine(), scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new GeospatialCamera("raster-camera", scene, { planetRadius: 6378137 });
      camera.addBehavior(new GeospatialClippingBehavior());
      const controller = new CameraController(camera);
      const currentView = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 300, pitchDeg: 20, headingDeg: 0 };
      const runtime = createRasterTilesRuntime({
        scene,
        source: RASTER_BASE_MAP_SOURCES[0],
        imagery: "atlas",
        getViewState: () => currentView,
        getRefinePoint: () => ({ x: camera.center.x, y: camera.center.y, z: camera.center.z }),
      });
      try {
        controller.applyViewState(currentView, 0);
        controller.applyViewState(currentView, 0);
        scene.render();
        runtime.update();

        getAppSettings().set("map.terrain.meshRebuildTimePerFrame", 50);
        // Settle terrain with detail (fine) tiles resolving before their coarse stand-ins (b - a).
        // Under robustOrbitLOD, a tile's own HD elevation must not be overwritten by its z-4 stand-in.
        for (let round = 0; round < 6 && pending.terrain.length; round++) {
          const batch = pending.terrain.splice(0);
          const zooms = [...new Set(batch.map(load => load.tile.z))].sort((a, b) => b - a);
          for (const z of zooms) {
            for (const load of batch.filter(item => item.tile.z === z)) {
              load.resolve({ ...load.tile, size: 2, heights: new Float32Array([150, 150, 150, 150]) });
            }
            await flush();
            scene.render();
            runtime.update();
          }
        }
        const visibleFine = scene.meshes.filter(
          mesh => mesh.isEnabled() && mesh.metadata?.mapSurface && zoomOfKey(tileKeyOfMesh(mesh.name)) >= 12,
        );
        expect(visibleFine.length).toBeGreaterThan(0);
        for (const mesh of visibleFine) {
          const z = zoomOfKey(tileKeyOfMesh(mesh.name));
          expect(mesh.metadata.terrainZoom, mesh.name).toBe(z);
        }
      } finally {
        getAppSettings().set("map.terrain.robustOrbitLOD", false);
        runtime.dispose();
        engine.dispose();
      }
    });

    it("retains recently viewed HD tiles in cache across a 360-degree orbit instead of evicting them", async () => {
      getAppSettings().set("map.terrain.reselectWhileMoving", 0);
      getAppSettings().set("map.terrain.meshRebuildTimePerFrame", 500);
      getAppSettings().set("map.terrain.robustOrbitLOD", true);
      const engine = createHdEngine(), scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new GeospatialCamera("raster-camera", scene, { planetRadius: 6378137 });
      camera.addBehavior(new GeospatialClippingBehavior());
      const controller = new CameraController(camera);
      // In GlobeViewState, pitchDeg=20 is 20deg above the horizon (70deg tilt from nadir).
      const currentView = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 300, pitchDeg: 20, headingDeg: 0 };
      const runtime = createRasterTilesRuntime({
        scene,
        source: RASTER_BASE_MAP_SOURCES[0],
        imagery: "atlas",
        getViewState: () => currentView,
        getRefinePoint: () => ({ x: camera.center.x, y: camera.center.y, z: camera.center.z }),
      });
      const settleTerrain = async () => {
        for (let round = 0; round < 10 && pending.terrain.length; round++) {
          const batch = pending.terrain.splice(0);
          const zooms = [...new Set(batch.map(load => load.tile.z))].sort((a, b) => a - b);
          for (const z of zooms) {
            for (const load of batch.filter(item => item.tile.z === z)) {
              load.resolve({ ...load.tile, size: 2, heights: new Float32Array([150, 150, 150, 150]) });
            }
            await flush();
            scene.render();
            runtime.update();
          }
        }
      };
      try {
        controller.applyViewState(currentView, 0);
        controller.applyViewState(currentView, 0);
        scene.render();
        runtime.update();
        await settleTerrain();

        const initialHdMeshes = scene.meshes.filter(
          mesh => mesh.isEnabled() && mesh.metadata?.mapSurface && zoomOfKey(tileKeyOfMesh(mesh.name)) >= 12,
        );
        expect(initialHdMeshes.length).toBeGreaterThan(0);

        // Orbit around the target through 90, 180, 270 and back to 0.
        for (const headingDeg of [90, 180, 270, 0]) {
          currentView.headingDeg = headingDeg;
          controller.applyViewState(currentView, 0);
          scene.render();
          runtime.update();
          if (headingDeg !== 0) await settleTerrain();
        }

        // Settled HD tiles from heading=0 should still be in cache when completing the orbit back to heading=0.
        const disposedCount = initialHdMeshes.filter(mesh => mesh.isDisposed()).length;
        expect(disposedCount).toBe(0);
      } finally {
        getAppSettings().set("map.terrain.robustOrbitLOD", false);
        runtime.dispose();
        engine.dispose();
      }
    });

    it("does not hold back settled in-frustum HD tiles behind a coarse ancestor while an out-of-frustum sibling leaf waits at the back of the queue", async () => {
      getAppSettings().set("map.terrain.reselectWhileMoving", 0);
      getAppSettings().set("map.terrain.meshRebuildTimePerFrame", 500);
      getAppSettings().set("map.terrain.cachedTiles", 2000);
      getAppSettings().set("map.terrain.robustOrbitLOD", true);
      const engine = createHdEngine(), scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new GeospatialCamera("raster-camera", scene, { planetRadius: 6378137 });
      camera.addBehavior(new GeospatialClippingBehavior());
      const controller = new CameraController(camera);
      // Start at heading=180deg (looking South) so the Northern tiles behind the camera settle as coarse z=8..10 leaves.
      const currentView = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 1200, pitchDeg: 15, headingDeg: 180 };
      const runtime = createRasterTilesRuntime({
        scene,
        source: RASTER_BASE_MAP_SOURCES[0],
        imagery: "atlas",
        getViewState: () => currentView,
        getRefinePoint: () => ({ x: camera.center.x, y: camera.center.y, z: camera.center.z }),
      });
      const settleTerrain = async () => {
        for (let round = 0; round < 10 && pending.terrain.length; round++) {
          const batch = pending.terrain.splice(0);
          const zooms = [...new Set(batch.map(load => load.tile.z))].sort((a, b) => a - b);
          for (const z of zooms) {
            for (const load of batch.filter(item => item.tile.z === z)) {
              load.resolve({ ...load.tile, size: 2, heights: new Float32Array([200, 200, 200, 200]) });
            }
            await flush();
            scene.render();
            runtime.update();
          }
        }
      };
      try {
        controller.applyViewState(currentView, 0);
        controller.applyViewState(currentView, 0);
        scene.render();
        runtime.update();
        await settleTerrain();

        // Orbit to heading=0deg (looking North): the coarse Northern leaves (z=8..10) split down to z=14.
        // In-frustum children (needed=true) are queued first, while out-of-frustum sibling leaves (needed=false)
        // created by the quadtree splits are queued at the very back of lastDesired.
        currentView.headingDeg = 0;
        controller.applyViewState(currentView, 0);
        scene.render();
        runtime.update();

        // Resolve 100% of terrain loads for tiles inside the camera frustum, leaving only out-of-frustum
        // sibling leaves waiting at the back of the elevation queue.
        for (let round = 0; round < 12; round++) {
          const currentPlanes = Frustum.GetPlanes(camera.getTransformationMatrix());
          const ready = pending.terrain.filter(load => {
            const mesh = scene.meshes.find(m => tileKeyOfMesh(m.name) === `${load.tile.z}/${load.tile.x}/${load.tile.y}`);
            return !mesh || mesh.isInFrustum(currentPlanes);
          });
          if (!ready.length) break;
          for (const load of ready) {
            const idx = pending.terrain.indexOf(load);
            if (idx >= 0) pending.terrain.splice(idx, 1);
          }
          const zooms = [...new Set(ready.map(load => load.tile.z))].sort((a, b) => a - b);
          for (const z of zooms) {
            for (const load of ready.filter(item => item.tile.z === z)) {
              load.resolve({ ...load.tile, size: 2, heights: new Float32Array([200, 200, 200, 200]) });
            }
            await flush();
            scene.render();
            runtime.update();
          }
        }

        const visibleWhileOutOfFrustumPending = new Set(
          scene.meshes
            .filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface && zoomOfKey(tileKeyOfMesh(mesh.name)) >= 12)
            .map(mesh => tileKeyOfMesh(mesh.name)),
        );

        // Now resolve the remaining out-of-frustum sibling leaves.
        await settleTerrain();
        const visibleAfterAllSettle = new Set(
          scene.meshes
            .filter(mesh => mesh.isEnabled() && mesh.metadata?.mapSurface && zoomOfKey(tileKeyOfMesh(mesh.name)) >= 12)
            .map(mesh => tileKeyOfMesh(mesh.name)),
        );

        const finalPlanes = Frustum.GetPlanes(camera.getTransformationMatrix());
        const inFrustumHdTiles = [...visibleAfterAllSettle].filter(key => {
          const mesh = scene.meshes.find(m => tileKeyOfMesh(m.name) === key);
          return mesh ? mesh.isInFrustum(finalPlanes) : false;
        });
        expect(inFrustumHdTiles.length).toBeGreaterThan(0);
        const heldBackInFrustumHdTiles = inFrustumHdTiles.filter(key => !visibleWhileOutOfFrustumPending.has(key));
        expect(heldBackInFrustumHdTiles).toEqual([]);
      } finally {
        getAppSettings().set("map.terrain.robustOrbitLOD", false);
        runtime.dispose();
        engine.dispose();
      }
    });

    it("does not jolt the camera upward via safe space when orbiting places the camera eye over recently viewed valley terrain", async () => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      getAppSettings().set("map.terrain.reselectWhileMoving", 0);
      getAppSettings().set("map.terrain.meshRebuildTimePerFrame", 50);
      getAppSettings().set("map.terrain.cachedTiles", 2000);
      getAppSettings().set("map.terrain.robustOrbitLOD", true);
      const engine = createHdEngine(), scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new GeospatialCamera("raster-camera", scene, { planetRadius: 6378137 });
      camera.addBehavior(new GeospatialClippingBehavior());
      const controller = new CameraController(camera, () => now);
      // Target is in a valley at 0m; coarse tiles (z <= 10) bridge the canyon walls at 20m
      // (so at z=10, bounds.max + lift = 20 + 50 + 12 = 82m < 87m eye altitude, causing selectTerrain to cull 10/193/511
      // below the bottom frustum plane when the eye is over it), while fine tiles (z >= 11) resolve the valley floor at 0m.
      const heightForLevel = (z: number) => (z >= 11 ? 0 : 20);

      const runtime = createRasterTilesRuntime({
        scene,
        source: RASTER_BASE_MAP_SOURCES[0],
        imagery: "atlas",
        nowMs: () => now,
        getViewState: () => controller.syncFromCamera(),
      });
      controller.configureOrbitTargetHeight({
        resolveSurfaceHeightMeters: (latDeg, lonDeg) => runtime.sample(latDeg, lonDeg)?.heightMeters ?? null,
      });
      controller.setEyeContact({
        enabled: true,
        clearanceMeters: 70,
        maxAccelerationMetersPerSecondSquared: 200,
        glideKeepPerFrame: 0.9,
      });

      const resolveAllPending = async () => {
        for (let round = 0; round < 6 && pending.terrain.length; round++) {
          const batch = pending.terrain.splice(0);
          const zooms = [...new Set(batch.map(load => load.tile.z))].sort((a, b) => a - b);
          for (const z of zooms) {
            for (const load of batch.filter(item => item.tile.z === z)) {
              const h = heightForLevel(load.tile.z);
              load.resolve({ ...load.tile, size: 2, heights: new Float32Array([h, h, h, h]) });
            }
            await flush();
            runtime.update();
          }
        }
      };

      try {
        // 1. Start at heading=0, pitch=5 (85deg tilt from nadir), zoom=1000m looking North across the valley near the equator boundary.
        //    The camera eye is at ~87m altitude (1000*sin(5deg)), well above the 0m valley floor + 70m safe-space clearance.
        controller.applyViewState({ latDeg: -0.00895, lonDeg: -112.0, zoomMeters: 1000, pitchDeg: 5, headingDeg: 0 }, 0);
        controller.applyViewState({ latDeg: -0.00895, lonDeg: -112.0, zoomMeters: 1000, pitchDeg: 5, headingDeg: 0 }, 0);
        scene.render();
        runtime.update();
        await resolveAllPending();

        // Prime the safe-space clock at heading=0.
        controller.stepEyeContact();
        now += 16;
        expect(controller.stepEyeContact()).toBe(false);
        const centerAltBeforeOrbit = ecefToGeodetic(camera.center.x, camera.center.y, camera.center.z).altMeters;
        expect(centerAltBeforeOrbit).toBeCloseTo(0, 1);

        // 2. Orbit 180deg so the camera eye swings around to the North side of the target (lat ~ +0.00006deg, inside 10/193/511)—
        //    the exact valley region that was just in front of the camera in HD at heading=0!
        controller.applyViewState({ latDeg: -0.00895, lonDeg: -112.0, zoomMeters: 1000, pitchDeg: 5, headingDeg: 180 }, 0);
        scene.render();
        now += 16;
        runtime.update();
        await resolveAllPending();

        const eyeGeodetic = ecefToGeodetic(camera.position.x, camera.position.y, camera.position.z);
        const eyeLatDeg = (eyeGeodetic.latRad * 180) / Math.PI;
        const eyeLonDeg = (eyeGeodetic.lonRad * 180) / Math.PI;
        const sampledUnderEye = runtime.sample(eyeLatDeg, eyeLonDeg);
        expect(sampledUnderEye).not.toBeNull();

        // Stepping safe space while hovering over the valley should NOT jolt the camera upward!
        now += 16;
        controller.stepEyeContact();
        now += 16;
        controller.stepEyeContact();
        const centerAltAfterOrbit = ecefToGeodetic(camera.center.x, camera.center.y, camera.center.z).altMeters;
        expect(centerAltAfterOrbit).toBeCloseTo(centerAltBeforeOrbit, 1);
        // Ground directly under the camera eye must sample the fine 0m valley floor, not the coarse 20m canyon-wall mesh!
        expect(sampledUnderEye!.heightMeters).toBeLessThan(10);
      } finally {
        getAppSettings().set("map.terrain.robustOrbitLOD", false);
        runtime.dispose();
        engine.dispose();
      }
    });
  });
});

