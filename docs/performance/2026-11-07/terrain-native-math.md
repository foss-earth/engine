# The terrain core's sqrt, floor, round, min and max in WebAssembly — 7 November 2026

P-132 in the performance ledger. Engine `fe33d19`; baseline engine
`d6b2f8b` (after P-130 and P-131). Not an item of the performance limits audit. This is steps 2
and 3 of prompt F2 in 0SFS's audit of 5 November
(`docs/performance/2026-11-05/prompts/F2-terrain-wasm-math.md` in fly).

## What it was

After P-130 the terrain core still called JavaScript for ten Math
functions. Each call leaves WebAssembly and comes back. Sampling a point
inside a grid (`own`) made 8 such calls, 6 to `min` and `max` and 2 to
`floor`. A mesh samples each of its vertices, and a height batch each of
its points. In Node 26, P-130's bench found the core 4.2 times slower than
the TypeScript reference for a mesh and 2.4 times for heights.

## What changed

- `crates/earth-terrain/src/lib.rs` no longer imports `sqrt`, `floor`,
  `round`, `min` or `max`:
  - `sqrt` and `floor` are `f64::sqrt` and `f64::floor`, WebAssembly's
    `f64.sqrt` and `f64.floor`;
  - `round` is `c = x.ceil(); if c - 0.5 > x { c - 1 } else { c }`;
  - `min` and `max` are written out: NaN if either is NaN, −0 below +0.

  Rust's own `f64::round`, `f64::min` and `f64::max` are not used: they take
  halves away from zero, return the other argument for NaN, and either zero.
- The core imports `sin`, `cos`, `atan`, `sinh` and `pow`.
  `index.js`'s list of imports, `index.d.ts`'s `math` option and the
  README say so.
- `single/terrain.wasm` is rebuilt with the pinned toolchain and Node
  26.9.0: 34,154 → 34,510 bytes, `ef33651b…6779`. `build-metadata.json`
  records it.

## Why it is exact

ECMAScript defines these five exactly, unlike `sin`, `cos`, `atan`, `sinh`
and `pow`, which it leaves to each engine's approximation:

- `Math.sqrt` is the square root rounded to the nearest double, as IEEE 754's
  square root and WebAssembly's `f64.sqrt` are.
- `Math.floor` is IEEE 754's floor, as `f64.floor` is.
- `Math.round` takes halves toward +∞, and gives −0 from −0.5 to −0. The
  sequence gives the same:
  - `ceil` is exact;
  - `c - 0.5` is exact wherever the result is not already whole;
  - at 2^52 and above every double is whole, so `c - 0.5 > x` is false;
  - NaN and ±∞ come back unchanged.
- `Math.min` and `Math.max` return NaN if either argument is NaN, and order
  −0 below +0, as the written-out versions do. For two zeros, the bits are
  combined: or-ed for the minimum, and-ed for the maximum.

Checked in Node 22 and 26 (`build/native-math/probe.mjs`): the sequences,
compiled alone with the same toolchain, against `Math` with `Object.is`.
The inputs are 462 edge values and 2,000,000 random ones:

- ±0, ±∞, NaNs, subnormals, ±`MAX_VALUE`;
- halves from −12.5 to 12.5 and the doubles one and two steps either side;
- values around 2^51, 2^52, 2^53, 2^54, 2^60 and 2^100;
- doubles of random bits, and random halves at random scales.

That is 4,000,462 values for `round`, `floor` and `sqrt`, and 8,213,444
pairs for `min` and `max`. None differ. The probe has teeth: built with
Rust's own `round`, `min` and `max` and with `trunc` for `floor`, it finds
333,556 wrong roundings, 1,190,285 wrong floors and 5,690 and 5,691 wrong
minima and maxima. A `min` that returns its second argument on ties
gives 3,341 wrong.

These five return Rust's NaN where `Math` returns its own. No input the
core accepts gives them a NaN: the wrapper and the core check that a
batch's points are finite, tile numbers are whole, and the wrapper rounds
and checks the segment count before the core sees it.

## Proof

- **Parity** (`npm run check:parity`, Node 26): every core, the terrain's 97
  mesh cases (172,908 vertex coordinates and as many target positions) and
  267 height-batch cases (223,737 coordinates), bit-identical to the
  TypeScript reference.
- **Differential harness** (`build/native-math/diff.mjs`): HEAD's wrapper
  and binary against the change's, in Node 22 and 26.
  - The 770 height-batch cases of P-131's harness: 2,007,834 heights,
    114,014 of them NaN, bit-identical; the same batches refused with the
    same errors.
  - 2,365 meshes:
    - tiles at z0, z1, z4, z9, z14, z18 and z30;
    - grids 1 to 65 pixels a side, with plain heights and with NaNs, ±0, ±∞
      and subnormals;
    - no neighbours, or 0 or 4;
    - segment counts 1, 2.5, 3.5, −0.4, 7, 16.49999999999999 and 64, which
      exercise `round`;
    - with and without UVs;
    - a parent's coarser grid, and no grid.

    19,822,968 values bit-identical: positions, target positions, UVs and
    indices, with the centre, height bounds, segments and zoom.
  - The A/A run gives the same digests.
