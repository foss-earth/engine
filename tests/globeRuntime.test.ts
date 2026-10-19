// @vitest-environment jsdom
import { describe,expect,it,vi } from "vitest";
import { createGlobeHostFixture } from "../fixtures/composition/globeHost.js";
import { createEngineSettings } from "../fixtures/composition/runtimeHost.js";
import { createGlobeRuntime } from "../src/babylon/createGlobeRuntime.js";
import { createBorrowedRuntimeAuthority } from "../src/babylon/borrowedRuntimeAuthority.js";
import { createTerrainPerformanceCapture } from "../src/terrain/terrainPerformanceCapture.js";
import { TransformNode, Color3, Mesh, Vector3, StandardMaterial, type Scene } from "@babylonjs/core";
import type { GlobeRuntimeOptions } from "../src/babylon/globeRuntimePorts.js";
import { createParameterControl } from "@foss-earth/ui/browser";
import { ANCHOR_FALLBACK_MESSAGES, NAVIGATION_ANCHOR_SETTING_IDS, SHOW_COMPASS_CENTER_ID, SHOW_NAVIGATION_ANCHORS_ID } from "../src/input/navigationAnchors.js";
import { ecefToGeodetic } from "../src/camera/cameraMath.js";
import type { NavigationAnchorService } from "../src/babylon/navigationAnchorService.js";
import type { NavigationAnchorMarkers } from "../src/browser/navigationAnchorMarkers.js";

/** Each runtime's own anchor service, passed through unchanged, so a test can see what the runtime asks of it. */
const anchorServices = vi.hoisted(() => [] as NavigationAnchorService[]);
vi.mock("../src/babylon/navigationAnchorService.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/babylon/navigationAnchorService.js")>();
  return { ...actual, createNavigationAnchorService(...args: Parameters<typeof actual.createNavigationAnchorService>) {
    const service = actual.createNavigationAnchorService(...args); anchorServices.push(service); return service;
  } };
});

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
function createGoogleKeyHost(initialKey: string | null = null, ready?: GlobeRuntimeOptions["mapPorts"]["google"]["ready"]) {
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
      ready,
    } },
  }));
  return { ...host, tokens, renderers };
}

/** A host's 3D Tiles code that loads when Google mode first asks for it, and comes, or fails, when the test says. */
function codeOnDemand() {
  let settle: { resolve(): void; reject(error: Error): void } | undefined;
  let loaded = false, loading: Promise<void> | null = null;
  const ready = vi.fn(() => (loaded ? null : loading ??= new Promise<void>((resolve, reject) => { settle = { resolve, reject }; })));
  const settled = async (outcome: () => void) => { outcome(); await loading?.catch(() => undefined); await Promise.resolve(); };
  return { ready,
    arrive: () => settled(() => { loaded = true; settle!.resolve(); }),
    fail: () => settled(() => { settle!.reject(new Error("chunk fixture failed")); loading = null; }) };
}

