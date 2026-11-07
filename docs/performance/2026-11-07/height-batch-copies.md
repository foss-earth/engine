# Height batches copied whole — 7 November 2026

P-131 in the performance ledger. Engine `ab62613`; baseline engine
`809de39` (after P-130). Not an item of the performance limits audit. It
came from a CPU profile of P-130's bench.

## What it was

The terrain height kernel (`src/browser/terrainHeightBatchKernel.ts`)
samples batches of up to 8,192 points in a worker. With the default tier,
`single`, it hands each batch to the WebAssembly core's height sampler
(`terrain-WASM/heightSampler.js`). The sampler's JavaScript moved numbers
one at a time:

- making a sampler copied every height of the grid and its neighbours into
  WebAssembly's memory through a `DataView`, one `setFloat32` each: about
  330,000 for a 257-sided grid with 4 neighbours. The kernel keeps a dense
  grid's sampler, and makes a sparse one for each request;
- each batch's points went in with one `setFloat64` callback each, through
  `forEach`;
- each batch's heights came out with one `getFloat64` each;
- the points were checked finite with `every(Number.isFinite)`, a call for
  each number. The kernel checked them the same way before handing them on.
  At 8,192 points that check took 67–70 µs in Node 22, and 6.5–7.7 µs as a
  loop.

`core.js`, the mesh's side of the same core, already copies whole arrays
on a little-endian host.

## What changed

- `terrain-WASM/heightSampler.js`, on a little-endian host:
  - a dense grid's heights go in with one `Float32Array.set` per grid;
  - a sparse grid's index and height pairs go in through a `Float32Array`
    over the memory, in a plain loop;
  - a batch's points go in, and its heights come out, with one `set` each;
  - the points are checked in a loop (`allFinite`).

  On a big-endian host the copies are as before.
- `src/browser/terrainHeightBatchKernel.ts`: the kernel checks the points
  with the same loop.
- `terrain-WASM/build-metadata.json`: the receipt records the sampler's new
  hash. The rebuilt binary is byte-identical.

## Why it is exact

- WebAssembly's memory is little-endian, so on a little-endian host a typed
  array over it holds the same bytes the `DataView` wrote with
  `littleEndian` set.
- `set` between typed arrays of one element type copies their bytes.
- The sparse loop stores an index and a height into a `Float32Array`. That
  converts them as `setFloat32` did.
- The `DataView` read a `Float32Array`'s height as a number and wrote it
  back as a 32-bit float. `set` copies its bits, so a NaN's payload is now
  kept where it might not have been. `core.js` already copies a mesh's
  heights this way. The harness below compares NaN results bit for bit and
  found none different.
- The loop answers as `every(Number.isFinite)` does: false at the first
  value that is not finite.
- Every typed array over the memory is made after the last allocation, as
  the `DataView`s were, so none can be detached by the memory growing.

## Proof

- **Differential harness** (`build/sampler-copy/diff.mjs`): HEAD's wrapper
  and the change, each with its own instance of the same `terrain.wasm`. 770
  cases:
  - tiles at z0, z4, z14 and z30, grids of 1 to 257 pixels a side, with no
    neighbours or 0, 1 or 4;
  - plain heights, and heights with NaNs of six payloads, ±0, ±∞, the
    smallest subnormal and the largest negative float;
  - each grid dense, sparse as the page collects it, packed as the page
    sends it, and sparse with random pixels missing;
  - up to 3,000 points, each batch sampled, then 1 point, then again;
  - a grid in a `SharedArrayBuffer`, as decode workers publish it, with
    65,536 points;
  - a grid that is a view at an offset.

  The outputs are bit-identical: 2,007,834 heights, 114,014 of them NaN.
  The 454 batches the core refuses, where random pixels are missing, are
  refused with the same error by both. Non-finite, odd, empty, too long and
  untyped batches throw the same errors. The A/A run, and the change with
  the big-endian copies forced, give the same digest (`3b5ef847065334be`).
- **Parity** (`terrain-WASM/scripts/check-height-batches.mjs`, Node 22 and
  26): 267 cases, 223,737 coordinates, the same as the TypeScript
  reference.
