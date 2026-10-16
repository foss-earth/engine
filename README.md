# @foss-earth/engine

Globe engine for FOSS Earth: geographic coordinates, camera and input, navigation, terrain and maps, layers, points of interest, sprites, the orbit compass, and the Map, Location and Controls panels.

The host supplies the renderer, scene, scheduler, settings, clock and feature contributions. `createGlobeRuntime` borrows the renderer, lifecycle, scheduler, profiler and sky from the host and needs an explicit host terrain policy. See [globe runtime](docs/globe-runtime.md).

## Entries

Root, `/core` and `/imagery` are pure. Everything else is an explicit optional entry.

| Export | Contents |
| --- | --- |
| `@foss-earth/engine` and `/core` | Pure geographic and camera math, layer contracts, navigation. |
| `/browser`, `/browser-globe` | Browser bindings, including the full globe mouse, wheel and touch input (Safari included). |
| `/babylon` | Babylon integration (optional peer `@babylonjs/core`). |
| `/settings` | Engine settings and migrations. |
| `/gamepad` | Gamepad host adapter (optional peer `@felipegalind0/gamepad-tools`). |
| `/imagery` | Legacy and atlas imagery selection, residency and material binding. |
| `/panels` | Map, Location and Controls panels, built through the UI package's factories. |
| `/react` | React components, including the map cache panel (optional peer `react`). |
| `/layers`, `/sprites`, `/compass` | Layer, sprite and orbit compass host adapters. Need host ports. |
| `/visualization` | Pure source defaults, point math, migrations and horizon culling. |
| `/visualization-tuners` | Visualization tuner HUD. |
| `/location-provider` | Location provider and cache. |
| `/prepare-heights` | Node only, at build time, also as the `foss-earth-prepare-heights` command. Fixed heights above the WGS84 ellipsoid: the top of Google Photorealistic 3D Tiles' finest geometry on the vertical, or USGS 3DEP with GEOID18 where Google can't serve a point, with the reason recorded. Reads `FOSS_EARTH_GOOGLE_KEY`, sends it as a header and keeps no Google responses. |
| `/input-mode.css`, `/map.css`, `/map-cache.css`, `/location.css`, `/visualization-tuners.css` | Engine-owned styles. Generic cache-section styles belong to [`@foss-earth/ui`](https://github.com/foss-earth/ui). |

Other optional peers: `@foss-earth/renderer`, `@foss-earth/ui`, `@foss-earth/sky` and `3d-tiles-renderer`. Terrain and imagery code uses [`@foss-earth/images`](https://github.com/foss-earth/images). Terrain covers sources, grids, download, selection, refinement and displayed-height queries, plus Google and raster streaming runtimes.

A displayed geometry coordinate height does not establish a physical terrain datum conversion.

## Documents

- [Public contracts](docs/public-contracts.md) and [host adoption and compatibility](docs/adoption.md).
- [Visualization and bounded-map contracts](docs/visualization-contracts.md).
- [Location provider and cache](docs/location-provider.md). It keeps the original persisted records, aliases and Interface search settings, with injected IO, cancellation, clock, timers, storage and settings, and airport and host contributions. The Map and Controls panels pass their `Document` to the UI factory contract.
- [Map cache panel](docs/map-cache-presentation.md). The React panel borrows the engine's map cache and the host's pulse, visibility and clock, shares the named 40-row, two-second policy with the DOM section, and reports actual storage limits.
- [Map detail distribution slider proposal](docs/proposals/map-detail-distribution-slider.md). Replace the loaded-detail I-beam with mirrored tile-count bars and a hollow target handle inside the existing widget dimensions.
- [Frame preparation, async raster handles and owned cleanup](docs/async-raster-and-cleanup.md).
- [Bounded atlas page producer](docs/bounded-atlas-producer.md). It uses the public images acquisition and readback broker and returns explicitly held pages. Managed pages need the optional owned atlas runtime below; legacy void stores are refused before allocation.
- [Managed atlas runtime](docs/owned-atlas-runtime.md). It uses the renderer's whole-batch admission, completion and retirement with explicit GPU, table and copy grants from the same broker. Transactional tables reserve two physical blocks per logical patch inside the GPU budget.
- [Retained engine specifications](docs/retained-specifications.md): nine specifications kept with their proposal limits.
- [Build-time height preparation](docs/height-preparation.md): Google-first fixed heights, the USGS fallback, what a height means and the first real run.
- [Google tiles across a reload](docs/google-tile-reload.md): which requests use the browser cache, why the root is revalidated and a session renewal skips the cache.
- [Performance notes](docs/performance-notes.md): where the tour's first view spends its time, what was measured and how, and the rules a speedup must keep.

## Assets

`assets/` contains the geoid grids (`geoid/`, EGM2008 at 15, 30 and 60 arc-minutes, with `provenance.json`), gesture icons (`icons/`) and map provider logos (`providers/`: CARTO and OpenStreetMap). Map data, terrain data, imagery services and logos have their own licenses and terms; see `NOTICE` and `assets/geoid/provenance.json`.

## Development

`@foss-earth/engine` depends on other `@foss-earth/*` libraries (images, renderer, ui and sky) and names them by versions that are not published. Its own `npm install`, tests and build therefore do not work on their own yet. Develop it through the app, which uses libraries straight from their checkouts: see [local source](https://github.com/foss-earth/app#local-source).

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