describe("live Google key activation", () => {
  it("streams the map behind a see-through panorama without releasing navigation", () => {
    const update = vi.spyOn(TerrainTilesFixture.prototype, "update");
    const host = createTerrainHost(() => ({ external: undefined }));
    const frame = (at: number) => { host.runtime.prepareFrame(at); host.runtime.afterFrame(at); };
    try {
      const acquired = host.runtime.acquireNavigation({ owner: "fixture.panorama", inputContext: "viewer" });
      if (!acquired.ok) throw new Error(acquired.message);
      update.mockClear();
      frame(10);
      expect(update).not.toHaveBeenCalled();
      host.runtime.setPresentedWorldVisible(true);
      frame(20);
      expect(update).toHaveBeenCalled();
      expect(acquired.lease.released).toBe(false);
      update.mockClear();
      host.runtime.setPresentedWorldVisible(false);
      frame(30);
      expect(update).not.toHaveBeenCalled();
      acquired.lease.release("exit");
      frame(40);
      expect(update).toHaveBeenCalled();
    } finally { host.disposeHost(); update.mockRestore(); }
  });

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

  it("waits for 3D Tiles code that loads on demand, keeping the map shown, then starts with the key saved", async () => {
    const code = codeOnDemand();
    const host = createGoogleKeyHost(null, code.ready);
    try {
      host.settings.set("map.source.basemap", "google");
      // Without a key there is nothing to load the code for.
      expect(code.ready).not.toHaveBeenCalled();
      host.settings.set("map.source.googleKey", "on-demand-fixture-key");
      expect(code.ready).toHaveBeenCalledOnce();
      expect(host.runtime.status).toMatchObject({ mode: "fallback", message: "Loading Google 3D Tiles.", googleApiKeyProvided: true });
      expect(host.renderers).toHaveLength(0);
      await code.arrive();
      expect(host.runtime.status).toMatchObject({ mode: "google-tiles", lastError: null });
      expect(host.tokens).toEqual(["on-demand-fixture-key"]);
      expect(host.renderers).toHaveLength(1);
    } finally { host.disposeHost(); }
  });

  it("drops a Google start still waiting for its code when its key is cleared, and falls back when the code fails", async () => {
    const chosen = codeOnDemand();
    const host = createGoogleKeyHost(null, chosen.ready);
    try {
      host.settings.setMany({ "map.source.googleKey": "on-demand-fixture-key", "map.source.basemap": "google" });
      host.settings.set("map.source.googleKey", "");
      await chosen.arrive();
      expect(host.runtime.status).toMatchObject({ mode: "fallback", lastError: "Google 3D Tiles need an API key." });
      expect(host.renderers).toHaveLength(0);
      // Saved again, the code is there.
      host.settings.set("map.source.googleKey", "on-demand-fixture-key");
      expect(host.runtime.status.mode).toBe("google-tiles");
      expect(host.tokens).toEqual(["on-demand-fixture-key"]);
    } finally { host.disposeHost(); }
    const failing = codeOnDemand();
    const failed = createGoogleKeyHost(null, failing.ready);
    try {
      failed.settings.setMany({ "map.source.googleKey": "on-demand-fixture-key", "map.source.basemap": "google" });
      await failing.fail();
      expect(failed.runtime.status).toMatchObject({ mode: "fallback", lastError: "Google 3D Tiles could not be loaded (chunk fixture failed)." });
      expect(failed.renderers).toHaveLength(0);
      // A later choice asks again.
      failed.runtime.setMapSource("google");
      expect(failing.ready).toHaveBeenCalledTimes(2);
    } finally { failed.disposeHost(); }
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
    const failed: Mesh[] = [];
    const materialDispose = vi.spyOn(StandardMaterial.prototype, "dispose");
    // The fallback globe's sphere fails its first cleanup.
    const meshDispose = Mesh.prototype.dispose;
    vi.spyOn(Mesh.prototype, "dispose").mockImplementation(function (this: Mesh, ...args: Parameters<Mesh["dispose"]>) {
      if (this.name === "fallback-globe" && !failed.length) { failed.push(this); throw cleanup; }
      return meshDispose.apply(this, args);
    });
    vi.spyOn(Color3, "FromHexString").mockImplementationOnce(() => { throw operation; });
    try { let failure: unknown;
      try { createGlobeRuntime(document.createElement("canvas"), { ...host.options, external: undefined }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([operation, cleanup]);
      expect(materialDispose).toHaveBeenCalled(); expect(host.scene.getMaterialByName("fallback-globe-material")).toBeNull();
      expect(host.scene.getLightByName("fallback-light")).toBeNull(); expect(host.camera.isDisposed()).toBe(false); expect(host.holdCount()).toBe(1);
    } finally { vi.restoreAllMocks(); for (const mesh of failed) mesh.dispose(); host.disposeHost(); }
  });
});

/** An ordinary (not simulation) runtime, which owns its camera and input, with the anchor service it made. */
function createAnchorHost(markers: NavigationAnchorMarkers | null = null) {
  const made = anchorServices.length;
  const host = createGlobeHostFixture(document, defaults => ({ external: undefined,
    platform: markers ? { ...defaults.platform, navigationAnchorMarkers: () => markers } : defaults.platform }));
  const service = anchorServices[made];
  if (!service || anchorServices.length !== made + 1) throw new Error("The runtime did not make exactly one anchor service.");
  return { ...host, anchors: host.runtime.navigationAnchors, service };
}
const noGlide = { orbit: null, zoom: null };
const nonPointerZoom = { family: "nonPointer", operations: ["zoom"], client: null } as const;
const noteOf = (host: { settings: { inspect(id: string): { note: string | null } } }, id: string) => host.settings.inspect(id).note;

describe("runtime navigation anchors", () => {
  it("reports Pick point, Pin compass target and Clear pin through status and subscribers", () => {
    const host = createAnchorHost(), changed = vi.fn();
    try {
      expect(host.anchors.status()).toEqual({ pin: null, selection: "off", pinningBlocked: null, tracking: false,
        last: { mouse: {}, trackpad: {}, touch: {}, nonPointer: {} } });
      const unsubscribe = host.anchors.subscribe(changed);
      expect(host.anchors.togglePick()).toBe(true);
      expect(host.anchors.status().selection).toBe("armed"); expect(changed).toHaveBeenCalledOnce();
      expect(host.anchors.togglePick()).toBe(false);
      expect(host.anchors.status().selection).toBe("off"); expect(changed).toHaveBeenCalledTimes(2);
      expect(host.anchors.armPick()).toBe(true); host.anchors.cancelPick();
      expect(host.anchors.status().selection).toBe("off"); expect(changed).toHaveBeenCalledTimes(4);
      host.anchors.cancelPick(); expect(changed).toHaveBeenCalledTimes(4);

      // Pinning the compass target disarms Pick point and copies the camera's centre as it is.
      host.anchors.armPick(); changed.mockClear();
      const center = host.runtime.geospatialCamera!.center.clone();
      expect(host.anchors.pinTarget()).toBe(true);
      const pin = host.anchors.status().pin!;
      expect(pin).toMatchObject({ source: "target", surfaceRevision: null, point: { x: center.x, y: center.y, z: center.z } });
      expect([pin.latDeg, pin.lonDeg, pin.heightMeters].every(Number.isFinite)).toBe(true);
      expect(host.anchors.status().selection).toBe("off"); expect(changed).toHaveBeenCalledOnce();
      host.runtime.geospatialCamera!.center.x += 1000;
      expect(host.anchors.status().pin!.point.x).toBe(center.x);

      host.anchors.clearPin();
      expect(host.anchors.status().pin).toBeNull(); expect(changed).toHaveBeenCalledTimes(2);
      host.anchors.clearPin(); expect(changed).toHaveBeenCalledTimes(2);
      unsubscribe(); host.anchors.pinTarget(); expect(changed).toHaveBeenCalledTimes(2);
    } finally { host.disposeHost(); }
  });

  it("explains that a simulation owning the camera blocks picking and pinning", () => {
    const host = createGlobeHostFixture(document);
    try {
      expect(host.runtime.navigationAnchors.status().pinningBlocked).toBe("A simulation owns the camera.");
      expect(host.runtime.navigationAnchors.pinTarget()).toBe(false);
      expect(host.runtime.navigationAnchors.togglePick()).toBe(false);
      expect(host.runtime.navigationAnchors.status()).toMatchObject({ pin: null, selection: "off" });
    } finally { host.disposeHost(); }
  });

  it("blocks Pick point and Pin compass target while a navigation lease holds the camera, keeping the pin and Clear pin", () => {
    const host = createAnchorHost(), changed = vi.fn();
    const reset = vi.spyOn(host.service, "reset"), refresh = vi.spyOn(host.service, "refresh");
    try {
      host.anchors.subscribe(changed);
      expect(host.anchors.pinTarget()).toBe(true);
      const pin = host.anchors.status().pin;
      expect(host.anchors.armPick()).toBe(true);
      const beforeLease = host.service.acquire(nonPointerZoom);
      expect(beforeLease.zoom!.owner).toBe("globe");
      changed.mockClear();

      const acquired = host.runtime.acquireNavigation({ owner: "fixture.scenes", inputContext: "viewer" });
      if (!acquired.ok) throw new Error(acquired.message);
      const lease = acquired.lease;
      // The lease resets gesture contexts and Pick point, and says pinning is now blocked.
      expect(reset).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalled();
      expect(host.service.isCurrent(beforeLease.zoom!)).toBe(false);
      const blocked = host.anchors.status();
      expect(blocked).toMatchObject({ pin, selection: "off" });
      expect(blocked.pinningBlocked).toContain("holds the camera");
      expect(host.anchors.armPick()).toBe(false); expect(host.anchors.togglePick()).toBe(false);
      expect(host.anchors.status().selection).toBe("off");
      host.runtime.geospatialCamera!.center.x += 1000;
      expect(host.anchors.pinTarget()).toBe(false);
      expect(host.anchors.status().pin).toBe(pin);
      expect(host.service.acquire(nonPointerZoom).zoom!.owner).toBe("fixture.scenes");

      changed.mockClear();
      lease.release("exit");
      expect(refresh).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalled();
      expect(host.anchors.status()).toMatchObject({ pin, pinningBlocked: null });
      expect(host.anchors.armPick()).toBe(true); host.anchors.cancelPick();

      // Clear pin stays available under a lease.
      const second = host.runtime.acquireNavigation({ owner: "fixture.scenes", inputContext: "viewer" });
      if (!second.ok) throw new Error(second.message);
      changed.mockClear();
      host.anchors.clearPin();
      expect(host.anchors.status().pin).toBeNull(); expect(changed).toHaveBeenCalledOnce();
      expect(host.anchors.status().pinningBlocked).not.toBeNull();
      second.lease.release("exit");
      expect(host.anchors.status()).toMatchObject({ pin: null, pinningBlocked: null });
    } finally { host.disposeHost(); }
  });

  it("retires gesture contexts when a snapshot restores, and not when it is refused", () => {
    const host = createAnchorHost(), retire = vi.spyOn(host.service, "retire");
    try {
      const snapshot = host.runtime.captureNavigationSnapshot()!;
      let anchor = host.service.acquire(nonPointerZoom).zoom!;
      expect(host.runtime.restoreNavigationSnapshot(snapshot)).toBe(true);
      expect(retire).toHaveBeenCalledOnce(); expect(host.service.isCurrent(anchor)).toBe(false);

      const acquired = host.runtime.acquireNavigation({ owner: "fixture.scenes", inputContext: "viewer" });
      if (!acquired.ok) throw new Error(acquired.message);
      retire.mockClear();
      anchor = host.service.acquire(nonPointerZoom).zoom!;
      // Another holder's lease refuses a restore without it.
      expect(host.runtime.restoreNavigationSnapshot(snapshot)).toBe(false);
      expect(retire).not.toHaveBeenCalled(); expect(host.service.isCurrent(anchor)).toBe(true);
      expect(host.runtime.restoreNavigationSnapshot(snapshot, acquired.lease)).toBe(true);
      expect(retire).toHaveBeenCalledOnce(); expect(host.service.isCurrent(anchor)).toBe(false);
      acquired.lease.release("exit");
    } finally { host.disposeHost(); }
  });

  it("retires held anchors on setViewState and configureOrbitTargetHeight, keeping the pin", () => {
    const host = createAnchorHost(), changed = vi.fn(), retire = vi.spyOn(host.service, "retire");
    try {
      expect(host.anchors.pinTarget()).toBe(true);
      const pin = host.anchors.status().pin!;
      host.settings.set("input.nonPointer.zoomAnchor", "pinned");
      const held = host.service.acquire({ ...nonPointerZoom, hold: true }).zoom!;
      expect(held).toMatchObject({ source: "pinned", fallback: null, point: pin.point });
      expect(host.service.markerPoints(noGlide)).toEqual([{ point: pin.point, zoom: true, orbit: false, grab: false, pinned: true, held: false, zoomHeld: true }]);
      host.anchors.subscribe(changed);

      host.runtime.setViewState(host.runtime.getViewState()!);
      expect(retire).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
      expect(host.service.isCurrent(held)).toBe(false);
      expect(host.service.markerPoints(noGlide)).toEqual([{ point: pin.point, zoom: false, orbit: false, grab: false, pinned: true, held: false, zoomHeld: false }]);
      expect(host.anchors.status().pin).toBe(pin);

      const next = host.service.acquire(nonPointerZoom).zoom!;
      host.runtime.configureOrbitTargetHeight(null);
      expect(retire).toHaveBeenCalledTimes(2); expect(host.service.isCurrent(next)).toBe(false);
      expect(host.anchors.status().pin).toBe(pin);
    } finally { host.disposeHost(); }
  });

  it("keeps navigation snapshots at version 1 with no anchor or pin fields", () => {
    const host = createAnchorHost();
    try {
      expect(host.anchors.pinTarget()).toBe(true);
      host.service.acquire({ ...nonPointerZoom, hold: true });
      const snapshot = host.runtime.captureNavigationSnapshot()!;
      expect(snapshot.version).toBe(1);
      expect(Object.keys(snapshot).sort()).toEqual(["camera", "version", "view"]);
      expect(Object.keys(snapshot.camera).sort()).toEqual(["center", "fov", "pitch", "radius", "yaw"]);
      expect(JSON.stringify(snapshot)).not.toMatch(/pin|anchor|selection/i);
      const pin = host.anchors.status().pin;
      expect(host.runtime.restoreNavigationSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
      expect(host.anchors.status().pin).toBe(pin);
    } finally { host.disposeHost(); }
  });

  it("says beside each of the four zoom choices what it last did, following every choice's changes", () => {
    const host = createAnchorHost(), noPin = `${ANCHOR_FALLBACK_MESSAGES["no-pin"]}.`;
    try {
      expect(NAVIGATION_ANCHOR_SETTING_IDS).toEqual(["input.mouse.zoomAnchor", "input.trackpad.zoomAnchor", "input.touch.zoomAnchor", "input.nonPointer.zoomAnchor"]);
      expect(host.settings.has("input.mouse.orbitPivot")).toBe(false);
      for (const id of NAVIGATION_ANCHOR_SETTING_IDS) expect(noteOf(host, id)).toBeNull();
      // Each choice set to Pinned point without a pin is noted at once: its own watcher ran.
      for (const id of NAVIGATION_ANCHOR_SETTING_IDS) {
        expect(host.settings.set(id, "pinned").ok).toBe(true);
        expect(noteOf(host, id)).toBe(noPin);
      }
      host.settings.set("input.mouse.zoomAnchor", "pointer");
      expect(noteOf(host, "input.mouse.zoomAnchor")).toBeNull(); expect(noteOf(host, "input.trackpad.zoomAnchor")).toBe(noPin);

      // Pinning and clearing update the notes too.
      expect(host.anchors.pinTarget()).toBe(true);
      for (const id of NAVIGATION_ANCHOR_SETTING_IDS) expect(noteOf(host, id)).toBeNull();
      host.service.acquire(nonPointerZoom);
      expect(noteOf(host, "input.nonPointer.zoomAnchor")).toBe("Last used the pinned point.");
      host.settings.set("input.nonPointer.zoomAnchor", "target");
      expect(noteOf(host, "input.nonPointer.zoomAnchor")).toBeNull();
      host.anchors.clearPin();
      expect(noteOf(host, "input.touch.zoomAnchor")).toBe(noPin); expect(noteOf(host, "input.nonPointer.zoomAnchor")).toBeNull();
    } finally { host.disposeHost(); }
  });

  it("makes a tracked point every gesture's centre, retiring gesture contexts and noting the override", () => {
    const host = createAnchorHost(), changed = vi.fn(), retire = vi.spyOn(host.service, "retire");
    const tracking = `${ANCHOR_FALLBACK_MESSAGES.tracking}.`;
    try {
      host.anchors.subscribe(changed);
      const before = host.service.acquire(nonPointerZoom).zoom!;
      changed.mockClear();
      host.runtime.setOrbitMode(true);
      expect(retire).toHaveBeenCalledOnce(); expect(host.service.isCurrent(before)).toBe(false);
      expect(changed).toHaveBeenCalled(); expect(host.anchors.status().tracking).toBe(true);
      for (const id of NAVIGATION_ANCHOR_SETTING_IDS) expect(noteOf(host, id)).toBe(tracking);
      expect(host.service.acquire({ family: "mouse", operations: ["zoom", "orbit"], client: { x: 400, y: 300 } }))
        .toMatchObject({ zoom: { source: "target", fallback: "tracking" }, orbit: { source: "target", fallback: "tracking" } });
      expect(host.settings.get("input.mouse.zoomAnchor")).toBe("pointer");

      host.runtime.setOrbitMode(true);
      expect(retire).toHaveBeenCalledOnce();
      host.runtime.setOrbitMode(false);
      expect(retire).toHaveBeenCalledOnce(); expect(host.anchors.status().tracking).toBe(false);
      // Families with no gesture while tracking are noted as before.
      for (const id of NAVIGATION_ANCHOR_SETTING_IDS.filter(id => !id.startsWith("input.mouse."))) expect(noteOf(host, id)).toBeNull();
      // Leaving tracking restores the preferences for the next gesture.
      const next = host.service.acquire({ family: "mouse", operations: ["zoom"], client: { x: 400, y: 300 } }).zoom!;
      expect(next.fallback).not.toBe("tracking"); expect(next.requested).toBe("pointer");
      expect(noteOf(host, "input.mouse.zoomAnchor")).not.toBe(tracking);
    } finally { host.disposeHost(); }
  });

  // Spec (POI tracking): "Explain the temporary override in Controls ... Leaving tracking
  // restores those preferences for the next gesture." A family whose last gesture ran while
  // tracking does not keep describing the override.
  it("stops describing the tracking override once tracking ends", () => {
    const host = createAnchorHost(), tracking = `${ANCHOR_FALLBACK_MESSAGES.tracking}.`;
    try {
      host.runtime.setOrbitMode(true);
      host.service.acquire({ family: "mouse", operations: ["zoom"], client: { x: 400, y: 300 } });
      host.runtime.setOrbitMode(false);
      expect(host.anchors.status().tracking).toBe(false);
      expect(noteOf(host, "input.mouse.zoomAnchor")).not.toBe(tracking);
    } finally { host.disposeHost(); }
  });

  it("requests a render when the marker switch changes, and shows the markers it allows on drawn frames", () => {
    const markers = { show: vi.fn<NavigationAnchorMarkers["show"]>(), destroy: vi.fn() };
    const host = createAnchorHost(markers);
    const frame = (at: number) => { host.runtime.prepareFrame(at); host.runtime.afterFrame(at); return markers.show.mock.lastCall?.[0]; };
    try {
      expect(host.settings.get(SHOW_NAVIGATION_ANCHORS_ID)).toBe(true);
      expect(frame(10)).toEqual([]);
      expect(host.anchors.pinTarget()).toBe(true);
      expect(frame(20)).toEqual([expect.objectContaining({ pinned: true, held: false, zoom: false, orbit: false })]);

      const requests = host.requestCount();
      host.settings.set(SHOW_NAVIGATION_ANCHORS_ID, false);
      expect(host.requestCount()).toBeGreaterThan(requests);
      expect(frame(30)).toEqual([]);
      const again = host.requestCount();
      host.settings.set(SHOW_NAVIGATION_ANCHORS_ID, true);
      expect(host.requestCount()).toBeGreaterThan(again);
      expect(frame(40)).toHaveLength(1);

      // A lease's view is not the globe's: no markers over it.
      const acquired = host.runtime.acquireNavigation({ owner: "fixture.scenes", inputContext: "viewer" });
      if (!acquired.ok) throw new Error(acquired.message);
      expect(frame(50)).toEqual([]);
      acquired.lease.release("exit");
      expect(frame(60)).toHaveLength(1);

      host.runtime.destroy();
      expect(markers.destroy).toHaveBeenCalledOnce();
    } finally { host.disposeHost(); }
  });

  it("shows the grabbed ground from the press, and drops it when the press is released without moving", () => {
    const markers = { show: vi.fn<NavigationAnchorMarkers["show"]>(), destroy: vi.fn() };
    const host = createAnchorHost(markers);
    const canvas = host.canvas;
    Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 600 });
    Object.assign(canvas, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    const frame = (at: number) => { host.setTime(at); host.runtime.prepareFrame(at); host.runtime.afterFrame(at); return markers.show.mock.lastCall?.[0] ?? []; };
    const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    try {
      const before = host.runtime.getViewState()!;
      expect(frame(10).some(marker => marker.grab)).toBe(false);
      pointer("pointerdown", 400, 360);
      const held = frame(30);
      const grab = held.find(marker => marker.grab && !marker.zoom && !marker.orbit);
      expect(grab).toEqual(expect.objectContaining({ grab: true, held: true, pinned: false }));
      expect(Math.hypot(grab!.x - 400, grab!.y - 360)).toBeLessThan(2);
      pointer("pointerup", 400, 360);
      for (let at = 50; at < 8000 && frame(at).some(marker => marker.grab); at += 20) { /* the glide, if a still press left any */ }
      expect(frame(8100).some(marker => marker.grab)).toBe(false);
      const settled = host.runtime.getViewState()!;
      expect(settled.headingDeg).toBeCloseTo(before.headingDeg, 6);
      expect(settled.pitchDeg).toBeCloseTo(before.pitchDeg, 6);
      expect(settled.zoomMeters).toBeCloseTo(before.zoomMeters, 6);
    } finally { host.disposeHost(); }
  });

  it("turns and tilts about the compass down to the horizon, leaving it on its ground wherever the drag starts", () => {
    const host = createAnchorHost();
    const canvas = host.canvas;
    Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 600 });
    Object.assign(canvas, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    let at = 0;
    const frame = () => { at += 16; host.setTime(at); host.runtime.prepareFrame(at); host.runtime.afterFrame(at); };
    const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: "mouse", isPrimary: true, button: 2, buttons: type === "pointerup" ? 0 : 2, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    const centre = () => { const c = host.runtime.geospatialCamera!.center; return ecefToGeodetic(c.x, c.y, c.z); };
    try {
      host.runtime.setViewState({ latDeg: 44, lonDeg: -93, headingDeg: 0, pitchDeg: 30, zoomMeters: 3000 });
      const before = centre();
      // Low on the screen and off to the side: turning about the ground there would carry the compass off.
      let x = 650, y = 520;
      pointer("pointerdown", x, y);
      for (let step = 0; step < 40; step += 1) { x += 5; y -= 10; pointer("pointermove", x, y); frame(); }
      pointer("pointerup", x, y);
      for (let step = 0; step < 600; step += 1) frame();
      const view = host.runtime.getViewState()!;
      expect(view.pitchDeg).toBeLessThan(10);
      expect(Math.abs(view.headingDeg)).toBeGreaterThan(1);
      const after = centre();
      const north = (after.latRad - before.latRad) * 6_378_137, east = (after.lonRad - before.lonRad) * 6_378_137 * Math.cos(before.latRad);
      expect(Math.hypot(north, east)).toBeLessThan(0.01);
    } finally { host.disposeHost(); }
  });

  it("has no compass center's ball on a page without the developer tools, however the view turns", () => {
    const host = createAnchorHost();
    try {
      expect(host.settings.has(SHOW_COMPASS_CENTER_ID)).toBe(false);
      host.runtime.setViewState({ latDeg: 44, lonDeg: -93, headingDeg: 0, pitchDeg: 30, zoomMeters: 3000 });
      host.runtime.prepareFrame(16);
      expect(host.runtime.scene.getMeshByName("compass-center-sphere")).toBeNull();
    } finally { host.disposeHost(); }
  });

  it("fetches the compass center's ball when the developer tool is switched on, and stands it while the view turns about it, fading from the release", async () => {
    const host = createGlobeHostFixture(document, { settings: createEngineSettings({ dev: true }), external: undefined });
    const canvas = host.canvas;
    Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 600 });
    Object.assign(canvas, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    let at = 0;
    const frame = () => { at += 16; host.setTime(at); host.runtime.prepareFrame(at); host.runtime.afterFrame(at); };
    const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: "mouse", isPrimary: true, button: 2, buttons: type === "pointerup" ? 0 : 2, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    const ball = () => host.runtime.scene.getMeshByName("compass-center-sphere");
    const opacity = () => (ball()!.material as unknown as { _colors4: Record<string, { a: number }> })._colors4.color?.a ?? 0;
    try {
      host.runtime.setViewState({ latDeg: 44, lonDeg: -93, headingDeg: 0, pitchDeg: 30, zoomMeters: 3000 });
      expect(host.settings.get(SHOW_COMPASS_CENTER_ID)).toBe(false);
      expect(ball()).toBeNull();
      host.settings.set(SHOW_COMPASS_CENTER_ID, true);
      // Its module is fetched only now.
      await vi.waitFor(() => expect(ball()).not.toBeNull());
      expect(ball()!.isEnabled()).toBe(false);

      let x = 650, y = 520;
      pointer("pointerdown", x, y);
      for (let step = 0; step < 20; step += 1) { x += 5; y -= 5; pointer("pointermove", x, y); frame(); }
      expect(ball()!.isEnabled()).toBe(true);
      const held = opacity();
      const center = host.runtime.geospatialCamera!.center;
      expect(Vector3.Distance(ball()!.position, center)).toBeLessThan(1e-6);
      pointer("pointerup", x, y);
      const levels: number[] = [];
      for (let step = 0; step < 1200 && ball()!.isEnabled(); step += 1) { frame(); if (ball()!.isEnabled()) levels.push(opacity()); }
      expect(ball()!.isEnabled()).toBe(false);
      expect(levels.length).toBeGreaterThan(3);
      expect(levels.at(-1)!).toBeLessThan(held * 0.2);
      for (let i = 1; i < levels.length; i += 1) expect(levels[i]).toBeLessThanOrEqual(levels[i - 1]! + 1e-12);

      // A drag that grabs the ground turns nothing about the compass.
      canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
      for (let step = 0; step < 5; step += 1) {
        canvas.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: 400 + 10 * step, clientY: 300, bubbles: true, cancelable: true }));
        frame();
        expect(ball()!.isEnabled()).toBe(false);
      }
      canvas.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0, clientX: 440, clientY: 300, bubbles: true, cancelable: true }));

      const requests = host.requestCount();
      host.settings.set(SHOW_COMPASS_CENTER_ID, false);
      expect(ball()).toBeNull();
      expect(host.requestCount()).toBeGreaterThan(requests);
      // Switched on again and the runtime gone before the fetch answers: no ball is left behind.
      host.settings.set(SHOW_COMPASS_CENTER_ID, true);
      host.runtime.destroy();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(ball()).toBeNull();
    } finally { host.disposeHost(); }
  });

  it("disposes the anchor service with the runtime: no more notifications, notes or pinning", () => {
    const host = createAnchorHost(), changed = vi.fn(), dispose = vi.spyOn(host.service, "dispose");
    try {
      host.settings.set("input.mouse.zoomAnchor", "pinned");
      expect(noteOf(host, "input.mouse.zoomAnchor")).not.toBeNull();
      host.anchors.subscribe(changed);
      expect(host.anchors.pinTarget()).toBe(true); host.anchors.armPick();
      changed.mockClear();

      expect(() => host.runtime.destroy()).not.toThrow();
      expect(dispose).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
      expect(host.anchors.status()).toEqual({ pin: null, selection: "off", pinningBlocked: "The globe has closed.", tracking: false,
        last: { mouse: {}, trackpad: {}, touch: {}, nonPointer: {} } });
      for (const id of NAVIGATION_ANCHOR_SETTING_IDS) expect(noteOf(host, id)).toBeNull();
      expect(host.anchors.pinTarget()).toBe(false); expect(host.anchors.armPick()).toBe(false);
      host.anchors.clearPin(); host.anchors.cancelPick();
      const late = vi.fn(); host.anchors.subscribe(late)();
      host.settings.set("input.trackpad.zoomAnchor", "pinned");
      expect(noteOf(host, "input.trackpad.zoomAnchor")).toBeNull();
      expect(changed).not.toHaveBeenCalled(); expect(late).not.toHaveBeenCalled();
      expect(() => host.runtime.destroy()).not.toThrow(); expect(dispose).toHaveBeenCalledOnce();
    } finally { host.disposeHost(); }
  });
});
