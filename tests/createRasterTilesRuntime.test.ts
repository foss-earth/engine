import { Frustum, GeospatialCamera, GeospatialClippingBehavior, NullEngine, Scene, StandardMaterial, Texture, VertexBuffer } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCameraController as CameraController } from "../fixtures/composition/runtimeHost.js";
import * as refinement from "../src/babylon/meshRefinement.js";
import * as selector from "../src/terrain/terrainSelector.js";
import { createTerrainMesh } from "../src/babylon/terrainMesh.js";
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
  terrain: [] as Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void; reject(error: Error): void; interest?: TerrainInterest }>,
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
      loadPatch: (tile: TerrainTile, interest?: TerrainInterest) => new Promise<TerrainGrid>((resolve, reject) => {
        pending.terrain.push({ tile, resolve, reject, interest });
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
});
