# Provider capabilities and available detail levels

Status: Implementation appendix to [Flat-basemap performance recovery](raster-terrain-performance.md)
Date: 2026-09-07  
Scope: raster imagery, raster elevation, and the terrain mesh built from them

## Three independent levels of detail

Low/Balanced/High are resource policies. They are not data levels. A displayed
patch needs separate records for its imagery, elevation source, and mesh:

| Dimension | Available choices | What changing it does |
|---|---|---|
| Imagery source level | Provider-specific integer tile levels, constrained by local coverage | Downloads a different image of a smaller/larger geographic footprint |
| Elevation source level | Provider-specific integer tile levels, constrained by local coverage | Downloads a different grid of height samples |
| Rendered mesh detail | Geographic patch footprint plus subdivisions per edge | Controls how many triangles represent those heights and Earth curvature |

Texture mipmaps are an additional GPU filtering mechanism: smaller versions of
an already-loaded texture. They do not fetch more detail or increase the source's
real resolution. A retina image variant also needs its own pixel-size metadata;
do not assume its zoom number means the same sampling density as a standard tile.

Imagery and elevation can come from different providers. Selecting USGS Imagery
Topo does not select a USGS elevation API: the current application's height source
remains Mapterhorn. Printed contours or hillshading in an image do not supply the
physics height field.

## Hot-swap basemaps without restarting the app

Changing the basemap must update the running map, preserving the camera, aircraft
position/orientation/velocity, controls and trim, weather, pause state, open panels
and other session state. For flat-to-flat changes with the same elevation source,
this is an imagery replacement: retain the terrain loader, decoded heights,
adopted mesh, surface-query object and surface revision. Sharper imagery or a
different image tile footprint must not reset terrain or trigger aircraft lifting.

### Why it reloads today

The exported `setMapSourcePreference` in
[`resolveMapRuntimeConfig.ts`](../../src/engine/babylon/resolveMapRuntimeConfig.ts)
sets `mapSource` in the URL and calls `window.location.assign()`. Flight-sim wires
its map menu directly to that function. The standalone globe has a duplicate
reload-based helper in [`createGlobeApp.ts`](../../src/app/createGlobeApp.ts).
The reset is an explicit navigation path, not a requirement of map tiles.

Removing navigation alone is insufficient: the public runtime currently has no
source-change method, and `enableRasterBaseMapMode` in
[`createBabylonRuntime.ts`](../../src/engine/babylon/createBabylonRuntime.ts)
disposes the raster runtime when its imagery source ID differs. That disposal
also destroys its terrain loader and mesh cache. The new path must separate
imagery replacement from terrain lifetime.

### Replacement contract

- Both apps call one public runtime source-change API. Keep the Babylon engine,
  scene, world root, render loop, input subscriptions and flight simulation alive.
  Selecting the already-active source with no pending switch is a no-op.
- Keep current imagery visible while loading replacement textures, then replace
  patches as usable images arrive. Prefer the selected source's available parent
  image when sharper tiles are missing. Different image tile grids use appropriate
  UV mapping or surface-preserving image patches; they do not dictate a new DEM
  level or rebuild the physical terrain. No crossfade is required initially.
- Track requested, displayed and pending sources accurately. Keep usable coverage
  on failure and report incomplete replacement; never show a blank map or claim
  the new source is fully displayed while old patches remain. Attribution follows
  the sources actually visible during the transition.
- Key imagery caches by provider/version, tile and image variant. Cancel obsolete
  imagery requests, reject stale completions and preserve valid elevation work.
  Use separate imagery/elevation generations so changing both rapidly cannot make
  an unrelated completion stale or restore the wrong source.
- Fit old/new textures and pending decode/upload work within the shared budgets.
  Release replaced imagery or retain it only within the bounded cache. Do not run
  a second full map runtime or duplicate DEM downloads for a texture change.
