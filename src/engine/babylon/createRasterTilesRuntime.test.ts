import { NullEngine, Scene, StandardMaterial, Texture } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as refinement from "../../terrain/meshRefinement";
import { createTerrainPerformanceCapture } from "../../terrain/terrainPerformanceCapture";
import type { TerrainGrid, TerrainTile } from "../../terrain/terrainTiles";
import { createRasterTilesRuntime } from "./createRasterTilesRuntime";
import { RASTER_BASE_MAP_SOURCES } from "./rasterBaseMaps";

const pending = vi.hoisted(() => ({
  imagery: [] as Array<() => void>,
  imageryErrors: [] as Array<(message?: string) => void>,
  terrain: [] as Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void; reject(error: Error): void }>,
  dispose: vi.fn(),
}));
vi.mock("./loadMapTexture", () => ({ loadMapTexture: (_url: string, scene: Scene, loaded: () => void, failed: (message?: string) => void) => {
  pending.imagery.push(loaded); pending.imageryErrors.push(failed); return new Texture(null, scene);
} }));
vi.mock("../../terrain/terrainTiles", async importOriginal => ({
  ...await importOriginal<typeof import("../../terrain/terrainTiles")>(),
  createTerrainTileLoader: () => ({ dispose: pending.dispose,
    getMetrics: () => ({ active: 0, queued: 0, decodedBytes: 0 }),
    loadPatch: (tile: TerrainTile) => new Promise<TerrainGrid>((resolve, reject) => pending.terrain.push({ tile, resolve, reject })) }),
}));
beforeEach(() => { pending.imagery = []; pending.imageryErrors = []; pending.terrain = []; pending.dispose.mockClear(); });
afterEach(() => vi.restoreAllMocks());
const view = { latDeg: 0, lonDeg: 0, zoomMeters: 8000000, headingDeg: 0 };
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
    const coarse = pending.terrain[0];
    coarse.resolve({ ...coarse.tile, size: 2, heights: new Float32Array([100, 100, 100, 100]) });
    await flush();
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
