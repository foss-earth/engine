# Remember elevation that does not exist — 6 November 2026

Item L21 of the performance limits audit (app
`docs/proposals/performance-limits.md`), P-108 in the performance ledger.

`createTerrainTileLoader` (`src/terrain/terrainLoader.ts`) keeps the tiles
the source answered 404 for, as quadtree indices in a `Set<number>`. Before a
tile is asked for, the loader walks up from it to zoom 1. If it finds a tile
known to be missing, it gives the tile the nearest existing ancestor's grid,
through the same fallback a 404 takes, and sends no request. It checks twice:
when the tile is first asked for, and again when a queued tile gets its
download slot, because an ancestor may have answered 404 while it waited. Only
404 counts; any other failure is not remembered. The walk does not run until
the first 404, so inside coverage nothing changes.

## Why it is exact

Before, a tile under a missing one asked the network, got 404, and fell back to
its parent, and so on up until a tile answered. Now it skips those requests and
goes straight to the parent of the deepest tile known to be missing. Both reach
the same ancestor, if no tile exists under a missing one. Mapterhorn builds
each zoom from the one below, so a parent exists wherever a child does. That
held in every check:

- 507 Mapterhorn responses of a cold visit to the app (startup audit, 6
  November): no tile answered 200 under one that answered 404.
- At 0°, 20°E, the audit's uncovered spot: 13/4551/4096 answers 404 and its
  parent 200. Its four children and sixteen grandchildren all answer 404.
- The open-ocean tile 4/6/5 answers 404, and so do its four children.

## Tests

`tests/terrainTiles.test.ts`, "elevation that does not exist", five tests: no
request under a tile that answered 404, beside it, or at another zoom with the
same row × width + column; a queued tile that an ancestor's 404 overtook; a
missing tile its cache let go; a walk through several missing ancestors, down
to zoom 1; a 500 asked again; and `whenLoaded` and `loadPatch` for a tile under
a missing one.

Nine one-line mutants: eight fail at least one test. They are: not recording a
404; starting the walk at the parent; redirecting to the missing tile rather
than its parent; stopping the walk above zoom 1; an index without the zoom
offset; the row taken from the column; a walk that never runs; and no check
when a queued tile starts. The ninth returns the asked tile, not the missing
ancestor. It is equivalent: the fallback then walks up one level at a time, to
the same grid with the same requests, through a few more cache entries.

## Differential harness

The loader before (engine `0aea1b8`) and after ran the same seeded workloads.
There were 200 seeds of 12 batches, each of 1–16 concurrent `load`, `loadPatch`
and `holdPatch` + `whenLoaded` calls, under one zoom-6 tile. Each seed had 0–11
missing subtrees at zooms 4–15, 0–2 tiles that answer 500, 1–8 download slots,
0–2 decode slots and 2–65 cache entries. Fetches finished after 0–4 timer
ticks, fixed per URL.

| | Before | After |
| --- | ---: | ---: |
| Outcomes (20,193 calls, no claims) | digest `a8ab472f6eed400b` | the same, each call equal |
| Requests | 76,284 | 37,602 (−51%) |
| 404s | 34,974 | 1,840 (−95%) |

A second pass gave 60% of the calls claims and released 30% of those at random
moments. Every call that ended with a grid in both runs had the same grid
(2,051). The rest differ only in timing: a released tile is withdrawn or not,
and a call finished or not when the batch was read.

## Browser count

Built into the app (`vite build`), against the same app with the engine at
`0aea1b8`, three interleaved pairs. Each was a new profile in headless Chrome,
unthrottled, with `?bench=1`. The camera was placed 2 km above 0°, 20°E,
looking 35° down. Tiles were counted until they stopped streaming for 3 s. Then
the camera moved about 5 km north-east, and tiles were counted again.

| | Before | After |
| --- | ---: | ---: |
| First view: Mapterhorn requests | 398 (377–432) | 387 (363–388) |
| First view: 404s | 46 (45–46) | 30 (30–35) |
| After moving: requests | 15 (15–15) | 0 (0–1) |
| After moving: 404s | 15 (15–15) | 0 (0–0) |

Medians, ranges in brackets. The first view's remaining 404s are the first
wave: fine tiles sent together before any 404 has come back. The gain is in
every request after that. Not a frame-rate claim; the frame profiler does not
apply, as no frame's work changes.