- **Mutants** (`build/sampler-copy/mutants.py`): 12 of 12 caught by the
  harness:
  - a neighbour's heights at the wrong offset, or without one;
  - a sparse pair's index and height swapped, or packed one apart;
  - the dense copy used for a sparse grid;
  - half the points copied, or copied as 32-bit floats;
  - the heights read from the points' memory;
  - the memory's view returned instead of a copy;
  - the finiteness check skipped, missing the last value, or reading only
    x.
- **`tests/terrainHeightBatches.adversarial.test.ts`**: a new test. The
  kernel refuses a batch with NaN, +∞ or −∞ at its first, second, middle,
  next-to-last or last number, and answers the same batch with all its
  numbers finite. 4 of 4 mutants of the kernel's loop caught (skipped,
  missing the first or the last value, reading only x).
- `npm run typecheck`, `eslint` on the three files and the engine's suite
  (142 files, 1,526 tests) pass. `node terrain-WASM/scripts/check.mjs`
  passes with Node 26.9.0.

## Measured

`build/sampler-copy/bench.mjs`, the kernels only, in plain Node on an Apple
M5, on mains power, Low Power Mode off. One process per run; each takes the
median of 3 timings after a warm-up. The grid is a z14 tile 257 pixels a
side with 4 neighbours, and the batch 8,192 points, the kernel's largest,
spread over the tile and just past its edges:

- a batch from a sampler the kernel keeps;
- a sparse grid of the 1,112 pixels the batch reads, sampler made, sampled
  once and released, as the kernel does for each sparse request;
- the dense grid's sampler made, sampled once and released.

The digest of both arms' outputs is the same (`d26b115835be20aa`). Medians
of the runs, with their ranges:

| µs a call | Node 22, HEAD | Node 22, change | Node 26, HEAD | Node 26, change |
| --- | ---: | ---: | ---: | ---: |
| Batch, sampler kept | 625.7 (624.2–652.9) | 494.4 (491.8–504.3) | 965.4 (950.0–973.1) | 860.0 (844.0–901.2) |
| Sparse grid, made for the batch | 1,158.9 (1,148.4–1,172.7) | 1,012.9 (1,002.1–1,028.0) | 1,493.1 (1,488.9–1,550.8) | 1,401.5 (1,383.0–1,484.2) |
| Dense grid, made for the batch | 3,206.1 (3,178.6–3,249.1) | 515.8 (512.6–520.2) | 3,422.6 (3,385.6–3,699.9) | 912.9 (892.1–987.3) |

Node 22: 9 interleaved rounds; Node 26.9.0: 5.

- A batch from a kept sampler takes 21 % less time in Node 22 and 11 % less
  in Node 26. The kernel's own check, not in these numbers, saves about
  another 60 µs a batch once the loop is compiled.
- The loop is slower on its first calls in a process
  (`build/native-math/cold.mjs`, 16,384 numbers, 3 fresh processes per
  Node):
  - In Node 22 its first two calls take 332–406 and 199–227 µs, against 78–88
    and 187–198 µs for `every`. From the third it takes 6–11 µs against
    57–74 µs. It has caught up by about the sixth call.
  - In Node 26 the loop takes 235–250, 83–95 and 171–211 µs for its first three
    calls, against 86–99, 81–89 and 167–205 µs for `every`. It is at 6–7 µs
    by the tenth call against 65–107 µs, and has caught up by then.

  A worker that checks only a few batches pays more for the check than
  before. The kernel and then the sampler each check every batch.
- Making a dense grid's sampler costs about 0.02 ms rather than 2.6 in Node
  22, and 0.05 ms rather than 2.5 in Node 26 (each row less the kept
  sampler's batch).
- What is left is mostly the WebAssembly kernel itself, which calls
  JavaScript's Math for each point (P-130's note).
- These are worker timings in Node, not a frame rate, and were not measured
  in a browser.

## Left

- F2's second step: `sqrt`, `floor`, `round`, `min` and `max` computed in
  WebAssembly. Each point inside a grid makes 8 of these calls. Done as P-132
  ([the terrain core's native math](terrain-native-math.md)).
- The kernel's TypeScript reference for sparse grids builds its heights with
  `Float64Array.from` and a callback. It runs on the `typescript-worker`
  tier, for the first sparse batch's parity check, and after a fallback.
