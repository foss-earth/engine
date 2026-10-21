import { testAtlasDevice, testAfter } from "../fixtures/composition/runtimeHost.js";
import { GeospatialCamera, NullEngine, Scene, StandardMaterial, type Material, type UniformBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostCameraController as CameraController } from "../fixtures/composition/runtimeHost.js";
import { DEG_TO_RAD, geodeticToEcef } from "../src/camera/cameraMath.js";
import type { RasterBaseMapSource } from "../src/map/rasterBaseMaps.js";
import type { TileId } from "../src/terrain/imagery/imageryGeometry.js";
import { createImageryRuntime, type ImageryFeedback, type ImageryRuntimeOptions, type ImageryTuning } from "../src/babylon/imagery/createImageryRuntime.js";
import { ImageryAtlasMaterialPlugin } from "../src/babylon/imagery/imageryMaterialPlugin.js";
import { ImageryMissingError, type ImageryLoader, type ImageryResourceLimits } from "../src/terrain/imagery/imageryResidency.js";

const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
const VIEW = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 30_000, pitchDeg: 0, headingDeg: 0 };
const VIEW_ROOT = { z: 2, x: 0, y: 1 };
const LIMITS: ImageryResourceLimits = { gpuBytes: 48 * 2 ** 20, stagingBytes: 16 * 2 ** 20, concurrentRequests: 6, queuedRequests: 128, uploadBytesPerUpdate: 2 * 2 ** 20, cpuMsPerUpdate: 2, missingRetryMs: 1000, retryDelayMs: { min: 2000, max: 30_000 } };
const TUNING: ImageryTuning = { reselectWhileMovingMs: 0, anisotropy: 4, fallbackGap: 4, fallbackStep: 3, tablePatches: 16, maxNodes: 12_000, hysteresis: { refineAbove: 1.2, coarsenBelow: 0.8, coarsenAfterMs: 500, pinMs: 1000 }, refineAtRestAbove: 1 };

