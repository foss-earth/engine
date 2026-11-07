// @vitest-environment jsdom
/**
 * P-112 (audit L19): while maps load, their updates run in the host's work
 * passes and a frame is drawn only when what is drawn changes. This runs one
 * 2D map load twice on the same host frames, the same loader answers and the
 * same clock: once drawing every frame as before, once in work passes. On
 * every host frame the picture on screen must be the same in both, and the
 * maps must have asked for the same tiles and images.
 */
import { createHash, type Hash } from "node:crypto";
import type { InternalTexture, Material, Scene, Texture } from "@babylonjs/core";
import { createRenderScheduler, type WorkRenderScheduler } from "@foss-earth/renderer";
import { createTextureDevicePorts } from "@foss-earth/renderer/babylon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGlobeHostFixture } from "../fixtures/composition/globeHost.js";
import * as rasterModule from "../src/babylon/createRasterTilesRuntime.js";
import type { GlobeRuntimeOptions } from "../src/babylon/globeRuntimePorts.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import type { TerrainGrid, TerrainTile } from "../src/terrain/terrainGrid.js";
import type { ImageryAtlasDevicePorts } from "../src/babylon/imagery/imageryAtlas.js";

const FRAME_MS = 1000 / 60;
const VIEW = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 30_000, pitchDeg: 30, headingDeg: 0 };
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

interface Run {
  /** Per host frame: what the screen shows, as of the last frame drawn. */
  shown: string[];
  /** Per host frame: the tiles and images the maps asked for in it. */
  requests: string[][];
  /** Per host frame: whether a frame was drawn. */
  drawn: boolean[];
  /** Per host frame: how often the 2D map updated. */
  updates: number[];
}

interface Script {
  /** Host frames to run. */
  frames: number;
  /** Host frame → a change to make before it, such as a new view. */
  at?: Record<number, (host: ReturnType<typeof createGlobeHostFixture>) => void>;
  /** The settings to start with. */
  settings?: Record<string, number | boolean | string>;
}

/** Host frames a request takes to answer, as on a network: from 2 to 13, the same for a request in both runs. */
const latency = (key: string): number => 2 + (createHash("sha256").update(key).digest()[0]! % 12);

/** Bytes that differ per image, so an image written to the wrong place or not at all shows. */
const pageBytes = (url: string, page: number): Uint8Array => new Uint8Array(createHash("sha256").update(`${url}#${page}`).digest().subarray(0, 4));

