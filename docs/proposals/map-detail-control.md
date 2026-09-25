# Map detail control: projected raster imagery

Status: Implemented in FOSS Earth and 0sfs (2026-09-25); qualified only on the machine and browser named in the [implementation record](#implementation-record)

Date: 2026-09-24

Owner: FOSS Earth; 0sfs consumes its public runtime and shell APIs

## Decision and scope

Implement option 3 from the detail-slider review: select raster imagery by the
size of its image pixels projected into the actual rendered view. Expose a
relative detail target around a source-specific Normal setting. Preserve useful
visible coverage, apply source limits, and admit refinement within explicit
resource limits. Projected pixel size is the quality measurement, not the entire
loading policy.

The same HUD control serves Google 3D Tiles and raster basemaps through separate
adapters. Google retains its screen-space geometric-error target. Raster changes
imagery resolution independently of elevation downloads and terrain geometry.
Equal slider positions across those adapters do not promise equal visual quality,
ground accuracy, workload, or bandwidth.

FOSS Earth owns the range editor, saved defaults, session overrides, provider
policy, selector, loading and texture binding. The range editor lives in the
**Map tab → Detail** section in both applications. 0sfs retains flight-specific
terrain requirements, aircraft anchoring, preparation and contact behavior.

This specifies the next detail implementation after the conservative profiles in
[Flat-basemap performance recovery](raster-terrain-performance.md). It refines
that document's C1/C2 direction without declaring its broader terrain-selection
work complete. Source metadata and fallback requirements also follow
[Provider capabilities](raster-provider-detail.md). Where older prose places
generic selector UI in the flight application, this specification supersedes it.

Excluded: vector-map rendering, new providers, higher approved provider request
ceilings, new elevation accuracy claims, a replacement terrain LOD algorithm,
Google traversal/collision redesign, and an unrestricted resource-budget slider.

## Current implementation and defects to remove

- [`chooseTileZoom`](../../src/engine/babylon/createRasterTilesRuntime.ts) uses
  `round(log2(circumference / clamp(zoomMeters * 0.65, 250, 8000000))) + zoomBias`.
  It does not measure projected imagery demand. The 250 m clamp limits High to
  focus zoom 17 even where the registered imagery source permits higher levels.
- The fixed focus ring in that file shrinks geographically as zoom increases.
  Merely attaching the HUD to `zoomBias` is not completion of this specification.
- [`rasterQuality.ts`](../../src/engine/babylon/rasterQuality.ts) bundles image
  zoom, ring size, terrain subdivisions and cache counts. Tile records bind one
  image to one terrain mesh; selecting finer imagery also changes terrain work.
  Its cache count excludes visible, desired and in-flight entries from eviction,
  so it is not a hard memory admission limit.
- [`mapDetailSlider.ts`](../../src/shell/mapDetailSlider.ts) is Google-specific.
  It treats the coarsest endpoint as both a numeric target and reset-to-default.
  0sfs sorts World detail and Flight minimum into endpoints even when the saved
  default is the finer value. The endpoint can therefore restore an unrelated,
  finer target.
- 0sfs's `WorldDetailSettings` in `src/flight/hud/FlightControlPanel.tsx` owns the
  generic range UI together with flight policy. Its low-spawn preparation can
  also overwrite the saved World detail preference with the flight requirement.

These are observations of the working checkouts on the date above, not claims
that the proposed APIs below already exist.

## User behavior

### HUD and Map tab

Keep the HUD rail beside the map-source chip and retain its orientation: finer
on the left, coarser on the right. The thumb shows the requested session value,
or the resolved saved default when there is no override. Both endpoints are
ordinary values. Neither endpoint has reset semantics.

Map → Detail contains, in paragraph-grid layout:

- The active source's permitted finer/coarser endpoints and saved default.
- A default mode choice: Normal or Custom for raster; the existing recommended
  or manual target behavior for Google.
- A **Restore saved detail** action clearing the session override. A **Reset
  detail settings** action restores only the active source's range/default.
- A compact status for pending refinement or source/resource limits, when one
  actually applies. Advanced readings name their units explicitly.

The map-source button continues to toggle the Map tab; no popover or second
range editor is added. The HUD is the sole interactive temporary-detail rail;
the tab edits persistent policy. A default tick identifies the resolved saved
default independently of the endpoints. The existing blue marker may represent
an effective policy target only when one scalar exists. It must never imply
that all requested imagery has loaded. Raster uses a loading/limited status when
different patches have different delivered detail, rather than inventing an
average zoom as an achieved-quality marker.

Keyboard, pointer and touch operation must agree with the visual direction.
Provide an accessible value description such as “Normal”, “one level finer than
Normal”, or “Google error target 32 pixels”. Equal endpoints disable dragging
with the selected value still readable. Invalid persisted values are rejected;
range edits maintain an ordered range and clamp the default/session value once.
Editing a range must not silently change Normal to Custom.
While Normal is selected, the raster range must include 0; constrain range
handles accordingly. Selecting Normal from Custom expands the range to include
0 if necessary. Custom ranges may exclude 0.

Source switching preserves each source's saved policy and its session override;
reload clears overrides. Google and raster never inherit each other's numeric
units. Returning to a source in the same session restores its own override.

### Raster target and initial range

Use a signed detail offset `d`, measured in binary resolution steps, positive
for finer imagery. Normal is `d = 0`. The imagery target is:

```text
allowed projected image-pixel size = normalTargetPx * 2^(-d)
```

For photographic imagery, the initial Normal target is 1 physical render pixel
per image pixel. Initial selectable bounds are `d = -3` to `+1` (8 px to 0.5 px),
with a default of 0 and a slider step of 0.25. These are explicit starting values
for visual calibration, not measured device recommendations. Keep the supported
envelope bounded to this range initially; a later wider envelope needs evidence.
The user's Map-tab endpoints select a subrange of that envelope.

Continuous target changes cause discrete source-level changes. Never put a
fractional zoom in a tile URL. Refinement hysteresis below prevents tile thrash;
the UI must not promise a visible change at every quarter-step.

Normal depends on projection, actual rendered resolution, tile dimensions and
source kind. It is not a moving FPS target. Automatic resource adaptation may
constrain delivery but must not rewrite `d`, the saved default, or the range.

### Labelled and mixed raster maps

Mark sources as `photographic` or `cartographic`; imagery with baked labels or
contours uses `cartographic`. Resolve a stable baseline cartographic zoom per
visible region using standard-density tiles and logical viewport pixels. Its
purpose is readable map scale. Moving the camera can change it; changing DPR
alone must not change cartographic zoom. Hysteresis applies to this baseline too.
Numerically, choose the coarsest legal standard-density level with a projected
footprint at most 1 logical pixel per image pixel, using the projection metric
below in logical viewport dimensions. Do not round a distance-derived zoom.
At offset `d`, use the logical target `2^max(0, -d)` to choose cartographic level:
coarser offsets can select parents; positive offsets cannot advance that level.

Independently, the physical sampling target is `2^(-d)` actual render pixels per
image pixel, including at Normal (`1`). Choose the smallest verified same-zoom
variant that meets it. DPR/render scaling can therefore change variant demand
without changing cartographic level. If none meets it, use the finest available
legal variant and report the source limit. Render downscaling may need no variant
upgrade at all. This explicitly separates readable map scale from sampling.

At a given cartographic zoom, prefer a verified higher-pixel-density image
variant to satisfy finer requested sampling. It must represent the same extent
and cartographic content. Do not infer an `@2x` URL or treat a zoom change as an
equivalent variant. Use actual render pixels for variant selection.

For the first implementation, finer-than-Normal settings on cartographic sources
may select those verified variants, but may not advance cartographic zoom solely
to satisfy supersampling. Coarser settings may use parent map tiles, accepting
less cartographic detail. Show a source limit when the available variant cannot
meet the request. Keep the shared range visible; do not change its endpoints
while moving through source-limited regions.

This intentionally bounds “more detail” on providers without same-zoom variants.
An explicit future control for additional labels/content is separate work. Do
not market source interpolation as extra real detail. Mixed-LOD label boundaries
must be included in visual fixtures; prefer coherent adjacent source levels and
avoid oscillating level choices at seams.

## Provider capabilities

Extend the descriptor in
[`rasterBaseMaps.ts`](../../src/engine/babylon/rasterBaseMaps.ts), publicly exported
through `foss-earth/runtime`, with:

- Source kind, stable identity/version and supported tile scheme.
- Standard tile pixel width/height; actual dimensions for each verified variant,
  its stable ID and URL builder, and whether it preserves cartographic content.
- Minimum level, approved request ceiling, geographic coverage, and any known
  local availability/native-resolution metadata. Unknown remains unknown.

Retain today's approved request ceilings. Metadata cannot silently raise them.
Validate returned dimensions; account for decoded size before admitting a
variant. Use reviewed static descriptors for the initial registry. Optional
metadata loading must not block coarse coverage. Missing detail is recorded per
source/version/variant/tile with expiry, not as a permanent global level ban.
Preserve provider-specific request, caching, attribution and prefetch rules from
the provider appendix. The imagery selector requests visible demand; it does not
inherit the terrain/flight predictive corridor.

## Selection algorithm

### Inputs and projection measurement

Create a pure, testable selector in FOSS Earth's `src/terrain/` taking a view
snapshot, source capabilities, adopted surface bounds, requested target,
resident imagery and resource reservations. The view snapshot includes camera
view/projection matrices, physical render viewport dimensions, logical viewport
dimensions, and the world transform needed for floating-origin scenes.

Use the actual render-buffer dimensions after hardware scaling, not CSS size
times an assumed DPR. Perspective and orthographic projections must work.
Raster visual detail follows the active camera, independently of any consumer's
contact-area reservation or Google's aircraft-anchor setting.

For a visible surface region, estimate the Jacobian mapping a source image pixel
in each texture direction into screen pixels. The largest singular value gives
the maximum stretched image-pixel footprint. Evaluate across the clipped region
with a bounded adaptive set of interior/edge samples and conservative curvature
bounds. Do not approximate the entire globe or a near-plane-crossing tile with
one projected bounding-box width. Sampling must use adopted terrain or available
coarse bounds, never download finer heights merely to decide imagery demand.

Clip against the near plane and frustum before perspective division; use
conservative globe/horizon rejection. Regions crossing the horizon are retained
until visibility is resolved. Handle antimeridian wrapping, Mercator latitude
limits, camera-inside-bounds and finite/zero-distance cases. A bounded sample or
traversal limit produces deferred work and retained coverage, never infinite
error-driven requests. Mipmapping and supported anisotropic filtering handle
minification at grazing angles; they are not new source detail.

### Traversal and refinement

1. Begin with coarse coverage ancestors and traverse only potentially visible
   imagery regions. Coverage is independent of the current terrain mesh tiling.
2. Compute the projected footprint for each legal source level/variant. Select
   the coarsest useful candidate meeting the requested target, constrained by
   source kind, approved levels and known availability.
3. Refinement becomes eligible when the existing footprint exceeds `1.2 * target`.
   Coarsening becomes eligible only when the proposed parent's footprint is
   below `0.8 * target` for 500 ms. Pin newly adopted detail for at least 1 second
   unless source/view invalidation or a hard resource limit requires release.
   These initial constants are explicit and covered by deterministic tests.
4. Prioritize missing coarse coverage first, then visible refinements. Rank
   refinements by estimated screen area improved times reduction in target
   exceedance, divided by incremental decoded/upload bytes. Shared resident
   ancestors and children are charged once. Estimate cost from dimensions when
   compressed size is unknown; do not claim semantic/perceptual image analysis.
5. Admit a bounded amount of work, retain uncovered ancestors, and continue on
   later updates. Loading a child is not permission to remove a usable parent.

If the target cannot be met, retain the best admissible coverage and record the
limiting reason. Increasing requested detail at a fixed view must not shrink the
desired geographic coverage or deliberately request a coarser image. Resource
pressure can delay improvements; it does not change the user's requested value.

Recompute demand on view/projection/viewport changes, meaningful surface-bound
changes, source or target changes, and relevant residency/availability changes.
Coalesce slider events to one selection update per rendered frame. A stationary
settled scene does no repeated traversal or texture work. Bound traversal nodes
and CPU work per update; incomplete traversals preserve the previous valid plan.
Schedule an on-demand wakeup for the earliest outstanding hysteresis/residency
deadline. Incomplete traversals and admitted decode/upload work request another
update even when the camera and simulation are paused. Cancel wakeups when
settled, superseded or disposed; do not require continuous rendering to finish.

## Independent imagery binding

Split terrain records and imagery residency. A terrain patch owns its committed
positions, indices, normals, elevation provenance and surface-query membership.
An imagery page owns source/variant/tile identity, decoded image, GPU allocation,
load state and references. Multiple imagery tiles can cover a single terrain
triangle; one image can cover multiple terrain patches.

The initial binding design is a **bounded paged imagery atlas with a page lookup
sampled by the terrain material**. Use patch-local texture coordinates plus tile
identity to locate the selected level/variant's resident page or a permitted
ancestor fallback. Maintain selected/displayed coverage separately from cache
residency: finer cached pages cannot override a coarser selection, and a late
completion cannot promote itself merely by becoming resident. Coarsening
publishes the new selected binding atomically while finer pages may remain
cached. Do not
construct an arbitrarily large full-resolution mosaic per terrain patch. Do not
re-tessellate the surface to match imagery boundaries.

Required implementation properties:

- Page gutters and isolated mip levels prevent cross-page filtering bleed.
  Whole-atlas automatic mip generation without isolation is not acceptable.
- Publish page-table changes atomically after upload; no table may reference an
  uninitialized or reused slot. Pin visible fallback pages until replacements
  are usable. Account for old/new pages and table buffers simultaneously.
- Preserve pixel orientation, color space and filtering behavior in fixtures.
  Use integer tile coordinates plus local fractions for high-zoom precision;
  one global 32-bit Mercator float is insufficient for zoom-19/20 texel lookup.
- Bound page-table size and shader lookup depth, as well as atlas bytes. Avoid
  shader recompilation or allocation per tile/slider movement.
- Support the actual WebGPU, WebGL2 and WebGL fallback paths. The binding proof
  must establish a compatible bounded lookup on each; use smaller supported
  atlases/limits on constrained backends. Do not silently disable WebGL support
  or return to terrain-driven imagery selection. Record a capability limit if a
  backend cannot meet the requested detail.

With camera/elevation policy fixed and elevation settled, an imagery-only target,
variant or source change must leave terrain vertex/index/normal buffers, terrain
coverage, surface revision and sampled contact hits unchanged. No DEM request or
mesh rebuild may originate from imagery selection. Existing terrain updates still
commit their displayed and queried surface together through the safe path.

Keep the existing terrain-selection policy initially, but give it independent
terrain inputs/limits. An imagery provider's zoom cap or tile dimensions may no
longer drive terrain selection. Adapting terrain geometry to a new screen-space
error estimator is not a prerequisite for this imagery feature.

## Resource admission and asynchronous work

Separate visual target from resource policy. The existing `rasterQuality`
Auto/Low/Balanced/High choice remains the terrain/resource setting; its image
`zoomBias` and focus ring cease to control imagery once the new selector is used.
Do not silently convert `terrainQuality` URL values into a saved imagery target.

Provide injectable resource limits for GPU imagery bytes (including mipmaps,
gutters and lookup tables), decoded/staging bytes, in-flight requests, queued
requests, pending uploads, traversal and update CPU work. Account for compressed
response buffers when observable; otherwise label their reserved sizes as
estimates. Browser/process/GPU-total memory is not fully measurable here.

Starting calibration limits, not device-performance claims:

| Limit | Low | Balanced | High |
| --- | ---: | ---: | ---: |
| Estimated GPU imagery allocation | 64 MiB | 128 MiB | 256 MiB |
| Decoded/staging imagery | 8 MiB | 16 MiB | 32 MiB |
| Concurrent imagery requests | 4 | 6 | 8 |
| Queued imagery requests | 64 | 128 | 256 |

Reserve coarse coverage and replacement headroom inside those limits. Initial
selection/preparation CPU work yields after 2 ms per update; bound individual
jobs as well. Upload admission starts at 2 MiB per update, at most one larger
legal page when necessary and when its reservation fits. GPU timing, where
available, determines whether that starting allowance is sustainable; a CPU
timer cannot establish GPU upload duration. Confirm an indivisible standard or
variant tile fits every supported policy before enabling it.

If a selected profile would exceed renderer capabilities, lower effective limits
and report that constraint. On a limit reduction, stop admitting optional work,
release unpinned resources and coarsen safely; include the finite temporary
excess of already-reserved work in diagnostics. Never drop fallback coverage to
pretend that a new lower bound was reached immediately.

Auto may select resource limits using bounded sustained observations. Existing
frame intervals are not GPU timings; retain that distinction. Startup, source
switching and detail-drag load bursts do not justify rewriting the imagery
target or repeatedly rebuilding contact terrain. A manual detail change does
not require disabling bounded resource admission.

Deduplicate requests by source/version/variant/tile. Remove obsolete queued work;
abort obsolete in-flight work when economical and supported. Selection changes
do not invalidate still-useful shared pages. Source generations prevent stale
completions from rebinding the wrong imagery; stale images may be retained only
inside the correct bounded cache. Disposal releases callbacks and resources.

Missing tiles fall back to parents. Transient failures back off; rate limits and
timeouts do not permanently mark a level unavailable. Preserve attribution for
imagery still displayed during a source transition. This work must not add a
second full map runtime, reset the app, or repeat terrain preparation on a
raster-to-raster image change.

## Public state, persistence and migration

Export the policy/state types through `foss-earth/runtime`, and the shared
controller/range UI through `foss-earth/shell`. Implement one controller per app;
the Map tab and HUD observe the same instance. Avoid deep imports from 0sfs.

The proposed contract separates these facts explicitly:

```ts
type DetailPolicy =
  | { kind: "raster"; coarseOffset: number; fineOffset: number;
      defaultValue: "normal" | number }
  | { kind: "google"; finestErrorPx: number; coarsestErrorPx: number;
      defaultValue: number | { mode: "recommended";
        policy: "device-hints" | "renderer-default" } };

// Values in a state carry the active policy's kind/units; never mix them.
// A scalar target is a request, not a delivered-detail measurement.
interface DetailState {
  key: string; // "google" or "raster:<stable source id>"
  availability: "ready" | "initializing" | "unavailable";
  policy: DetailPolicy;
  resolvedDefault: number;
  sessionOverride: number | null;
  requestedTarget: number;
  effectiveTarget: number | null;
  pending: boolean;
  limits: readonly ("source" | "memory" | "loading" | "backend" | "consumer")[];
}
```

Raster numeric state values are offsets `d`; Google numeric values are native
screen-space error pixels. Derive raster pixel targets through its source policy.
The controller clamps a resolved recommended Google default to the user range
without replacing that saved mode with a number. Normal's range includes 0;
a clamped Google recommendation is explicitly labelled as limited by the range.
Persist the Google recommendation policy ID, preserving its meaning on reload.
`renderer-default` resolves the captured plugin default, distinct from a user
default or the device-hint recommendation. Raster `effectiveTarget` is
`null` when spatially varying delivery has no single meaningful target.

Operations: read state, subscribe, update saved policy, set session override,
clear session override, reset active policy and dispose. Validate finite values
and kind/range consistency at the public boundary. Native Google targets retain
their current 1–524,288 px limits and log scale; never round-trip them through a
0–100 quality percentage. Default, requested and effective targets are distinct.
Runtime subscriptions must publish meaningful changes while paused/on demand,
without depending on 0sfs polling a React snapshot every simulation frame.

Save a versioned record at `foss-earth.map-detail.v1`, keyed by source. Storage is
per browser origin; shared code does not mean cross-site preference transfer.
Precedence on initialization: explicit host policy, then valid saved policy, then
registered defaults. The host may configure defaults; it does not reimplement
the shared range editor or selector. New detail URL parameters are out of scope;
existing map/elevation/terrain-quality parameters remain independent.
Distinguish a forced host override from seed defaults in the API: a seed applies
only when no valid saved policy exists and cannot overwrite later user edits.
The legacy import is also a seed, never a forced override. Inject storage for
tests/embedded hosts; the low-level rendering runtime does not own localStorage.

0sfs performs a one-time legacy import through the public initialization API:

1. If a valid new Google policy exists, do not import over it.
2. Read `osfs.world-detail-target`. A finite valid number becomes the saved Google
   default. `auto` retains the existing recommendation behavior. Move its generic
   recommendation helper into FOSS Earth; 0sfs opts into that seed policy while
   the standalone globe may retain its renderer-recommended seed.
3. Seed the Google bounds from the old configured target and
   `osfs.flight-terrain-requirement` once, preserving the old reachable interval.
   Thereafter changing the flight requirement never changes the generic bounds.
   When recommended defaults change, resolve/clamp them within the saved bounds.
4. Write the new versioned record before marking import complete. Storage denial
   retains functional in-memory state and leaves migration retryable. Do not
   delete legacy keys in this change; they remain available for rollback.

`osfs.flight-terrain-requirement`, `osfs.terrain-detail-anchor` and the session-only
coarse-terrain waiver remain owned by 0sfs. Their controls remain in its flight
settings; they are removed from the shared range editor. The currently entwined
two-handle control is replaced by a generic range editor plus separate flight
settings, not moved wholesale into FOSS Earth.

For low-spawn preparation, 0sfs requests temporary Google refinement through an
explicit consumer requirement/release handle. Compose an active requirement as
the smaller (finer) native error target, independently of the saved range and
HUD override. It may exceed the user's range; report the consumer limit and
effective target rather than moving the thumb or editing the saved preference.
Release it only after the existing readiness/contact policy allows release,
including cancellation and error cleanup. Specifically, a requirement acquired
for a low spawn survives completion of preparation and near-ground departure;
release after the aircraft remains at least 100 m above a valid adopted surface
for one continuous second of unpaused simulation time. Use an established current
local ground/contact observation, not a retained spawn height. Missing, stale or
nonfinite evidence resets that interval and cannot satisfy departure.
Enabling the existing coarser-terrain waiver also releases it. A new preparation
supersedes the old lease without an intervening coarse frame; a failed/cancelled
preparation releases only its own lease. Disposal releases all leases. Restoring
the saved HUD target does not release a consumer requirement. Do not reacquire
this preparation-only requirement merely because a later flight descends. This
replaces the old lasting preference mutation with a defined session behavior;
it does not create a new in-flight readiness gate or change JSBSim.
Switching away from Google releases its lease; a later return requires its own
ordinary preparation if the host performs one. Editing Flight minimum updates
an active lease immediately; without a lease it affects future preparations.
After departure, restoring a previously coarse saved target is an intentional
behavior change from the old lasting mutation and must be validated in flight.

Keep the low-level Google runtime APIs for compatibility while migrating both
apps' UI to the new controller. There must be one authoritative target writer;
flight preparation and HUD handlers cannot race independent direct writes.

## Implementation sequence

Each stage lands in FOSS Earth first, with public exports and consuming changes
in 0sfs where necessary. Do not expose the raster rail as working before the
independent imagery path passes its acceptance checks.

1. **Shared state and UI.** Implement explicit bounds/default/override state,
   persistence, Google adapter and migration. Move the editor to Map → Detail;
   remove its 0sfs copy. Fix endpoint reset behavior and flight-preparation writes.
2. **Provider and selector.** Add reviewed descriptor dimensions/source kinds,
   synthetic projection fixtures, bounded visible traversal, hysteresis and
   admission planning. Keep runtime integration behind a development switch.
3. **Binding proof and separation.** Implement independent imagery records and
   bounded atlas/page lookup on the supported backends. Prove finer imagery on
   unchanged terrain triangles before replacing production tile material code.
4. **Streaming integration.** Connect selection, residency and upload queues;
   remove imagery dependence on the focus ring/profile zoom bias. Preserve
   source transitions, attribution, contact sampling and on-demand rendering.
5. **Calibration and release.** Exercise fixed fixtures, tune the explicitly
   marked starting constants, run both repository checks, and enable the raster
   rail after recording acceptance evidence. Update the implementation record
   with actual completed work and remaining backend/device limitations.

Likely source homes (new files belong to FOSS Earth): selection/projection and
provider policy under `src/terrain/`; Babylon atlas/material/upload integration
under `src/engine/babylon/`; shared detail controller, preferences and Map-tab
editor under `src/shell/`. Refactor the current raster runtime incrementally;
do not place globe logic in `0sfs/src/flight/`.

## Acceptance and validation

Use synthetic labelled/color-grid imagery for deterministic tests; live provider
content and network speed are not correctness oracles. Test invariants rather
than reproducing the implementation formula in test assertions.

| Area | Required evidence |
| --- | --- |
| Projection | Perspective/orthographic; viewport/FOV changes; DPR versus render scaling; overhead/oblique/horizon views; poles/dateline; floating-origin invariance. A photographic image at twice the projected linear size selects approximately one finer legal level. |
| Source semantics | 256/512-pixel sources; same-zoom variants; cartographic DPR changes preserve map scale; unknown variants are never guessed; source cap/missing child retains usable parent. |
| Coverage | Increasing detail at fixed view never reduces desired visible coverage. Incomplete/failed refinement leaves no imagery holes. Fixed-ring boundaries no longer determine image sharpness. |
| Independence | With terrain settled/frozen, imagery level/variant/source changes cause zero DEM requests, terrain buffer writes, surface revisions or contact-hit changes. Test an imagery boundary crossing the interior of a single terrain triangle. |
| Binding | Page seams, mip bleed, Y orientation, color space, high-zoom texel precision, stale slot references and actual WebGPU/WebGL2/WebGL behavior. |
| Scheduling | Hard admission under tiny injected limits; replacement headroom; shared-page deduplication; stale completion; failures/retries; disposal; no unbounded all-desired loading burst. |
| Stability | Camera/slider threshold jitter produces bounded level changes; stationary settled frames have no recurring selector/geometry/upload work; rotation/FOV-only changes do invalidate demand. |
| UI/state | Both endpoints are values; saved default inside/either side of old endpoints; equal bounds; reset, reload, source round trips, corrupt/denied storage, keyboard/touch and narrow paragraph-grid layout. |
| Google/flight | Existing manual/recommended defaults and camera/aircraft anchor work; one-time import; HUD cannot clear an active preparation requirement; saved preference unchanged by low-spawn preparation; departure restores the saved target without later low-flight reacquisition. Exercise threshold jitter, pause, missing/stale ground, waiver, source switch, flight-minimum edit, supersession, failure and disposal. Existing contact/ground safety behavior remains intact. |

Record a fixed-view sweep over low/coarse, Normal and fine targets for a city,
mountainous area, coast/dateline, and near-horizon flight view. Include a
photographic, cartographic and mixed imagery/topo source, cold and warm caches,
source switching, rapid slider drag and a fixed-camera elevation update. Compare
against the current profiles at matched visible detail, not only matched names.

Capture requested target, per-region requested/delivered level and variant,
projected footprint distribution, limit reasons, coverage, requests/bytes,
resident/staging/estimated GPU bytes, draw calls, texture uploads, terrain writes,
surface revisions, selector/preparation timings and frame P50/P95/P99. Mark GPU
timing unavailable when unsupported. Confirm the real GPU for GPU comparisons.
Release requires demonstrated improvement in photographic sharpness at finer
settings where source data allows it, unchanged physical surface for image-only
changes, enforced allocation/queue bounds and no unexplained regressions in
frame pacing at matched quality. Retune or reduce the effective envelope if those
checks fail; passing unit tests alone does not qualify performance.

Run focused tests as each stage changes behavior, then `npm run ci` in FOSS Earth
and 0sfs for the integrated implementation. For this documentation-only change,
validate links and whitespace; no runtime behavior or performance is claimed.
Use terminal/headless validation, with no dev/watch server unless requested.
Runnable fixtures belong in the owning repository's scripts/tests/benchmarks;
scratch belongs in its gitignored `build/`. Retained evidence belongs in
`validation/evidence/map-detail/`, with a human-readable report linking results.

## References

- [3D Tiles geometric error and screen-space error](https://docs.ogc.org/cs/18-053r2/18-053r2.html).
- [Tile levels, dimensions and ground resolution](https://learn.microsoft.com/en-us/azure/azure-maps/zoom-levels-and-tile-grid).
- [Cesium's screen-space target and memory allowance](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html#maximumCacheOverflowBytes), a precedent for keeping requested quality distinct from resource-constrained delivery.
- [MapLibre source descriptors](https://maplibre.org/maplibre-style-spec/sources/), including source levels and tile dimensions.

## Implementation record

Written 2026-09-25 against the working checkouts; it records what exists, not
what the sections above ask for. Evidence and how to reproduce it:
[`validation/evidence/map-detail/`](../../validation/evidence/map-detail/README.md)
and [`benchmarks/map-detail/`](../../benchmarks/map-detail/README.md).

### What landed

1. **Shared state and UI.** `src/terrain/mapDetailPolicy.ts` holds the policy
   types, validation, range editing, the device-hint recommendation moved from
   0sfs, and value descriptions, exported through `foss-earth/runtime` and the
   light `foss-earth/mapDetailPolicy` subpath. `src/shell/mapDetailController.ts` holds
   saved policies per source in `foss-earth.map-detail.v1`, session overrides,
   forced host policies, seeds, consumer requirements and change notification.
   `connectMapDetailRuntime` makes it the one writer of the renderer's target.
   The HUD rail (`mapDetailSlider.ts`) has two ordinary ends, a default tick and a
   marker only for a single effective Google target; the Map tab's Detail group
   (`mapDetailPanel.ts`) edits range, Normal or Custom default, Restore and Reset.
   0sfs imports `osfs.world-detail-target` once (`src/flight/worldDetail.ts`),
   keeps Flight minimum, the anchor and the waiver in its own Settings, and holds a
   low spawn with a requirement lease released after one second of simulated
   flight at least 100 m above the sampled surface.
2. **Provider and selector.** Descriptors in `rasterBaseMaps.ts` gained kind,
   version, tile size, reviewed variants and request policy.
   `src/terrain/imagery/imagerySelector.ts` is the pure, time-sliced traversal:
   Jacobian footprints at grid, nearest-point, view-edge and screen-ray samples,
   near-plane and frustum clipping, a bounding-sphere and point horizon test,
   hysteresis (1.2 / 0.8, 500 ms, 1 s pin), a page budget, cartographic level and
   variant rules, and limits per region.
3. **Binding.** `src/engine/babylon/imagery/` holds the paged atlas (256-pixel
   pages in 288-pixel slots, per-page mips to level 4), page tables of up to 64 ×
   64 cells per terrain patch, and a `StandardMaterial` plugin with the same lookup
   in GLSL (WebGL 2 `textureGrad`, WebGL 1 `texture2DGradEXT` or plain sampling)
   and WGSL. Terrain records no longer own images.
4. **Streaming.** `imageryResidency.ts` bounds requests, queue, staging bytes,
   uploads per update and slots, pins what the published tables reference, records
   missing tiles with an expiry and backs off failures. Decoding and page building
   run in a worker. `createImageryRuntime.ts` ties selection, residency and
   publication together and wakes itself for deadlines.
5. **Calibration and release.** Binding fixtures on WebGPU, WebGL 2 and WebGL 1,
   and a real-provider sweep on WebGPU, met the release criteria; the
   [evidence report](../../validation/evidence/map-detail/README.md) has the
   numbers. `DEFAULT_RASTER_IMAGERY` is `atlas`, which enables the raster rail;
   `?rasterImagery=legacy` rolls back. The starting constants were kept. The
   sweep found two defects, both fixed: a fully transparent "no data" tile was
   drawn black, and a tile whose own image was missing was still refined, so its
   region never stopped loading. A 0sfs flight found a third: ground coming into
   view showed the level-2 coverage, a flat colour, until its own images arrived.

### Decisions the sections above left open

- The page table addresses at most six levels below a terrain patch. Selection is
  capped there (`maxLevelFor`) and a deeper request is reported as a backend limit.
- With the atlas, terrain levels are capped at 16 regardless of the imagery source;
  before, the imagery source's maximum level also capped terrain.
- The atlas texture is sized once, from the resource profile active when the
  raster runtime is created. Later Auto changes move admission limits and the
  selection budget inside it, but never reallocate it.
- A moving camera starts a new traversal at most every 100 ms; source and target
  changes restart at once, and a wake-up always selects the final view.
- Off-screen leaves kept only for coverage report no limit and get no variant.
- A fully transparent image is a missing tile, like a 404: some servers answer
  "no data" that way.
- A tile whose own image is missing is not refined; its region shows the nearest
  ancestor, reports a source limit and does not count as loading.
- A leaf whose region would show a page four or more levels coarser also asks,
  ahead of itself, for its ancestor three levels up: one small image that stands
  in, blurred, for 64 leaves while they load.
- Google's `pending` is the renderer's tile streaming state.
- If the atlas cannot be created, the raster runtime draws per-tile imagery and
  reports raster detail as unavailable with a backend limit, rather than failing.
- `?rasterImagery=legacy` or `atlas` selects the path for development and rollback.
- 0sfs no longer prepares terrain again when one 2D basemap replaces another.

### Remaining limitations

- Qualified only on one Apple M5 with Chrome in headless mode, on WebGPU, WebGL 2
  and a WebGL 1 engine. No other device, browser or display is qualified.
- The atlas is allocated whole when the raster runtime starts: 126 MiB on the
  Balanced profile, against 35–39 MB of textures for legacy Balanced and 63 MB
  for legacy High in the sweep. Hard views use all of it (near-horizon at Normal
  reports a memory limit); easy ones use under half.
- GPU frame time was measured only through WebGPU timestamp queries without
  Chrome's WebGPU developer features, so it is coarse; the 2 MiB upload
  allowance is still the starting value.
- CARTO has required an API key since August 2026 and answers without one with
  an "API KEY REQUIRED" placeholder tile, in both imagery paths. FOSS Earth has
  no key setting, so its CARTO basemaps show that placeholder. The `@2x` variant
  is registered from CARTO's documentation and a 512 × 512 dimension check; one
  pair of tiles saved before the placeholder appeared aligns best at zero offset,
  but by too small a margin to prove the content is the same.
- No other provider has a verified variant, so cartographic sources on
  high-density screens report a source limit at Normal.
- A tile's footprint is measured at fixed sample points. On steep relief a
  parent can under-estimate by about 1.5× against its children (the Mount
  Rainier view), and a view whose footprints sit inside the hysteresis band can
  settle into either of two plans depending on how it got there.
- A partly transparent tile at the edge of a source's coverage is drawn black
  where it is transparent, as the legacy path draws it.
- In continuous flight the atlas costs more than the legacy path. In one 0sfs
  flight at 6,200 ft over Minneapolis on WebGPU, it made 1,550 tile fetches
  against legacy's 632, spent 3.7 ms against 2.4 ms of measured work per frame,
  and had a frame P95 of 19.3 ms against 17.5 ms, at the same 59 fps mean, with
  much sharper imagery. While the camera moves, selection restarts every 100 ms
  and runs in 2 ms slices, and the plan sits at the Balanced memory limit, so
  pages turn over as the view moves. These are single runs.
- Legacy keys `osfs.world-detail-target` and `osfs.flight-terrain-requirement`
  remain in storage for rollback.
