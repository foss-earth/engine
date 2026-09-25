import { GeospatialCamera, NullEngine, Scene } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../../camera/cameraState";
import * as refinement from "../../terrain/meshRefinement";
import type { TerrainGrid, TerrainTile } from "../../terrain/terrainTiles";
import { createRasterTilesRuntime } from "./createRasterTilesRuntime";
import type { ImageryLoader, PreparedImage } from "./imagery/imageryResidency";
import { RASTER_BASE_MAP_SOURCES } from "./rasterBaseMaps";

const pending = vi.hoisted(() => ({
  terrain: [] as Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void; reject(error: Error): void }>,
  legacyImagery: 0,
}));
vi.mock("./loadMapTexture", () => ({ loadMapTexture: () => { pending.legacyImagery += 1; throw new Error("The atlas path must not load per-tile textures."); } }));
vi.mock("../../terrain/terrainTiles", async importOriginal => ({
  ...await importOriginal<typeof import("../../terrain/terrainTiles")>(),
  createTerrainTileLoader: () => ({ dispose: vi.fn(),
    getMetrics: () => ({ active: 0, queued: 0, decodedBytes: 0 }),
    loadPatch: (tile: TerrainTile) => new Promise<TerrainGrid>((resolve, reject) => pending.terrain.push({ tile, resolve, reject })) }),
}));
beforeEach(() => { pending.terrain = []; pending.legacyImagery = 0; });
afterEach(() => vi.restoreAllMocks());

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function imageryLoader() {
  const urls: string[] = [];
  const loader: ImageryLoader = {
    async load(url, expected): Promise<PreparedImage> {
      urls.push(url);
      const pages = (expected.width / 256) * (expected.height / 256);
      return { width: expected.width, height: expected.height, compressedBytes: 10, pages: Array.from({ length: pages }, () => [new Uint8Array(4)]) };
    },
  };
  return { loader, urls };
}

async function setup(sourceIndex = 0) {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 });
  // NullEngine has no sub-image upload; the atlas only needs it to exist.
  Object.assign(engine, { updateTextureData: vi.fn() });
  // NullEngine reports a 512 px limit; a real GPU allows the atlas.
  engine.getCaps().maxTextureSize = 8192;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("atlas-camera", scene, { planetRadius: 6378137 });
  const controller = new CameraController(camera);
  const view = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 30_000, pitchDeg: 30, headingDeg: 0 };
  controller.applyViewState(view);
  const { loader, urls } = imageryLoader();
  const onDetailFeedback = vi.fn();
  const runtime = createRasterTilesRuntime({
    scene, source: RASTER_BASE_MAP_SOURCES[sourceIndex], getViewState: () => view,
    imagery: "atlas", imageryLoader: loader, onDetailFeedback,
  });
  const settle = async () => {
    for (let round = 0; round < 40; round++) {
      runtime.update();
      scene.render();
      await flush();
      for (const item of pending.terrain.splice(0)) {
        item.resolve({ ...item.tile, size: 2, heights: new Float32Array([100 + item.tile.z, 100, 100, 100]) });
      }
      await flush();
    }
  };
  return { engine, scene, runtime, urls, settle, onDetailFeedback, camera, controller, view };
}

describe("raster runtime with atlas imagery", () => {
  it("draws terrain from atlas coverage without per-tile textures, and reports raster detail as supported", async () => {
    const { runtime, settle, engine, urls } = await setup();
    await settle();
    expect(pending.legacyImagery).toBe(0);
    expect(runtime.getMetrics().visibleTiles).toBeGreaterThan(0);
    expect(runtime.getDetailFeedback().support).toBe("ready");
    const diagnostics = runtime.getImageryDiagnostics();
    expect(diagnostics.mode).toBe("atlas");
    expect(diagnostics.atlas?.binding.blocks).toBeGreaterThan(0);
    // The sixteen root tiles of fallback coverage were requested first.
    expect(urls.slice(0, 16).every(url => /\/2\/\d\/\d$/.test(url))).toBe(true);
    runtime.dispose();
    engine.dispose();
  });

  it("changes imagery level and source without touching terrain, elevation requests or the surface", async () => {
    const { runtime, settle, engine, urls } = await setup();
    await settle();
    const writes = vi.spyOn(refinement, "updateTerrainPositions");
    const revision = runtime.getRevision();
    const probe = runtime.sample(36.1, -112.14);
    expect(probe).not.toBeNull();
    const demRequests = pending.terrain.length;
    const imageRequests = urls.length;

    for (const offset of [1, -2, 0.5, -3, 0]) {
      runtime.setDetailTarget(offset);
      await settle();
    }
    runtime.setSource(RASTER_BASE_MAP_SOURCES.find(source => source.id === "carto-positron")!);
    await settle();

    expect(urls.length).toBeGreaterThan(imageRequests);
    expect(pending.terrain.length).toBe(demRequests);
    expect(writes).not.toHaveBeenCalled();
    expect(runtime.getRevision()).toBe(revision);
    expect(runtime.sample(36.1, -112.14)).toEqual(probe);
    expect(runtime.getDisplayedSourceId()).toBe("carto-positron");
    runtime.dispose();
    engine.dispose();
  });

  it("asks the new source only for its own images after a switch", async () => {
    const { runtime, settle, engine, urls } = await setup();
    await settle();
    urls.length = 0;
    runtime.setSource(RASTER_BASE_MAP_SOURCES.find(source => source.id === "osm-standard")!);
    await settle();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(url => url.startsWith("https://tile.openstreetmap.org/"))).toBe(true);
    runtime.dispose();
    engine.dispose();
  });

  it("asks first for a near ancestor where a new region could only show the root coverage", async () => {
    const { runtime, settle, engine, urls, controller, view } = await setup();
    await settle();
    // Somewhere the atlas has only the level-2 coverage for.
    Object.assign(view, { latDeg: 47.6, lonDeg: -122.3 });
    controller.applyViewState(view);
    urls.length = 0;
    await settle();
    const tiles = urls.map(url => {
      const [z, y, x] = url.split("/").slice(-3).map(Number);
      return { z, x, y };
    });
    const deepest = Math.max(...tiles.map(tile => tile.z));
    expect(deepest).toBeGreaterThanOrEqual(6);
    const firstDeep = tiles.findIndex(tile => tile.z === deepest);
    const leaf = tiles[firstDeep];
    const ancestorIndex = tiles.findIndex(tile => tile.z === leaf.z - 3 && tile.x === leaf.x >> 3 && tile.y === leaf.y >> 3);
    expect(ancestorIndex).toBeGreaterThanOrEqual(0);
    expect(ancestorIndex).toBeLessThan(firstDeep);
    runtime.dispose();
    engine.dispose();
  });
});