async function runLoad(workPasses: boolean, script: Script): Promise<Run> {
  /** Answers due at a host frame, in the order asked. */
  const answers: Array<{ due: number; answer(): void }> = [];
  let hostFrame = 0;
  let frameRequests: string[] = [];
  let terrainLoaders = 0;
  const terrainRequest = (loader: number, tile: TerrainTile): Promise<TerrainGrid> => new Promise<TerrainGrid>(resolve => {
    const key = `dem ${loader} ${tile.z}/${tile.x}/${tile.y}`;
    frameRequests.push(key);
    // Each elevation source has its own ground.
    const corner = 100 + tile.z * 7 + ((tile.x * 31 + tile.y * 17) % 13) + loader * 40;
    answers.push({ due: hostFrame + latency(key), answer: () => resolve({ ...tile, size: 2, heights: new Float32Array([corner, 100, 100, corner / 2]) }) });
  });
  let rasterUpdates = 0;
  const textureIds = new Map<object, number>();
  const writes = new Map<object, Hash>();
  const textureKey = (texture: Texture | InternalTexture | null | undefined): object | null => {
    if (!texture) return null;
    return (texture as Texture).getInternalTexture?.() ?? texture;
  };
  const textureId = (texture: Texture | InternalTexture | null | undefined): string => {
    const key = textureKey(texture);
    if (!key) return "-";
    if (!textureIds.has(key)) textureIds.set(key, textureIds.size);
    return `${textureIds.get(key)}:${writes.get(key)?.copy().digest("hex") ?? "unwritten"}`;
  };
  let queued: ((time: number) => void) | null = null, handle = 0, frameAt = 0, drewThisFrame = false, lastShown = "nothing drawn";
  let scheduler!: WorkRenderScheduler;
  // Assigned once the fixture returns; the scheduler calls back only from a host frame, after that.
  const state: { host?: ReturnType<typeof createGlobeHostFixture> } = {};
  const signature = (scene: Scene): string => {
    const hash = createHash("sha256");
    const camera = scene.activeCamera!;
    hash.update(Float64Array.from(camera.getViewMatrix().asArray()));
    hash.update(Float64Array.from(camera.getProjectionMatrix().asArray()));
    for (const mesh of scene.meshes) {
      if (!mesh.isEnabled() || !mesh.isVisible || (mesh.layerMask & camera.layerMask) === 0) continue;
      hash.update(`|${mesh.name}|`);
      hash.update(Float64Array.from(mesh.computeWorldMatrix(true).asArray()));
      for (const kind of ["position", "normal", "uv"]) {
        const data = mesh.getVerticesData(kind);
        hash.update(data ? Float32Array.from(data) : new Float32Array(0));
      }
      hash.update(Uint32Array.from(mesh.getIndices() ?? []));
      const material = mesh.material as (Material & { diffuseTexture?: Texture | null }) | null;
      if (!material) continue;
      hash.update(`${material.name}:${material.alpha}:${textureId(material.diffuseTexture)}`);
      const atlas = material.pluginManager?.getPlugin("ImageryAtlas") as unknown as {
        atlas: { texture: Texture; table: Texture } | null; patch: number[]; tableBlock: number[]; fallback: number[];
      } | null;
      if (atlas) hash.update(JSON.stringify([atlas.patch, atlas.tableBlock, atlas.fallback,
        atlas.atlas ? [textureId(atlas.atlas.texture), textureId(atlas.atlas.table)] : null]));
    }
    return hash.digest("hex");
  };
  const realCreate = rasterModule.createRasterTilesRuntime;
  const spy = vi.spyOn(rasterModule, "createRasterTilesRuntime").mockImplementation(options => {
    const runtime = realCreate(options);
    const update = runtime.update.bind(runtime);
    runtime.update = () => { rasterUpdates += 1; update(); };
    return runtime;
  });
  const host = createGlobeHostFixture(document, defaults => {
    scheduler = createRenderScheduler({
      requestFrame: callback => { queued = time => { frameAt = time; callback(time); }; return ++handle; },
      cancelFrame: () => { queued = null; },
      work: (time, frame) => state.host!.runtime.prepareWork(time, frame),
      tick: () => {
        const runtime = state.host!.runtime;
        runtime.prepareFrame(frameAt);
        defaults.scene.render();
        runtime.afterFrame(frameAt, true);
        drewThisFrame = true;
        lastShown = signature(defaults.scene);
      },
      shouldKeepRendering: () => state.host!.runtime.shouldKeepRendering(),
      minFrameIntervalMs: () => state.host!.runtime.minFrameIntervalMs(),
    });
    const base = createTextureDevicePorts({ scene: defaults.scene, transfer: (_bytes, _label, submit) => submit() });
    const device: ImageryAtlasDevicePorts = {
      createRawTexture: options => {
        const texture = base.createRawTexture(options);
        const key = textureKey(texture)!;
        const hash = createHash("sha256");
        if (options.data) hash.update(options.data);
        writes.set(key, hash);
        return texture;
      },
      updateTextureData(texture, data, x, y, width, height, faceIndex, lod) {
        const hash = writes.get(texture) ?? createHash("sha256");
        writes.set(texture, hash);
        hash.update(JSON.stringify([x, y, width, height, faceIndex ?? 0, lod ?? 0]));
        hash.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
    };
    const raster: GlobeRuntimeOptions["mapPorts"]["raster"] = {
      ...defaults.mapPorts.raster,
      attachTerrainLighting: () => ({}) as ReturnType<GlobeRuntimeOptions["mapPorts"]["raster"]["attachTerrainLighting"]>,
      createTerrainLoader: () => {
        const loader = terrainLoaders++;
        return { dispose() {}, setPaused() {}, getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }),
          load: (tile: TerrainTile) => terrainRequest(loader, tile), loadPatch: (tile: TerrainTile) => terrainRequest(loader, tile),
        } as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["raster"]["createTerrainLoader"]>;
      },
      imageryPorts: {
        device, capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
        createAbortController: () => new AbortController(),
        loader: { load: (url, expected) => new Promise(resolve => {
          const key = `img ${url}`;
          frameRequests.push(key);
          const pages = (expected.width / 256) * (expected.height / 256);
          answers.push({ due: hostFrame + latency(key), answer: () => resolve({ width: expected.width, height: expected.height, compressedBytes: 10,
            pages: Array.from({ length: pages }, (_, page) => [pageBytes(url, page)]) }) });
        }) },
      },
    };
    return { external: undefined, preferGoogleTiles: false, googleApiKey: null, rasterBaseMap: RASTER_BASE_MAP_SOURCES[0],
      scheduler, workPasses, mapPorts: { ...defaults.mapPorts, raster } };
  });
  state.host = host;
  // Before the first host frame, so before any load starts.
  for (const [id, value] of Object.entries(script.settings ?? {})) host.settings.set(id, value);
  const run: Run = { shown: [], requests: [], drawn: [], updates: [] };
  try {
    host.runtime.setViewState(VIEW);
    for (let frame = 0; frame < script.frames; frame++) {
      hostFrame = frame;
      const time = 1000 + frame * FRAME_MS;
      host.setTime(time);
      script.at?.[frame]?.(host);
      frameRequests = []; rasterUpdates = 0; drewThisFrame = false;
      const callback = queued as ((time: number) => void) | null;
      queued = null;
      callback?.(time);
      // Loads answer between frames, the same in both runs.
      await flush();
      for (let i = 0; i < answers.length;) {
        if (answers[i]!.due <= frame) answers.splice(i, 1)[0]!.answer();
        else i++;
      }
      await flush();
      run.shown.push(lastShown);
      run.requests.push(frameRequests);
      run.drawn.push(drewThisFrame);
      run.updates.push(rasterUpdates);
    }
  } finally {
    scheduler.stop();
    host.disposeHost();
    spy.mockRestore();
  }
  return run;
}

