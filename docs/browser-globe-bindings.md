# Borrowed globe browser bindings

Status: implemented source draft; no checks, build, pack or new qualification run in this source-only phase.

`@foss-earth/engine/browser-globe` exports
`createBrowserGlobeBindings(options: BrowserGlobeBindingOptions)`. The host supplies
its one renderer/scene, SettingsRegistry, clock/readiness/timers, Images broker,
map cache, Renderer native resources, Sky terrain-light adapter, realm,
transport/decoder/canvas/worker factories, Google provider ports and resource policy. The result supplies
`platform`, `mapPorts`, `files`, `managedAtlas`, `lighting`, `mapFetch`, `whenReady`,
`skyTerrain`, `nightTilePorts`, `retire()`, `dispose()` and `whenSettled()`.
The optional native entry is separate from `@foss-earth/engine/browser`.
Importing either entry creates no browser session, scene, broker or scheduler.

Await `loadBrowserGlobeGoogleProviders()` from the same public entry during
browser startup, check cancellation again, then supply its result as
`googleProviders` to the synchronous binding factory. This owner loader acquires
the actual 3D Tiles renderer/authentication constructors. Those provider modules
expect browser/bundler resolution; plain Node imports of the shared entry do not
initialize them. CPU or embedded hosts can explicitly supply those two ports;
CPU fixtures refuse unexpected provider construction. Existing qualified
packages did not contain this new browser binding. Prepared draft hosts must
add this field before adopting the candidate. The logger supplies `info`,
`error` and raster's `warn` methods.

The host still constructs exactly one Renderer scheduler/profile/presentation,
Sky instance and feature frame closure. Sky constants and implementation stay in
Sky; Engine accepts its existing terrain-light adapter. Settings retain the named
`map.terrain.meshRebuildTimePerFrame` budget. Raster fallback retains actual
asynchronous texture acquisition, approved source dimensions (reviewed legacy
fallback 256 × 256), the managed imagery atlas and GL1 capability constraints.
No App/Campus/Flight implementation, host stamp or placement enters Engine.

`@foss-earth/engine` exports `createGlobeOverviewBinding(GlobeOverviewOptions)`.
It supplies `showOverview(authored, { signal? })`, `observeFrame()`, `cancel()`,
`isPending()`, `dispose()` and `whenSettled()`. The host supplies `isOverview`,
minimum preparation radius, configured FOV and cancellation realm. The binding
uses the existing displayed surface and `prepareTerrain`; it preserves the
original camera-change/fresh-input/supersession checks and FOV restoration.
Call `observeFrame` from the existing frame observer and `cancel` on fresh input;
do not add a loop. Authored overview records and geographic marker placement
remain in the application.

The factories `createGlobeRuntime`, `createGoogleTilesRuntime` and
`createRasterTilesRuntime` in `@foss-earth/engine/babylon` now return richer
`SettledGlobeRuntime`, `SettledGoogleTilesRuntime` and `SettledRasterTilesRuntime`
with `whenSettled(): Promise<void>`. Their legacy interfaces remain assignable.
The Google owner tracks authenticated fetch, root-body work, actual queue
callbacks, model parsing and readiness. Cancelling a queue result cannot retire
a parser still running underneath it. Raster tracks complete elevation and
image acquisition callbacks; this does not change terrain selection or datum
claims. Previous map owners retain their drains through a source switch.

`NativeMapStartupError` carries a real `whenSettled(): Promise<void>` for a failed
constructor's partial map work. A host catches it, registers that drain before
starting host retirement, and awaits it before requesting its final native device
marker. Throwing allocation/disposal is not completion proof. No parser/decoder
input is forcibly declared retired.

`createAtlasImageryWorkerBridge` and `createBoundedAtlasImageryLoader` retain
existing interfaces; their factories return `SettledAtlasImageryWorkerBridge`
and `SettledBrowserImageryLoader`. They wait for actual worker replies, native
fallback decode, readback/canvas retirement and retained prepared-page inputs.
Idle worker termination follows proof. Unknown or rejected canvas retirement
keeps its proof and Images reservation pending rather than reporting free memory.

## Native host consumption

A Campus `CampusNativeHostFactory.prepare` uses these public owner ports:

1. Check the supplied abort signal; construct the host renderer/scene and one
   Images broker/cache. Build native resources with the same signal, then pass
   them, the realm, awaited Google provider ports and actual Sky adapter to
   `createBrowserGlobeBindings`. Recheck abort after provider acquisition and
   before constructing the binding.
2. Construct Renderer `createBorrowedFrameClosure` with callbacks to the future
   globe, actual presentation, feature `onFrame`, resource work and all owner
   cleanup/drain callbacks. Construct the one scheduler from its
   `schedulerOptions(frames)`. Pass that scheduler/profile/lifecycle and
   `bindings.platform`/`bindings.mapPorts` to `createGlobeRuntime`. Sky is created
   only by the host's explicit attach callback.
3. Construct the viewer/resources over the same broker and native uploader;
   use the 360 public globe and browser bindings. Connect the shared overview
   binding to the Campus-authored overview; Campus owns placement resolution.
4. Supply the existing `LoadSceneOptions` hooks: the viewer, world,
   `createGlobeViewerProjection`, `createViewerSceneDescription` (or
   `createGlobeViewerFrameBinding` with explicit `description` ports), existing
   frame subscription and host session identity. Do not copy App conversion.
5. Abort begins cancellation immediately while the device lives. Retire scenes,
   viewer, resource cache, globe, bindings and native resources; await every real
   drain with `Promise.allSettled` and retain every error. Then await Renderer
   `whenBorrowedDeviceSettled` on the live device, and attempt all broker/scene/
   device releases. Rejection after true retirement still permits cleanup and
   remains observable; a still-pending proof does not permit device disposal.

If startup fails, include `NativeMapStartupError.whenSettled` in step 5. Guard
partial ownership after every awaited startup step: an abort cannot clean a
mutable owner variable before it is assigned and then leave a newly constructed
owner outside teardown. `prepare` must not return until its scene is usable.
The separate `report` path imports UI reporting/update contracts only and creates
no globe, viewer, scheduler or Dev session.

Campus' readable draft must import the native binding from
`@foss-earth/engine/browser-globe`, provide `description: { representations,
tileMemoryBytes, maxTextureSide }` to the 360 frame binding, and await the final
Renderer device marker after all model/decoder/feature drains. These are source
adoption instructions, not installed-consumer evidence.

## Provenance and pending verification

Generic browser assembly comes from Earth App `src/app/browserRuntime.ts`;
overview behavior comes from `src/app/sceneWorld.ts`; managed-atlas reservations
come from `src/app/nativeResources.ts`. Exact original bytes/modes are retained
in the Earth source-only before maps and recovery copies. Existing human lineage
and upstream notices remain unchanged; no new author or attribution is asserted.
New settlement instrumentation extends the existing owner implementations.

The authored tests cover overview supersession/input/FOV, actual worker/fallback
and canvas retirement, retained pages, cancelled outer queues with delayed inner
parsers, partial startup cleanup and globe destruction. Public consumer files in
`fixtures/native-bindings/` exercise emitted package exports and strict public
types, including the new optional native entry. All are UNRUN. GPU/browser startup,
three-browser WebGL1/2 behavior, source-free exact archives, App/Campus adoption,
lineage/ref audits and remote admission remain separate gates. Legacy callback
loaders must actually deliver success/error retirement callbacks; an adapter
that never does leaves its drain pending and requires a real retirement port.