/** Real selection, residency, atlas allocation and material binding; downloads are deterministic. */
function harness(loaderOverride?: ImageryLoader<AbortSignal>, tablePatches = 1, extra: Partial<ImageryRuntimeOptions> | ((scene: Scene) => Partial<ImageryRuntimeOptions>) = {}) {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 });
  Object.assign(engine, { updateTextureData: vi.fn() });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("imagery-test", scene, { planetRadius: 6378137 });
  let time = 0;
  const controller = new CameraController(camera, () => time);
  controller.applyViewState(VIEW);
  let frameRequested = true;
  const requestRender = vi.fn(() => { frameRequested = true; });
  const onFeedback = vi.fn();
  const loader: ImageryLoader<AbortSignal> = loaderOverride ?? {
    async load(_url, { width, height }) {
      return { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
    },
  };
  const source: RasterBaseMapSource = { id: "test", version: "1", label: "Test", provider: "Test", attribution: "Test", protocol: "xyz", kind: "cartographic", urlTemplate: "https://tiles.invalid/{z}/{x}/{y}", maxZoom: 14 };
  const runtime = createImageryRuntime({
    device: testAtlasDevice(scene), createAbortController: () => new AbortController(), after: testAfter, log: { warn: () => {} },
    scene,
    source,
    capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 8, getRevision: () => 0 },
    limits: LIMITS,
    tuning: { ...TUNING, tablePatches },
    loader, requestRender, onFeedback, now: () => time,
    ...(typeof extra === "function" ? extra(scene) : extra),
  });
  const attach = (key: string, tile: TileId, visible = true): Material => {
    const material = new StandardMaterial(key, scene);
    runtime.attachPatch(key, tile, material);
    runtime.setPatchVisible(key, visible);
    return material;
  };
  const settle = async () => {
    // Follow requested frames, so a test cannot repair a stalled queue by
    // unconditionally pumping the runtime while no render was requested.
    for (let round = 0; frameRequested && round < 100; round++) {
      frameRequested = false;
      runtime.update();
      await flush();
    }
    expect(frameRequested, "imagery settles without an endless frame loop").toBe(false);
  };
  return {
    runtime, controller, attach, settle, requestRender, onFeedback, engine, scene,
    update: () => { frameRequested = true; },
    advance: (ms: number) => { time += ms; },
    dispose: () => { runtime.dispose(); scene.dispose(); engine.dispose(); },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("imagery runtime recovery", () => {
  it("reuses blocks released later in the patch order in the same coverage handover", async () => {
    const test = harness();
    try {
      test.attach("replacement", VIEW_ROOT, false);
      test.attach("previous", VIEW_ROOT);
      await test.settle();
      expect(test.runtime.getDiagnostics().binding).toMatchObject({ blocks: 1, fallbackPatches: 0 });
      test.runtime.setPatchVisible("replacement", true);
      test.runtime.setPatchVisible("previous", false);
      test.runtime.update();
      expect(test.runtime.getDiagnostics().binding).toMatchObject({ blocks: 1, fallbackPatches: 0 });
      const writes = test.runtime.getDiagnostics().counters.tableWrites;
      test.runtime.update();
      expect(test.runtime.getDiagnostics().counters.tableWrites).toBe(writes);
    } finally { test.dispose(); }
  });

  it("keeps the table budget available for detailed patches when the view moves past coarse cached patches", async () => {
    const test = harness(undefined, 16);
    try {
      // The user can limit tables to 16. Coarse cached patches need only
      // their coverage pages, but used to consume the entire table budget.
      test.attach("far-side", { z: 2, x: 3, y: 1 });
      for (let index = 0; index < 15; index++) test.attach(`coarse-${index}`, { z: 4, x: 8 + index % 4, y: 8 + Math.floor(index / 4) });
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      expect(test.runtime.getDiagnostics().atlas?.tableBlocks).toBe(16);
      expect(test.runtime.getDiagnostics().binding).toMatchObject({ blocks: 1, fallbackPatches: 0 });
      expect(test.runtime.getDiagnostics().residency).toMatchObject({ queued: 0, inFlight: 0, staged: 0 });

      // Camera motion reverses their roles without detaching either patch.
      test.controller.applyViewState({ ...VIEW, lonDeg: 112.14 });
      test.update();
      await test.settle();
      expect(test.runtime.getDiagnostics().binding).toMatchObject({ blocks: 1, fallbackPatches: 0 });
      const writes = test.runtime.getDiagnostics().counters.tableWrites;
      test.runtime.update();
      expect(test.runtime.getDiagnostics().counters.tableWrites).toBe(writes);
    } finally { test.dispose(); }
  });

  it("refines a stationary view after its missing-image deadline without a reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let unavailable = true;
    const test = harness({
      async load(url, { width, height }) {
        const level = Number(new URL(url).pathname.split("/")[1]);
        if (unavailable && level > 2) throw new ImageryMissingError("temporarily missing");
        return { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
      },
    });
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      expect(test.runtime.getDiagnostics().residency.missing).toBeGreaterThan(0);
      // Delivered levels are what attached patches draw; regions no patch draws have none.
      const bound = test.runtime.getDiagnostics().plan!.regions.filter(region => region.delivered !== null);
      expect(bound.length).toBeGreaterThan(0);
      expect(bound.every(region => region.delivered === 2)).toBe(true);
      unavailable = false;
      test.requestRender.mockClear();
      test.advance(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(test.requestRender).toHaveBeenCalled();
      await test.settle();
      expect(test.runtime.getDiagnostics().residency.missing).toBe(0);
      expect(test.runtime.getDiagnostics().plan?.regions.some(region => (region.delivered ?? 0) > 2)).toBe(true);
    } finally { test.dispose(); }
  });

  it("gives a finite priority to the source's finest tiles that measure around a low camera before terrain loads", async () => {
    // Unknown heights sample the surface at the 9 km fallback bound, above a camera
    // a few hundred metres up, so the tiles under it measure as surrounding it.
    const requests: Array<{ level: number; priority: number | undefined }> = [];
    const test = harness({
      async load(url, { width, height }, _signal, priority) {
        requests.push({ level: Number(new URL(url).pathname.split("/")[1]), priority });
        return { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
      },
    }, 1, { surface: { heightAt: () => null, boundsFor: () => ({ min: -500, max: 9000 }), maxLevelFor: () => Infinity, getRevision: () => 0 } });
    try {
      test.controller.applyViewState({ latDeg: 44.977753, lonDeg: -93.265011, zoomMeters: 600, pitchDeg: 23.1, headingDeg: 345.6 });
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      expect(test.runtime.getDiagnostics().plan!.regions.some(region => region.footprintPx === Infinity && region.limit === "source")).toBe(true);
      expect(requests.some(request => request.level === 14)).toBe(true);
      expect(requests.filter(request => !Number.isFinite(request.priority))).toEqual([]);
    } finally { test.dispose(); }
  });

  it("publishes the active target immediately while finer delivery remains pending", () => {
    const test = harness();
    try {
      test.runtime.setOffset(-1);
      expect(test.runtime.getFeedback()).toMatchObject({ activeTarget: -1, effectiveTarget: null, pending: true });
    } finally { test.dispose(); }
  });

  it("does not move the tile distribution when only the request changes", async () => {
    const test = harness();
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      const before = test.runtime.getFeedback().distribution;
      expect(before?.status).toBe("measured");
      expect(before?.tileCount).toBeGreaterThan(0);
      test.runtime.setOffset(-1);
      expect(test.runtime.getFeedback().activeTarget).toBe(-1);
      expect(test.runtime.getFeedback().distribution?.revision).toBe(before?.revision);
    } finally { test.dispose(); }
  });

  it("reports each feedback once: never the same loaded target and content twice in a row", async () => {
    const waiting: Array<() => void> = [];
    const test = harness({
      load(url, { width, height }) {
        const image = { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
        const level = Number(new URL(url).pathname.split("/")[1]);
        return level === 2 ? Promise.resolve(image) : new Promise(resolve => waiting.push(() => resolve(image)));
      },
    });
    const seen: Array<{ loadedTarget: number | null | undefined; json: string }> = [];
    test.onFeedback.mockImplementation(() => { const feedback = test.runtime.getFeedback(); seen.push({ loadedTarget: feedback.loadedTarget, json: JSON.stringify(feedback) }); });
    const finishDownloads = async () => {
      for (let round = 0; waiting.length > 0 && round < 100; round++) {
        for (const resolve of waiting.splice(0)) resolve();
        await flush();
        await test.settle();
      }
    };
    try {
      test.attach("current-view", VIEW_ROOT);
      test.attach("next-view", { z: 2, x: 3, y: 1 });
      await test.settle();
      await finishDownloads();
      for (const lonDeg of [-112.1, 112.14, -112.14]) {
        test.controller.applyViewState({ ...test.controller.getViewState(), lonDeg });
        test.update(); test.runtime.update(); test.runtime.update();
        await test.settle();
        await finishDownloads();
      }
      test.runtime.setOffset(-1); test.update(); await test.settle(); await finishDownloads();
      test.runtime.setLimits({ ...LIMITS, gpuBytes: 64 * 2 ** 20 }); test.update(); await test.settle(); await finishDownloads();
      for (let index = 0; index < 3; index++) test.runtime.update();
      const targetChanges = seen.filter((entry, index) => index > 0 && !Object.is(entry.loadedTarget, seen[index - 1]!.loadedTarget)).length;
      expect(targetChanges).toBeGreaterThan(1);
      expect(seen.length).toBeGreaterThan(targetChanges + 1);
      for (let index = 1; index < seen.length; index++) {
        expect(Object.is(seen[index]!.loadedTarget, seen[index - 1]!.loadedTarget) && seen[index]!.json === seen[index - 1]!.json, `report ${index} repeats the one before`).toBe(false);
      }
    } finally { test.dispose(); }
  });

  it("moves loaded detail as visible pages arrive and after a view change, without changing the requested target", async () => {
    const waiting: Array<() => void> = [];
    const test = harness({
      load(url, { width, height }) {
        const image = { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
        const level = Number(new URL(url).pathname.split("/")[1]);
        return level === 2 ? Promise.resolve(image) : new Promise(resolve => waiting.push(() => resolve(image)));
      },
    });
    const finishDownloads = async () => {
      for (let round = 0; waiting.length > 0 && round < 100; round++) {
        for (const resolve of waiting.splice(0)) resolve();
        await flush();
        await test.settle();
      }
      expect(waiting).toHaveLength(0);
    };
    try {
      test.attach("current-view", VIEW_ROOT);
      test.attach("next-view", { z: 2, x: 3, y: 1 });
      await test.settle();
      const coarse = test.runtime.getFeedback().loadedTarget;
      expect(coarse).toEqual(expect.any(Number));
      expect(test.runtime.getFeedback()).toMatchObject({ activeTarget: 0, pending: true });
      const initialCallbacks = test.onFeedback.mock.calls.length;
      await finishDownloads();
      const fine = test.runtime.getFeedback().loadedTarget!;
      expect(fine).toBeGreaterThan(coarse! + 3);
      expect(test.onFeedback.mock.calls.length).toBeGreaterThan(initialCallbacks);

      test.controller.applyViewState({ ...test.controller.getViewState(), lonDeg: 112.14 });
      test.update();
      await test.settle();
      expect(test.runtime.getFeedback().loadedTarget).toBeLessThan(fine - 3);
      expect(test.runtime.getFeedback().activeTarget).toBe(0);
      await finishDownloads();
      expect(test.runtime.getFeedback().loadedTarget).toBeGreaterThan(coarse! + 3);

      test.onFeedback.mockClear();
      test.requestRender.mockClear();
      const counters = test.runtime.getDiagnostics().counters;
      test.runtime.update();
      test.runtime.getFeedback();
      expect(test.onFeedback).not.toHaveBeenCalled();
      expect(test.requestRender).not.toHaveBeenCalled();
      expect(test.runtime.getDiagnostics().counters).toEqual(counters);
    } finally { test.dispose(); }
  });

  it("retains measured loaded detail while the old source still draws during a source switch", async () => {
    const test = harness({
      async load(url, { width, height }) {
        if (url.includes("replacement.invalid")) return new Promise(() => {});
        return { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
      },
    });
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      const loaded = test.runtime.getFeedback().loadedTarget;
      expect(loaded).toEqual(expect.any(Number));
      test.runtime.setSource({ id: "replacement", urlTemplate: "https://replacement.invalid/{z}/{x}/{y}", maxZoom: 14 });
      await test.settle();
      expect(test.runtime.getDisplayedSourceId()).toBe("test");
      expect(test.runtime.getFeedback()).toMatchObject({ loadedTarget: loaded, pending: true });
      expect(test.runtime.getFeedback().distribution).toMatchObject({ status: "unavailable" });
      expect(test.runtime.getFeedback().distribution?.samples).toEqual([]);
    } finally { test.dispose(); }
  });

  it("moves from coarse fallback into the normal rail when the selected normal-detail imagery is bound", async () => {
    const waiting: Array<() => void> = [];
    const test = harness({
      load(url, { width, height }) {
        const image = { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
        const level = Number(new URL(url).pathname.split("/")[1]);
        return level === 2 ? Promise.resolve(image) : new Promise(resolve => waiting.push(() => resolve(image)));
      },
    }, 16, {
      surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 14, getRevision: () => 0 },
    });
    try {
      await test.settle();
      // Terrain can address each selected region; no artificial z8 table cap.
      for (const region of test.runtime.getDiagnostics().plan!.regions) {
        const [z, x, y] = region.key.split("/").map(Number);
        test.attach(region.key, { z, x, y });
      }
      test.update();
      await test.settle();
      expect(test.runtime.getFeedback().loadedTarget).toBeLessThan(-3);
      for (let round = 0; waiting.length > 0 && round < 100; round++) {
        for (const resolve of waiting.splice(0)) resolve();
        await flush();
        await test.settle();
      }
      expect(waiting).toHaveLength(0);
      const loaded = test.runtime.getFeedback().loadedTarget!;
      expect(loaded).toBeGreaterThanOrEqual(-0.3);
      expect(loaded).toBeLessThan(1.5);
      expect(test.runtime.getFeedback().activeTarget).toBe(0);
    } finally { test.dispose(); }
  });

  it("measures the actual view while focus-only loading does not reselect when the camera turns", async () => {
    const test = harness(undefined, 16, {
      getFocus: () => ({ mode: "around", position: geodeticToEcef(VIEW.latDeg * DEG_TO_RAD, VIEW.lonDeg * DEG_TO_RAD, 0), radiusMeters: 20_000, offsetCap: null, horizonCull: false }),
    });
    try {
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) test.attach(`coverage-${x}-${y}`, { z: 2, x, y });
      await test.settle();
      for (const region of test.runtime.getDiagnostics().plan!.regions) {
        const [z, x, y] = region.key.split("/").map(Number);
        test.attach(region.key, { z, x, y });
      }
      test.update();
      await test.settle();
      expect(test.runtime.getDiagnostics().plan!.regions.every(region => region.screenArea === 0)).toBe(true);
      const loaded = test.runtime.getFeedback().loadedTarget;
      expect(loaded).toEqual(expect.any(Number));
      const selections = test.runtime.getDiagnostics().counters.selections;
      test.controller.applyViewState({ ...test.controller.getViewState(), headingDeg: 90 });
      test.update();
      await test.settle();
      expect(test.runtime.getDiagnostics().counters.selections).toBe(selections);
      expect(test.runtime.getFeedback().loadedTarget).toEqual(expect.any(Number));
      expect(test.runtime.getFeedback().loadedTarget).not.toBe(loaded);
    } finally { test.dispose(); }
  });
});

describe("imagery selection at rest", () => {
  // Enough pages and levels that only hysteresis decides how far the view refines.
  const FAR = { ...VIEW, zoomMeters: 1_000_000 };
  const NEAR = { ...VIEW, zoomMeters: 1_000_000 / 1.05 };
  const roomy = (tuning: Partial<ImageryTuning> = {}) => harness(undefined, 16, {
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 14, getRevision: () => 0 },
    limits: { ...LIMITS, gpuBytes: 128 * 2 ** 20 },
    tuning: { ...TUNING, tablePatches: 16, ...tuning },
  });
  const regions = (test: ReturnType<typeof harness>) => (test.runtime.getDiagnostics().plan?.regions ?? []).map(region => region.key).sort();
  const freshRegions = async (view: typeof VIEW) => {
    const test = roomy();
    try {
      test.controller.applyViewState(view);
      test.attach("root", VIEW_ROOT);
      await test.settle();
      return regions(test);
    } finally { test.dispose(); }
  };

  it("keeps leaves from refining while the view moves, then refines to what a fresh view of the same place selects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fresh = await freshRegions(NEAR);
    const test = roomy({ reselectWhileMovingMs: 100 });
    try {
      test.controller.applyViewState(FAR);
      test.attach("root", VIEW_ROOT);
      await test.settle();
      test.advance(5000);
      test.controller.applyViewState(NEAR);
      test.update();
      await test.settle();
      // While it moves, a 5% nearer view refines nothing that was already a leaf.
      const moving = regions(test);
      expect(moving.length).toBeLessThan(fresh.length - 10);
      expect(test.runtime.getFeedback().pending).toBe(true);
      const selections = test.runtime.getDiagnostics().counters.selections;
      test.advance(100);
      vi.advanceTimersByTime(100);
      await test.settle();
      expect(test.runtime.getDiagnostics().counters.selections).toBe(selections + 1);
      expect(regions(test)).toEqual(fresh);
      // At rest it selects nothing more.
      test.advance(5000);
      test.update();
      await test.settle();
      expect(test.runtime.getDiagnostics().counters.selections).toBe(selections + 1);
      expect(test.runtime.getFeedback().pending).toBe(false);
    } finally { test.dispose(); }
  });

  it("selects the resting view after a move that loads nothing, so loading ends", async () => {
    const test = roomy();
    try {
      test.controller.applyViewState(NEAR);
      test.attach("root", VIEW_ROOT);
      await test.settle();
      const plan = regions(test);
      const selections = test.runtime.getDiagnostics().counters.selections;
      // A slight pan selects the same regions, so no page arrives to draw another frame.
      test.advance(2000);
      test.controller.applyViewState({ ...NEAR, lonDeg: NEAR.lonDeg + 1e-4 });
      test.update();
      await test.settle();
      expect(regions(test)).toEqual(plan);
      expect(test.runtime.getDiagnostics().counters.selections).toBe(selections + 2);
      expect(test.runtime.getFeedback().pending).toBe(false);
    } finally { test.dispose(); }
  });

  it("keeps what it refined at rest when the view moves back and forth, without merging it or refining again", async () => {
    const test = roomy();
    try {
      test.controller.applyViewState(FAR);
      test.attach("root", VIEW_ROOT);
      await test.settle();
      const seen: Record<string, string[][]> = { far: [], near: [] };
      for (let cycle = 0; cycle < 4; cycle++) {
        for (const [name, view] of [["near", NEAR], ["far", FAR]] as const) {
          test.advance(2000);
          test.controller.applyViewState(view);
          test.update();
          await test.settle();
          seen[name].push(regions(test));
        }
      }
      // The first rest near refines; from then on each view keeps the plan it had.
      for (const name of ["far", "near"]) for (const plan of seen[name]) expect(plan).toEqual(seen[name][0]);
      expect(seen.near[0].length).toBe((await freshRegions(NEAR)).length);
    } finally { test.dispose(); }
  });
});

