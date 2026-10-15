# Performance notes: where the first view's time goes

Measured in October 2026 on the UMN tour's Minneapolis first view, on the
`perf/terrain-decode-workers` branch. Use these notes to decide what to measure
next. Before relying on a number, check it against the current code.

## How it was measured

- A local harness replays every tile from a byte-for-byte cache and adds a fixed
  delay to each request, usually 80 ms. It doesn't model bandwidth: a request
  costs the same whatever its size. It records, every 100 ms, the terrain tiles
  shown by level, imagery levels, each request's start and end, and when the
  renderer sleeps.
- Desktop: an M5 Mac, 1280×720, DPR 1, the app's default backend.
- Phone proxy: 412×915, DPR 2.625, mobile, 4× CPU throttle, WebGL2 on
  SwiftShader. Use it for ordering, scheduling and main-thread work. Its GPU
  costs aren't a real phone's (see below).
- Each comparison uses interleaved runs, 3 to 6 per arm, and reports medians. A
  speedup counts only if the arms' ranges separate or most runs of one arm beat
  every run of the other. Other agents' benchmarks on the same machine add noise,
  so batches are coordinated.

## Findings

### Elevation downloads bound the first view

- With 6 requests at once, about 6 elevation requests are in flight 92–98% of the
  time, both on the bench and against the live servers. Imagery is finished long
  before elevation.
- Before the download-queue fixes (`a31de78`, `31a454d`, `46b8a8c`), the desktop
  made 631 elevation downloads:

  | Downloads | Why |
  |---|---|
  | 100 | the final view's own tiles |
  | 212 | neighbours, whose pixels the edge vertices read; dropping them changes the picture |
  | about 200 | finer tiles asked for while the selection still moved, never shown |
  | 98 | repeats of grids evicted from the 256-entry decoded cache |

  The queue fixes drop downloads that no tile still wants. That took the desktop
  from 600 to 320 downloads and the phone proxy from 947 to 441.
- With the queue fixes, raising both request caps from 6 to 16
  (`map.loader.requests` and `map.imagery.concurrentRequests`), at 80 ms per
  request, medians of 3:

  | | Overview shown | Renderer asleep | Elevation downloads |
  |---|---|---|---|
  | Desktop, 6 → 16 | 2.6 → 1.9 s | 5.7 → 2.9 s (with the compass fixes) | 320 → 327 |
  | Phone proxy, 6 → 16 | 10.2 → 8.0 s | 15.6 → 13.4 s | 441 → 444 |

  The default is still 6; changing it is waiting on a decision.
- Protocols, checked against the live servers. These need a recheck if the
  providers change.
  - Mapterhorn elevation (the default) and the USGS imagery use HTTP/2, so 16
    means the same requests sent sooner over one connection.
  - The AWS Terrarium elevation source uses HTTP/1.1. There the browser allows 6
    connections per host, so 16 neither helps nor hurts.

### On phones, bytes matter more than requests

- A Mapterhorn elevation tile is a 512×512 lossless WebP, about 86 KiB.
- The phone's first view downloads 442 elevation tiles, 37.1 MiB, of which
  24.8 MiB comes before the overview shows. Its imagery is 4.2 MiB.
- On a real mobile network that is likely bandwidth-bound, not latency-bound,
  but the bench can't show it until it models a shared link.
- A terrain tile's mesh has 64 to 128 segments a side, and its elevation tile has
  512 pixels a side, so most pixels never become a vertex.
- `map.terrain.coarserElevation` (`a073fa4`) takes heights from an ancestor
  elevation tile. It downloads about 60% less elevation at one level and 75% less
  at three. It changes heights by metres, so it is opt-in: the "Save battery and
  data" preset uses 1.
- No lossless way to cut these bytes has been found yet.
- The phone selects finer terrain and imagery than the desktop because of its
  DPR. That is intended. Render resolution scale belongs to the upscaling work,
  not here.

### The phone proxy's startup is mostly SwiftShader

- On the phone proxy, creating the WebGL context takes about 2.4 s.
- Shader linking is synchronous and takes about 1.45 s, because SwiftShader has
  no `KHR_parallel_shader_compile`.
