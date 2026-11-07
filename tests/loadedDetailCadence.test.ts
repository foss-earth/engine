import { testAtlasDevice, testAfter, HostCameraController as CameraController, createEngineSettings } from "../fixtures/composition/runtimeHost.js";
import { GeospatialCamera, NullEngine, Scene, StandardMaterial } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import type { RasterBaseMapSource } from "../src/map/rasterBaseMaps.js";
import { createImageryRuntime, type ImageryTuning } from "../src/babylon/imagery/createImageryRuntime.js";
import type { ImageryLoader, ImageryResourceLimits } from "../src/terrain/imagery/imageryResidency.js";
import { measureLoadedImagery } from "../src/terrain/imagery/imageryBinding.js";
import { IMAGERY_TUNING_IDS, imageryTuningFrom } from "../src/settings/imageryParameters.js";

// Counts the readout's measurements of what is loaded; the measurement itself is the real one.
vi.mock("../src/terrain/imagery/imageryBinding.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/terrain/imagery/imageryBinding.js")>();
  return { ...actual, measureLoadedImagery: vi.fn(actual.measureLoadedImagery) };
});

const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
const VIEW = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 1_000_000, pitchDeg: 0, headingDeg: 0 };
const LIMITS: ImageryResourceLimits = { gpuBytes: 128 * 2 ** 20, stagingBytes: 16 * 2 ** 20, concurrentRequests: 6, queuedRequests: 128, uploadBytesPerUpdate: 2 * 2 ** 20, cpuMsPerUpdate: 2, missingRetryMs: 1000, retryDelayMs: { min: 2000, max: 30_000 } };
const TUNING: ImageryTuning = { reselectWhileMovingMs: 100, anisotropy: 4, fallbackGap: 4, fallbackStep: 3, tablePatches: 16, maxNodes: 12_000, hysteresis: { refineAbove: 1.2, coarsenBelow: 0.8, coarsenAfterMs: 500, pinMs: 1000 }, refineAtRestAbove: 1 };
const FRAME_MS = 16;

/** One imagery runtime on a shared clock, whose downloads finish only when the test says. */
function runtimeOn(clock: { time: number }, everyPublish: boolean) {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 });
  Object.assign(engine, { updateTextureData: vi.fn() });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("cadence", scene, { planetRadius: 6378137 });
  const controller = new CameraController(camera, () => clock.time);
  controller.applyViewState(VIEW);
  const waiting: { url: string; finish(): void }[] = [];
  const requested: string[] = [];
  const loader: ImageryLoader<AbortSignal> = {
    load(url, { width, height }) {
      requested.push(url);
      return new Promise(resolve => waiting.push({ url, finish: () => resolve({ width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] }) }));
    },
  };
  const source: RasterBaseMapSource = { id: "test", version: "1", label: "Test", provider: "Test", attribution: "Test", protocol: "xyz", kind: "cartographic", urlTemplate: "https://tiles.invalid/{z}/{x}/{y}", maxZoom: 14 };
  const wakes = { count: 0 };
  const runtime = createImageryRuntime({
    device: testAtlasDevice(scene), createAbortController: () => new AbortController(), after: testAfter, log: { warn: () => {} },
    scene, source,
    capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 14, getRevision: () => 0 },
    limits: LIMITS,
    tuning: { ...TUNING, loadedDetailEveryPublish: everyPublish },
    loader, requestRender: () => { wakes.count++; }, now: () => clock.time,
  });
  const material = new StandardMaterial("root", scene);
  runtime.attachPatch("root", { z: 2, x: 0, y: 1 }, material);
  runtime.setPatchVisible("root", true);
  /** Finishes the `count` oldest downloads, in the order they were asked for. */
  const finish = (count: number) => { for (const download of waiting.splice(0, count)) download.finish(); };
  return { runtime, controller, finish, waiting, requested, wakes, dispose: () => { runtime.dispose(); scene.dispose(); engine.dispose(); } };
}

/** Everything but the readout: what was chosen, kept and drawn, and the work done for it. */
function drawn(test: ReturnType<typeof runtimeOn>) {
  const { plan, counters, ...rest } = test.runtime.getDiagnostics() as ReturnType<typeof test.runtime.getDiagnostics> & Record<string, unknown>;
  return JSON.stringify({ plan, counters, rest, requested: test.requested });
}
const readout = (test: ReturnType<typeof runtimeOn>) => {
  const { loadedTarget, distribution } = test.runtime.getFeedback();
  return JSON.stringify({ loadedTarget, distribution });
};

afterEach(() => { vi.useRealTimers(); vi.mocked(measureLoadedImagery).mockClear(); });

