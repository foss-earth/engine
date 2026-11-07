# Drawing only what changed while maps load — 7 November 2026

Item P-112 of the performance ledger, audit L19 in the performance limits
audit (app `docs/proposals/performance-limits.md`).

## What it was

When a map starts loading, `beginStreaming` (`src/babylon/createGlobeRuntime.ts`)
held continuous rendering until loading ended. Google's startup held it too,
until its first tiles showed. The maps update in each frame's preparation,
so while anything loaded, a still camera drew every display frame, whether
or not anything new was shown.

## The change

Where the host runs the globe's work pass and the setting is on, a load
holds work passes instead of frames:

- **Updates in work passes.** The renderer's scheduler runs `work` on every
  frame it runs, before any drawing. The app's frame closure calls the
  globe's new `prepareWork` from it. While a load holds work, each host
  frame's work pass updates both maps (Google's `tiles.update()` and the
  raster update with its imagery), once per host frame, at the same
  timestamp a drawn frame would use. A frame-rate cap paces these updates
  as it paced frames.
- **A frame only when the picture changes.** After the update, the pass
  compares what is drawn with what the last drawn frame showed, and asks
  for a frame only if it differs. What is drawn is: the map runtime in use,
  whether the fallback globe shows, the surface revision, the raster map's
  draw revision and Google's revision. The raster map's draw revision counts
  tiles shown or hidden, shown tiles disposed, and changes to the tiles or
  imagery (its revision, imagery publications and uploads) while any tile is
  shown.
