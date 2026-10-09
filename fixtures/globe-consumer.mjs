/** Prepared installed-only public consumer, CPU NullEngine; no implicit frame/server/network. */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { NullEngine, Scene, FreeCamera, TransformNode, Vector3 } from "@babylonjs/core";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { createFrameProfiler, createFrameProfileSession } from "@foss-earth/renderer/profiling";
import { createBabylonRendererLifecycle } from "@foss-earth/renderer/babylon";
import { RENDERER_PARAMETERS } from "@foss-earth/renderer/settings";
import { SKY_PARAMETERS } from "@foss-earth/sky/settings";
import { createGlobeRuntime } from "@foss-earth/engine/babylon";
import { hasPickablePointAt } from "@foss-earth/engine/sprites";
import { NAVIGATION_PRESENTATION_LAYER } from "@foss-earth/engine/core";
import { CONTROLS_PARAMETERS,MAP_SOURCE_PARAMETERS,MAP_DETAIL_PARAMETERS,MAP_LOADING_PARAMETERS,MAP_SELECTION_PARAMETERS,MAP_TERRAIN_SELECTION_PARAMETERS,MAP_AUTO_PARAMETERS,GLOBE_RUNTIME_PARAMETERS,createGlobeRuntimeBudgets } from "@foss-earth/engine/settings";
const dom = new JSDOM("<!doctype html><canvas></canvas>",{ url: "https://fixture.invalid" });
const { window } = dom, document = window.document,canvas = document.querySelector("canvas");
const engine = new NullEngine();engine.getCaps().maxTextureSize = 8192;const scene = new Scene(engine);scene.useRightHandedSystem = true;
const camera = new FreeCamera("host-camera",new Vector3(0,0,-10),scene),root = new TransformNode("host-world",scene);scene.activeCamera = camera;
const renderer = { requested: "auto",mode: "webgl2",engine },settings = createSettingsRegistry({ storage: null });
settings.register([...CONTROLS_PARAMETERS,...MAP_SOURCE_PARAMETERS,...MAP_DETAIL_PARAMETERS,...MAP_LOADING_PARAMETERS,...MAP_SELECTION_PARAMETERS,...MAP_TERRAIN_SELECTION_PARAMETERS,...MAP_AUTO_PARAMETERS,...GLOBE_RUNTIME_PARAMETERS,...RENDERER_PARAMETERS,...SKY_PARAMETERS]);
assert.equal(typeof hasPickablePointAt,"function");
let holds = 1,skyFrames = 0,skyDetach = 0,hostFrames = 0,ordinaryFrames = 0;
const contribution = { prepare(frame) { assert.equal(this,contribution);assert.equal(frame.nowMs,10);assert(frame.deltaSeconds>0);assert.equal(frame.scene,scene);ordinaryFrames++; } };
const timers = new Set(),clock = { nowMs: () => 10,after(callback) { timers.add(callback);return () => timers.delete(callback); } };
const scheduler = { requestRender() {},beginContinuous() { holds += 1; },endContinuous() { holds -= 1; },setPaused() {},isActive: () => true,isContinuous: () => holds > 0,onActiveChange: () => () => {},stop() { throw new Error("engine must not stop host scheduler"); } };
const frameProfile = createFrameProfileSession({ profiler: createFrameProfiler({ now: clock.nowMs }),measure: () => () => {},canTimeGpuFrames: () => false });
let runtime;
const lifecycle = createBabylonRendererLifecycle({ renderer,scene,scheduler,settings,presentationLayer: NAVIGATION_PRESENTATION_LAYER,isPreparingFrame: () => runtime?.isPreparingFrame() ?? false,
 platform: { devicePixelRatio: () => 1,isHidden: () => false,onResize: () => () => {},onVisibilityChange: () => () => {} },timers: { setTimeout: callback => { timers.add(callback);return callback; },clearTimeout: callback => timers.delete(callback) } });
const never = () => { throw new Error("fallback fixture must not acquire map content"); },budgets = createGlobeRuntimeBudgets(settings);
try {
 runtime = createGlobeRuntime(canvas,{ renderer,scene,scheduler,frameProfile,lifecycle,settings,clock,budgets,external: { worldRoot: root,running: false,onFrame() { hostFrames += 1;assert(runtime.isPreparingFrame()); } },
 framePreparation: contribution,
 sky: { attach: () => ({ runtime: { update() { assert.equal(ordinaryFrames,1);skyFrames += 1; },getEnvironment: () => null,getNightLights: () => null,isLighting: () => false,subscribe: () => () => {},setGroundLights() {},setGroundLightReceiver() {} },detach() { skyDetach += 1; } }) },
 platform: { isHidden: () => false,abortError: message => new window.DOMException(message,"AbortError"),hasPickablePointAt: () => false,
 input: { realm: { window,document,userAgent: "fixture",hasGestureEvent: false,nowMs: clock.nowMs },loadGlobeAnchorRotationPreference: () => true,saveGlobeAnchorRotationPreference() {} },
 passToWorld: { realm: { window,Node: window.Node,Element: window.Element,HTMLInputElement: window.HTMLInputElement,WheelEvent: window.WheelEvent,Event: window.Event,getComputedStyle: window.getComputedStyle.bind(window),userAgent: "fixture",hasGestureEvent: false,nowMs: clock.nowMs } },
 navigation: { focusReturn: () => document.activeElement,createAbortController: () => new window.AbortController(),abortReason: reason => new window.DOMException(reason,"AbortError") } },
 mapPorts: { setCacheLimits() {},raster: { loadMapTexture: never,attachTerrainLighting: never,createTerrainLoader: never,meshRebuildCpuMs: () => 2,log: { warn() {} },imageryPorts: { device: { createRawTexture: never,updateTextureData: never },capabilities: { backend: "webgl2",maxTextureSize: 8192,explicitGradients: true },loader: { load: never },createAbortController: () => new window.AbortController() } },google: { createTilesRenderer: never,createAuthPlugin: never,createAbortController: () => new window.AbortController(),combineSignals: never,whenMeshesReady: never,lighting: { followTerrainLight: never },responseRealm: { Response,TransformStream },recordMapRequest() {},resourceTiming: () => null,online: () => true,origin: () => "https://fixture.invalid",log: { info() {},error() {} } } },
 terrainPreparation: { ...budgets,requiredRasterQuality: () => null,evaluate: never,fallback: (_request,groundHeightMeters) => ({ groundHeightMeters,altitudeMeters: groundHeightMeters }) },log: { info() {},warn() {},error() {} } });
 lifecycle.renderFrame(() => runtime.prepareFrame(10),() => runtime.afterFrame(10));assert.equal(skyFrames,1);assert.equal(hostFrames,1);assert.equal(ordinaryFrames,1);assert.equal(scene.activeCamera,camera);assert.equal(runtime.getWorldRoot(),root);
 runtime.beginContinuous();assert.equal(holds,2);runtime.destroy();runtime.destroy();assert.equal(holds,1);assert.equal(skyDetach,1);assert.equal(root.isDisposed(),false);assert.equal(camera.isDisposed(),false);assert.equal(scene.getMeshByName("fallback-globe"),null);
 assert.equal(runtime.shouldKeepRendering(),false);await assert.rejects(runtime.prepareTerrain({ latDeg: 0,lonDeg: 0 }),{ name: "AbortError" });
 console.log("Installed borrowed globe lifecycle/feature cleanup passed with CPU fixture; no backend/device/terrain policy qualification.");
} finally { runtime?.destroy();lifecycle.dispose();frameProfile.dispose();scene.dispose();engine.dispose();dom.window.close(); }