// A drag that moves every frame, a view that moves every 10 frames, and a still view, each while tiles arrive two at a time.
it.each([{ name: "a drag", moveEvery: 1 }, { name: "steps", moveEvery: 10 }, { name: "a still view", moveEvery: 0 }])("measures the loaded detail at the selector's cadence while imagery streams under $name, draws the same, and reads the same once it stops", async ({ moveEvery }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = { time: 1000 };
  const old = runtimeOn(clock, true);
  const cadence = runtimeOn(clock, false);
  const measured = { old: 0, cadence: 0 };
  const update = (test: typeof old, key: keyof typeof measured) => {
    const before = vi.mocked(measureLoadedImagery).mock.calls.length;
    test.runtime.update();
    measured[key] += vi.mocked(measureLoadedImagery).mock.calls.length - before;
  };
  const frame = async (downloads: number) => {
    clock.time += FRAME_MS;
    vi.advanceTimersByTime(FRAME_MS);
    update(old, "old");
    update(cadence, "cadence");
    old.finish(downloads); cadence.finish(downloads);
    await flush();
  };
  try {
    let streamingMs = 0, readoutsDiffered = 0, newPlans = 0;
    const selections = () => old.runtime.getDiagnostics().counters.selections;
    for (let index = 0; index < 120; index++) {
      if (moveEvery > 0 && index % moveEvery === 0) for (const test of [old, cadence]) {
        const view = test.controller.getViewState();
        test.controller.applyViewState({ ...view, zoomMeters: view.zoomMeters / 1.3 ** (moveEvery / 10), lonDeg: view.lonDeg + 0.04 * moveEvery });
      }
      const selected = selections();
      await frame(2);
      streamingMs += FRAME_MS;
      expect(drawn(cadence), `frame ${index}`).toBe(drawn(old));
      // A new plan is measured on the frame it is shown, as before.
      if (selections() > selected) { newPlans++; expect(readout(cadence), `new plan, frame ${index}`).toBe(readout(old)); }
      else if (readout(cadence) !== readout(old)) readoutsDiffered++;
    }
    expect(newPlans).toBeGreaterThan(0);
    const streamed = { ...measured };
    // At rest: every download finishes, then two intervals pass, so the held-back measurement is due.
    for (let index = 0; index < 60 && (old.waiting.length > 0 || cadence.waiting.length > 0 || old.runtime.getFeedback().pending); index++) {
      await frame(64);
      expect(drawn(cadence), `rest frame ${index}`).toBe(drawn(old));
    }
    for (let index = 0; index < Math.ceil(2 * TUNING.reselectWhileMovingMs / FRAME_MS); index++) {
      await frame(64);
      expect(drawn(cadence), `settled frame ${index}`).toBe(drawn(old));
    }
    if (process.env.CADENCE_REPORT) process.stderr.write(`CADENCE ${moveEvery} streamed ${JSON.stringify(streamed)} total ${JSON.stringify(measured)} new plans ${newPlans}, readouts differed on ${readoutsDiffered} of 120 frames\n`);
    expect(old.waiting).toHaveLength(0);
    expect(cadence.runtime.getFeedback().pending).toBe(false);
    expect(readout(cadence)).toBe(readout(old));
    expect(JSON.stringify(cadence.runtime.getFeedback())).toBe(JSON.stringify(old.runtime.getFeedback()));
    // The old readout measured on most frames; the cadence at most once per interval, plus one.
    expect(streamed.old).toBeGreaterThan(3 * streamed.cadence);
    expect(streamed.cadence).toBeLessThanOrEqual(Math.ceil(streamingMs / TUNING.reselectWhileMovingMs) + 1);
    expect(streamed.cadence).toBeGreaterThan(0);
    // The two readouts differ only between measurements while tiles stream in.
    expect(readoutsDiffered).toBeGreaterThan(0);
    // Nothing left to measure: a frame at rest measures nothing in either.
    const atRest = { ...measured };
    await frame(0);
    expect(measured).toEqual(atRest);
  } finally { old.dispose(); cadence.dispose(); }
});

it("measures the last publication once the interval has passed, without another frame from the view", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = { time: 1000 };
  const test = runtimeOn(clock, false);
  try {
    // Let the first coverage arrive and be measured.
    for (let index = 0; index < 30; index++) { clock.time += FRAME_MS; vi.advanceTimersByTime(FRAME_MS); test.runtime.update(); test.finish(64); await flush(); }
    const settled = vi.mocked(measureLoadedImagery).mock.calls.length;
    const view = test.controller.getViewState();
    test.controller.applyViewState({ ...view, zoomMeters: view.zoomMeters / 2 });
    // One frame selects and measures the moved view; the next publishes what arrived, within the interval.
    clock.time += FRAME_MS; test.runtime.update(); test.finish(64); await flush();
    clock.time += FRAME_MS; test.runtime.update(); await flush();
    const before = readout(test);
    const measuredBefore = vi.mocked(measureLoadedImagery).mock.calls.length;
    expect(measuredBefore).toBeGreaterThan(settled);
    // The runtime asks for a frame when the interval is up; that frame measures the publication it held back.
    const wakes = test.wakes.count;
    clock.time += TUNING.reselectWhileMovingMs; vi.advanceTimersByTime(TUNING.reselectWhileMovingMs);
    expect(test.wakes.count).toBeGreaterThan(wakes);
    test.runtime.update(); await flush();
    expect(vi.mocked(measureLoadedImagery).mock.calls.length).toBeGreaterThan(measuredBefore);
    expect(readout(test)).not.toBe(before);
  } finally { test.dispose(); }
});

it("measures at the cadence by default, and on every publication when the setting is on", () => {
  const settings = createEngineSettings();
  expect(settings.get("map.imagery.loadedDetailEveryPublish")).toBe(false);
  expect(imageryTuningFrom(settings).loadedDetailEveryPublish).toBe(false);
  settings.set("map.imagery.loadedDetailEveryPublish", true);
  expect(imageryTuningFrom(settings).loadedDetailEveryPublish).toBe(true);
  // A change reaches a running runtime, as the other imagery tuning does.
  expect(IMAGERY_TUNING_IDS).toContain("map.imagery.loadedDetailEveryPublish");
});
