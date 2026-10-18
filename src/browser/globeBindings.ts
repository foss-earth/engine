/** Reusable native browser binding extracted from Earth App/browserRuntime. */
import type { Scene, BaseTexture } from "@babylonjs/core";
import type { ImageSessionBroker } from "@foss-earth/images";
import { createCanvasRgbaSurface, type ImageTransferLimits } from "@foss-earth/images/browser";
import { checkUntilSettled, type ReadinessPolicy, type ReadinessTimers } from "@foss-earth/renderer";
import { whenMeshesReady, type RendererSelection, type createNativeImageResources } from "@foss-earth/renderer/babylon";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { createTerrainTileLoader, type TerrainLoaderLimits } from "../terrain/terrainLoader.js";
import { createTerrainImageDecodeLimits, loadGlobeAnchorRotationPreference, saveGlobeAnchorRotationPreference } from "../settings/index.js";
import { createBoundedMapTextureLoader } from "../babylon/imagery/boundedMapTextureLoader.js";
import { createManagedImageryAtlasResources } from "../babylon/managedImageryAtlas.js";
import { hasPickablePointAt } from "../sprites/picking.js";
import { attachNavigationAnchorMarkers } from "./navigationAnchorMarkers.js";
import type { createTerrainLightingAdapter } from "../babylon/imagery/terrainLightPlugin.js";
import type { GlobeMapPorts, GlobeRuntimeClock, GlobeRuntimePlatform } from "../babylon/globeRuntimePorts.js";
import { createTerrainImageDecoder } from "./terrainImageDecoder.js";
import { createAtlasImageryWorkerBridge } from "./atlasImageryWorkerBridge.js";
import type { AtlasImageryWorkerPort } from "./atlasImageryWorkerProtocol.js";
import { createTerrainDecodeWorkers } from "./terrainDecodeWorkers.js";
import type { TerrainDecodeWorkerPort } from "./terrainDecodeWorkerProtocol.js";
import type { TerrainMeshWorkerPort } from "./terrainMeshWorkerProtocol.js";
import type { HeightBatchWorkerPort } from "./terrainHeightBatchProtocol.js";
import { createBoundedAtlasImageryLoader, type BoundedAtlasImageryLoaderOptions } from "./boundedAtlasImageryLoader.js";
import type { createMapCache } from "./mapCache.js";
import { measureMapResponse } from "./mapDownloadMeter.js";
import { latestResourceTiming } from "./describeGoogleTileFailure.js";

/** A terrain decode worker idle this long stops; the next tile starts one again (a few ms). */
const TERRAIN_WORKER_IDLE_MS = 30_000;

export interface BrowserGlobeRealm {
  window: Window & typeof globalThis;
  document: Document;
  /** Constructors come from the transport/input realm, not ambient imports. */
  AbortController: typeof AbortController; AbortSignal: typeof AbortSignal; DOMException: typeof DOMException;
  Blob: typeof Blob; URL: typeof URL; Response: typeof Response; TransformStream: typeof TransformStream;
  Node: typeof Node; Element: typeof Element; HTMLInputElement: typeof HTMLInputElement;
  WheelEvent: typeof WheelEvent; Event: typeof Event;
  performance: Pick<Performance, "getEntriesByType">;
}
export interface BrowserGlobeBindingOptions {
  realm: BrowserGlobeRealm;
  renderer: RendererSelection; scene: Scene; settings: SettingsRegistry; clock: GlobeRuntimeClock;
  timers: ReadinessTimers; readinessPolicy: ReadinessPolicy;
  broker: ImageSessionBroker;
  /** Host constructs the single map cache and attaches its compatibility policy. */
  cache: ReturnType<typeof createMapCache>;
  native: Pick<ReturnType<typeof createNativeImageResources>, "device" | "uploader" | "restoreDevice" | "whenSettled">;
  managedAtlas?: ReturnType<typeof createManagedImageryAtlasResources>;
  /** Host supplies the existing Sky light table adapter; Engine imports no Sky implementation here. */
  lighting: ReturnType<typeof createTerrainLightingAdapter>;
  imageTransferLimits(): ImageTransferLimits;
  terrainLoaderLimits(): TerrainLoaderLimits;
  describeMapTransfer: BoundedAtlasImageryLoaderOptions["describe"];
  mapPriority(): number;
  createWorker(): AtlasImageryWorkerPort | null;
  /** A worker running installTerrainDecodeWorkerKernel. Absent, null or a throw: terrain decodes on the page. */
  createTerrainWorker?(): TerrainDecodeWorkerPort | null;
  /** The most terrain decode workers at once, read at each decode. 0 or absent: terrain decodes on the page. */
  terrainDecodeWorkers?(): number;
  /** A worker running installTerrainMeshWorkerKernel. Absent or null: terrain mesh targets prepare on page. */
  createTerrainMeshWorker?(): TerrainMeshWorkerPort | null;
  /** The most terrain mesh workers at once. */
  terrainMeshWorkers?(): number;
  createTerrainHeightWorker?(): HeightBatchWorkerPort | null;
  createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
  decode(bytes: Uint8Array, mimeType: "image/jpeg" | "image/png"): Promise<ImageBitmap>;
  onError(error: unknown): void;
  log: GlobeMapPorts["google"]["log"] & GlobeMapPorts["raster"]["log"];
  /** Owner's loaded native provider ports, or an explicit CPU/embedded boundary. */
  googleProviders: BrowserGlobeGoogleProviders;
  signal?: AbortSignal;
}

