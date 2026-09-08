import { NullEngine, Scene, Texture } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as refinement from "../../terrain/meshRefinement";
import { createTerrainPerformanceCapture } from "../../terrain/terrainPerformanceCapture";
import type { TerrainGrid, TerrainTile } from "../../terrain/terrainTiles";
import { createRasterTilesRuntime } from "./createRasterTilesRuntime";
import { RASTER_BASE_MAP_SOURCES } from "./rasterBaseMaps";

const pending = vi.hoisted(() => ({
  imagery: [] as Array<() => void>,
  terrain: [] as Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void; reject(error: Error): void }>,
  dispose: vi.fn(),
}));
vi.mock("./loadMapTexture", () => ({ loadMapTexture: (_url: string, scene: Scene, loaded: () => void) => {
  pending.imagery.push(loaded); return new Texture(null, scene);
} }));
vi.mock("../../terrain/terrainTiles", async importOriginal => ({
  ...await importOriginal<typeof import("../../terrain/terrainTiles")>(),
  createTerrainTileLoader: () => ({ dispose: pending.dispose,
    getMetrics: () => ({ active: 0, queued: 0, decodedBytes: 0 }),
    loadPatch: (tile: TerrainTile) => new Promise<TerrainGrid>((resolve, reject) => pending.terrain.push({ tile, resolve, reject })) }),
}));
beforeEach(() => { pending.imagery = []; pending.terrain = []; pending.dispose.mockClear(); });
afterEach(() => vi.restoreAllMocks());
const view = { latDeg: 0, lonDeg: 0, zoomMeters: 8000000, headingDeg: 0 };
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
  it.each([false, true])("processes one refinement pass per update (alwaysRefresh=%s) and idles when settled", async alwaysRefresh => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stitch = vi.spyOn(refinement, "stitchTerrainEdges");
    const advance = vi.spyOn(refinement, "advanceRefinement");
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
    expect(advance).toHaveBeenCalledOnce();
    const revision = runtime.getRevision();
    now = 1300;
    runtime.update();
    expect(stitch).toHaveBeenCalledTimes(2);
    expect(runtime.getRevision()).toBe(revision + 1);
    const settled = runtime.getRevision();
    const writes = scene.meshes.map(mesh => vi.spyOn(mesh, "updateVerticesData"));
    now = 2000;
    runtime.update(); runtime.update();
    expect(stitch).toHaveBeenCalledTimes(2);
    expect(runtime.getRevision()).toBe(settled);
    expect(writes.every(write => write.mock.calls.length === 0)).toBe(true);
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
