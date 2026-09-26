import { GeospatialCamera, NullEngine, Scene } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geodeticToEcef } from "../../camera/cameraMath";
import { CameraController } from "../../camera/cameraState";
import * as refinement from "../../terrain/meshRefinement";
import type { TerrainGrid, TerrainTile } from "../../terrain/terrainTiles";
import { createRasterTilesRuntime, type RasterTilesRuntimeOptions } from "./createRasterTilesRuntime";
import type { ImageryLoader, PreparedImage } from "./imagery/imageryResidency";
import { getAppSettings } from "../../settings/appSettings";
import { RASTER_BASE_MAP_SOURCES } from "./rasterBaseMaps";

const pending = vi.hoisted(() => ({
  terrain: [] as Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void; reject(error: Error): void }>,
  /** Every elevation request, including those already answered. */
  terrainRequests: 0,
  /** The four corner heights each elevation tile answers with. */
  heights: (tile: TerrainTile): number[] => [100 + tile.z, 100, 100, 100],
  legacyImagery: 0,
}));
vi.mock("./loadMapTexture", () => ({ loadMapTexture: () => { pending.legacyImagery += 1; throw new Error("The atlas path must not load per-tile textures."); } }));
vi.mock("../../terrain/terrainTiles", async importOriginal => ({
  ...await importOriginal<typeof import("../../terrain/terrainTiles")>(),
  createTerrainTileLoader: () => ({ dispose: vi.fn(),
    getMetrics: () => ({ active: 0, queued: 0, decodedBytes: 0 }),
    loadPatch: (tile: TerrainTile) => new Promise<TerrainGrid>((resolve, reject) => {
      pending.terrainRequests += 1;
      pending.terrain.push({ tile, resolve, reject });
    }) }),
}));
beforeEach(() => {
  pending.terrain = [];
  pending.terrainRequests = 0;
  pending.heights = tile => [100 + tile.z, 100, 100, 100];
  pending.legacyImagery = 0;
});
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

