# One raster update per flight frame, measured again — 7 November 2026

P-072 in the performance ledger (backlog C11, and prompt F1 of 0SFS's audit
of 5 November). Baseline engine `0c3438a`, after P-126. Nothing is
committed: with today's code, a flight frame with one raster update did the
same work as one with two, so the change was set aside.

## What it was

In a simulation host, such as 0SFS's flight, the raster map is updated twice
in each frame:

1. `prepareFrame` updates it (`pumpMaps`);
2. the flight's tick then gives the globe its view (`setSimViewState`), and
   `setExternalViewState` updates the map again.

The raster map does not read the view the flight gives. It reads the
scene's camera and the world's root. The flight moves those after the call
(`floatingOrigin.apply`, `applyChaseFrame`), so in steady flight the second
update sees the view the first saw. Each update gives imagery selection and
uploads a budget of their own (`cpuMsPerUpdate`), so the second update also
gives them a second share each frame.

On 22 October, removing the call raised the flight at 4× CPU from
26.5–28.1 to 36.4–37.2 frames a second
([flight frame](https://github.com/0SFS/fly/blob/main/docs/performance/2026-10-22/flight-frame.md)).
The fixed work of an update was paid twice then: publication, the
loaded-detail refresh, feedback, and a read of the canvas's size.

## What was tried

F1's first step: a setting, `map.loading.updateOnSimView`, on by default
(two updates, as before). Off, `setExternalViewState` updates the map only
while the simulation is not running, so a placement made then still loads
at once:

```ts
simViewState = { ...current, ...partial };
if (!simRunning || !settings.has(UPDATE_ON_SIM_VIEW_ID) || settings.get(UPDATE_ON_SIM_VIEW_ID) !== false) rasterTilesRuntime?.update();
```

Its test counted the map's updates in the globe's real frames, around a
map that only counts them:

- two in each running frame by default;
- one when off;
- one at once for a view given while the simulation is stopped;
- a change of the setting applied from the next view.

7 of 7 mutants of the condition were caught. The engine's typecheck, lint
and suite (1,527 tests) passed, and so did fly's typecheck.

## Measured

Chrome, fly in flight at a phone's viewport (412 × 915 at 2.625), by day
(`set.sky.time.utcHours=18`). One build served both arms. The setting was
given in the address (`set.map.loading.updateOnSimView=false`). Research's
`profile.mjs` took 10 s in flight, 15 s after content. The runs were
interleaved: on, off, off, on, then off, on at 4× CPU, then on, off at 6×.
Times are ms/s of main-thread CPU and include what each function calls.

| Run | CPU | fps | Frames over 25 ms, % | Main thread, % | Raster update | From `setSimViewState` | Imagery selection | Terrain selection | Loaded-detail refresh | `applyWorldViewport` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| On 1 | 4× | 55.2 | 2 | 80 | 189.6 | 86.3 | 52.4 | 55.9 | 31.0 | 38.0 |
| Off 1 | 4× | 55.7 | 1 | 78 | 182.8 | 0 | 51.9 | 56.1 | 29.2 | 37.9 |
| Off 2 | 4× | 50.1 | 11 | 96 | 214.6 | 0 | 60.8 | 61.8 | 36.6 | 48.0 |
| On 2 | 4× | 55.3 | 2 | 79 | 188.3 | 87.2 | 53.7 | 55.9 | 27.1 | 37.7 |
| Off 3 | 4× | 55.8 | 1 | 74 | 180.8 | 0 | 52.1 | 55.2 | 28.9 | 33.8 |
| On 3 | 4× | 55.2 | 1 | 74 | 179.5 | 88.4 | 50.2 | 53.5 | 27.1 | 34.7 |
| On | 6× | 41.1 | 29 | 98 | 257.9 | 119.9 | 74.3 | 76.2 | 42.1 | 43.1 |
| Off | 6× | 41.8 | 28 | 98 | 257.0 | 0 | 74.8 | 79.7 | 43.4 | 43.7 |

Imagery selection is the selector's `step`; terrain selection is the raster
map's `selectTiles`.

- With the setting off, the remaining update took on the second one's work.
  The raster map's updates took 179.5–189.6 ms/s with two updates and
  180.8–214.6 with one at 4×, and 257.9 against 257.0 at 6×.
- Imagery and terrain selection took the same time a second in both arms.
  So their budgets were not what limited them, and detail should not arrive
  later with one update. Arrival was not measured.
- The loaded-detail refresh, which follows tiles as they arrive, took the
  same time in both arms.
- The frame rate was the same, except in Off 2. That run's whole page was
  busier: style recalculations took 29.8 ms/s against 21.6–24.4 in the
  other runs at 4×, and `applyWorldViewport`, where they are paid, 48.0
  against 33.8–38.0.

Since 22 October, the engine has changed much of the work an update did. The
loaded-detail refresh runs at the selector's pace (P-074). The surface's
counters no longer build its whole state (P-125). Tile materials no longer
walk the scene (P-123). And since P-126, a moved terrain region no longer
makes the two updates select different tiles. Which of these took the gain away was not measured.

Not measured: a desktop at 1×, and a real phone.

## Left

- P-072 moves to "Rejected or no gain": at today's code, a second update
  a frame costs nothing measurable. Measure again if an update gains fixed
  work, or if selection becomes bound by its budget.
- F1's second step, one update with doubled budgets, was not tried. With
  the work the same, it has nothing to recover.
