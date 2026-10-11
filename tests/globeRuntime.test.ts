// @vitest-environment jsdom
import { describe,expect,it,vi } from "vitest";
import { createGlobeHostFixture } from "../fixtures/composition/globeHost.js";
import { createGlobeRuntime } from "../src/babylon/createGlobeRuntime.js";
import { createBorrowedRuntimeAuthority } from "../src/babylon/borrowedRuntimeAuthority.js";
import { createTerrainPerformanceCapture } from "../src/terrain/terrainPerformanceCapture.js";
import { TransformNode, Color3, MeshBuilder, StandardMaterial, type Scene } from "@babylonjs/core";
import type { GlobeRuntimeOptions } from "../src/babylon/globeRuntimePorts.js";
import { createParameterControl } from "@foss-earth/ui/browser";

/** The supplied traversal leaf never downloads; the actual globe and Google
 * adapter still own frame, preparation, camera, listeners and hold lifetime. */
function createTerrainHost(configure: (defaults: Readonly<GlobeRuntimeOptions>) => Partial<Omit<GlobeRuntimeOptions, "settings">> = () => ({})) {
  return createGlobeHostFixture(document, defaults => ({
    googleApiKey: "fixture-only", preferGoogleTiles: true,
    mapPorts: { ...defaults.mapPorts,google: { ...defaults.mapPorts.google,
      createTilesRenderer(_rootUrl, scene) {
        void _rootUrl;
        return new TerrainTilesFixture(scene) as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createTilesRenderer"]>;
      },
      createAuthPlugin: () => ({ fetchData: async () => { throw new Error("No fixture network."); } }) as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createAuthPlugin"]>,
    } },
    terrainPreparation: { ...defaults.terrainPreparation,evaluate: () => ({ result: null,progress: { phase: "loading",readySamples: 0,totalSamples: 5,progress: 0,message: "Fixture waiting." } }) },
    ...configure(defaults),
  }));
}
class TerrainTilesFixture {
  fetchOptions = {};
  errorTarget = 20;
  readonly group: TransformNode;
  visibleTiles = new Set(); activeTiles = new Set();
  lruCache = { minSize: 0,maxSize: 0,minBytesSize: 0,maxBytesSize: 0,itemSet: new Set(),cachedBytes: 0 };
  downloadQueue = { maxJobs: 0,currJobs: 0,items: [] };
  parseQueue = { maxJobs: 0,currJobs: 0,items: [] };
  processNodeQueue = { maxJobs: 0,currJobs: 0,items: [] };
  stats = { queued: 0 };
  private listeners = new Map<string,Set<(event: unknown) => void>>();
  constructor(scene: Scene) { this.group = new TransformNode("fixture-google-group",scene); }
  registerPlugin() {}
  calculateTileViewError(_tile: unknown, target: { inView: boolean; error: number; distanceFromCamera: number }) { void _tile; target.inView = false; target.error = 1; target.distanceFromCamera = 1; }
  update() {}
  async parseTile() {}
  addEventListener(type: string,listener: (event: unknown) => void) { let listeners = this.listeners.get(type); if (!listeners) this.listeners.set(type,listeners = new Set()); listeners.add(listener); }
  removeEventListener(type: string,listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  dispose() { this.listeners.clear(); this.group.dispose(); }
}

/** Real runtime and settings/control behavior, with authenticated transport
 * replaced at its public port. No live key, network or GPU is required. */
function createGoogleKeyHost(initialKey: string | null = null) {
  const tokens: string[] = [];
  const renderers: TerrainTilesFixture[] = [];
  const host = createTerrainHost(defaults => ({
    googleApiKey: initialKey,
    preferGoogleTiles: initialKey !== null,
    mapPorts: { ...defaults.mapPorts, google: { ...defaults.mapPorts.google,
      createTilesRenderer(_rootUrl, scene) {
        void _rootUrl;
        const renderer = new TerrainTilesFixture(scene);
        renderers.push(renderer);
        return renderer as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createTilesRenderer"]>;
      },
      createAuthPlugin({ apiToken }) {
        tokens.push(apiToken);
        return { fetchData: async () => { throw new Error("No fixture network."); } } as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createAuthPlugin"]>;
      },
    } },
  }));
  return { ...host, tokens, renderers };
}

describe("live Google key activation", () => {
  it("uses a key saved after startup when Google is selected, without replacing the host", () => {
    const host = createGoogleKeyHost();
    const control = createParameterControl(host.settings, "map.source.googleKey", document);
    const engineDispose = vi.spyOn(host.engine, "dispose"), sceneDispose = vi.spyOn(host.scene, "dispose");
    const changed = vi.fn();
    const unsubscribe = host.runtime.subscribeStatus(changed);
    try {
      expect(host.runtime.status).toMatchObject({ mode: "fallback", googleApiKeyProvided: false });
      const input = control.element.querySelector<HTMLInputElement>('input[type="password"]')!;
      input.value = "  saved-fixture-key  ";
      [...control.element.querySelectorAll("button")].find(button => button.textContent === "Save")!.click();
      expect(host.settings.get("map.source.googleKey")).toBe("saved-fixture-key");
      expect(host.runtime.status.googleApiKeyProvided).toBe(true);
      expect(changed).toHaveBeenCalled();
      expect(host.tokens).toEqual([]);
      expect(input.value).toBe("");
      expect(control.element.textContent).not.toContain("Applies when the app next starts");

      host.settings.set("map.source.basemap", "google");
      expect(host.runtime.status).toMatchObject({ mode: "google-tiles", googleApiKeyProvided: true, lastError: null });
      expect(host.tokens).toEqual(["saved-fixture-key"]);
      expect(host.runtime.engine).toBe(host.engine);
      expect(host.runtime.scene).toBe(host.scene);
      expect(engineDispose).not.toHaveBeenCalled();
      expect(sceneDispose).not.toHaveBeenCalled();
      expect(host.timers.size).toBe(1);
    } finally { unsubscribe(); control.destroy(); host.disposeHost(); }
  });

  it("retries an already selected Google source as soon as the missing key is saved", () => {
    const host = createGoogleKeyHost();
    try {
      host.settings.set("map.source.basemap", "google");
      expect(host.runtime.status.lastError).toBe("Google 3D Tiles need an API key.");
      expect(host.tokens).toEqual([]);
      host.settings.set("map.source.googleKey", "retry-fixture-key");
      expect(host.runtime.status).toMatchObject({ mode: "google-tiles", googleApiKeyProvided: true, lastError: null });
      expect(host.tokens).toEqual(["retry-fixture-key"]);
    } finally { host.disposeHost(); }
  });

  it("rotates and clears a live credential, retiring the old tile session and its holds", () => {
    const host = createGoogleKeyHost("host-fixture-key");
    const control = createParameterControl(host.settings, "map.source.googleKey", document);
    try {
      const first = host.renderers[0];
      host.settings.set("map.source.googleKey", "replacement-fixture-key");
      expect(host.tokens).toEqual(["host-fixture-key", "replacement-fixture-key"]);
      expect(first.group.isDisposed()).toBe(true);
      expect(host.runtime.status.mode).toBe("google-tiles");
      expect(host.timers.size).toBe(1);
      expect(host.holdCount()).toBe(2);

      host.settings.set("map.source.googleKey", " replacement-fixture-key ");
      expect(host.tokens).toHaveLength(2);
      // A standalone shared control borrows its presentation pulse from the
      // host; the full Map section supplies this after registry changes.
      control.update();
      [...control.element.querySelectorAll("button")].find(button => button.textContent === "Clear")!.click();
      expect(host.renderers[1].group.isDisposed()).toBe(true);
      expect(host.runtime.status).toMatchObject({ mode: "fallback", googleApiKeyProvided: false });
      expect(host.timers.size).toBe(0);
      expect(host.holdCount()).toBe(1);
      host.runtime.setMapSource("google");
      expect(host.tokens).toHaveLength(2);
      expect(host.runtime.status.lastError).toBe("Google 3D Tiles need an API key.");
    } finally { control.destroy(); host.disposeHost(); }
  });

  it.each(["source-first", "key-first"])("applies a %s batched key/source update once with the new credential", order => {
    const host = createGoogleKeyHost();
    try {
      const key = { "map.source.googleKey": "batch-fixture-key" };
      const source = { "map.source.basemap": "google" };
      expect(host.settings.setMany(order === "source-first" ? { ...source, ...key } : { ...key, ...source }).ok).toBe(true);
      expect(host.runtime.status.mode).toBe("google-tiles");
      expect(host.tokens).toEqual(["batch-fixture-key"]);
      expect(host.renderers).toHaveLength(1);
      expect(host.timers.size).toBe(1);
    } finally { host.disposeHost(); }
  });

  it("keeps blank credentials unavailable and never creates an authenticated session", () => {
    const host = createGoogleKeyHost();
    try {
      host.settings.set("map.source.googleKey", "   ");
      host.settings.set("map.source.basemap", "google");
      expect(host.runtime.status).toMatchObject({ mode: "fallback", googleApiKeyProvided: false });
      expect(host.tokens).toEqual([]);
      expect(host.holdCount()).toBe(1);
    } finally { host.disposeHost(); }
  });

  it("detaches credential/source observers on destruction", () => {
    const host = createGoogleKeyHost();
    try {
      host.settings.setMany({ "map.source.googleKey": "lifetime-fixture-key", "map.source.basemap": "google" });
      expect(host.tokens).toEqual(["lifetime-fixture-key"]);
      host.runtime.destroy();
      host.settings.set("map.source.googleKey", "after-disposal-fixture-key");
      expect(host.tokens).toEqual(["lifetime-fixture-key"]);
      expect(host.renderers[0].group.isDisposed()).toBe(true);
      expect(host.timers.size).toBe(0);
      expect(host.holdCount()).toBe(1);
    } finally { host.disposeHost(); }
  });
});

describe("borrowed globe runtime", () => {
  it("prepares real globe work without rendering/bracketing a second frame", () => {
    const host = createGlobeHostFixture(document);
    const begin = vi.spyOn(host.engine,"beginFrame"),end = vi.spyOn(host.engine,"endFrame"),render = vi.spyOn(host.scene,"render");
    const frame = vi.spyOn(host.frameProfile,"frame");
    try { host.runtime.prepareFrame(10);expect(host.skyUpdates()).toBe(1);expect(frame).toHaveBeenCalledOnce();
      expect(begin).not.toHaveBeenCalled();expect(end).not.toHaveBeenCalled();expect(render).not.toHaveBeenCalled();
      expect(host.runtime.isPreparingFrame()).toBe(false);host.runtime.afterFrame(10);expect(host.runtime.shouldKeepRendering()).toBe(false);
    } finally { host.disposeHost(); }
  });
  it("uses the actual renderer lifecycle once and retains the borrowed external camera/root", () => {
    const host = createGlobeHostFixture(document);const begin = vi.spyOn(host.engine,"beginFrame"),end = vi.spyOn(host.engine,"endFrame"),render = vi.spyOn(host.scene,"render");
    let preparing = false,calls = 0;
    try { host.runtime.setExternalFrameCallback(() => { calls += 1;preparing = host.runtime.isPreparingFrame(); });
      host.lifecycle.renderFrame(() => host.runtime.prepareFrame(20),() => host.runtime.afterFrame(20));
      expect(begin).toHaveBeenCalledOnce();expect(end).toHaveBeenCalledOnce();expect(render).toHaveBeenCalledOnce();expect(calls).toBe(1);expect(preparing).toBe(true);
      expect(host.scene.activeCamera).toBe(host.camera);expect(host.runtime.getWorldRoot()).toBe(host.worldRoot);expect(host.runtime.acquireNavigation({ owner: "fixture",inputContext: "viewer" }).ok).toBe(false);
      host.runtime.setSimRunning(true);expect(host.runtime.shouldKeepRendering()).toBe(true);host.runtime.setExternalRunning(false);expect(host.runtime.shouldKeepRendering()).toBe(false);
      host.settings.set("renderer.frameRateCap",50);expect(host.runtime.minFrameIntervalMs()).toBe(20);
    } finally { host.disposeHost(); }
  });
  it("rejects reentrant preparation and resets its boundary after a host callback failure", () => {
    const host = createGlobeHostFixture(document);
    try { host.runtime.prepareFrame(10);expect(() => host.runtime.prepareFrame(11)).toThrow("twice");host.runtime.afterFrame(10);
      host.runtime.setExternalFrameCallback(() => { throw new Error("host frame failed"); });expect(() => host.runtime.prepareFrame(20)).toThrow("host frame failed");expect(host.runtime.isPreparingFrame()).toBe(false);
      host.runtime.setExternalFrameCallback(null);host.runtime.prepareFrame(30);host.runtime.afterFrame(30);
    } finally { host.disposeHost(); }
  });
  it("closes an engine boundary when the borrowed renderer fails", () => {
    const host = createGlobeHostFixture(document);const render = vi.spyOn(host.scene,"render").mockImplementation(() => { throw new Error("render failed"); });
    try { let rendered = false;
      expect(() => { try { host.lifecycle.renderFrame(() => host.runtime.prepareFrame(10)); rendered = true; } finally { host.runtime.afterFrame(10,rendered); } }).toThrow("render failed");
      render.mockRestore();host.runtime.prepareFrame(20);host.runtime.afterFrame(20);
    } finally { host.disposeHost(); }
  });
  it("releases only engine holds/resources and leaves every host authority live", () => {
    const host = createGlobeHostFixture(document);const sceneDispose = vi.spyOn(host.scene,"dispose"),engineDispose = vi.spyOn(host.engine,"dispose"),profileDispose = vi.spyOn(host.frameProfile,"dispose"),lifecycleDispose = vi.spyOn(host.lifecycle,"dispose");
    try { host.runtime.beginContinuous();host.runtime.beginContinuous();expect(host.holdCount()).toBe(3);
      host.runtime.destroy();host.runtime.destroy();expect(host.holdCount()).toBe(1);expect(host.skyDetached()).toBe(1);
      for (const spy of [sceneDispose,engineDispose,profileDispose,lifecycleDispose]) expect(spy).not.toHaveBeenCalled();
      expect(host.worldRoot.isDisposed()).toBe(false);expect(host.camera.isDisposed()).toBe(false);expect(host.scene.getMeshByName("fallback-globe")).toBeNull();
      const exposure = host.scene.imageProcessingConfiguration.exposure;host.settings.set("renderer.exposureEV",2);expect(host.scene.imageProcessingConfiguration.exposure).toBe(exposure);
      const requests = host.requestCount();host.runtime.requestRender();host.runtime.beginContinuous();host.runtime.prepareFrame(50);expect(host.requestCount()).toBe(requests);expect(host.holdCount()).toBe(1);
    } finally { host.disposeHost(); }
  });
  it("cleans partial engine setup after a Sky attach failure, without disposing host resources", () => {
    const host = createGlobeHostFixture(document);host.runtime.destroy();
    try { expect(() => createGlobeRuntime(host.scene.getEngine().getRenderingCanvas() ?? document.createElement("canvas"),{ ...host.options,sky: { attach() { throw new Error("Sky host failed"); } } })).toThrow("Sky host failed");
      expect(host.scene.getLightByName("sim-light")).toBeNull();expect(host.worldRoot.isDisposed()).toBe(false);expect(host.holdCount()).toBe(1);
    } finally { host.disposeHost(); }
  });
  it("delegates destination placement to the explicit host policy and rejects calls after disposal", async () => {
    const host = createGlobeHostFixture(document);
    try { expect(await host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0 })).toEqual({ groundHeightMeters: 0,altitudeMeters: 0 });
      expect(await host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0,altitudeAboveGroundMeters: 42 })).toEqual({ groundHeightMeters: 0,altitudeMeters: 42 });
      await expect(host.runtime.prepareTerrain({ latDeg: 100,lonDeg: 0 })).rejects.toThrow("valid destination");
      host.runtime.destroy();await expect(host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0 })).rejects.toMatchObject({ name: "AbortError" });
    } finally { host.disposeHost(); }
  });
  it("preserves preparation and capture errors while retiring frame focus before supplied cleanup", () => {
    const capture = createTerrainPerformanceCapture(4),operation = new Error("external frame failed"),cleanup = new Error("capture close failed");
    const host = createGlobeHostFixture(document,{ terrainPerformanceCapture: capture });
    let position = { x: 1,y: 2,z: 3 };
    host.runtime.registerFocusPoint({ id: "fixture-focus",label: "Fixture focus",getPosition: () => position });
    host.settings.set("map.focus.point","fixture-focus");
    const end = vi.spyOn(capture,"endFrame").mockImplementationOnce(() => {
      expect(host.runtime.isPreparingFrame()).toBe(false);
      expect(host.runtime.getFocusPosition()).toEqual(position);
      throw cleanup;
    });
    try {
      host.runtime.setExternalFrameCallback(() => { expect(host.runtime.getFocusPosition()).toEqual(position); position = { x: 4,y: 5,z: 6 }; throw operation; });
      let failure: unknown;
      try { host.runtime.prepareFrame(10); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors).toEqual([operation,cleanup]);
      host.runtime.afterFrame(10);expect(end).toHaveBeenCalledOnce();expect(host.runtime.isPreparingFrame()).toBe(false);
      host.runtime.setExternalFrameCallback(null);host.runtime.prepareFrame(20);host.runtime.afterFrame(20);expect(end).toHaveBeenCalledTimes(2);
    } finally { host.disposeHost(); }
  });
  it("closes a failed-render boundary once even when capture cleanup throws", () => {
    const capture = createTerrainPerformanceCapture(4),cleanup = new Error("capture close failed");
    const host = createGlobeHostFixture(document,{ terrainPerformanceCapture: capture });
    const end = vi.spyOn(capture,"endFrame").mockImplementationOnce(() => { throw cleanup; });
    try {
      host.runtime.prepareFrame(10);
      const clock = vi.spyOn(host.frameProfile.profiler,"clock");
      expect(() => host.runtime.afterFrame(10,false)).toThrow(cleanup);expect(clock).not.toHaveBeenCalled();
      host.runtime.afterFrame(10);expect(end).toHaveBeenCalledOnce();expect(host.runtime.isPreparingFrame()).toBe(false);
      host.runtime.prepareFrame(20);host.runtime.afterFrame(20);expect(end).toHaveBeenCalledTimes(2);
    } finally { host.disposeHost(); }
  });
  it("aggregates post-render operation and capture failures in causal order and allows the next frame", () => {
    const capture = createTerrainPerformanceCapture(4),operation = new Error("sample clock failed"),cleanup = new Error("capture close failed");
    const host = createGlobeHostFixture(document,{ terrainPerformanceCapture: capture });
    try {
      host.runtime.prepareFrame(10);vi.spyOn(host.frameProfile.profiler,"clock").mockImplementationOnce(() => { throw operation; });
      const end = vi.spyOn(capture,"endFrame").mockImplementationOnce(() => { throw cleanup; });
      let failure: unknown;try { host.runtime.afterFrame(10); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors).toEqual([operation,cleanup]);
      host.runtime.afterFrame(10);expect(end).toHaveBeenCalledOnce();host.runtime.prepareFrame(20);host.runtime.afterFrame(20);
    } finally { host.disposeHost(); }
  });
  it("recovers after both supplied capture begin and end fail", () => {
    const capture = createTerrainPerformanceCapture(4),operation = new Error("capture begin failed"),cleanup = new Error("capture close failed");
    const host = createGlobeHostFixture(document,{ terrainPerformanceCapture: capture });
    vi.spyOn(capture,"beginFrame").mockImplementationOnce(() => { throw operation; });
    const end = vi.spyOn(capture,"endFrame").mockImplementationOnce(() => { throw cleanup; });
    try {
      let failure: unknown;try { host.runtime.prepareFrame(10); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors).toEqual([operation,cleanup]);
      expect(host.runtime.isPreparingFrame()).toBe(false);host.runtime.afterFrame(10);expect(end).toHaveBeenCalledOnce();
      host.runtime.prepareFrame(20);host.runtime.afterFrame(20);
    } finally { host.disposeHost(); }
  });
  it("does not lose a literal undefined operation failure while closing the frame", () => {
    const capture = createTerrainPerformanceCapture(4),host = createGlobeHostFixture(document,{ terrainPerformanceCapture: capture });
    try {
      host.runtime.prepareFrame(10);vi.spyOn(host.frameProfile.profiler,"clock").mockImplementationOnce(() => { throw undefined; });
      const notThrown = Symbol("not thrown");let failure: unknown = notThrown;
      try { host.runtime.afterFrame(10); } catch (error) { failure = error; }
      expect(failure).toBeUndefined();expect(capture.snapshot().frames).toBe(1);host.runtime.prepareFrame(20);host.runtime.afterFrame(20);
    } finally { host.disposeHost(); }
  });
  it("finishes real runtime teardown after watcher, Sky detach and frame capture cleanup throw", () => {
    const capture = createTerrainPerformanceCapture(4),watcherError = new Error("watcher stop failed"),skyError = new Error("Sky detach failed"),captureError = new Error("capture close failed");
    const detach = vi.fn();
    const host = createTerrainHost(defaults => ({ terrainPerformanceCapture: capture,
      clock: { ...defaults.clock,after(callback,delay) { const stop = defaults.clock.after(callback,delay); return () => { stop(); throw watcherError; }; } },
      sky: { attach(context) { const attached = defaults.sky.attach(context); return { ...attached,detach() { attached.detach(); detach(); throw skyError; } }; } },
    }));
    const end = vi.spyOn(capture,"endFrame").mockImplementationOnce(() => { throw captureError; });
    try {
      host.runtime.beginContinuous();host.runtime.prepareFrame(10);
      let failure: unknown;try { host.runtime.destroy(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([watcherError,skyError,captureError]));
      expect(end).toHaveBeenCalledOnce();expect(detach).toHaveBeenCalledOnce();expect(host.holdCount()).toBe(1);expect(host.timers.size).toBe(0);
      expect(host.runtime.isPreparingFrame()).toBe(false);expect(host.worldRoot.isDisposed()).toBe(false);expect(host.camera.isDisposed()).toBe(false);
      host.runtime.afterFrame(10);host.runtime.destroy();expect(end).toHaveBeenCalledOnce();expect(detach).toHaveBeenCalledOnce();
    } finally { host.disposeHost(); }
  });
});