- Centralize preference handling. Update `mapSource` using `history.replaceState`
  without navigation after accepting the choice, preserving unrelated URL fields
  and history state. Save it independently of elevation and quality; report pending
  or failed activation separately. Reloading later restores the saved choice.

The no-restart behavior also applies to Google ↔ flat-map selections. That is a
separate content-mode handoff, not a texture swap: keep the app/simulation alive,
prepare destination coverage within a bounded transition allowance, then change
the visible and queried surface together and apply safe support correction when
needed. Preparation geometry must not participate in surface queries before
activation. Failure retains the active mode. Dispose outgoing mode resources
after handoff; retain preferences without retaining two complete worlds. This
lifecycle step does not redesign Google's rendering or collision algorithms and
is checked separately from the first flat-to-flat implementation.

### Acceptance

With fixed camera and settled elevation, a flat-to-flat change causes no page
navigation, app/JSBSim reinitialization, terrain vertex writes, DEM re-fetch or
surface revision change attributable to the selection. Independently arriving
height refinements still use the normal safe path. The user checks switches in
flight and while paused; automated integration checks cover no-op selection,
slow/failed textures, rapid A → B → A changes, independent concurrent elevation
changes and preference restoration. Repeated switches must release obsolete
resources and callbacks. Google-mode round trips additionally verify a coherent
surface handoff and preserved flight state before that path is accepted.

## Independent elevation-provider selection

For flat basemaps, expose separate **Basemap**, **Elevation** and **Quality**
controls. For example, USGS Imagery Topo can use either Mapterhorn or another
registered elevation provider without changing the imagery. Changing the basemap
preserves the elevation choice; changing elevation preserves the basemap and
quality setting. Hardware adaptation changes detail within the selected source,
not the user's provider choice.