afterEach(() => { vi.restoreAllMocks(); });

const firstDifference = (a: readonly unknown[], b: readonly unknown[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  return -1;
};

async function compare(script: Script) {
  const before = await runLoad(false, script);
  const after = await runLoad(true, script);
  return { before, after,
    drawnBefore: before.drawn.filter(Boolean).length, drawnAfter: after.drawn.filter(Boolean).length,
    updatesBefore: before.updates.reduce((a, b) => a + b, 0), updatesAfter: after.updates.reduce((a, b) => a + b, 0) };
}

describe("maps loading in work passes (P-112)", () => {
  it("shows the same picture on every host frame of a still load, drawing only when it changes", async () => {
    const result = await compare({ frames: 240 });
    const { before, after } = result;
    // The load did happen, and showed map tiles.
    expect(before.requests.flat().length).toBeGreaterThan(20);
    // Loading went on for many frames, and the old way drew each of them.
    expect(result.drawnBefore).toBeGreaterThan(40);
    expect(new Set(before.shown).size).toBeGreaterThan(3);
    expect(firstDifference(after.requests, before.requests)).toBe(-1);
    expect(firstDifference(after.shown, before.shown)).toBe(-1);
    // Never more than one map update per host frame.
    expect(Math.max(...after.updates)).toBeLessThanOrEqual(1);
    // Fewer frames: only those that change the picture, and the first.
    const changes = after.shown.filter((shown, i) => i === 0 || shown !== after.shown[i - 1]).length;
    expect(result.drawnAfter).toBeLessThan(result.drawnBefore);
    expect(result.drawnAfter).toBeLessThanOrEqual(changes + 1);
    console.info(`[P-112 still load] requests ${before.requests.flat().length}, frames drawn ${result.drawnBefore} → ${result.drawnAfter}, picture changes ${changes}, map updates ${result.updatesBefore} → ${result.updatesAfter}`);
  });

  it("shows the same picture when the view moves while the map loads", async () => {
    const moved = { ...VIEW, lonDeg: VIEW.lonDeg + 0.2, zoomMeters: 12_000, pitchDeg: 50 };
    const result = await compare({ frames: 240, at: { 40: host => host.runtime.setViewState(moved), 41: host => host.runtime.setViewState({ ...moved, headingDeg: 20 }) } });
    const { before, after } = result;
    // The move showed, and loaded more.
    expect(before.shown[42]).not.toBe(before.shown[39]);
    expect(before.requests.slice(40).flat().length).toBeGreaterThan(10);
    expect(firstDifference(after.requests, before.requests)).toBe(-1);
    expect(firstDifference(after.shown, before.shown)).toBe(-1);
    expect(Math.max(...after.updates)).toBeLessThanOrEqual(1);
    expect(result.drawnAfter).toBeLessThan(result.drawnBefore);
    console.info(`[P-112 moved load] frames drawn ${result.drawnBefore} → ${result.drawnAfter}, map updates ${result.updatesBefore} → ${result.updatesAfter}`);
  });

  it("shows the same picture while the camera glides as the map loads, the maps following the camera's pose of each frame", async () => {
    const turn = { dt: 0.1, intents: [{ actionId: "globe.orbitHeading", value: 1 }, { actionId: "globe.zoom", value: 0.6 }] } as const;
    const result = await compare({ frames: 240, at: { 20: host => host.runtime.applyGlobeNavigationIntents(turn), 60: host => host.runtime.applyGlobeNavigationIntents(turn) } });
    const { before, after } = result;
    // The glide went on over many frames, each of them drawn both ways.
    expect(before.drawn.slice(20, 40).every(Boolean)).toBe(true);
    expect(after.drawn.slice(20, 40).every(Boolean)).toBe(true);
    expect(firstDifference(after.requests, before.requests)).toBe(-1);
    expect(firstDifference(after.shown, before.shown)).toBe(-1);
    expect(Math.max(...after.updates)).toBeLessThanOrEqual(1);
    console.info(`[P-112 glide] frames drawn ${result.drawnBefore} → ${result.drawnAfter}, map updates ${result.updatesBefore} → ${result.updatesAfter}`);
  }, 30_000);

  it("shows the same picture when another elevation source reshapes the shown ground, its imagery unchanged", async () => {
    const result = await compare({ frames: 240, at: { 120: host => host.settings.set("map.source.elevation", "aws-terrarium") } });
    const { before, after } = result;
    // The new ground came in after the switch.
    expect(before.requests.slice(120).flat().some(key => key.startsWith("dem 1 "))).toBe(true);
    expect(new Set(before.shown.slice(121)).size).toBeGreaterThan(2);
    expect(firstDifference(after.requests, before.requests)).toBe(-1);
    expect(firstDifference(after.shown, before.shown)).toBe(-1);
    console.info(`[P-112 elevation switch] frames drawn ${result.drawnBefore} → ${result.drawnAfter}`);
  });

  it("paces map updates to a frame-rate cap as frames were", async () => {
    const result = await compare({ frames: 240, settings: { "renderer.frameRateCap": 30 } });
    const { before, after } = result;
    expect(firstDifference(after.requests, before.requests)).toBe(-1);
    expect(firstDifference(after.shown, before.shown)).toBe(-1);
    expect(result.updatesAfter).toBeLessThanOrEqual(result.updatesBefore);
  });

  it("draws every frame of a load as before with the setting off", async () => {
    const result = await compare({ frames: 120, settings: { "map.loading.drawOnlyChanges": false } });
    expect(result.after.drawn).toEqual(result.before.drawn);
    expect(result.after.shown).toEqual(result.before.shown);
  });
});
