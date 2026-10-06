import { GeospatialCamera, NullEngine, Scene, StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../../../camera/cameraState";
import { DEG_TO_RAD, geodeticToEcef } from "../../../camera/cameraMath";
import type { TileId } from "../../../terrain/imagery/imageryGeometry";
import { createImageryRuntime, type ImageryRuntimeOptions } from "./createImageryRuntime";
import { ImageryMissingError, type ImageryLoader } from "./imageryResidency";

const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
const VIEW = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 30_000, pitchDeg: 0, headingDeg: 0 };
const VIEW_ROOT = { z: 2, x: 0, y: 1 };

/** Real selection, residency, atlas allocation and material binding; downloads are deterministic. */
function harness(loaderOverride?: ImageryLoader, tablePatches = 1, extra: Partial<ImageryRuntimeOptions> = {}) {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 });
  Object.assign(engine, { updateTextureData: vi.fn() });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("imagery-test", scene, { planetRadius: 6378137 });
  const controller = new CameraController(camera);
  controller.applyViewState(VIEW);
  let time = 0;
  let frameRequested = true;
  const requestRender = vi.fn(() => { frameRequested = true; });
  const onFeedback = vi.fn();
  const loader: ImageryLoader = loaderOverride ?? {
    async load(_url, { width, height }) {
      return { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
    },
  };
  const runtime = createImageryRuntime({
    scene,
    source: { id: "test", version: "1", label: "Test", provider: "Test", attribution: "Test", protocol: "xyz", kind: "cartographic", urlTemplate: "https://tiles.invalid/{z}/{x}/{y}", maxZoom: 14 },
    capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 8, getRevision: () => 0 },
    limits: { gpuBytes: 48 * 2 ** 20, stagingBytes: 16 * 2 ** 20, concurrentRequests: 6, queuedRequests: 128, uploadBytesPerUpdate: 2 * 2 ** 20, cpuMsPerUpdate: 2, missingRetryMs: 1000, retryDelayMs: { min: 2000, max: 30_000 } },
    tuning: { reselectWhileMovingMs: 0, anisotropy: 4, fallbackGap: 4, fallbackStep: 3, tablePatches, maxNodes: 12_000, hysteresis: { refineAbove: 1.2, coarsenBelow: 0.8, coarsenAfterMs: 500, pinMs: 1000 } },
    loader, requestRender, onFeedback, now: () => time,
    ...extra,
  });
  const attach = (key: string, tile: TileId, visible = true) => {
    runtime.attachPatch(key, tile, new StandardMaterial(key, scene));
    runtime.setPatchVisible(key, visible);
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
    runtime, controller, attach, settle, requestRender, onFeedback,
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
      expect(test.runtime.getDiagnostics().plan?.regions.every(region => region.delivered === 2)).toBe(true);
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

  it("publishes the active target immediately while finer delivery remains pending", () => {
    const test = harness();
    try {
      test.runtime.setOffset(-1);
      expect(test.runtime.getFeedback()).toMatchObject({ activeTarget: -1, effectiveTarget: null, pending: true });
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
