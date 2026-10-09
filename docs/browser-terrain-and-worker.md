# Native terrain and optional Atlas worker — source only

All source, new causal fixtures and installed consumer composition described here are UNRUN. No current archive, app adoption, browser decoder/worker, GPU or timing result is claimed. These seams restore the original immutable `90e23b3` native DEM and optional worker behaviors while keeping transport/header/cache ownership in Images and Atlas layout/preparation ownership in Engine.

`@foss-earth/engine/browser` exports `createTerrainImageDecoder`, `TerrainImageDecoderPorts`, `TerrainImageDecodeLimits`, `DEFAULT_TERRAIN_IMAGE_DECODE_LIMITS`, `createAtlasImageryWorkerBridge`, `AtlasImageryWorkerBridgeOptions`, `AtlasImageryWorkerBridge`, `installAtlasImageryWorkerKernel`, `AtlasImageryWorkerKernelPorts` and public request/reply/worker/scope types. Importing those exports constructs no Document, Worker, canvas, clock or broker.

The DEM decoder accepts the original native Blob, including WebP. It supplies both `colorSpaceConversion:"none"` and `premultiplyAlpha:"none"`, checks square dimensions and the named maximum before allocating its canvas, uses the unchanged `decodeTerrarium`, and attempts bitmap close and optional CPU report independently in finally. Operational and cleanup failures retain their causal errors. The original maximum is 1024 pixels; reducing it rejects larger tiles. No Images JPEG/PNG header parser is placed in this separate native DEM path.

The one host settings catalogue must include `TERRAIN_IMAGE_DECODE_PARAMETERS` and `POSITION_GEOID_PARAMETERS` from Engine/settings. `map.terrain.maxDecodedTileSide` has unit px, bounds 1–1024, default 1024 and home Map/loading/all; `createTerrainImageDecodeLimits(settings)` requires the registered numeric value. `interface.position.seaLevelGrid` is the exact reviewed original parameter, including Interface/position/main home, EGM2008 choices, default, visibility and reason. Engine owns the computation and parameter; Toolbar still presents its same ID. Register it once, removing its former app-owned duplicate during primary integration.

```ts
import { createTerrainImageDecoder } from "@foss-earth/engine/browser";
import { createTerrainImageDecodeLimits } from "@foss-earth/engine/settings";
const decodeTerrainImage = createTerrainImageDecoder({
  createImageBitmap: (blob, options) => hostWindow.createImageBitmap(blob, options),
  createCanvas: () => hostDocument.createElement("canvas"),
  nowMs: () => hostPerformance.now(),
  limits: createTerrainImageDecodeLimits(settings),
  onDecodeCpu: hostTerrainDecodeCpu,
});
// Supply this as existing Raster terrainPorts.decodeImage; retain that host's
// existing WebP source, error hooks and sampled CPU policy.
```

The Atlas bridge borrows the same `ImageSessionBroker`. Its `createFileService` invokes the actual public Images `createImageFileService`, using that broker and the bridge's native decode callback; no copied fetch, HTTP status, header, orientation, cache or native dimension logic exists. Pass that exact service and bridge into `createBoundedAtlasImageryLoader`. Foreign-service/broker combinations are refused. The common pipeline retains its typed 404/204, dimension mismatch, forget/refetch and generation-first policies. Worker page errors do not manufacture those typed missing observations.

A selected host worker handles native decode, then transparent detection and unchanged `preparePages`, returning all independent mip buffers by transfer. The native decoded bitmap crosses back to the main actual Images service for its real dimension validation, then transfers to the worker for preparation. No bitmap clone is allocated by Engine. This two-message seam retains the shared admission authority without copying service/queue functions into a worker. Its exposed `offThread` is true only when an actual supplied worker remains selected. Factory throw/null and failed worker selection use the admitted main native fallback. Public Images currently accepts JPEG/PNG identity orientation; native old formats/orientations beyond that staged common contract remain unsupported and unqualified.

```ts
import { createAtlasImageryWorkerBridge, createBoundedAtlasImageryLoader }
  from "@foss-earth/engine/browser";
import { createCanvasRgbaSurface } from "@foss-earth/images/browser";
const decodeNative = (bytes: Uint8Array, mimeType: string) => {
  // This view does not copy. Blob creates the one charged native encoded copy.
  const view = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  return hostWindow.createImageBitmap(new Blob([view], { type: mimeType }),
    { premultiplyAlpha: "none", colorSpaceConversion: "default" });
};
const createSurface = (width: number, height: number) => createCanvasRgbaSurface({
  width, height, createCanvas: () => hostDocument.createElement("canvas"),
});
const worker = createAtlasImageryWorkerBridge({
  broker, decode: decodeNative, onError: reportError,
  createWorker: () => hostWorkerAndOffscreenCanvasAvailable
    ? new Worker(hostOwnedWorkerEntry, { type: "module" }) : null,
});
const files = worker.createFileService({ fetch: hostFetch, cache: mapImageCache,
  limits: imageFileLimits, priority: imageryPriority });
const loader = createBoundedAtlasImageryLoader({ broker, files, worker,
  describe: describeImagery, priority: imageryPriority, createSurface,
  onBytes: accountImageryBytes, onCleanupFailure: reportError });
// Host owns dedicated teardown: loader.dispose(); worker.dispose(); broker.dispose().
// Existing explicit releaseOwnedLoader should release both loader and bridge.
```

