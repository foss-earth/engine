# Skipping Google 3D tiles below the horizon, behind a setting — 8 November 2026

From the Google tiles brief of the 8 November performance run. Ledger: P-146.
Baseline: engine `6fd4756^`.

Commits:

- engine `6fd4756` (already pushed and deployed, in the user's 23:52 deploy
  together with the move to tsrs): the setting and the code, with no test or
  note at the time.
- engine `0e36862`: the tests.

**Status:**

- A setting, **Map → Terrain selection → Skip Google tiles below the
  horizon** (`map.terrain.horizonCull`, listed when all settings are shown),
  default off. Off, nothing changes;
  the tests below prove it.
- On, it is exact in what the view shows in every Chrome comparison below,
  and it draws 39 fewer tiles in a low view of the horizon.
- The default stays off, as the user asked. The evidence would support
  turning it on after the timing phase and a check on the phone.

## Why

The renderer picks Google tiles by the view's frustum. The frustum goes on
through the Earth, so in a view that shows the horizon, tiles on the far side
of the globe are in it. The renderer loads and draws them, and the ground in
front hides them in the depth test.

## What changed

`src/babylon/createTilesRuntime.ts`:

- At each update, if the setting is on and the view is a perspective one
  (`m[15]` of the projection is not 1), the eye is moved into the tiles' frame
  (the inverse of the tiles group's world matrix).
- In `calculateTileViewError`, after the renderer's own measure, a tile whose
  bounding sphere lies wholly below the eye's horizon is marked not in view.
  The horizon is that of a sphere 1 km inside the ellipsoid's polar radius
  (`isSphereBelowHorizon` in `src/terrain/imagery/imageryGeometry.ts`, the
  same test the focus region already uses). The ground is above that sphere
  everywhere, so where it is drawn it hides such a tile.
- Only `inView` changes. The tile's error and distance stay the renderer's.
- The anchor, focus region, proximity and aircraft region code runs after it,
  as before, and can still bring a tile back.

## Exactness

**Unit tests** (`tests/createTilesRuntime.test.ts`, "Google horizon culling",
in `0e36862`), on six tile spheres (below the eye, 300 km away, a quarter of
the way round, on the far side, a huge one on the far side, and one outside
the frustum):

- Off by default; off, every tile's measure is the renderer's.
- On, the quarter-way and far-side tiles leave the view, and nothing else
  about any tile's measure changes.
- The test is from the eye in the tiles' frame, not the scene's.
- From 20,000 km up, a tile 60° away is in sight; from 1 km up it is not.
- An orthographic view culls nothing.
- The setting applies live, at the next update.
- With the orbit view's proximity and line of sight on, the far side still
  stays out.
- A focus region (mode "both") and an aircraft's region still load tiles the
  eye cannot see.

The geometry itself has its own tests in
`tests/terrain/imagery/imageryGeometry.test.ts`.

**Mutants** (`build/horizon-mutants.py`, each applied, the tests run, the file
restored):

| Mutant | Caught |
| --- | --- |
| The eye not moved into the tiles' frame | yes |
| The tiles' matrix not inverted | yes |
| No orthographic check | yes |
| The setting ignored (always on) | yes |
| The flag not reset at each update | yes |
| The tile's radius dropped | yes |
| The error cleared as well as `inView` | yes |
| The cull left out (as if run after the focus and regions) | yes |
| The test inverted | yes |

9 of 9 caught.

## In Chrome

Headless Chrome on the M5, the app's dev server at engine `0e36862`, Google
3D tiles, 1280 × 720, under the perf lock. Scripts in `build/horizon-cull/`
(not committed). Each arm is a new Chrome profile with the setting set before
the page loads, then three views in turn, 15 s each:

| View | Tiles drawn, off | Tiles drawn, on | Tiles loaded, off | Tiles loaded, on |
| --- | ---: | ---: | ---: | ---: |
| Orbit, 20,000 km over the Gulf of Mexico | 24 | 20 | 24 | 24 |
| Minneapolis, 60 km up, pitched 80° (horizon in view) | 66 | 27 | 134 | 105 |
| San Francisco approach, 9 km up, pitched 80° | 64 | 29 | 139 | 106 |

The same counts came from both runs of each arm (off, on, on, off).

**Pixels** (`diff2.mjs`: pixels that differ, the view above the toolbar apart
from the toolbar's rows):

| View | Off against off (A/A) | On against on (A/A) | Off against on (4 pairs) |
| --- | --- | --- | --- |
| Orbit | view 0 | view 0 | view 0 |
| Minneapolis | view 1 (by 1 of 255) | view 2 (by at most 4) | view 0 to 3 (by at most 4), the same pixels as the A/A pairs |
| San Francisco | view 27 (by at most 16, one thin line) | view 0 | view 0, or the same 27 pixels when the pair has the second off run |

- In every view, off and on draw the same picture, up to the noise that two
  runs of the same arm also show.
- The toolbar's rows differ by up to 97 pixels between off and on, and by up
  to 41 between two runs of the same arm. A crop shows what changes: the
  frames-per-second readout and the network meter with its graph. The
  credit line reads the same.

**Live toggle** (`toggle.mjs`, one page, the setting switched in the page):
at Minneapolis the drawn tiles went 23, 62, 23, 62 (on, off, on, off), and
27, 66, 27, 66 after coming from the orbit view first. The view's pixels were
the same; only the toolbar's rows differed.

**After a jump** (`trace.mjs`, from the orbit view to Minneapolis, the counts
each second for 20 s, three new profiles each way): on, the view settles at
27 drawn and 105 loaded within 1 to 2 s every time; off, at 66 and 134 within
2 s.

**One run not reproduced.** In the first probe (fixed waits shorter, a settle
rule of counts that hold still for 4 s), the Minneapolis view with culling on
was captured with 4 tiles drawn and 24 loaded, which are the orbit view's
tiles, and its picture was blurry. Five later jumps from orbit to Minneapolis
with culling on (two in the 15 s probe, three in the trace) all settled at
27 and 105. The likeliest cause is that the probe's settle rule stopped
before the new view's tiles began to load. It is not proven.

## Other effects of turning it on

- **The detail rail.** The loaded detail figure is the worst screen error
  among the tiles in view (`observeLoadedError`). The far side's coarse tiles
  no longer count, so the figure is finer: 17.4 → 13.4 px at Minneapolis,
  19.6 → 14.1 px at San Francisco, 12.4 both ways from orbit. The rail's tile
  distribution leaves them out too. It then describes what can be seen. It
  does not feed the detail target; nothing the runtime loads reads it.
- **Downloads and memory.** About a fifth fewer tiles are loaded in the two
  low views (134 → 105, 139 → 106).
- The setting's description says the credits list only tiles in sight. That
  was not checked here.

## Left

- The timing phase (below): frame time and tile requests, off against on.
- The phone, at Minneapolis and on an approach.
- The decision whether to make it the default. It moves no pixel in these
  views, so it is the user's call after the timing.

## Measurement plan

Under the perf lock, the app's dev server, interleaved off, on, on, off, a
new profile each arm (cold cache), 15 s to load, then a steady turn of 0.5°
a frame for 10 s at full speed and at 4× slower CPU. Each stretch reports
the frame intervals (median, 95th percentile, worst), the tiles drawn, the
tiles loaded and the tile requests during the turn.

```sh
node ~/gh/0sfs/fly/build/perf-lock-wait.mjs acquire --agent <name> --task "horizon culling P-146 timing"
cd ~/gh/foss-earth/app && npm run llm-dev -- --port 7492 --strictPort &
cd ~/gh/foss-earth/engine/build/horizon-cull
node timing.mjs 7492 off,on,on,off 10 1,4 high-horizon
node timing.mjs 7492 off,on,on,off 10 1,4 ksfo-approach
kill $(lsof -nP -t -iTCP:7492 -sTCP:LISTEN)
cd ~/gh/foss-earth/research && node scripts/benchmarks/startup-audit/perf-lock.mjs release --agent <name>
~/gh/foss-earth/browser-testing/scripts/chrome-clones.sh --clean
```

About 2 minutes a view. The off-against-off and on-against-on pairs are the
A/A control. Headless Chrome paces frames at 60 Hz, so the median may not
move. A smoke test of 2 s showed every interval at 16.7 ms at both rates,
which is not a result. The 95th percentile, the worst frame and the requests
say more. The phone's numbers matter more than the laptop's.