- Tile requests that are issued in frames wait behind those compiles.
- After the overview, the proxy is network-bound.
- Don't optimise for the proxy's GPU costs; a real phone's GPU driver behaves
  differently.

### Caches

- The engine's map cache can't compute freshness for the tour's tile servers,
  whose cross-origin responses don't expose the `Date` and `Age` headers it needs.
  In practice it stores nothing for the tour.
- Waiting for the cache's index used to delay the phone's first tile request by
  about 2 s. It now opens before the renderer (`6cb2494`, app `016a9ee`).
- On the published HTTPS site, Chrome's disk cache answers a repeated tile in
  about 2 ms. On a page served from `http://127.0.0.1` it stores nothing, so a
  local bench overstates repeats. The harness has an option that treats a repeat
  as a cache hit.

### Imagery

- Imagery selection hysteresis used to hold at rest. After a small zoom-in, a
  region stayed a level coarser than the target, so the settled imagery depended
  on arrival timing; about one phone run in ten settled coarser. It now holds
  only while the view moves (`79f5b3b`). `map.imagery.refineAtRest` (default 1)
  sets the ratio at rest.
- On slow devices, page tables were cancelled by every selection or residency
  change during their upload, so the nearest imagery stayed coarse until loading
  stopped. An uploading table now finishes and binds (`a29b641`).
- Raising the per-frame imagery selection budget from 2 to 16 ms, or the upload
  budget from 4 to 16 MiB a frame, made the first imagery request sooner on the
  phone proxy but not the overview or sleep. Neither was committed.

### Cores

- The engine works on one hardware thread: the decode pool sizes to zero and the
  page decodes elevation itself. It can't be fast there. On the M5, the renderer
  process uses 6.4 s of CPU during a 2.7 s load, about 2.4 cores' worth, and only
  1.9 s of that is the main thread.
- Tune for 4 to 16 threads. One and two must still work.
- The decode pool grows to the device's threads, with one decode slot per worker
  (`4e4e9bf`, `c681cff`).

## Rules learned the hard way

- Babylon keeps a fresh updatable mesh's positions as a `Float32Array` and an
  updated mesh's as `number[]`. Code that copies or compares positions must take
  both.
- A decode worker is used only after its heights match the page's, bit for bit,
  for one tile (`d95411a`). Keep that check for any new worker path.
- Don't use `SharedArrayBuffer`.
- `Math.sin` and `Math.cos` stay in JavaScript. Moving them to WebAssembly or a
  table changes bits.
- Nothing reads terrain-tile vertex normals, so they are no longer built
  (`f425410`). Google 3D Tiles and glTF normals are read; keep them.
- `loadedTarget` drives only the detail slider.
- The imagery selector job captures its input when it begins, so hysteresis is
  fixed for a whole traversal.

## How a speedup is shown to change nothing

The priority is speedups that keep every output bit. Each one was checked with:

1. A guarded fast path, with the old path kept where the guard fails.
2. A differential harness comparing old and new outputs over many inputs.
3. Pinned digests of real tiles' outputs in tests.
4. Mutants: each part of the change is broken on purpose, and some test must fail.
5. Interleaved timing runs, compared by median.

Changes that lower quality go behind settings, off by default, and may be used
by the "Smooth motion" and "Save battery and data" presets.

## Open questions

- **Request caps.** Raise the default from 6 to 16? See the table above.
- **Seam stitching.** Terrain levels now match across runs, but the vertices
  along tile edges depend on the order neighbours arrive in. A stitch that gives
  the same edge whatever the order would make the settled picture reproducible.
  It needs a decision, because it changes edge vertices.
- **Overview height.** Writing the overview's height into the scene file shows the
  overview about 3 s sooner on the desktop, but the final view only about 1 s
  sooner. That 3% improvement to settle time is not significant. On the phone
  proxy, settle time is 9% shorter (p = 0.08). This would change scene content.
- **Shared-bandwidth replay.** The harness should model one shared link, so that
  byte savings show up in its timings.
- **Other follow-ups:**
  - A barrier for coarse patches.
  - Rechecking the size of the decoded-grid LRU.
  - Rounding the compass radius to 500 m steps.
  - Moving terrain mesh building to workers, which is postponed.