describe("actual runtime terrain preparation settlement", () => {
  it("rejects an initial progress failure and removes its timer, camera and continuous hold", async () => {
    const host = createTerrainHost(),operation = new Error("initial progress failed"),baseline = host.holdCount();
    const progress = vi.fn(() => { throw operation; });
    try {
      await expect(host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0,onProgress: progress })).rejects.toBe(operation);
      expect(progress).toHaveBeenCalledOnce();expect(host.holdCount()).toBe(baseline);expect(host.timers.size).toBe(1);expect(host.scene.activeCamera).toBe(host.camera);
      host.runtime.prepareFrame(10);host.runtime.afterFrame(10);expect(host.scene.activeCamera).toBe(host.camera);
      const abort = new AbortController(),next = host.runtime.prepareTerrain({ latDeg: 1,lonDeg: 1,signal: abort.signal }).catch(error => error);
      abort.abort();expect(await next).toMatchObject({ name: "AbortError" });expect(host.holdCount()).toBe(baseline);
    } finally { host.disposeHost(); }
  });
  it("rejects a timer registration failure after retiring the acquired preparation camera and hold", async () => {
    const host = createTerrainHost(),operation = new Error("timer registration failed"),baseline = host.holdCount();
    vi.spyOn(host.options.clock,"after").mockImplementationOnce(() => { throw operation; });
    try {
      await expect(host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0 })).rejects.toBe(operation);
      expect(host.holdCount()).toBe(baseline);expect(host.scene.activeCamera).toBe(host.camera);expect(host.timers.size).toBe(1);
      host.runtime.prepareFrame(10);host.runtime.afterFrame(10);expect(host.scene.activeCamera).toBe(host.camera);
    } finally { host.disposeHost(); }
  });
  it("settles cancellation despite throwing timer, signal removal, hold release and failure-progress ports", async () => {
    const host = createTerrainHost(),timerError = new Error("timer stop failed"),signalError = new Error("signal removal failed"),holdError = new Error("hold release failed"),progressError = new Error("failure progress failed"),baseline = host.holdCount();
    const stop = vi.fn(() => { throw timerError; }),abort = new AbortController(),remove = vi.fn((listener: () => void) => { abort.signal.removeEventListener("abort",listener); throw signalError; });
    vi.spyOn(host.options.clock,"after").mockImplementationOnce(() => stop);
    const releaseHold = host.options.scheduler.endContinuous;
    vi.spyOn(host.options.scheduler,"endContinuous").mockImplementationOnce(() => { releaseHold();throw holdError; });
    const signal = { get aborted() { return abort.signal.aborted; },addEventListener(_type: "abort",listener: () => void,options?: { once?: boolean }) { abort.signal.addEventListener("abort",listener,options); },removeEventListener(_type: "abort",listener: () => void) { remove(listener); } };
    try {
      const pending = host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0,signal,onProgress(progress) { if (progress.diagnostics?.status === "failed") throw progressError; } }).catch(error => error);
      abort.abort();const failure = await pending;expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0]).toMatchObject({ name: "AbortError" });expect(failure.errors.slice(1)).toEqual([timerError,signalError,holdError,progressError]);
      expect(stop).toHaveBeenCalledOnce();expect(remove).toHaveBeenCalledOnce();expect(host.holdCount()).toBe(baseline);expect(host.scene.activeCamera).toBe(host.camera);
      host.runtime.prepareFrame(10);host.runtime.afterFrame(10);host.runtime.destroy();expect(stop).toHaveBeenCalledOnce();expect(remove).toHaveBeenCalledOnce();expect(host.holdCount()).toBe(1);
    } finally { host.disposeHost(); }
  });
  it("rejects successful preparation if timer cleanup fails and prevents another evaluation", async () => {
    const result = { groundHeightMeters: 12,altitudeMeters: 42 },evaluate = vi.fn(() => ({ result,progress: { phase: "ready" as const,readySamples: 5,totalSamples: 5,progress: 1,message: "Ready." } }));
    const host = createTerrainHost(defaults => ({ terrainPreparation: { ...defaults.terrainPreparation,evaluate } })),timerError = new Error("timer stop failed"),baseline = host.holdCount();
    vi.spyOn(host.options.clock,"after").mockImplementationOnce(() => () => { throw timerError; });
    try {
      const pending = host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0 }).catch(error => error);
      host.runtime.prepareFrame(10);host.runtime.afterFrame(10);expect(await pending).toBe(timerError);
      expect(host.holdCount()).toBe(baseline);expect(host.scene.activeCamera).toBe(host.camera);
      host.runtime.prepareFrame(20);host.runtime.afterFrame(20);expect(evaluate).toHaveBeenCalledOnce();
    } finally { host.disposeHost(); }
  });
  it("preserves evaluation, timer cleanup and capture failures without stranding the promise or next frame", async () => {
    const operation = new Error("evaluation failed"),timerError = new Error("timer stop failed"),captureError = new Error("capture close failed"),capture = createTerrainPerformanceCapture(4);
    const host = createTerrainHost(defaults => ({ terrainPerformanceCapture: capture,terrainPreparation: { ...defaults.terrainPreparation,evaluate() { throw operation; } } })),baseline = host.holdCount();
    vi.spyOn(host.options.clock,"after").mockImplementationOnce(() => () => { throw timerError; });
    try {
      const pending = host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0 }).catch(error => error);
      host.runtime.prepareFrame(10);vi.spyOn(capture,"endFrame").mockImplementationOnce(() => { throw captureError; });
      let frameFailure: unknown;try { host.runtime.afterFrame(10); } catch (error) { frameFailure = error; }
      const preparationFailure = await pending;expect(preparationFailure).toBeInstanceOf(AggregateError);expect(preparationFailure.errors).toEqual([operation,timerError]);
      expect(frameFailure).toBeInstanceOf(AggregateError);expect((frameFailure as AggregateError).errors).toEqual([preparationFailure,captureError]);
      expect(host.holdCount()).toBe(baseline);expect(host.scene.activeCamera).toBe(host.camera);host.runtime.prepareFrame(20);host.runtime.afterFrame(20);
    } finally { host.disposeHost(); }
  });
  it("retires pending preparation and frame state when disposal progress and capture cleanup throw", async () => {
    const capture = createTerrainPerformanceCapture(4),progressError = new Error("failure progress failed"),captureError = new Error("capture close failed"),host = createTerrainHost(() => ({ terrainPerformanceCapture: capture }));
    try {
      const pending = host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0,onProgress(progress) { if (progress.diagnostics?.status === "failed") throw progressError; } }).catch(error => error);
      host.runtime.prepareFrame(10);const end = vi.spyOn(capture,"endFrame").mockImplementationOnce(() => { throw captureError; });
      expect(() => host.runtime.destroy()).toThrow("Globe feature cleanup failed");const failure = await pending;
      expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors[0]).toMatchObject({ name: "AbortError" });expect(failure.errors[1]).toBe(progressError);
      expect(host.holdCount()).toBe(1);expect(host.timers.size).toBe(0);expect(host.skyDetached()).toBe(1);expect(host.runtime.isPreparingFrame()).toBe(false);
      host.runtime.afterFrame(10);host.runtime.destroy();expect(end).toHaveBeenCalledOnce();expect(host.scene.activeCamera).toBe(host.camera);
    } finally { host.disposeHost(); }
  });
  it("cancels an eagerly firing supplied timeout only after acquiring its stop handle", async () => {
    const host = createTerrainHost(),stopError = new Error("timer stop failed"),stop = vi.fn(() => { throw stopError; }),baseline = host.holdCount();
    vi.spyOn(host.options.clock,"after").mockImplementationOnce(callback => { callback();return stop; });
    try {
      const failure = await host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0 }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors[0].message).toContain("did not become ready");expect(failure.errors[1]).toBe(stopError);
      expect(stop).toHaveBeenCalledOnce();expect(host.holdCount()).toBe(baseline);expect(host.scene.activeCamera).toBe(host.camera);
      host.runtime.prepareFrame(10);host.runtime.afterFrame(10);
    } finally { host.disposeHost(); }
  });
  it("returns a rejected promise for a fallback progress port failure", async () => {
    const host = createGlobeHostFixture(document),operation = new Error("fallback progress failed");
    try { await expect(host.runtime.prepareTerrain({ latDeg: 0,lonDeg: 0,onProgress() { throw operation; } })).rejects.toBe(operation);expect(host.holdCount()).toBe(1); }
    finally { host.disposeHost(); }
  });
});

