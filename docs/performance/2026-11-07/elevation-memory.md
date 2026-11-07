# Elevation memory: neighbour bands, a byte bound, kept downloads — 7 November 2026

Item L6 of the performance limits audit (app
`docs/proposals/performance-limits.md`), P-114 in the performance ledger.
Engine `381f8d5`; the app's settings are app `1de4f46`.

## Where the memory was

A census of the default map (WebGPU, Minneapolis, 1280 × 800, after
loading settled and after a 40 s tour) counted every height buffer reachable
from the raster runtime's records and the loader's cache, each once:

| | Settled | After the tour |
| --- | ---: | ---: |
| All heights | 255 MiB | 306–308 MiB |
| Shown tiles' own grids | 79 MiB | 88 MiB |
| Shown tiles with their neighbours | 233 MiB | 251 MiB |
| Only in the loader | 1–20 MiB | |

So the cache's 256 grids of 1 MiB were not the problem by themselves: they
were the same grids the records held. Each record's patch held 8 whole
neighbours of 1 MiB, of which a mesh reads one pixel row (half a pixel past
the edge, the next row with weight 0).

## The change

- **Bands** (`neighborBandLevels`). A patch keeps, of each neighbour of its
  own zoom and size, the band along the shared edge 1/2^n of a tile wide as
  2^n sub-tiles at zoom z+n, and 2 × 2 pixels of each corner, at the zoom
  where a sub-tile is 2 pixels. Each pixel keeps its place in the quadtree,
  so every reader finds and interpolates it as before. A neighbour of another
  size, or a coarser one standing in for a missing tile, stays whole in its
  place. Bands are made once per neighbour grid and side.
- **Byte bound** (`cacheBytes`). The cache lets the oldest used tiles go
  past a bound on their heights' bytes as well as their count. A tile under a
  missing one holds its ancestor's heights and is not counted.
- **Kept downloads** (`encodedBytes`). The loader keeps the WebP it
  downloaded, most recently decoded longest, so a tile the cache let go is
  decoded again without the transport (Cache Storage or the network).

All three are absent in `DEFAULT_TERRAIN_LOADER_LIMITS`, which is the old
behaviour. The app sets 4 levels, 64 MiB and 32 MiB (Map → Loading).

**More grids per patch.** Level 4 makes 68 neighbour grids. Every reader's
limit went from 32 to `MAX_TERRAIN_NEIGHBORS` = 68: the TypeScript core,
the height batch kernel and pixels, and the WebAssembly core (69 grids,
160 buffers), rebuilt with the locked toolchain.

**Lookup.** Each reader finds the neighbour under a pixel by scanning for
the first that covers it. Over 68 grids that made the renderer's mesh 4×
and the WebAssembly mesh about 30% slower, since every `covers` in the Rust
core makes three imported `Math` calls. Both scans now try the last 4
neighbours that covered a pixel first, but only when no two neighbours
overlap. Then the first that covers a pixel is the only one. That is
checked once per list: in TypeScript per neighbour array, in Rust per job,
with exact integer shifts. A list where neighbours overlap scans in order,
as before.

## Exactness

`tests/terrainLoaderMemory.test.ts` compares a whole-neighbour patch and a
banded one, at levels 2 and 4 (2, 3 and 4 for the lookup), with `Object.is`
on every value:

- `sampleTerrainGrid` at every pixel centre and edge of the outer three
  pixels, the corners and random points, for sizes 8–512;
- the same at the antimeridian, the poles' rows, and zooms 0 and 1;
- with a coarser neighbour standing in for a missing one;
- for a child tile drawn from the patch;
- with a neighbour of another size;
- for rows;
- for the renderer's mesh, the TypeScript core and the WebAssembly core, at
  1–64 segments, and the WebAssembly height sampler;
- for sparse height pixels.

The lookup tests:

- read overlapping neighbours in an order that puts the later one in the
  recent list first, in TypeScript and WebAssembly, against the plain scan;
- read band patches with a missing corner.

`npm run check:parity` passes.