export type BrowserGlobeGoogleProviders = Pick<GlobeMapPorts["google"], "createTilesRenderer" | "createAuthPlugin">;
/** Deferred browser/bundler acquisition; importing the public entry is pure. */
export async function loadBrowserGlobeGoogleProviders(): Promise<BrowserGlobeGoogleProviders> {
  const { TilesRenderer } = await import("3d-tiles-renderer/babylonjs");
  const { GoogleCloudAuthPlugin } = await import("3d-tiles-renderer/core/plugins");
  return { createTilesRenderer: (url, scene) => new TilesRenderer(url, scene),
    createAuthPlugin: options => new GoogleCloudAuthPlugin(options) };
}

/** No renderer, scene, broker, scheduler/profile/lifecycle or Sky is created here. */
export function createBrowserGlobeBindings(options: BrowserGlobeBindingOptions) {
  const { realm, cache, broker, native, scene, renderer, settings, lighting } = options;
  if (scene.getEngine() !== renderer.engine) throw new Error("Browser globe bindings require the host's supplied scene/device.");
  let disposed = false;
  const operations = new Set<Promise<unknown>>(), terrain = new Set<ReturnType<typeof createTerrainTileLoader<Blob, AbortSignal>>>();
  const errors: unknown[] = [];
  const waiters = new Set<() => void>();
  const changed = (): void => { for (const wake of [...waiters]) wake(); };
  const track = <T>(work: Promise<T>): Promise<T> => {
    operations.add(work);
    void work.then(() => { operations.delete(work); changed(); }, () => { operations.delete(work); changed(); });
    return work;
  };
  const mapFetch: typeof fetch = (input, init) => {
    if (disposed) return Promise.reject(new Error("Browser globe transport has retired."));
    return track(typeof input === "string" ? cache.fetch(input, init)
      : input instanceof realm.URL ? cache.fetch(input.href, init) : realm.window.fetch(input, init));
  };
  const managedAtlas = options.managedAtlas ?? createManagedImageryAtlasResources(broker);
  let worker: ReturnType<typeof createAtlasImageryWorkerBridge> | undefined;
  let loader: ReturnType<typeof createBoundedAtlasImageryLoader> | undefined;
  let terrainWorkers: ReturnType<typeof createTerrainDecodeWorkers> | undefined;
  const retire = (): void => {
    if (disposed) return;
    disposed = true;
    for (const action of [() => options.signal?.removeEventListener("abort", abort),
      ...[...terrain].map(value => () => value.dispose()), () => terrainWorkers?.dispose(), () => loader?.dispose(), () => worker?.dispose()]) {
      try { action(); } catch (error) { errors.push(error); }
    }
    changed();
    if (errors.length) throw new AggregateError(errors, "Browser globe binding cleanup failed.");
  };
  const abort = (): void => { try { retire(); } catch (error) {
    try { options.onError(error); } catch (reporting) { errors.push(reporting); }
  } };
  try {
    if (options.createTerrainWorker) terrainWorkers = createTerrainDecodeWorkers({ createWorker: options.createTerrainWorker,
      workers: options.terrainDecodeWorkers ?? (() => 0), timers: options.timers, nowMs: () => options.clock.nowMs(),
      idleMs: TERRAIN_WORKER_IDLE_MS, limits: createTerrainImageDecodeLimits(settings), onError: options.onError });
    worker = createAtlasImageryWorkerBridge({ broker, createWorker: options.createWorker, decode: options.decode, onError: options.onError });
    const files = worker.createFileService({ limits: options.imageTransferLimits, priority: options.mapPriority, fetch: mapFetch, cache: null });
    loader = createBoundedAtlasImageryLoader({ broker, files, worker, describe: options.describeMapTransfer, priority: options.mapPriority,
      createSurface: (width, height) => createCanvasRgbaSurface({ width, height, createCanvas: options.createCanvas }), onCleanupFailure: options.onError });
    const whenReady = (texture: BaseTexture, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        let stop = () => {}, finished = false;
        const finish = (failed: boolean, error?: unknown): void => {
          if (finished) return; finished = true;
          try { stop(); signal.removeEventListener("abort", cancelled); }
          catch (cleanup) { reject(failed ? new AggregateError([error, cleanup], "Map readiness cleanup failed.") : cleanup); return; }
          if (failed) reject(error); else resolve();
        };
        const cancelled = (): void => finish(true, signal.reason);
        signal.addEventListener("abort", cancelled, { once: true });
        try {
          if (texture.isReady()) finish(false);
          else stop = checkUntilSettled(1, () => {
            try { return texture.isReady() ? 0 : 1; }
            catch (error) { finish(true, error); return 0; }
          }, () => finish(false), options.timers, options.readinessPolicy);
          if (signal.aborted) cancelled();
        } catch (error) { finish(true, error); }
      });
    };
    const acquireMapTexture = createBoundedMapTextureLoader({ broker, files, uploader: native.uploader,
      maxTextureSide: () => renderer.engine.getCaps().maxTextureSize, whenReady });
    const caps = renderer.engine.getCaps();
    const mapPorts: GlobeMapPorts = {
      setCacheLimits: limits => cache.setLimits(limits),
      raster: {
        attachTerrainLighting: material => lighting.createMaterialPlugin(material),
        asyncMapTextures: {
          resolve(source, _tile, url) {
            const dimensions = source.tileSize ?? { width: 256, height: 256 };
            return { file: { url, ...dimensions }, declaredBytes: 0, priority: options.mapPriority() };
          },
          acquire: (file, request) => track(acquireMapTexture(file, request)),
          createAbortController: () => new realm.AbortController(),
        },
        meshRebuildCpuMs: () => settings.get<number>("map.terrain.meshRebuildTimePerFrame"), log: options.log,
        createTerrainMeshWorker: options.createTerrainMeshWorker,
        terrainMeshWorkers: options.terrainMeshWorkers,
        createTerrainHeightWorker: options.createTerrainHeightWorker,
        imageryPorts: {
          device: native.device, managedAtlas, restoreManagedDevice: native.restoreDevice,
          capabilities: { backend: renderer.mode, maxTextureSize: caps.maxTextureSize,
            explicitGradients: renderer.mode !== "webgl" || Boolean(caps.textureLOD && caps.standardDerivatives) },
          loader, createAbortController: () => new realm.AbortController(),
        },
        createTerrainLoader(source, onBytes, trackMemory, onPreparationMs) {
          if (disposed) throw new Error("Browser globe bindings have retired.");
          const onPage = (blob: Blob) => createTerrainImageDecoder({ createImageBitmap: (body, decodeOptions) => realm.window.createImageBitmap(body, decodeOptions),
            createCanvas: options.createCanvas, nowMs: () => options.clock.nowMs(), limits: createTerrainImageDecodeLimits(settings), onDecodeCpu: onPreparationMs })(blob);
          const actual = createTerrainTileLoader<Blob, AbortSignal>({ source, onBytes, trackMemory, limits: options.terrainLoaderLimits,
            // Downloads go on while workers decode; tiles decoded on the page keep their download slot.
            decodeSlots: () => terrainWorkers?.capacity() ?? 0,
            // Worker decodes take no page time, so only page decodes count as preparation.
            decode: (blob, request) => track(terrainWorkers ? terrainWorkers.decode(blob, onPage, { priority: request.prioritize ? 1 : 0, signal: request.signal }) : onPage(blob)),
            ports: { createAbortController: () => new realm.AbortController(),
              requestSignal: (signal, timeoutMs) => realm.AbortSignal.any([signal, realm.AbortSignal.timeout(timeoutMs)]),
              fetchTile: (url, signal) => track(cache.fetch(url, { signal, mode: "cors" })), byteLength: blob => blob.size },
          });
          terrain.add(actual);
          return { ...actual, load: (...args) => track(actual.load(...args)), loadPatch: (...args) => track(actual.loadPatch(...args)) };
        },
      },
      google: {
        createTilesRenderer: options.googleProviders.createTilesRenderer,
        createAuthPlugin: options.googleProviders.createAuthPlugin,
        createAbortController: () => new realm.AbortController(), combineSignals: signals => realm.AbortSignal.any([...signals]),
        whenMeshesReady: (meshes, readyOptions = {}) => track(whenMeshesReady(meshes, { ...readyOptions, timers: options.timers, readinessPolicy: options.readinessPolicy })),
        lighting, responseRealm: { Response: realm.Response, TransformStream: realm.TransformStream },
        recordMapRequest: url => cache.recordBrowserRequest(url),
        resourceTiming: url => latestResourceTiming(url, realm.performance.getEntriesByType("resource")),
        online: () => realm.window.navigator.onLine, origin: () => realm.window.location.origin, log: options.log,
      },
    };
    const platform: GlobeRuntimePlatform = {
      isHidden: () => realm.document.hidden, abortError: message => new realm.DOMException(message, "AbortError"),
      input: { realm: { document: realm.document, window: realm.window, userAgent: realm.window.navigator.userAgent,
        hasGestureEvent: "GestureEvent" in realm.window, nowMs: () => options.clock.nowMs() },
        loadGlobeAnchorRotationPreference: () => loadGlobeAnchorRotationPreference(settings),
        saveGlobeAnchorRotationPreference: enabled => saveGlobeAnchorRotationPreference(settings, enabled) },
      passToWorld: { realm: { window: realm.window, Node: realm.Node, Element: realm.Element, HTMLInputElement: realm.HTMLInputElement,
        WheelEvent: realm.WheelEvent, Event: realm.Event, getComputedStyle: element => realm.window.getComputedStyle(element),
        userAgent: realm.window.navigator.userAgent, hasGestureEvent: "GestureEvent" in realm.window, nowMs: () => options.clock.nowMs() } },
      hasPickablePointAt,
      navigation: { focusReturn: () => realm.document.activeElement, createAbortController: () => new realm.AbortController(),
        abortReason: reason => new realm.DOMException(reason, "AbortError") },
      navigationAnchorMarkers: attachNavigationAnchorMarkers,
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    return {
      platform, mapPorts, files, managedAtlas, lighting, mapFetch, whenReady,
      skyTerrain: { setLighting: (value: Parameters<typeof lighting.setTerrainLighting>[1]) => lighting.setTerrainLighting(scene, value),
        setLocalLights: (value: Parameters<typeof lighting.setTerrainLocalLights>[1]) => lighting.setTerrainLocalLights(scene, value) },
      nightTilePorts: { fetchTile: (url: string, init: RequestInit) => mapFetch(url, init),
        measureResponse: (response: Response, onBytes: (bytes: number) => void) => measureMapResponse(response, onBytes, { Response: realm.Response, TransformStream: realm.TransformStream }),
        setNightLightMap: (value: Parameters<typeof lighting.setTerrainNightLightMap>[1]) => lighting.setTerrainNightLightMap(scene, value) },
      /** Terrain decode workers: live, busy, queued and per-worker counts, and tiles decoded on the page. Null without workers. */
      terrainDecodeStats: () => terrainWorkers?.stats() ?? null,
      retire, dispose: retire,
      async whenSettled() {
        const results = await Promise.allSettled([worker!.whenSettled(), loader!.whenSettled(), native.whenSettled()]);
        while (operations.size) await Promise.allSettled([...operations]);
        // This terminal proof includes every borrowed broker hold. The host first
        // retires its viewer/cache/features; a forgotten holder keeps this pending.
        if (disposed) await new Promise<void>(resolve => {
          let stop = () => {};
          const check = (): void => {
            if (!operations.size && !broker.requests.stats().active && !broker.requests.stats().queued &&
                !broker.decodes.stats().active && !broker.decodes.stats().queued && broker.pools.live().length === 0) {
              stop(); waiters.delete(check); resolve();
            }
          };
          stop = broker.pools.subscribeAvailable(check); waiters.add(check); check();
        });
        const failures = [...errors, ...results.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
        if (failures.length) throw new AggregateError(failures, "Browser globe retirement failed.");
      },
    };
  } catch (error) {
    try { retire(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Browser globe setup and cleanup failed."); }
    throw error;
  }
}
