# The loaded-detail readout at the selector's cadence — 7 November 2026

Item P-074 of the performance ledger, approved as a default in the
performance limits audit (app `docs/proposals/performance-limits.md`).

## What it was

After each imagery update, `refreshLoadedDetail`
(`src/babylon/imagery/createImageryRuntime.ts`) tells the detail rail how
much detail is loaded. It has two parts:

- **The view's regions.** These were already measured at most every
  `map.imagery.reselectWhileMoving` (100 ms) while the view moves, or at once
  when a new plan is shown.
- **The loaded detail itself.** `measureLoadedImagery` over every shown
  patch's binding, then `syncDistribution`, which measures the loaded pages
  in the view again (`measureImageryView`) whenever the pages or the view
  changed. This ran on every publication, so while tiles arrive during a
  drag, it ran most frames.

## The change

A publication alone, within 100 ms of the last readout, now waits. The
runtime asks for a frame when the interval is up, and that frame measures
the last publication. So:

- A new plan, or a region measure the selector's cadence makes due, is
  measured on that frame, as before.
- While tiles arrive, the rail can trail the map by up to one interval.
- Once they stop, the rail shows what it showed before.

The setting `map.imagery.loadedDetailEveryPublish` (Map → Loading, default
off) restores a measure on every publication. A host that does not register
the setting gets the cadence.

The readout feeds only the rail: `connectMapDetailRuntime` copies it into the
map detail controller's delivery, and the policy treats it as "never a
request". Nothing the runtime chooses, loads or draws reads it.

## Tests

`tests/loadedDetailCadence.test.ts`:

- **Differential.** Two runtimes share a clock and a loader whose downloads
  finish only when the test says: one with the setting on (the old
  readout), one with the cadence. Three motions while tiles arrive two a
  frame for 120 frames of 16 ms: a drag that moves every frame, a step every
  10 frames, and a still view. Every frame, both choose, keep, upload and
  publish the same: the plan, its regions and delivered levels, residency,
  the atlas, bindings, counters and every URL asked for are equal. On every
  frame a new plan is selected, both readouts are equal. Once the downloads
  finish and two intervals pass, the whole feedback is equal.
- **Count.** While tiles streamed, the old readout measured on 111 of 120
  frames under the drag, 106 under the steps and 71 under the still view.
  The cadence measured 17, 17 and 11 times: at most once per interval, plus
  one. The test holds the cadence to that bound and the old readout to more
  than three times it. A frame at rest measures nothing in either.
  `CADENCE_REPORT=1` prints the counts.
- **Wake.** With no frame from the view, the runtime asks for one when the
  interval is up, and that frame measures the publication it held back.
- **Setting.** Off by default, on through the registry, and listed with the
  imagery tuning that a running runtime takes live.

Eleven one-line mutants, all caught: no cadence; a cadence that ignores the
setting; one that also holds back region measures; one that never ends; held
back without a wake; the wake an interval late; a wake only after a move; the
readout's time not kept; the setting on by default; the setting read
inverted; and the setting left out of the live tuning.

## In the browser

The method:

- Research's `profile.mjs`, app target, phone viewport, finger drag, 4× CPU
  slowdown, 8 s stretches, headless Chrome 156 on an Apple M5. Each run is
  the audit's visit: a cold visit under Fast 4G, then a warm one through the
  service worker it installed, measured once its content is up.
- One build (`vite build --sourcemap`) for both arms. Old is the same build
  with `set.map.imagery.loadedDetailEveryPublish=1`.
- Two interleaved sets of three pairs: new, old, old, new, new, old, then
  old, new, new, old, old, new. The frame profiler
  (`set.renderer.profiling.enabled=1`) ran in every run. In the second set,
  a probe reset it before each stretch and read it after.
- Pairs come from research's `ab-summary.mjs` over each run's saved CPU
  profile.

CPU profile, ms of main thread per second, inclusive. Every row was lower
with the cadence in all six pairs, and the ranges did not overlap:

| | Old | Cadence | Old − cadence by pair |
| --- | ---: | ---: | --- |
| `refreshLoadedDetail` | 55.8–66.5, median 59.7 | 48.3–54.8, median 49.5 | 17.3, 7.5, 5.2, 9.8, 8.9, 14.4 |
| `syncDistribution` | 19.0–21.0 | 9.7–11.6 | 9.8, 8.5, 8.6, 9.4, 8.0, 11.1 |

So the readout costs about 9 ms/s less (−17%), and half of
`syncDistribution` goes.

The audit estimated that about 45 of the readout's 53.6 ms/s would go, and
most of that did not. In the first run with the cadence, 34.2 of the
readout's 49.8 ms/s was `measureImageryView` over the plan's leaves: the
view's region measure.
That already ran at most every 100 ms while the view moved, so this change
leaves it alone. Sharing the selector's measurements, or the GPU feedback of
audit L4, is what would remove it.

The frame profiler, second set, the "map/raster tiles" section in ms a
frame over the stretch (about 450 frames):

| By pair | Old | Cadence |
| --- | ---: | ---: |
| Mean | 3.96, 4.20, 4.43 | 3.84, 3.85, 3.95 |
| 95th percentile | 10.78, 12.41, 12.35 | 9.52, 10.04, 11.48 |

The cadence was lower in each pair, by 0.12, 0.35 and 0.48 ms. The frame
rate did not move (56.2–56.9 frames/s in both arms), because the phone drag
at 4× already draws at the display's rate.

The imagery runtime's whole update was also lower in all six pairs, by
2.9–28.5 ms/s, but the ranges overlap (148.5–166.1 against 158.1–182.5).
The whole raster update, the main thread and total busy time were mixed.

The scripts and raw results are in the app's `build/p074/`
(`runs.sh`, `runs-probe.sh`, `frame-profile.mjs`, `ab.txt`,
`ab-probe.txt`), which is not committed, and in research's
`build/benchmarks/startup-audit/profile-app-phone-p074-*`.