The cache tests cover:

- the byte bound's order;
- that a tile under a missing one is not counted;
- that the count alone bounds without `cacheBytes`;
- that a failed tile's bytes are forgotten;
- reuse of kept downloads within the bound;
- no store without the bound;
- that a kept download that would not decode is fetched again;
- that a download larger than the whole bound is not kept.

**Mutants.**

- Loader: 41 of 43 caught. The two survivors are equivalent:
  - the forget on a failed tile, which has no bytes counted yet;
  - the early return for level 0, which `neighborBand` repeats.
- TypeScript lookup: 4 of 8 caught. The other four change speed only:
  - two make overlaps report more often;
  - two each use one half of the recent list, which only does anything with
    the other half (both together are caught).
- Rust: the always-disjoint mutant is caught.

## Numbers

**Browser census**, same method, one run each, default map, WebGPU, M5:

| Setting | Heights, settled / tour | Kept downloads | Downloads read | Decodes | Settled in |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before (levels 0, no byte bound) | 255 / 308 MiB | 0 | 271 / 343 | 270 / 342 | 3.8 s |
| Levels 4, 256 MiB, 32 MiB kept | 279 / 299 MiB | 26 / 32 MiB | 261 / 325 | 260 / 330 | 4.4 s |
| Levels 4, 96 MiB, 32 MiB kept | 175 / 241 MiB | 27 / 32 MiB | 272 / 336 | 281 / 423 | 4.0 s |
| **Levels 4, 64 MiB, 32 MiB kept** | **154 / 212 MiB** | 26 / 31 MiB | 261 / 313 | 282 / 423 | 3.8 s |
| Levels 4, 96 MiB, none kept | 193 / 254 MiB | 0 | 313 / 451 | 312 / 450 | 3.8 s |

- With bands, shown tiles with their neighbours held 98–109 MiB instead of
  233–251 MiB. The loader's own whole grids were then most of what was left,
  so bands alone did not lower the total. The byte bound does.
- At the defaults, heights fall 101 and 96 MiB. Counting the kept downloads,
  the saving is about 75 and 65 MiB.
- No more downloads were read. Decodes rose 4% settled and 24% over the
  tour, in the decode workers.
- Without kept downloads, a 96 MiB cache read 115 more downloads on the tour.
- Settling time is within one run's noise.

An earlier try with quarter bands (levels 2) cost about 1 MiB a record and
raised the totals (355/405 MiB without a byte bound), so the default is
level 4.

**Node** (`build/l6/bench`, not committed), a 512-pixel patch, whole against
level 4, nine interleaved rounds, medians. These are Node timings, not frame
rates:

| | Whole | Level 4 |
| --- | ---: | ---: |
| Patch serialized | 9.4 MB | 1.3 MB |
| `structuredClone` (a mesh job's post) | 0.84 ms | 0.10 ms |
| WebAssembly mesh, the tile, 64 segments | 0.99 ms | 0.77 ms |
| WebAssembly mesh, a child at z+2 | 0.87 ms | 0.51 ms |
| TypeScript core, a child at z+2 | 0.12 ms | 0.14 ms |
| Renderer mesh, the tile (pages without mesh workers) | 0.12 ms | 0.19 ms |

The app's shared heights (`wasm.sharedHeights`) are off by default, so each
mesh job copies its patch: the clone saving is main-thread time per job.

## Not done

- **Decoded heights only for shown tiles.** Hidden records still hold their
  grids: 21 MiB settled and 48 MiB after the tour.
- **WebCodecs `ImageDecoder` in the decode workers.** It would save one
  1 MiB copy per decode.
- `terrainHeightPixels` keeps its plain scan. It sees only points near a
  tile's edge.
- **Not measured:**
  - Google mode;
  - a phone;
  - the frame profiler's main-thread time for mesh jobs;
  - more than one run per setting.

The scripts and raw results are in the app's `build/l6/` (`heap.mjs`,
`runs2.sh`, `probe.py`) and this repo's `build/l6/`, neither committed.