describe("owned continuous holds over one borrowed scheduler", () => {
  it("does not consume a host hold or call cleanup twice after unsubscribe", () => {
    let holds = 1;const stop = vi.fn();const scheduler = { requestRender: vi.fn(),beginContinuous() { holds += 1; },endContinuous() { holds -= 1; },setPaused: vi.fn(),isActive: () => true,onActiveChange: () => stop };
    const authority = createBorrowedRuntimeAuthority(scheduler);const unsubscribe = authority.scheduler.onActiveChange(() => {});
    authority.scheduler.beginContinuous();unsubscribe();authority.dispose();authority.dispose();expect(holds).toBe(1);expect(stop).toHaveBeenCalledOnce();authority.scheduler.requestRender();expect(scheduler.requestRender).not.toHaveBeenCalled();
  });
  it("finishes later cleanups and balances holds even if an owner callback throws", () => {
    let holds = 0;const done = vi.fn();const authority = createBorrowedRuntimeAuthority({ requestRender() {},beginContinuous() { holds += 1; },endContinuous() { holds -= 1; },setPaused() {},isActive: () => false,onActiveChange: () => () => undefined });
    authority.scheduler.beginContinuous();authority.own(done);authority.own(() => { throw new Error("cleanup"); });expect(() => authority.dispose()).toThrow("Globe feature cleanup failed");expect(done).toHaveBeenCalledOnce();expect(holds).toBe(0);
  });
});