describe("imagery limits and their explanations", () => {
  const DEEP_SURFACE = { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 14, getRevision: () => 0 };
  const of = <C extends ImageryFeedback["constraints"][number]["cause"]>(feedback: ImageryFeedback, cause: C) =>
    feedback.constraints.find(constraint => constraint.cause === cause) as Extract<ImageryFeedback["constraints"][number], { cause: C }> | undefined;
  /** The depth of the page table a patch's material reads, or -1 where it draws one page directly. */
  const tableDepth = (material: Material): number => {
    const values = new Map<string, number[]>();
    (material.pluginManager!.getPlugin("ImageryAtlas") as ImageryAtlasMaterialPlugin).bindForSubMesh({
      updateFloat4: (name: string, ...value: number[]) => { values.set(name, value); },
      setTexture: () => {},
    } as unknown as UniformBuffer);
    return values.get("imageryTable")![2];
  };

  it("names the GPU budget with the pages selection may use and at least how many more the view needs", async () => {
    const test = harness(undefined, 16, { surface: DEEP_SURFACE, limits: { ...LIMITS, gpuBytes: 24 * 2 ** 20 } });
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      const { atlas, plan } = test.runtime.getDiagnostics();
      const budget = of(test.runtime.getFeedback(), "gpu-budget")!;
      expect(budget).toMatchObject({ parameter: "map.imagery.gpuBudget", configuredMiB: 24, atlasPages: atlas!.capacity, rendererCapped: false, reducedRegions: 0 });
      expect(budget.atlasMiB).toBeLessThanOrEqual(24);
      expect(budget.selectedPages).toBe(plan!.leaves);
      expect(budget.selectedPages).toBeLessThanOrEqual(budget.selectablePages);
      expect(budget.selectablePages).toBeLessThan(budget.atlasPages);
      expect(budget.regions).toBeGreaterThan(0);
      expect(budget.morePagesAtLeast).toBeGreaterThan(0);
      // Selection's share is used up while the atlas itself still has room.
      expect(atlas!.freeSlots).toBeGreaterThan(0);
      expect(of(test.runtime.getFeedback(), "atlas-full")).toBeUndefined();
      expect(test.runtime.getFeedback().limits).toContain("memory");
    } finally { test.dispose(); }
  });

  it("tells a full atlas from the selection budget", async () => {
    const test = harness(undefined, 16, { limits: { ...LIMITS, gpuBytes: 12 * 2 ** 20 } });
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      const full = of(test.runtime.getFeedback(), "atlas-full")!;
      const { atlas, residency } = test.runtime.getDiagnostics();
      expect(full).toEqual({ cause: "atlas-full", parameter: "map.imagery.gpuBudget", configuredMiB: 12, atlasPages: atlas!.capacity, pinnedPages: residency.pinnedPages, waitingImages: residency.unplaced });
      expect(full.waitingImages).toBeGreaterThan(0);
      expect(of(test.runtime.getFeedback(), "gpu-budget")).toBeUndefined();
      expect(test.runtime.getFeedback().limits).toContain("memory");
    } finally { test.dispose(); }
  });

  it("names the page tables, as set and as the layout allocates them, when visible patches need more", async () => {
    const test = harness(undefined, 16);
    try {
      // Twenty visible patches over the same detailed ground each need a table.
      const materials = Array.from({ length: 20 }, (_, index) => test.attach(`view-${index}`, VIEW_ROOT));
      await test.settle();
      const depths = materials.map(tableDepth);
      expect(depths.filter(depth => depth < 0)).toHaveLength(4);
      expect(depths.filter(depth => depth > 0)).toHaveLength(16);
      expect(test.runtime.getDiagnostics().binding).toMatchObject({ tablesNeeded: 20, fallbackPatches: 4 });
      expect(of(test.runtime.getFeedback(), "page-tables")).toEqual({
        cause: "page-tables", parameter: "map.imagery.pageTablePatches", configured: 16, effective: 16, needed: 20, patches: 4,
      });
      expect(test.runtime.getFeedback().limits).toContain("backend");
    } finally { test.dispose(); }

    // The layout rounds 20 up to whole rows: 64 tables, enough for all.
    const rounded = harness(undefined, 20);
    try {
      const materials = Array.from({ length: 20 }, (_, index) => rounded.attach(`view-${index}`, VIEW_ROOT));
      await rounded.settle();
      expect(rounded.runtime.getDiagnostics().atlas!.tableBlocks).toBe(64);
      expect(materials.map(tableDepth).every(depth => depth > 0)).toBe(true);
      expect(of(rounded.runtime.getFeedback(), "page-tables")).toBeUndefined();
    } finally { rounded.dispose(); }
  });

  it("names the selection limit and keeps coverage where it runs out", async () => {
    const test = harness(undefined, 16, { surface: DEEP_SURFACE, tuning: { ...TUNING, maxNodes: 40 } });
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      const cap = of(test.runtime.getFeedback(), "node-cap")!;
      expect(cap).toMatchObject({ parameter: "map.imagery.maxNodes", configured: 40, examined: test.runtime.getDiagnostics().plan!.nodesEvaluated, reducedRegions: 0 });
      expect(cap.examined).toBeLessThanOrEqual(40);
      expect(cap.regions).toBeGreaterThan(0);
      // Not a memory limit: more GPU memory would not help.
      expect(test.runtime.getFeedback().limits).not.toContain("memory");
      expect(test.runtime.getDiagnostics().binding.emptyCells).toBe(0);
    } finally { test.dispose(); }
  });

  it("explains a reload after the GPU budget changes, until the view has its imagery again", async () => {
    const test = harness();
    const seen: ImageryFeedback[] = [];
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      expect(of(test.runtime.getFeedback(), "reload")).toBeUndefined();
      test.onFeedback.mockImplementation(() => { seen.push(test.runtime.getFeedback()); });
      test.runtime.setLimits({ ...LIMITS, gpuBytes: 64 * 2 ** 20 });
      await test.settle();
      const reloading = seen.filter(feedback => of(feedback, "reload"));
      expect(reloading.length).toBeGreaterThan(0);
      expect(of(reloading[0], "reload")).toEqual({ cause: "reload", reason: "gpu-budget", parameter: "map.imagery.gpuBudget", value: 64 });
      expect(reloading.every(feedback => feedback.pending)).toBe(true);
      expect(test.runtime.getFeedback().pending).toBe(false);
      expect(of(test.runtime.getFeedback(), "reload")).toBeUndefined();
    } finally { test.dispose(); }
  });

  it("explains a reload after the graphics context is restored", async () => {
    const test = harness();
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      (test.engine as unknown as { onContextRestoredObservable: { notifyObservers(engine: unknown): void } }).onContextRestoredObservable.notifyObservers(test.engine);
      test.runtime.update();
      expect(of(test.runtime.getFeedback(), "reload")).toEqual({ cause: "reload", reason: "context-restored", parameter: null, value: null });
      test.update();
      await test.settle();
      expect(of(test.runtime.getFeedback(), "reload")).toBeUndefined();
    } finally { test.dispose(); }
  });

  it("calls a long request queue loading, not a lack of memory", async () => {
    const test = harness({ load: () => new Promise(() => {}) }, 16, { limits: { ...LIMITS, concurrentRequests: 1, queuedRequests: 8 } });
    try {
      test.attach("current-view", VIEW_ROOT);
      await test.settle();
      expect(test.runtime.getDiagnostics().residency.overflow).toBeGreaterThan(0);
      expect(test.runtime.getFeedback().limits).toContain("loading");
      expect(test.runtime.getFeedback().limits).not.toContain("memory");
      expect(test.runtime.getFeedback().constraints.map(constraint => constraint.cause)).not.toContain("atlas-full");
    } finally { test.dispose(); }
  });
});


