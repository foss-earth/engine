/** CPU-only borrowed-authority fixture; timers never run implicitly. */
import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS } from "@foss-earth/sky/settings";
import { createFrameProfiler, createFrameProfileSession } from "@foss-earth/renderer/profiling";
import { createBabylonRendererLifecycle, type RendererSelection } from "@foss-earth/renderer/babylon";
import { createGlobeRuntime, type GlobeRuntime } from "../../src/babylon/createGlobeRuntime.js";
import type { GlobeRuntimeOptions } from "../../src/babylon/globeRuntimePorts.js";
import { createGlobeRuntimeBudgets } from "../../src/settings/catalogue/globeRuntime.js";
import { createEngineSettings } from "./runtimeHost.js";
import { NAVIGATION_PRESENTATION_LAYER } from "../../src/navigation/navigationLease.js";

type GlobeHostConfigure = Partial<GlobeRuntimeOptions> | ((defaults: Readonly<GlobeRuntimeOptions>) => Partial<Omit<GlobeRuntimeOptions, "settings">>);
export function createGlobeHostFixture(document: Document, configure: GlobeHostConfigure = {}) {
  const window = document.defaultView as Window & typeof globalThis;
  const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 600;
  const engine = new NullEngine(); engine.getCaps().maxTextureSize = 8192;
  const scene = new Scene(engine); scene.useRightHandedSystem = true;
  const camera = new FreeCamera("external-host-camera", new Vector3(0,0,-10), scene); scene.activeCamera = camera;
  const worldRoot = new TransformNode("host-world-root", scene);
  const settings: SettingsRegistry = (typeof configure === "function" ? undefined : configure.settings) ?? createEngineSettings();
  // Exposure and ambient fill retain their original IDs, now owned by Sky.
  settings.register(SKY_PARAMETERS.filter(parameter => !settings.has(parameter.id)));
  let now = 0, holds = 1, requests = 0;
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  const clock = { nowMs: () => now, after(callback: () => void, _ms: number) { void _ms; const id = ++nextTimer; timers.set(id,callback); return () => { timers.delete(id); }; } };
  const scheduler = { requestRender() { requests += 1; },beginContinuous() { holds += 1; },endContinuous() { holds -= 1; },
    setPaused(_paused: boolean) { void _paused; },isActive: () => requests > 0 || holds > 0,onActiveChange(_listener: (active: boolean) => void) { void _listener; return () => undefined; } };
  const profiler = createFrameProfiler({ now: clock.nowMs, enabled: false });
  const frameProfile = createFrameProfileSession({ profiler,measure: () => () => undefined,canTimeGpuFrames: () => false });
  const state: { runtime?: GlobeRuntime } = {};
  const lifecycle = createBabylonRendererLifecycle({ renderer: { requested: "auto",mode: "webgl2",engine } as unknown as RendererSelection,scene,
    scheduler: { ...scheduler,isContinuous: () => holds > 0,stop() {} },settings,
    platform: { devicePixelRatio: () => 1,isHidden: () => false,onResize: () => () => undefined,onVisibilityChange: () => () => undefined },
    timers: { setTimeout: (callback, ms) => clock.after(callback,ms),clearTimeout: handle => (handle as () => void)() },
    isPreparingFrame: () => state.runtime?.isPreparingFrame() ?? false,presentationLayer: NAVIGATION_PRESENTATION_LAYER });
  let skyUpdates = 0, skyDetached = 0;
  const sky = { update() { skyUpdates += 1; },getEnvironment: () => null,getNightLights: () => null,isLighting: () => false,
    subscribe: () => () => undefined,setGroundLights() {},setGroundLightReceiver() {} };
  const never = (): never => { throw new Error("No map transport/device selected in this fallback-only fixture."); };
  const budgets = createGlobeRuntimeBudgets(settings);
  const options: GlobeRuntimeOptions = {
    renderer: { requested: "auto",mode: "webgl2",engine } as unknown as RendererSelection,scene,scheduler,frameProfile,lifecycle,settings,clock,
    sky: { attach: () => ({ runtime: sky,detach() { skyDetached += 1; } }) },
    platform: { isHidden: () => false,abortError: message => new window.DOMException(message,"AbortError"),hasPickablePointAt: () => false,
      input: { realm: { window,document,userAgent: "fixture",hasGestureEvent: false,nowMs: clock.nowMs },loadGlobeAnchorRotationPreference: () => true,saveGlobeAnchorRotationPreference() {} },
      passToWorld: { realm: { window,Node: window.Node,Element: window.Element,HTMLInputElement: window.HTMLInputElement,WheelEvent: window.WheelEvent,Event: window.Event,
        getComputedStyle: window.getComputedStyle.bind(window),userAgent: "fixture",hasGestureEvent: false,nowMs: clock.nowMs } },
      navigation: { focusReturn: () => document.activeElement,createAbortController: () => new window.AbortController(),abortReason: reason => new window.DOMException(reason,"AbortError") } },
    mapPorts: { setCacheLimits() {},raster: { loadMapTexture: never,attachTerrainLighting: never,createTerrainLoader: never,meshRebuildCpuMs: () => 2,log: { warn() {} },
      imageryPorts: { device: { createRawTexture: never,updateTextureData: never },capabilities: { backend: "webgl2",maxTextureSize: 8192,explicitGradients: true },loader: { load: never },createAbortController: () => new window.AbortController() } },
      google: { createTilesRenderer: never,createAuthPlugin: never,createAbortController: () => new window.AbortController(),combineSignals: never,whenMeshesReady: never,
        lighting: { followTerrainLight: never },responseRealm: { Response,TransformStream },recordMapRequest() {},resourceTiming: () => null,online: () => true,origin: () => "https://fixture.invalid",log: { info() {},error() {} } } },
    external: { worldRoot,running: false },budgets,
    terrainPreparation: { ...budgets,requiredRasterQuality: () => null,evaluate: never,
      fallback(request,groundHeightMeters) { return { groundHeightMeters,altitudeMeters: request.altitudeMeters ?? groundHeightMeters + (request.altitudeAboveGroundMeters ?? 0) }; } },
    log: { info() {},warn() {},error() {} },
  };
  // Configured wrappers retain the original port objects. Passing options
  // itself would make defaults.sky/clock point back at the installed wrapper.
  Object.assign(options, typeof configure === "function" ? configure({ ...options }) : configure);
  const runtime = createGlobeRuntime(canvas,options);
  state.runtime = runtime;
  return { runtime,options,engine,scene,camera,canvas,worldRoot,settings,lifecycle,frameProfile,clock,
    setTime: (value: number) => { now = value; },holdCount: () => holds,requestCount: () => requests,skyUpdates: () => skyUpdates,skyDetached: () => skyDetached,timers,
    disposeHost() { runtime?.destroy(); lifecycle.dispose(); frameProfile.dispose(); scene.dispose(); engine.dispose(); } };
}