Mapterhorn remains the default. The second registered option is **Mapzen Terrain
Tiles (AWS)**: the [AWS dataset entry](https://registry.opendata.aws/terrain-tiles/)
documents public elevation tiles, and its
[format documentation](https://github.com/tilezen/joerd/blob/master/docs/formats.md)
includes Terrarium PNG. The runtime registers the public Terrarium endpoint with
its own level cap and attribution; it is not a promise of finer terrain. Browser
testing still needs to verify endpoint access, coverage and vertical-reference
compatibility at the user's routes. Do not copy Mapterhorn's limits into its
descriptor.

Foss-earth owns the provider registry, descriptors and live source-switching API;
the flight simulator supplies the selector UI. Hosts may register compatible
custom sources. An arbitrary URL/key entry form and support for additional
projections or encodings are outside the initial selector scope. A host-supplied
custom height callback must be identified as custom, with the selector disabled
unless the host explicitly supports replacing it; never silently ignore a choice.

Persist a stable elevation provider ID independently of the basemap and quality.
Allow an `elevationSource` URL setting for reproducible comparisons. Proposed
precedence is explicit host configuration, then URL, then saved preference, then
Mapterhorn. An unavailable/unknown saved ID falls back with a visible status.
In Google 3D Tiles mode, hide the elevation selector, suspend raster elevation
requests and remember the preference for the next flat-basemap session. Google
continues to use its own mesh.

### Live switching and surface safety

Switch without reloading the page or restarting the simulation. Retain camera,
heading, motion and pause state; only adjust aircraft position when the existing
safe surface-replacement rules require it. The current displayed surface remains
the physics surface while replacement data is prepared. Show the requested source
as pending until usable replacement coverage is committed; a failed switch keeps
the previous surface and reports the failure instead of claiming success.

Adopt replacements progressively through the same bounded preparation and seam
rules as ordinary refinement. Each adopted patch records its source ID/version
and delivered level. Adjacent old/new patches must meet without cracks, and
physics must sample their actual displayed triangles. Source and level are
separate: a selected provider's level 12 may replace another's level 15. The
existing higher-zoom-only refinement rule must not block deliberate source changes.
Every adopted replacement advances the surface revision across provider switches;
do not reset revisions in a way that hides a changed support height.

Adapters must document units and vertical reference and supply heights compatible
with the runtime convention before their grids can be combined at seams. Missing
or incompatible reference information is a validation gap, not permission to
assume matching heights. Any required datum-conversion work needs explicit scope.
The bundled coarse fallback may still be used, but keeps its actual provenance
and attribution; do not label it as data from the selected provider.

Key caches by source ID/version and tile coordinates; tag requests and completions
with the switch generation. Cancel obsolete work and reject late results after
another selection, while retaining reusable cached data within the cache budget.
Count old coverage, new data and pending replacements against one shared budget;
switching must not create two unrestricted terrain runtimes. Reuse compatible
imagery and mesh allocations where possible. Fetch only the selected provider's
needed replacement data, with no background provider comparison. Attribution and
diagnostics identify the sources still displayed during a transition.

## Configured sources and published capabilities

This inventory distinguishes current code limits from independently documented
capabilities. It does not claim that every level exists at every coordinate.
No source limits are changed as part of writing this appendix.

| Source | Current application request levels, inclusive | Provider evidence / constraint |
|---|---|---|
| USGS Imagery | 0–16 | 256×256 tiles; metadata lists levels 0–23 but service description/max scale corresponds to about level 16. Higher entries alone do not establish useful higher-resolution imagery. |
| USGS Imagery Topo | 0–16 | Same distinction between the 0–23 matrix list and the service's stated display scale; 256×256 tiles |
| USGS Topo | 0–16 | 256×256 tiles; 0–23 matrix list, max display scale corresponding to about level 16 |
| OpenStreetMap Standard | 0–19 | This is the current configured cap; broader provider capability was not independently verified in this review. Retain it pending adapter validation. |
| CARTO Positron / Dark Matter | 0–20 | Provider documents levels 0–20 and an optional double-resolution `@2x` variant; the current URLs use the standard variant |
| OpenTopoMap | 0–17 | Current configured cap. The provider repository says its raster service is deprecated in favor of vector tiles; future raster availability requires checking. |
| Mapterhorn elevation | 0–15, plus the bundled global fallback | 512×512 Terrarium WebP. Documentation describes a global archive at levels 0–12 and regional archives at 13–17. The application's 15 cap is therefore not the highest level described by the provider. |

USGS evidence: [Imagery](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer),
[Imagery Topo](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer),
[Topo](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer).
CARTO's [provider documentation](https://github.com/CartoDB/basemap-styles) defines
its range and retina variant. OpenTopoMap's
[repository](https://github.com/der-stefan/OpenTopoMap) describes the raster transition.
Current application values are in `src/engine/babylon/rasterBaseMaps.ts` and
`src/terrain/terrainTiles.ts`.

Mapterhorn's [data-access documentation](https://mapterhorn.com/data-access/)
describes tile dimensions, encoding and archive levels. Its
[coverage/source inventory](https://mapterhorn.com/) describes a global 30 m source,
US-wide 10 m data and partial US 1 m data, among other regional sources. These are
source resolutions, not guarantees that every displayed sample has that accuracy.
The exact live TileJSON maximum was not fetched successfully during this review;
the regional 13–17 range is documented, not an exhaustive endpoint-availability test.

Existing live fixtures establish successful level-15 downloads at LAX/MSP and a
successful level-12 Rainier tile. An earlier Rainier level-15 request returned
404. This is evidence for those coordinates at that time, not a blanket regional
maximum. See the [streamed-terrain notes](../streamed-terrain.md) and
[benchmark fixtures](../../benchmarks/terrain/README.md).

## What a level means in meters

For the supported Web Mercator XYZ grid, approximate horizontal ground spacing is:

```text
tileWidthMeters ≈ 40,075,016.69 × cos(latitude) / 2^z
sourceSampleSpacingMeters ≈ tileWidthMeters / tilePixelWidth
meshVertexSpacingMeters ≈ tileWidthMeters / subdivisionsPerEdge
```

These are local spacing estimates, not elevation accuracy or a universal formula
for every tile-matrix projection. At the equator:

| Level z | 256-pixel source spacing | 512-pixel source spacing | Mesh spacing with 64 subdivisions over that tile |
|---:|---:|---:|---:|
| 0 | 156,543 m | 78,272 m | 626,172 m |
| 8 | 611.50 m | 305.75 m | 2,445.98 m |
| 10 | 152.87 m | 76.44 m | 611.50 m |
| 12 | 38.22 m | 19.11 m | 152.87 m |
| 13 | 19.11 m | 9.55 m | 76.44 m |
| 14 | 9.55 m | 4.78 m | 38.22 m |
| 15 | 4.78 m | 2.39 m | 19.11 m |
| 16 | 2.39 m | 1.19 m | 9.55 m |
| 17 | 1.19 m | 0.60 m | 4.78 m |

Multiply by approximately 0.83 near LA or 0.71 near MSP. A 512-pixel level-15
height tile and a 256-pixel level-16 image have similar pixel/sample spacing, but
different geographic footprints. This does not mean their real source detail or
vertical accuracy is equal. A fine output grid may contain resampled coarser data.

Drawing more triangles or enlarging an image cannot recover missing source detail.
For example, a level-15 terrain tile over LA spans about 1 km. Even if its source
has 512 samples across, a 64-subdivision mesh spans that width in roughly 16 m
steps. Mesh approximation can be the limiting factor independently of the DEM.

## Provider descriptor required by the LOD policy

Keep a small descriptor per imagery/elevation source, with separate values for:

- Tile scheme/projection, matrix identifiers, row direction, origin and extent.
  The first implementation may support only the existing Web Mercator scheme;
  reject unsupported matrices explicitly instead of silently misplacing them.
- Actual tile pixel dimensions, available image variants and elevation encoding.
- Advertised/requestable level set and the application's approved request ceiling.
  Do not conflate either with a known native-detail ceiling.
- Geographic coverage, any level-specific availability metadata, and observed
  missing tiles. Source detail/accuracy by region stays unknown when not supplied.
- Known native-detail limits where documented, plus how parent images/heights may
  be enlarged or resampled beyond available detail.
- Source identity/version, attribution, units and elevation reference, metadata
  provenance/date, and request/caching/prefetch constraints relevant to scheduling.

Read TileJSON or ArcGIS metadata once when available, validate it and cache it.
Use reviewed static defaults if unavailable; metadata fetching must not block the
coarse fallback or repeat every frame. A metadata update must not silently raise
the application's approved request ceiling and multiply its workload.

Scheduling constraints are also provider-specific. For example, OSM Standard's
[tile policy](https://operations.osmfoundation.org/policies/tiles/) prohibits bulk
prefetch features while permitting normal viewport requests with modest browser
look-ahead. Disable the proposed predictive imagery corridor for that endpoint;
an allowed elevation source can still prepare aircraft support independently.

## Proposed supported mesh levels

For Stage C, evaluate a small set of regular grid sizes instead of arbitrary
per-frame retessellation:

| Subdivisions per edge | Vertices | Interior triangles | Proposed role |
|---:|---:|---:|---|
| 16 | 289 | 512 | Small patches needing little geometric detail |
| 32 | 1,089 | 2,048 | Moderate-detail patches |
| 64 | 4,225 | 8,192 | Detailed nearby patches |
| 128 | 16,641 | 32,768 | Optional exceptional detail, only if quality benefit and budget justify it |

These are candidate supported mesh levels, not a rule assigning a universal
distance to each. Their world spacing depends on patch footprint. Large coarse
patches must satisfy globe-curvature error, by sufficient tessellation or splitting.
Seam geometry, if additional, counts toward the triangle budget. Stage A retains
the existing grid construction; this table applies to the later LOD design.

For the default raster height source, the data progression is: bundled 64×64
global fallback, available parent tile, then finer available tiles up to the
approved cap. The bundled grid is not equivalent to a full 512×512 level-zero
download. Retain the current cap of 15 initially; considering regional levels
16–17 requires capability/availability validation and a measured quality benefit.
Do not load every ancestor or every intermediate level just to complete a ladder.

## Selection and fallback rules

For each visible/contact patch, the scheduler chooses from the provider's actual
level set using screen-space demand, native-detail knowledge where available,
local availability, hardware/work budgets and the selected quality ceiling. It
chooses imagery, elevation and mesh subdivisions independently, then enforces
compatible patch coverage and seams.

Record both requested and delivered levels. If elevation requested at 15 is
served by a level-12 parent, label it as level 12. If an image is enlarged beyond
its source level, keep the source level unchanged. A hardware upgrade may allow
more of the available detail to be shown; it cannot create a missing level.

When texture detail arrives first, apply it over the current surface without a
physics revision. When heights arrive first, refine the surface while keeping
available imagery. The consumer samples the committed mesh in both cases.

Cache missing-tile results with expiry and fall back to available parents. A 404
at one coordinate is not proof that a whole zoom level is absent. Timeouts, 429s
and server errors use backoff; they must not permanently change source capability.
Do not flood the network by probing every possible child to discover coverage.
Do not infer absence of detail from visually identical tiles: uniform ocean or
flat terrain can legitimately repeat values. Preserve valid fallback coverage.

Switching an imagery-only basemap retains the terrain source and adopted surface
as specified in the hot-swap contract above. Resource keys include the source
identity/version so equally numbered tiles from different providers cannot be
mixed accidentally. A downloaded
tile's bytes, a decoded grid's bytes, and its rendered mesh allocation are counted
separately; encoded file size is not its memory cost.

## Checks before accepting provider-aware LOD

1. A USGS texture cap of 16 and a height cap of 15 remain independent; equal zoom
   numbers are never assumed to mean equal pixel spacing.
2. A 256- versus 512-pixel source, or an allowed retina variant, produces the
   appropriate screen-space demand and memory estimate.
3. Missing regional heights retain the actual parent's level and valid support;
   unrelated regions can still load finer data.
4. Metadata failure uses the reviewed defaults; unsupported scheme/encoding is
   detected; higher advertised limits cannot bypass the application's caps.
5. Texture refinement alone does not change terrain geometry/revision. Elevation
   refinement does not wait unnecessarily for sharper imagery.
6. Stronger hardware stops at the useful/provider limits. A map-layer change
   cannot trigger an accidental increase in terrain density or source requests.
7. The user can compare two providers at the same view; diagnostics explain whether
   the limiting factor is source availability, requested budget or mesh density.

Provider-selection acceptance additionally covers:

- Both elevation choices work with the same flat basemap. Basemap, elevation and
  quality preferences remain independent across reload and a visit to Google mode.
- A pending or failed switch preserves visible/physical coverage and flight state.
  An upward surface replacement safely lifts the aircraft, including while paused;
  ordinary flight into an existing hill remains a collision.
- Rapid A → B → A switching cannot commit stale results. A coarser level from the
  newly selected provider can replace a finer old level with a new surface revision.
- Repeated switches remain within the shared loading/memory budgets. A settled
  selector adds no terrain work or network polling; incompatible adapters and
  unknown IDs produce understandable status rather than corrupt geometry.

The outstanding verification items are the live Mapterhorn metadata maximum,
USGS useful content above level 16, and current availability/capabilities of the
other configured raster endpoints, plus validation of the proposed Mapzen/AWS
adapter. These do not block Stage A, which preserves
the current source limits. They must not be silently promoted to guarantees in
Stage C.
