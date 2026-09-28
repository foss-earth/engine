# Work prompt: how Google 3D tiles refine, and showing that they are loading

Execute this task when the user starts a fresh conversation with this file.
Work in `/Users/felg/gh/foss-earth`. Read the current `AGENTS.md`,
[docs/ui-layout.md](ui-layout.md), [docs/proposals/settings.md](proposals/settings.md) and
[docs/proposals/map-detail-control.md](proposals/map-detail-control.md) first.

The user's words, from watching Google's photorealistic tiles load over the UMN campus:

> it 'steps up' detail, meaning it has to download ALL LODs to get to the highest, this should
> be settable as such with a setting, but should probably not be the default, I think the
> default strategy should be something like 'download the exact ideal LOD for the current
> distance/detail/other factors combo, not download progressively higher res, stepping through
> all of them, but again maybe some prefer that, also i think it would be nice to have a
> setting to make loading tiles pulsate or have some kind of visual indicator that they are
> loading, and i would like to have some kind of loading bar somewhere, maybe instead of making
> the outline of the chip with the map provider we could turn the outline into a loading bar

There are three parts.

## 1. Load strategy

**Why it steps.** FOSS Earth uses `3d-tiles-renderer` 0.4.24 and never sets its
`optimizedLoadStrategy`. The renderer's default is documented in
`node_modules/3d-tiles-renderer/src/core/renderer/tiles/TilesRendererBase.js` as "loading all
parent and sibling tiles for guaranteed smooth transitions". That is the stepping the user sees.

**The alternative the library offers:**

- `optimizedLoadStrategy = true` is marked experimental. Based on Cesium Native's selection, it
  loads the tiles the view needs first.
- `loadSiblings` applies only with that strategy. `false` loads only visible tiles, at the cost
  of brief gaps during fast moves.

**The same comment's warning:** the optimized strategy is incompatible with plugins that split
tiles or generate children on the fly:

- the `ImageOverlayPlugin` with `enableTileSplitting`;
- the `QuantizedMeshPlugin`;
- `ImageFormatPlugin` subclasses such as XYZ and TMS.

Tile sets that share caches or queues must also use the same setting. FOSS Earth draws raster
maps and terrain through the same renderer, so first find which of its tile sets use those
plugins, and which share an LRU cache or queues with the Google tileset.
[src/engine/babylon/createTilesRuntime.ts](../src/engine/babylon/createTilesRuntime.ts) is the
place to start. The new strategy may have to apply to the Google tileset alone.

**The setting:**

- It is a named parameter in the settings catalogue. Its home is the section where Google's
  tile detail already lives (`src/settings/catalogue/map.ts`).
- Its values are "every level on the way" and "the level the view needs", plus `loadSiblings`
  where it applies.
- The user wants "the level the view needs" as the default.

**Measure before changing the default.** Compare the two strategies from the same views, near
and far:

- time until the view is final;
- bytes and tiles downloaded;
- any gaps or flashing.

The tile metrics on `runtime.getTileMetrics()` and the `benchmarks/` tooling are the starting
points. 0SFS has an orbit check that records tile loading; see its `validation/`.

If the measurements argue against the user's default, say so and let them choose.

## 2. Showing which tiles are loading

- **The setting:** optional, as the user put it, and with a default you ask them about. It makes
  a tile that is waiting for finer children show it, for example with a slow pulse.
- **What "loading" means here:** with the stepping strategy, a tile being refined stays on
  screen until its children are ready. Define it from the renderer's state rather than
  guessing.

## 3. A loading bar

- **Where:** the user suggests turning the outline of the map-source chip into the bar. That
  chip is in the HUD; see `createSceneHud` in `src/shell/scenesPanel.ts` and the map-source
  element it is given.
- **What it measures:** streaming has no fixed end, so decide what 100% honestly means, for
  example the share of tiles the current view wants that are loaded. Say that on the chip's
  tooltip.
- **Layout:** follow [docs/ui-layout.md](ui-layout.md).

## Checks and report

- **Checks:** after each edit, `npx tsc -b`, `npx vitest related --run <changed files>` and
  `npm run lint`. Then run `npm run ci` once at the end.
- **0SFS:** it uses these tiles. Run its `npx tsc -b` and, if the defaults changed, the
  relevant part of its orbit check.
- **Benchmarks** are part of this task, so they may run. Confirm that the real GPU is in use.
- **Commit:** commit to `main` and push. Report the measurements with the defaults you chose.
