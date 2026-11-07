# The surface's counters without the maps' loading diagnostics — 7 November 2026

P-125 in the performance ledger. Engine `308616a`; baseline engine
`c54ae62`. Not an item of the performance limits audit. It came from a CPU
profile of the 0SFS flight app, with the map streaming under the aircraft.

## What it was

The globe runtime keeps two counters for the displayed surface:

- the revision, which moves on when the maps' geometry changes;
- the source generation, which moves on when the selected map or terrain
  source changes.

`readCurrentSurfaceState` moved them on when the maps had changed, and then
built the whole owner state. Building it read every map's loading
diagnostics:

- the raster runtime's `getLoadingDiagnostics`, a loop over every tile the
  view needs;
- `getMetrics`, a loop over every shown tile;
- the Google runtime's loading state;
- the error text, redacted with a regular expression.

Five callers used it. Only one, the displayed surface's observations, needed
the whole state. The other four wanted a counter, or nothing:

- `surface.revision()`, which every surface sample calls;
- the revision a raster hit carries;
- the source generation for terrain regions;
- `refreshCurrentSurface`, which threw the state away.

In fly, the surface is sampled every frame and every physics step (ground
contact), and refreshed whenever a map tile settles.

## What changed

`src/babylon/createGlobeRuntime.ts`:

- `advanceCurrentSurface` moves the counters on, exactly as the first half of
  `readCurrentSurfaceState` did, and returns the selected source.
- `readCurrentSurfaceState` calls it and then builds the state as before.
- The four other callers call only `advanceCurrentSurface`, then read their
  counter.

## Why it is exact

The part that is skipped only reads:

- `tiles.visibleTiles.size`;
- the raster runtime's `getMetrics` and `getLoadingDiagnostics` (plain loops,
  and the terrain loader's `getMetrics`);
- the Google runtime's `getLoadingState`, which reads its queues;
- `status`, through a string replacement.

None of them writes, schedules or throws on a live or disposed runtime. Every
side effect of the old read is in `advanceCurrentSurface`, in the same order:

- the revision bump;
- the source generation bump;
- cancelling the pending settlement read.

So each caller sees the same counters, at the same moments.

The observations still build the whole state, and they still read the
diagnostics each time.

## Proof

- **Differential harness** (`build/surface-state/diff.test.ts`, jsdom). A
  vite plugin serves `createGlobeRuntime.ts` at HEAD (`VARIANT=head`) or the
  working tree under the same module path, so both run against the same
  engine.
  - Four tours drive a local globe:
    - Google ground being added and settling;
    - a raster switch and a version change, imagery-only and geometry;
    - raster tile failures and retries;
    - provider error text that must be redacted.
  - After every step, the trace records:
    - `surface.revision()`;
    - three surface samples, each with its revision;
    - the terrain region leases;
    - every observation's callbacks and reads;
    - the status, and how many timers are pending (the settlement read is
      one).
  - HEAD and the change give identical traces (`trace-head.txt`,
    `trace-fixed.txt`). The A/A run gives the same trace again.
  - Diagnostics reads over the tours: the raster runtime's 7,115 before and
    4,427 after; the Google runtime's 468 before and 213 after. What is left
    is the observations' reads.
- **`tests/globeSurfaceStateReads.test.ts`**: a new test with a globe that
  counts the maps' diagnostics reads. It checks that:
  - `surface.revision()` and `surface.sample()` read no diagnostics;
  - with no observation, the revision still moves on after Google ground is
    added;
  - a terrain region's source generation still moves on after a raster
    switch and after a version change;
  - an imagery-only version keeps the revision;
  - an observation still reads them.
- **Mutants** (`build/surface-state/mutants.py`): 10 of 11 caught.
  - The test catches the ones that read the whole state again: HEAD, the
    query's revision and a hit's revision. It also catches a source
    generation that never moves.
  - The harness catches the rest:
    - a refresh, the state or the revision not moving the counters on;
    - the refresh or a region generation reading the whole state;
    - the pending settlement read not cancelled.
  - The survivor makes a terrain region's source generation skip
    `advanceCurrentSurface`. It is equivalent: the source changes only
    through `emitStatus`, which refreshes the surface, and so moves the
    counters on before any region can read them.
- The engine's suite passes (141 files, 1,523 tests). Fly's `npm run
  typecheck` passes.

## Measured

**Node** (`build/surface-state/bench.sh`). These are Node timings on a
small local globe, not frame rates. Nine rounds, with one process per
variant, interleaved. Medians, with the range in brackets:

| Call | Before | After |
| --- | ---: | ---: |
| `surface.revision()` | 7.13 µs [6.94–7.24] | 0.050 µs [0.048–0.053] |
| `surface.sample()`, a raster hit | 9.32 µs [9.10–9.43] | 2.07 µs [1.97–2.12] |
| `prepareFrame` and `afterFrame` | 22.4 µs [22.0–23.5] | 7.3 µs [6.7–7.8] |

**Chrome** on the M5, with fly at `2287de0`, which was built twice: once
with this engine file at HEAD and once with the change. Both builds carried
the uncommitted work in the checkouts. The runs were headless on Metal, from
the default start, with the map streaming under the aircraft. They were
interleaved before, after, after, before, under the perf lock, using
research's `profile.mjs`. Each run was 10 s, with the CPU profiler on. Times
are ms per second of the profile, inclusive:

| Run | `readCurrentSurfaceState` | of which `getLoadingDiagnostics` | `advanceCurrentSurface` | Frame rate | Main / script |
| --- | ---: | ---: | ---: | ---: | ---: |
| before 1 | 6.2 | 4.2 | – | 59.0 fps | 32 / 25 % |
| after 1 | 0.0 | 0.0 | 0.2 | 58.8 fps | 33 / 25 % |
| after 2 | 0.0 | 0.0 | 0.1 | 58.9 fps | 32 / 25 % |
| before 2 | 6.6 | 4.5 | – | 59.1 fps | 33 / 26 % |

Where the old reads came from, in the before runs:

| Caller | Before 1 | Before 2 |
| --- | ---: | ---: |
| Raster refresh, from the elevation-only load path | 2.6 | 2.6 |
| Raster refresh, from `beginLoad` | 1.8 | 2.0 |
| Raster refresh, from the raster runtime's `update` | 1.1 | 0.9 |
| The surface sample's revision | 0.3 | 0.4 |
| Other | 0.4 | 0.5 |

Each raster event the maps push (`currentSurfaceChanged`) built the whole
state, and then threw it away, because fly has no observation open while it
flies. Pushing the event now costs only the counters.

About 6 ms/s of main thread went away, but the main-thread share and the
frame rate stayed within the runs' noise. Fly holds 59 fps with room to
spare on the M5, so the gain is headroom, not frames. Nothing was measured
on a phone.

Harness, mutants and bench: `build/surface-state/`. Builds:
`0sfs/fly/build/surface-state/`. Profiles:
`research/build/benchmarks/startup-audit/profile-fly-ss-*/`.

## Left

- An open observation still builds the whole state on each refresh, and
  compares it with the last one as JSON. Fly opened none in these runs
  (`currentReadiness.ts`, 0.0 to 0.2 ms/s). A page that keeps an
  observation open while the map streams pays for it. A loading revision in
  each map would let the observation skip the build when nothing changed.
  That is a design change, and it is not done here.
- The Google tile renderer gives no event when its queues empty. The one
  coalesced settlement read after a loading change stays.