The primary owns the actual worker entry. It imports only public owner exports and supplies native worker realm ports:

```ts
import { installAtlasImageryWorkerKernel } from "@foss-earth/engine/browser";
import { createCanvasRgbaSurface } from "@foss-earth/images/browser";
installAtlasImageryWorkerKernel({ scope: self,
  decode: (bytes, mimeType) => createImageBitmap(new Blob([
    new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
  ], { type: mimeType }), { premultiplyAlpha: "none", colorSpaceConversion: "default" }),
  createSurface: (width, height) => createCanvasRgbaSurface({ width, height,
    createCanvas: (w, h) => new OffscreenCanvas(w, h) }),
  onError: reportWorkerError,
});
```

Before encoded worker transfer, the bridge admits 2N bytes in the same encoded pool: one private copied message body plus the native Blob copy. The common service independently retains its original N-byte input and prospective native 4WH pixels. Main fallback admits its N-byte Blob copy. Common/cache views never detach. Native decode cancellation/generation changes retain all relevant inputs until the actual worker reply finishes.

Before preparation, the bounded producer admits the complete original 441936-byte output per 256-square page. The bridge separately reserves 4WH canvas pixels and 4WH independent RGBA readback pixels; it retains the actual held native input before posting it. Preparation enters the same broker decode queue at the supplied residency priority. Output charge remains with `RetainedPreparedImage` until its owner and active native holds end. No new budget, cache, renderer, scheduler, worker clock or copied admission authority is added.

Worker preparation replies report input close separately from actual canvas retirement. Public Images canvas retirement proof and `RgbaSurfaceCreationError.retired` cross as explicit retirement messages; reset failure keeps the full canvas charge until that proof arrives. Abort, generation loss, disposal, malformed outputs and cleanup failures attempt all independent releases and never classify cleanup as missing imagery. Successful final replies drain before idle termination.

A fatal worker event or injected `postMessage` throw cannot establish whether native input or queued output retired. The optional worker `retired:Promise<void>` must be a real host proof covering that realm, input and queued output. Never synthesize it from legacy `Worker.terminate():void`. Without such proof or a final valid reply, pending work and its charges remain quarantined and unsettled; that is an explicit outstanding host/backend limitation. New work may use fallback after failure. Worker error reporting does not itself certify native completion.

`map.imagery.pageTablePatches` still counts logical visible patches. Its catalogue reason now describes two physical versions per patch for managed transactional publication. All initial table bytes and replacement overlap are charged in the same existing named GPU budget, and admission may refuse or reduce capacity when the physical storage cannot fit. No hidden second allowance changes the configured logical maximum.

React and React DOM prerequisites are now exactly 19.2.6, as authorized by the primary to match the actual UI archives. The optional React peer meaning is unchanged; pure entries still have the existing peer-isolation checks. No dependency lock or app composition is written by this child.

`tests/terrainImageDecoder.test.ts` prepares raw RGB/WebP seam, 1024 bound, smaller named limit, invalid native geometry and all-attempt close/report cases. `tests/atlasImageryWorker.test.ts` prepares actual common service/broker plus Engine kernel/message behavior, private encoded transfer, whole output transfer, fallback, generation/abort/dispose native holds, capacity refusal, malformed pages and delayed retirement. `fixtures/browser-worker-consumer.mjs` uses only installed public exports under the existing strict archive closure/isolation harness. Its CPU transport uses actual structured transfer for arrays and explicitly simulates native bitmap moves; it cannot qualify a browser worker or native bitmap transfer. Original tests, pure terrain/page algorithms, notices and shared pinned CI files remain unchanged.

Rollback omits the optional bridge and uses the existing main readback path or the retained plain-record original application pathway. `load` and public ports remain additive, and saved setting IDs retain their homes and meanings. The primary must package and run the exact public consumer closure, write the real host worker entry, compose Engine-owned settings once, and wire source/device teardown before declaring adoption. Native browser format/color, worker realm and unknown-fatal retirement capability remain explicitly unqualified. All new source and fixtures are UNRUN.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.