async function setup(sourceIndex = 0, loaderOverride?: ImageryLoader, extra: Partial<RasterTilesRuntimeOptions> = {}) {
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
  const created = imageryLoader();
  const loader = loaderOverride ?? created.loader;
  const urls = created.urls;
  const onDetailFeedback = vi.fn();
  const runtime = createRasterTilesRuntime({
    scene, source: RASTER_BASE_MAP_SOURCES[sourceIndex], getViewState: () => view,
    imagery: "atlas", imageryLoader: loader, onDetailFeedback, ...extra,
  });
  const settle = async () => {
    for (let round = 0; round < 40; round++) {
      runtime.update();
      scene.render();
      await flush();
      for (const item of pending.terrain.splice(0)) {
        item.resolve({ ...item.tile, size: 2, heights: new Float32Array(pending.heights(item.tile)) });
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
    // Imagery alone: the rail does not move terrain.
    getAppSettings().set("map.detail.linkTerrainToImagery", false);
    const { runtime, settle, engine, urls } = await setup();
    await settle();
    const writes = vi.spyOn(refinement, "updateTerrainPositions");
    const revision = runtime.getRevision();
    const probe = runtime.sample(36.1, -112.14);
    expect(probe).not.toBeNull();
    const demRequests = pending.terrainRequests;
    const imageRequests = urls.length;

    for (const offset of [1, -2, 0.5, -3, 0]) {
      runtime.setDetailTarget(offset);
      await settle();
    }
    runtime.setSource(RASTER_BASE_MAP_SOURCES.find(source => source.id === "carto-positron")!);
    await settle();

    expect(urls.length).toBeGreaterThan(imageRequests);
    expect(pending.terrainRequests).toBe(demRequests);
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

  it("sizes the atlas from its GPU budget, and on a change reallocates it while the old one keeps drawing", async () => {
    const settings = getAppSettings();
    const { runtime, settle, engine, scene } = await setup();
    await settle();
    const atlases = () => scene.textures.filter(texture => texture.name === "imagery-atlas");
    const before = runtime.getImageryDiagnostics().atlas!;
    expect(before.atlas!.estimatedGpuBytes).toBeLessThanOrEqual(128 * 2 ** 20);
    expect(before.atlas!.estimatedGpuBytes).toBeGreaterThan(64 * 2 ** 20);
    expect(atlases()).toHaveLength(1);

    settings.set("map.imagery.gpuBudget", 48);
    // The new atlas exists; the old one still draws until the new one covers the view.
    expect(atlases()).toHaveLength(2);
    const during = runtime.getImageryDiagnostics().atlas!;
    expect(during.atlas!.estimatedGpuBytes).toBeLessThanOrEqual(48 * 2 ** 20);
    expect(runtime.getMetrics().visibleTiles).toBeGreaterThan(0);
    await settle();
    expect(atlases()).toHaveLength(1);
    const after = runtime.getImageryDiagnostics().atlas!;
    expect(after.atlas!.capacity).toBeLessThan(before.atlas!.capacity);
    expect(after.residency.residentPages).toBeGreaterThan(0);
    expect(after.binding.blocks).toBeGreaterThan(0);
    expect(runtime.getDetailFeedback().support).toBe("ready");
    runtime.dispose();
    engine.dispose();
  });

  it("admits no more image requests at once than its budget", async () => {
    const settings = getAppSettings();
    settings.set("map.imagery.concurrentRequests", 2);
    let inFlight = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    const loader: ImageryLoader = {
      load(_url, expected) {
        inFlight += 1;
        most = Math.max(most, inFlight);
        return new Promise(resolve => waiting.push(() => {
          inFlight -= 1;
          const pages = (expected.width / 256) * (expected.height / 256);
          resolve({ width: expected.width, height: expected.height, compressedBytes: 10, pages: Array.from({ length: pages }, () => [new Uint8Array(4)]) });
        }));
      },
    };
    const { runtime, scene, engine } = await setup(0, loader);
    for (let round = 0; round < 10; round++) { runtime.update(); scene.render(); await flush(); }
    expect(most).toBe(2);
    settings.set("map.imagery.concurrentRequests", 5);
    for (let round = 0; round < 10; round++) { runtime.update(); scene.render(); await flush(); }
    expect(most).toBe(5);
    for (const done of waiting.splice(0)) done();
    runtime.dispose();
    engine.dispose();
  });

  it("keeps no more terrain tiles than its budget beyond what the view needs", async () => {
    const settings = getAppSettings();
    const visit = async (cachedTiles: number) => {
      settings.set("map.terrain.cachedTiles", cachedTiles);
      const { runtime, settle, engine, controller, view } = await setup();
      await settle();
      Object.assign(view, { latDeg: 47.6, lonDeg: -122.3 });
      controller.applyViewState(view);
      await settle();
      const kept = runtime.getMetrics().activeTiles;
      runtime.dispose();
      engine.dispose();
      return kept;
    };
    const generous = await visit(4096);
    const small = await visit(32);
    expect(small).toBeLessThan(generous);
  });

  it("orbiting a fixed focus point requests nothing new once the region around it is loaded", async () => {
    // Reselect at once after each turn, however fast the test runs.
    getAppSettings().set("map.imagery.reselectWhileMoving", 0);
    const orbit = async (mode: "view" | "around") => {
      let focus: { x: number; y: number; z: number } | null = null;
      const { runtime, settle, engine, urls, camera, controller, view } = await setup(0, undefined, { getFocus: () => (
        mode === "view" || !focus ? null : { mode, position: focus, radiusMeters: 10_000, offsetCap: null, horizonCull: true }
      ) });
      // Low over the Grand Canyon, looking toward the horizon: turning shows new ground.
      Object.assign(view, { zoomMeters: 3000, pitchDeg: 75 });
      controller.applyViewState(view);
      // The orbit target, in ECEF as the scene is here.
      focus = { x: camera.center.x, y: camera.center.y, z: camera.center.z };
      await settle();
      const settled = { images: urls.length, elevation: pending.terrainRequests };
      for (const headingDeg of [60, 120, 180, 240, 300]) {
        Object.assign(view, { headingDeg });
        controller.applyViewState(view);
        await settle();
      }
      // Anything else that reselects, such as automatic adjustment stepping
      // coarser and back, finds the same tiles: what is loaded does not change
      // what a still focus region asks for.
      const settings = getAppSettings();
      const detail = settings.get("map.detail.terrain.default") as number;
      settings.set("map.detail.terrain.default", detail * 2 ** 0.25);
      await settle();
      settings.set("map.detail.terrain.default", detail);
      await settle();
      const turned = { images: urls.length - settled.images, elevation: pending.terrainRequests - settled.elevation, pages: runtime.getImageryDiagnostics().atlas?.focus };
      runtime.dispose();
      engine.dispose();
      return turned;
    };
    // The view alone loads what each turn reveals: the check below means something.
    expect((await orbit("view")).images).toBeGreaterThan(0);
    const around = await orbit("around");
    expect(around).toMatchObject({ images: 0, elevation: 0 });
    // The region's pages are counted and estimated from this view.
    expect(around.pages?.pages).toBeGreaterThan(0);
    expect(around.pages?.estimatedPages).toBeGreaterThan(0);
  });

  it("settles on what it would choose again, so reselecting around a still, low focus point requests nothing", async () => {
    const settings = getAppSettings();
    settings.set("map.auto.terrainDetail", false);
    settings.set("map.detail.linkTerrainToImagery", false);
    // Reselect whenever there is cause, however fast the test runs.
    settings.set("map.terrain.reselectWhileMoving", 0);
    // One narrow peak beside the point: coarse grids miss it, fine ones find it.
    const peak = { latDeg: 36.103, lonDeg: -112.137 };
    pending.heights = tile => {
      const heights: number[] = [];
      for (const row of [0.25, 0.75]) for (const col of [0.25, 0.75]) {
        const n = 2 ** tile.z;
        const lonDeg = ((tile.x + col) / n) * 360 - 180;
        const latDeg = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + row)) / n))) * 180) / Math.PI;
        const d = Math.hypot((latDeg - peak.latDeg) * 111_000, (lonDeg - peak.lonDeg) * 90_000);
        heights.push(100 + 1300 * Math.exp(-((d / 300) ** 2)));
      }
      return heights;
    };
    // A chase camera's case: the point 1500 m up, the camera 100 m above it.
    const focus = geodeticToEcef((36.1 * Math.PI) / 180, (-112.14 * Math.PI) / 180, 1500);
    const { runtime, settle, engine, controller, view } = await setup(0, undefined, { getFocus: () => (
      { mode: "around", position: focus, radiusMeters: 10_000, offsetCap: null, horizonCull: true }
    ) });
    Object.assign(view, { zoomMeters: 1600, pitchDeg: 89 });
    controller.applyViewState(view);
    await settle();
    const settled = pending.terrainRequests;
    // Automatic adjustment stepping coarser and back reselects with nothing moved.
    const detail = settings.get("map.detail.terrain.default") as number;
    settings.set("map.detail.terrain.default", detail * 2 ** 0.25);
    await settle();
    settings.set("map.detail.terrain.default", detail);
    await settle();
    expect(settled).toBeGreaterThan(0);
    expect(pending.terrainRequests - settled).toBe(0);
    runtime.dispose();
    engine.dispose();
  });

  it("moves the terrain target a level per level of the rail when linked, within its range", async () => {
    const settings = getAppSettings();
    const { runtime, settle, engine } = await setup();
    await settle();
    const target = () => runtime.getTerrainState().targetPx;
    expect(target()).toBe(4);
    const selected = (offset: number) => { runtime.setDetailTarget(offset); return target(); };
    expect(selected(1)).toBe(2);
    expect(selected(-2)).toBe(16);
    // The range's coarse end, 16 px, holds.
    expect(selected(-3)).toBe(16);
    runtime.setDetailTarget(1);
    await settle();
    const fine = runtime.getTerrainState().selectedTiles;
    runtime.setDetailTarget(-2);
    await settle();
    expect(runtime.getTerrainState().selectedTiles).toBeLessThan(fine);
    settings.set("map.detail.linkTerrainToImagery", false);
    expect(target()).toBe(4);
    runtime.dispose();
    engine.dispose();
  });

  it("coarsens enabled detail toward its range when frames are slow, says why, and returns when they are fast", async () => {
    const settings = getAppSettings();
    settings.setMany({ "map.auto.frameTimeGoal": 16, "map.auto.coarsenWindows": 1, "map.auto.interval": 0, "map.auto.refineWindows": 2, "map.auto.step": 0.5 });
    const onDetailAdjusted = vi.fn();
    const { runtime, settle, engine, onDetailFeedback } = await setup(0, undefined, { onDetailAdjusted });
    await settle();
    const frames = (from: number, ms: number, frameMs: number) => {
      for (let now = from; now < from + ms; now += frameMs) runtime.reportFrame(now, frameMs, false);
    };
    frames(0, 1100, 40);
    expect(onDetailAdjusted).toHaveBeenCalledWith(expect.objectContaining({ from: 0, to: 0.5, goalMs: 16 }));
    expect(runtime.getTerrainState()).toMatchObject({ requestedTargetPx: 4, targetPx: 4 * Math.SQRT2 });
    expect(runtime.getAutoDetailState()).toMatchObject({ adjustment: 0.5, requestedOffset: 0, offset: -0.5 });
    expect(runtime.getDetailFeedback().limits).toContain("frame-time");
    expect(onDetailFeedback).toHaveBeenCalled();
    // Imagery may stay as asked while terrain alone gives way.
    settings.set("map.auto.imageryDetail", false);
    expect(runtime.getAutoDetailState().offset).toBe(0);
    expect(runtime.getDetailFeedback().limits).not.toContain("frame-time");
    expect(runtime.getTerrainState().targetPx).toBeCloseTo(4 * Math.SQRT2);
    // Fast frames return it to the request, never past it.
    frames(1100, 3000, 10);
    expect(runtime.getAutoDetailState().adjustment).toBe(0);
    expect(runtime.getTerrainState().targetPx).toBe(4);
    // With nothing it may move, it holds still.
    settings.setMany({ "map.auto.terrainDetail": false, "map.auto.imageryDetail": false });
    frames(4100, 3000, 40);
    expect(runtime.getAutoDetailState().adjustment).toBe(0);
    runtime.dispose();
    engine.dispose();
  });

  it("asks first for a near ancestor where a new region could only show the root coverage", async () => {
    // Reselect at once after the move, however fast the test runs.
    getAppSettings().set("map.imagery.reselectWhileMoving", 0);
    getAppSettings().set("map.terrain.reselectWhileMoving", 0);
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
    // The first image asked for stands in for finer ones asked for after it:
    // an ancestor fallbackStep (3) levels above them, more than fallbackGap (4)
    // levels finer than the root coverage. Terrain refines in stages from
    // there, so later, deeper images have nearer stand-ins already shown.
    const first = tiles[0];
    expect(first.z).toBeGreaterThanOrEqual(2 + 4);
    const covered = tiles.findIndex(tile => tile.z === first.z + 3 && tile.x >> 3 === first.x && tile.y >> 3 === first.y);
    expect(covered).toBeGreaterThan(0);
    runtime.dispose();
    engine.dispose();
  });
});