- **Mutants** (`build/native-math/mutants.py`): 10 in the crate, each
  built with the pinned toolchain and run through the harness. 6 caught:
  - `floor` as `trunc`, or as `round`;
  - `sqrt` one step up;
  - `round` as `ceil`;
  - `min` as `max`, and `max` as `min`.

  4 survive: Rust's own `round`, `min` and `max`, and a `min` that returns
  its second argument on ties. They differ from `Math` only for negative
  halves, NaN and signed zeros, which the core's accepted inputs never pass
  them: `round` sees only the segment count, which the wrapper has already
  rounded and checked. The probe above catches all four.
- **`tests/terrainWasmImports.test.ts`**: a new test that the binary
  imports only `Math.atan`, `cos`, `pow`, `sin` and `sinh`.
- **Reproducible**: the same source built again in `build/` gives the same
  bytes.
- `npm run test:rust`, `npm run typecheck`, `eslint` on the changed files,
  the engine's suite (142 files, 1,527 tests) and fly's `npm run typecheck`
  pass. Of `npm run check:wasm`, terrain's and ground's checks pass with
  Node 26.9.0. Raster's fails, as it has since `f77da98` (30 October),
  which changed `raster-WASM/core.js` without recording its hash.

## Measured

`build/native-math/bench.mjs`: kernels only, in plain Node on an Apple M5,
on mains power, Low Power Mode off. Three variants, one process per run, 9
interleaved rounds in each Node:

- HEAD's wrapper and binary;
- the change;
- the TypeScript reference, sampling in a loop as the height kernel's
  reference does.

Each run takes the median of 3 timings after a warm-up. Cases:

- a mesh of 64 segments with UVs, from a z14 grid 257 pixels a side and its
  4 neighbours;
- 8,192 points, the height kernel's largest batch, over the tile and just
  past its edges, from a sampler the kernel keeps;
- the same points from a sparse grid of the pixels they read, its sampler
  made for the batch.

All three give the same digest (`14a595aaba1aac27`). Medians of the runs,
with their ranges, in µs:

| Node 26.9.0 | HEAD | The change | TypeScript |
| --- | ---: | ---: | ---: |
| Mesh | 427.6 (420.3–437.8) | 183.8 (182.3–190.4) | 101.5 (98.3–105.0) |
| Batch, sampler kept | 838.8 (821.2–858.1) | 222.1 (220.5–227.6) | 182.6 (179.0–206.2) |
| Batch, sparse grid | 1,383.6 (1,372.7–1,404.2) | 665.9 (655.4–671.0) | 620.4 (614.1–663.5) |

| Node 22.22.3 | HEAD | The change | TypeScript |
| --- | ---: | ---: | ---: |
| Mesh | 288.2 (286.9–301.3) | 232.8 (230.2–270.3) | 132.0 (129.3–135.1) |
| Batch, sampler kept | 494.6 (492.2–496.4) | 356.2 (354.2–357.9) | 257.8 (245.7–271.6) |
| Batch, sparse grid | 1,015.4 (1,012.6–1,020.2) | 934.4 (928.6–940.3) | 731.7 (713.0–759.0) |

- In Node 26 a mesh takes 43 % of the time it took, a batch from a kept
  sampler 26 %, and a sparse batch 48 %. In Node 22, 81 %, 72 % and 92 %.
- The core is still slower than the TypeScript reference. In Node 26: 1.8
  times for a mesh, 1.2 for a kept batch, 1.07 for a sparse one. In Node 22:
  1.8, 1.4 and 1.3.
- These are worker timings in Node, not a frame rate. The app's paired
  `typescript-worker` against `single` comparison was not run.

Where the change's time goes now, from a CPU profile in Node 26 of a build
with the same source (its code differs slightly from the shipped binary's,
so it attributes and does not time):

- a mesh: 37 % of the samples in `core.js`'s JavaScript, which copies each
  grid's heights twice, into a snapshot and then into the memory, and the
  results out;
- a kept batch: 17 % in the sampler's check that the points are finite.
  Timed in place, a batch takes 187 µs without the check against 216 with
  it. The core checks the points again itself.

## Left

- `pow(2, z)` is still imported, and called for each pixel read near a
  grid's edge (`pixel`, `covers`). For whole `z` the result is 2^z, but
  ECMAScript leaves `Math.pow` to each engine, so computing it in
  WebAssembly would need checking in every engine that runs the app.
  macOS has JavaScriptCore's shell for Safari's.
- The sampler's own check that the points are finite, which the core
  repeats.
- `core.js` copying a mesh's heights twice.
- `docs/docs/webassembly-cores.md` in docs lists `terrain.wasm` as of 19
  October (33,297 bytes); it was out of date before this change (34,154
  bytes).
