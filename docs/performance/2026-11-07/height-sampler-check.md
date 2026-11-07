# The height sampler's finiteness check left to the core — 7 November 2026

P-133 in the performance ledger. Engine `419860c`; baseline engine
`b823ab3` (after P-132). Not an item of the performance limits audit. It
came from the CPU profile in [P-132's note](terrain-native-math.md).

## What it was

The terrain core's height sampler (`terrain-WASM/heightSampler.js`) checked,
in JavaScript, that every number of a batch was finite before handing the
batch to the core. The checks were then made three times for each batch on
the default tier, `single`:

1. the height kernel (`src/browser/terrainHeightBatchKernel.ts`), before it
   picks a sampler;
2. the sampler;
3. the core itself (`sample_batch` in `crates/earth-terrain/src/lib.rs`),
   which returns status 1 for a point that is not finite.

The sampler's check could never fail in the app, as the kernel's had
already passed. After P-132 it was 17 % of a batch's profile.

## What changed

`terrain-WASM/heightSampler.js`: `sample` still checks that a batch is a
`Float64Array` of 1 to 65,536 pairs before it allocates. It no longer checks
the points. If anything fails after that, a status from the core, an
allocation or the memory, it looks at the points. If one is not finite it
throws the `RangeError` it threw before, `Height batches need 1–65536
finite x/y pairs`, rather than the failure. The build receipt records the
sampler's new hash. The binary, rebuilt with the pinned toolchain and Node
26.9.0, is byte-identical.

The kernel's check stays: the `typescript-worker` tier needs it, and it
reports such a batch to the page.

## Why it is exact

- A batch whose points are all finite does the same work in the same order,
  and gives the same heights or the same error.
- A batch with a point that is not finite reaches the core. The core's
  checks before its finiteness check are on the lengths and the buffers.
  The sampler has already checked those lengths and allocated those buffers
  itself, so they pass, and the core returns status 1 before it reads a
  grid or writes a height. Whatever fails, a point that is not finite turns
  the failure into the `RangeError`. That is the error HEAD threw before
  doing anything.
- The input and output the batch took are released in the `finally` block,
  as for any failed batch. The core's own last error is set by the refusal,
  and set again by the next call that reads it, as after any failure.
- The one difference: if releasing a refused batch's buffers also fails,
  the `RangeError` comes wrapped with that failure in the sampler's
  `AggregateError`, "Height batch cleanup failed", where HEAD threw the
  `RangeError` alone. A core whose release fails is already one the sampler
  says to retire. The app's kernel never passes the sampler such a batch.

## Proof

- **Differential harness** (`build/sampler-check/diff.mjs`, built on
  P-131's), HEAD's sampler against the change, each with its own instance
  of the same binary, Node 22 and 26:
  - P-131's 770 cases (dense, sparse, packed and random-sparse grids; tiles
    at z0 to z30; NaNs of six payloads, ±0, ±∞, subnormals);
  - in every case a batch with NaN, +∞ or −∞ at a random place, and one with
    it at the last place, between its valid batches.

  1,987,635 heights bit-identical. The 1,540 batches that are not finite
  are refused by both with the same class and message. That includes grids
  missing pixels, where the core would refuse the batch anyway. The other
  refusals are the same too.
  - 3,000 refusals of the largest batch (131,072 numbers, 1.5 MiB each) on
    one sampler, then a valid batch with the same heights as HEAD's.
  - A stand-in core whose allocation of the points or the heights fails,
    whose status is 9, or whose memory goes bad: the same error as HEAD for
    finite and NaN batches. Its release failing gives the difference
    above, and nothing else.
  - The A/A run gives the same digest (`0b390009fd67caec`) in both Nodes.
- **Mutants** (`build/sampler-check/mutants.py`), 9 of 10 caught by the
  harness:
  - no check on failure, or the check inverted;
  - the check missing the last value, or reading only x;
  - a plain `Error`, or another message;
  - the check of a batch's greatest length dropped;
  - a refused batch's buffers not released;
  - the check made only for a status, not for a failed allocation.

  The survivor checks again when the core returns a status, before the
  same conversion, so it behaves as the change does.
- **`tests/terrainHeightSampler.test.ts`**, new: the sampler refuses NaN, +∞
  and −∞ at the first, second, middle and last two places with that
  `RangeError`. It refuses the largest batch with NaN at its end 300 times,
  then gives the same heights as before for a valid one. It passes on HEAD
  and on the change. It catches 5 of 5 mutants: no check, missing the last
  value, reading only x, a plain `Error`, buffers not released.
- **Parity** (`terrain-WASM/scripts/check-height-batches.mjs`, Node 22 and
  26): 267 cases, the same as the TypeScript reference. Its refusal of NaN
  and +∞ batches passes.
- `node terrain-WASM/scripts/check.mjs` (Node 26.9.0), `npm run typecheck`,
  `eslint` on both files, the engine's suite (143 files, 1,528 tests) and
  fly's `npm run typecheck` pass.

## Measured

`build/sampler-check/bench.mjs`: the sampler only, in plain Node on an
Apple M5, on mains power, Low Power Mode off. HEAD's sampler against the
change on the same binary, one process per run, 9 interleaved rounds in each
Node. The grid and batch are P-131's: a z14 tile 257 pixels a side with 4
neighbours, and 8,192 points over the tile and just past its edges. Each run
times the first 10 batches of the process one by one. It then takes the
median of 3 timings after a warm-up:

- a batch from a sampler the kernel keeps;
- a sparse grid of the pixels the batch reads, its sampler made for the
  batch.

Both arms give the same digest (`d26b115835be20aa`, P-131's). Medians of
the runs, with their ranges, in µs:

| Node 26.9.0 | HEAD | The change |
| --- | ---: | ---: |
| Batch, sampler kept | 225.1 (222.5–226.7) | 188.2 (186.7–196.0) |
| Batch, sparse grid | 663.0 (654.6–666.0) | 596.4 (588.4–611.3) |
| First batch of a process | 1,213.1 (1,120.4–1,243.3) | 1,002.3 (952.8–1,045.3) |
| First 10 batches, together | 3,657.9 (3,562.1–3,769.0) | 3,436.7 (3,339.1–4,072.6) |

| Node 22.22.3 | HEAD | The change |
| --- | ---: | ---: |
| Batch, sampler kept | 357.9 (356.0–364.9) | 349.2 (345.0–352.7) |
| Batch, sparse grid | 924.6 (916.5–930.0) | 911.8 (907.0–915.7) |
| First batch of a process | 1,098.5 (1,081.1–1,113.3) | 783.6 (771.5–797.0) |
| First 10 batches, together | 4,759.8 (4,703.2–4,957.3) | 4,364.4 (4,333.2–4,373.0) |

- In Node 26 a batch from a kept sampler takes 16 % less time, and a sparse
  one 10 % less. In Node 22, 2 % and 1 %.
- The first batch of a worker takes 0.2 ms less in Node 26 and 0.3 ms less
  in Node 22. That is the loop's first, slow calls (P-131's note).
- The kernel's own check is not in these numbers. It is unchanged.
- These are worker timings in Node, not a frame rate, and were not measured
  in a browser.

## Left

- The kernel's check could also be left to the core on the `single` tier,
  with the kernel's report of a refused batch kept. It is the only check
  left in JavaScript on that tier.
- In Node 26 a kept batch is now about as fast as the TypeScript reference
  (182.6 µs in P-132's bench).