- **Frames still drawn as before.** A frame the scheduler draws anyway (a
  move, a glide, a render request) updates the maps in its preparation,
  after the camera has moved; that host frame's work pass leaves them to it.
  A load's end still asks for a frame, so a host that watches frames sees it
  end (the app's `boot:content` mark).
- **Loading with no input.** The hold keeps work passes coming every frame
  until the load ends, so loading progresses with nothing drawn and nothing
  moved.

The renderer side (renderer `adf340f`):

- `work(time, { presenting })` tells the work whether the same frame also
  presents, and a render request made inside work is drawn in that frame.
- `isPresenting` and `onPresentingChange` say whether a presentation is
  asked for, apart from work passes. The renderer lifecycle settles when
  presentations stop.

The setting `map.loading.drawOnlyChanges` (Map → Loading, default on) turns
it off: loads hold frames and draw every one, as before. It applies live; a
load under way takes the new hold before it gives up the old one. A host
that does not register the setting, or does not run work passes
(`workPasses`, and a scheduler with `requestWork`), keeps drawing every
frame. A terrain performance capture also keeps it, since it measures drawn
frames. In immersive mode, frames are drawn continuously anyway, and the
maps update in them.

## Tests

`tests/mapLoadingWorkPasses.test.ts`, a differential harness at the globe
runtime's level:

- One 2D map load runs twice on the same host frames, the same clock and the
  same loader answers: once drawing every frame (the setting off), once in
  work passes. Both use the renderer's real scheduler. Elevation and imagery
  arrive 2–13 host frames after each request (a fixed hash of the request),
  so the load takes many frames.
- **Picture.** After every host frame, a hash of what the screen shows: the
  camera's view and projection; each enabled, visible mesh's name, world
  matrix, vertex data and indices; its material and texture with every byte
  written to that texture; and the imagery atlas, its page table and the
  patch bindings, with their bytes. It must be equal on every host frame.
- **Requests.** Every elevation and imagery request, by host frame, must be
  equal.
- Scenarios, 240 host frames each:

  | Scenario | Frames drawn, old → new | Picture changes |
  | --- | ---: | ---: |
  | Still load | 51 → 34 | 34 |
  | The view set twice at frames 40–41 | 64 → 41 | |
  | A glide (orbit and zoom) at frames 20 and 60 | 102 → 89 | |
  | Another elevation source at frame 120 | 71 → 48 | |

  The still load asked for 190 tiles and images both ways, and made 51 map
  updates both ways. A frame-rate cap of 30 makes no more updates than the
  frames it allowed. With the setting off, the frames drawn are the same.
- **Bounds.** Never more than one map update per host frame. In the still
  load, frames drawn are at most the picture's changes plus one.

Mutants, each a one-line change:

- Caught: the draw state a constant; imagery publications and uploads not
  counted; changes counted while no tile shows; a drawn frame updating the
  maps again after its work pass; the hold not asking for the next work
  pass; no pacing to the cap; the work pass updating the maps in a frame
  that presents (caught by the glide). Two combined mutants, the surface
  revision with the raster revision, and those with tile flips, are caught
  by the elevation switch.
- Survived, as signals another covers here: tile flips alone (the raster
  revision moves with them), the surface revision alone (the raster
  revision moves with it), and the map runtime and fallback globe signals
  (no map switch happens in a load; the first tiles shown change the
  picture at the same time).

The differential covers the 2D map only. Google's revision is the one surface
queries already use: it moves when a tile's visibility changes or a model
is disposed.

## In the browser

This is the audit's M-6: frames drawn during a cold load with a still
camera, against frames in which something became visible.

The method:

- Research's `profile.mjs`, app target, 1280 × 800 at DPR 1, headless
  Chrome 156 with WebGPU on Metal, on an Apple M5. A cold visit on a new
  profile under Fast 4G and a 4× CPU slowdown, the default 2D map, no
  input. The visit ends at `boot:settled`, the first whole quiet second
  after loading. A 5 s still stretch at 4× follows.
- One build (`vite build --sourcemap`) for both arms. Old is the same build
  with `set.map.loading.drawOnlyChanges=0`. Six runs, interleaved: old, new,
  new, old, old, new.
- The frame profiler (`set.renderer.profiling.enabled=1`, a window of 36,000
  frames, so it keeps the whole load) was read by a probe when the stretch
  began, about 60 s after navigation, and again at its end. It counts drawn
  frames. Work done between drawn frames is added to the next drawn frame,
  so these are totals over the load.

From navigation to about 2 s after `boot:settled`:

| | Old | New |
| --- | ---: | ---: |
| Frames drawn | 3,385–3,398 | 864–874 |
| Frames a second | 56.5 | 14.4–14.6 |
| `boot:content`, ms | 57,528–57,813 | 57,718–57,748 |
| `boot:settled`, ms | 57,698–57,905 | 57,822–57,840 |
| Map updates, ms | 9,559–9,597 | 8,649–9,227 |
| Render, ms | 8,680–9,505 | 2,857–2,997 |
| GPU, ms | 8,078–8,799 | 2,053–2,294 |
| Sky and panoramas, ms | 700–801 | 238–253 |
| All measured sections, ms | 19,055–19,965 | 11,857–12,538 |

Times are at the 4× slowdown and do not overlap between arms, except the
marks.

- **Frames against changes.** With the setting on, a still load draws only
  when what is drawn changed, plus the first frame and one at each load's
  end. So at most 864–874 of the old 3,385–3,398 frames showed anything
  new, and at least 74% repeated the frame before.
- **Loading did not slow.** The map showed (`boot:content`) and the page
  settled at the same time in both arms, and both ended with the same 181
  tiles shown. The load here is paced by the network, not by frames.
- **CPU.** About 7.2 s less over the load at 4×, about 120 ms of main
  thread a second. Nearly all of it is drawing: Babylon's render, the sky
  and the 360 presentations. The maps' own updates took 3–10% less, which
  these runs do not explain.
- **GPU.** Three quarters less GPU time over the load.
- **After the load.** Neither arm drew a frame in the still stretch, and
  the main thread was 9.4–11.8% busy in both.

Not measured: a keyed Google load in the browser (the Google path has no
key on this build), a phone, and a GPU that is slower than its display.

The scripts and raw results are in the app's `build/p112/` (`runs.sh`,
`m6.mjs`, the run logs), which is not committed, and in research's
`build/benchmarks/startup-audit/profile-app-p112-*`.