describe("imagery all-stop owned release", () => {
  it("cleans allocated atlases after native observer setup fails and preserves explicit owned-loader cleanup failure", () => {
    const operation = new Error("restoration observer setup failed"), cleanup = new Error("owned loader setup rollback failed");
    let hostScene: Scene | undefined;
    try { let failure: unknown;
      try { harness(undefined, 1, scene => {
        hostScene = scene; vi.spyOn(scene.getEngine().onContextRestoredObservable, "add").mockImplementation(() => { throw operation; });
        return { releaseOwnedLoader() { throw cleanup; } };
      }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([operation, cleanup]);
      expect(hostScene!.textures).toHaveLength(0); expect(hostScene!.getEngine().isDisposed).toBe(false);
    } finally { vi.restoreAllMocks(); const engine = hostScene?.getEngine(); hostScene?.dispose(); engine?.dispose(); }
  });
  it("keeps a supplied shared loader alive and releases a dedicated loader only through its explicit port", () => {
    const dispose = vi.fn(), loader = { load: () => new Promise<never>(() => {}), dispose };
    const borrowed = harness(loader); borrowed.runtime.dispose(); borrowed.runtime.dispose(); expect(dispose).not.toHaveBeenCalled(); borrowed.dispose();
    const release = vi.fn(() => loader.dispose()), owned = harness(loader, 1, { releaseOwnedLoader: release });
    owned.runtime.dispose(); owned.runtime.dispose(); expect(release).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); owned.dispose();
  });
  it("attempts observer removal, every patch and both atlas generations after wake and owned-loader cleanup throw", async () => {
    const timerError = new Error("wake cleanup failed"), observerError = new Error("observer removal failed"), loaderError = new Error("owned loader cleanup failed"), patchError = new Error("patch cleanup failed");
    const timers: Array<() => void> = [], stop = vi.fn(() => { throw timerError; }), owned = vi.fn(() => { throw loaderError; });
    let restored: (() => void) | undefined, remove: ReturnType<typeof vi.spyOn> | undefined;
    const test = harness({ load: () => Promise.reject(new ImageryMissingError("missing")) }, 1, scene => {
      const observable = scene.getEngine().onContextRestoredObservable;
      vi.spyOn(observable, "add").mockImplementation(callback => { if (callback) restored = () => callback(scene.getEngine(), {} as never); return null; });
      remove = vi.spyOn(observable, "removeCallback").mockImplementation(() => { throw observerError; });
      return { after(callback) { timers.push(callback); return stop; }, releaseOwnedLoader: owned };
    });
    try {
      test.attach("first", VIEW_ROOT); test.attach("second", VIEW_ROOT); test.runtime.update(); await flush(); test.runtime.update(); await flush();
      expect(timers.length).toBeGreaterThan(0); test.runtime.setLimits({ ...LIMITS, gpuBytes: LIMITS.gpuBytes * 2 });
      const textures = [...test.scene.textures], released = textures.map(texture => vi.spyOn(texture, "dispose"));
      const originalSetAtlas = ImageryAtlasMaterialPlugin.prototype.setAtlas; let unbinds = 0;
      vi.spyOn(ImageryAtlasMaterialPlugin.prototype, "setAtlas").mockImplementation(function(this: ImageryAtlasMaterialPlugin, atlas) {
        originalSetAtlas.call(this, atlas); if (atlas === null) { unbinds++; if (unbinds === 1) throw patchError; }
      });
      let failure: unknown; try { test.runtime.dispose(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([timerError, observerError, loaderError, patchError]));
      expect(unbinds).toBe(2); expect(released.every(release => release.mock.calls.length === 1)).toBe(true); expect(owned).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
      const requests = test.requestRender.mock.calls.length; restored?.(); for (const callback of timers) callback();
      expect(test.requestRender).toHaveBeenCalledTimes(requests); test.runtime.dispose(); expect(owned).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); test.dispose(); }
  });
  it("cancels every residency request and releases atlas resources when the first supplied abort throws", async () => {
    const error = new Error("first abort cleanup failed"), controllers: AbortController[] = [];
    const test = harness({ load: () => new Promise<never>(() => {}) }, 1, { createAbortController() {
      const controller = new AbortController(); controllers.push(controller);
      if (controllers.length === 1) { const abort = controller.abort.bind(controller); vi.spyOn(controller, "abort").mockImplementation(() => { abort(); throw error; }); }
      return controller;
    } });
    try { test.attach("first", VIEW_ROOT); test.attach("second", { z: 2, x: 1, y: 1 }); test.runtime.update(); await flush();
      expect(controllers.length).toBeGreaterThan(1); const textures = [...test.scene.textures], released = textures.map(texture => vi.spyOn(texture, "dispose"));
      expect(() => test.runtime.dispose()).toThrow(error); expect(controllers.every(controller => controller.signal.aborted)).toBe(true); expect(released.every(release => release.mock.calls.length === 1)).toBe(true);
      test.runtime.dispose();
    } finally { vi.restoreAllMocks(); test.dispose(); }
  });
  it("retires display state and still requests the host frame when restoration cancellation throws", async () => {
    const error = new Error("restoration abort failed"), controllers: AbortController[] = [];
    const test = harness({ load: () => new Promise<never>(() => {}) }, 1, { createAbortController() {
      const controller = new AbortController(); controllers.push(controller);
      if (controllers.length === 1) { const abort = controller.abort.bind(controller); vi.spyOn(controller, "abort").mockImplementationOnce(() => { abort(); throw error; }); }
      return controller;
    } });
    try { test.attach("view", VIEW_ROOT); test.runtime.update(); await flush(); const requests = test.requestRender.mock.calls.length;
      expect(() => test.engine.onContextRestoredObservable.notifyObservers(test.engine)).toThrow(error);
      expect(controllers.every(controller => controller.signal.aborted)).toBe(true); expect(test.requestRender.mock.calls.length).toBeGreaterThan(requests);
      expect(test.runtime.getDiagnostics().displayedSource).toBeNull();
    } finally { vi.restoreAllMocks(); test.dispose(); }
  });
});
