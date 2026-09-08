import { NullEngine, Scene, Texture } from "@babylonjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    loadPatch: (tile: TerrainTile) => new Promise<TerrainGrid>((resolve, reject) => pending.terrain.push({ tile, resolve, reject })) }),
}));
beforeEach(() => { pending.imagery = []; pending.terrain = []; pending.dispose.mockClear(); });
const view = { latDeg: 0, lonDeg: 0, zoomMeters: 8000000, headingDeg: 0 };

describe("raster imagery and terrain lifecycle", () => {
  it("displays real global fallback and refines the same mesh when terrain arrives", async () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    const runtime = createRasterTilesRuntime({ scene, source: RASTER_BASE_MAP_SOURCES[0], getViewState: () => view });
    runtime.update();
    pending.imagery.forEach(loaded => loaded());
    expect(runtime.getMetrics().visibleTiles).toBeGreaterThan(0);
    const beforeRevision = runtime.getRevision();
    const beforeMeshes = scene.meshes.filter(mesh => mesh.isEnabled());
    expect(beforeMeshes.every(mesh => mesh.metadata?.terrainZoom === 0)).toBe(true);
    const first = pending.terrain[0];
    first.resolve({ ...first.tile, size: 2, heights: new Float32Array([250, 250, 250, 250]) });
    await Promise.resolve(); await Promise.resolve();
    runtime.update();
    expect(runtime.getRevision()).toBeGreaterThan(beforeRevision);
    expect(beforeMeshes.every(mesh => !mesh.isDisposed())).toBe(true);
    expect(scene.meshes.filter(mesh => mesh.isEnabled()).every(mesh => mesh.metadata?.mapSurface)).toBe(true);
    runtime.dispose();
    expect(scene.meshes).toHaveLength(0);
    engine.dispose();
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