describe("owned globe cleanup and ordinary host preparation", () => {
  it("forwards one ordinary frame timestamp/delta and receiver before Sky without external simulation mode", () => {
    const order: string[] = [];
    const contribution = { prepare(frame: import("../src/babylon/globeRuntimePorts.js").GlobeFramePreparation) {
      expect(this).toBe(contribution); expect(frame.nowMs).toBe(123); expect(frame.deltaSeconds).toBe(0.016);
      expect(frame.scene).toBe(host.scene); expect(host.runtime.isPreparingFrame()).toBe(true); order.push("host");
    } };
    const host = createGlobeHostFixture(document, defaults => ({ external: undefined, framePreparation: contribution,
      sky: { attach(context) { const attached = defaults.sky.attach(context); return { ...attached, runtime: { ...attached.runtime,
        update() { expect(order).toEqual(["host"]); order.push("sky"); attached.runtime.update(); } } }; } },
    }));
    vi.spyOn(host.engine, "getDeltaTime").mockReturnValue(16);
    try { host.runtime.prepareFrame(123); host.runtime.afterFrame(123); expect(order).toEqual(["host", "sky"]); expect(host.skyUpdates()).toBe(1); }
    finally { host.disposeHost(); vi.restoreAllMocks(); }
  });
  it("closes a failed ordinary contribution boundary before another host frame", () => {
    let fail = true; const error = new Error("ordinary contribution failed"), capture = createTerrainPerformanceCapture(4);
    const host = createGlobeHostFixture(document, { external: undefined, terrainPerformanceCapture: capture,
      framePreparation: { prepare() { if (fail) throw error; } } });
    const end = vi.spyOn(capture, "endFrame");
    try { expect(() => host.runtime.prepareFrame(10)).toThrow(error); expect(end).toHaveBeenCalledOnce(); expect(host.skyUpdates()).toBe(0);
      expect(host.runtime.isPreparingFrame()).toBe(false); fail = false; host.runtime.prepareFrame(20); host.runtime.afterFrame(20); expect(host.skyUpdates()).toBe(1); expect(end).toHaveBeenCalledTimes(2);
    } finally { host.disposeHost(); vi.restoreAllMocks(); }
  });
  it("disposes both owned cameras after clipping removal throws and preserves the borrowed previous camera", async () => {
    const host = createTerrainHost(), error = new Error("clipping release failed");
    // The external floating-origin host selects the separate local preparation
    // camera; without its parent the existing geospatial camera is reused.
    host.worldRoot.parent = new TransformNode("fixture-floating-origin-parent", host.scene);
    const preparing = host.runtime.prepareTerrain({ latDeg: 0, lonDeg: 0 }); const rejected = expect(preparing).rejects.toThrow();
    const camera = host.runtime.geospatialCamera!, preparation = host.scene.getCameraByName("terrain-preparation-camera")!;
    expect(camera).not.toBeNull(); expect(preparation).not.toBeNull();
    const clipping = vi.spyOn(camera, "removeBehavior").mockImplementationOnce(() => { throw error; });
    const cameraDispose = vi.spyOn(camera, "dispose"), preparationDispose = vi.spyOn(preparation, "dispose");
    try { expect(() => host.runtime.destroy()).toThrow(); await rejected;
      expect(clipping).toHaveBeenCalled(); expect(cameraDispose).toHaveBeenCalledOnce(); expect(preparationDispose).toHaveBeenCalledOnce();
      expect(host.scene.activeCamera).toBe(host.camera); expect(host.camera.isDisposed()).toBe(false); expect(host.worldRoot.isDisposed()).toBe(false);
      host.runtime.destroy(); expect(cameraDispose).toHaveBeenCalledOnce(); expect(preparationDispose).toHaveBeenCalledOnce(); expect(host.holdCount()).toBe(1);
    } finally { vi.restoreAllMocks(); host.disposeHost(); }
  });
  it("attempts fallback light release even when mesh disposal throws", () => {
    const host = createGlobeHostFixture(document), mesh = host.scene.getMeshByName("fallback-globe")!, light = host.scene.getLightByName("fallback-light")!;
    const error = new Error("fallback mesh release failed"), dispose = vi.spyOn(mesh, "dispose").mockImplementationOnce(() => { throw error; }), lightDispose = vi.spyOn(light, "dispose");
    try { expect(() => host.runtime.destroy()).toThrow(); expect(lightDispose).toHaveBeenCalledOnce(); expect(host.skyDetached()).toBe(1);
      host.runtime.destroy(); expect(dispose).toHaveBeenCalledOnce(); expect(lightDispose).toHaveBeenCalledOnce(); expect(host.camera.isDisposed()).toBe(false);
    } finally { vi.restoreAllMocks(); host.disposeHost(); }
  });
  it("retains fallback allocation failure while still releasing material and light after mesh cleanup fails", () => {
    const host = createGlobeHostFixture(document); host.runtime.destroy();
    const operation = new Error("fallback styling failed"), cleanup = new Error("fallback partial mesh cleanup failed");
    const createSphere = MeshBuilder.CreateSphere; let partial: ReturnType<typeof createSphere> | undefined;
    const materialDispose = vi.spyOn(StandardMaterial.prototype, "dispose");
    vi.spyOn(MeshBuilder, "CreateSphere").mockImplementation((...args) => {
      partial = createSphere(...args); vi.spyOn(partial, "dispose").mockImplementationOnce(() => { throw cleanup; }); return partial;
    });
    vi.spyOn(Color3, "FromHexString").mockImplementationOnce(() => { throw operation; });
    try { let failure: unknown;
      try { createGlobeRuntime(document.createElement("canvas"), { ...host.options, external: undefined }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([operation, cleanup]);
      expect(materialDispose).toHaveBeenCalled(); expect(host.scene.getMaterialByName("fallback-globe-material")).toBeNull();
      expect(host.scene.getLightByName("fallback-light")).toBeNull(); expect(host.camera.isDisposed()).toBe(false); expect(host.holdCount()).toBe(1);
    } finally { vi.restoreAllMocks(); partial?.dispose(); host.disposeHost(); }
  });
});
