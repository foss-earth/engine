# Pack terrain height pixels with 32-bit keys

Measured on 24 October 2026 against engine `5931043`. The source change is in
`src/browser/terrainHeightPixels.ts`, with a test in `tests/terrainHeightPixels.test.ts`. It
implements both hypotheses in `docs/performance/2026-10-22/heights-candidates.md`: narrower keys
and an exact fallback.

`packTerrainHeightPixels` sorts one key per visited leaf pixel so it can count and copy each
pixel once.

| | Before | After |
| --- | --- | --- |
| Key | `slot * 2^32 + index` | `slot * 2^24 + index` |
| Key storage | `Float64Array` | `Uint32Array` |
| Pixels and coordinates | plain arrays, converted in `finish` | typed arrays, written as stored |

Supported grids fit the new key. They have at most 4096² pixels and 32 neighbours, so every slot
is below 33 and every index below 2^24.

The first pixel that does not fit (slot 256 or more, or an index that is negative, fractional
or at least 2^24) switches the batch to the old keys. Keys already collected are converted, and
the batch finishes on the old path. Output arrays grow by doubling, and `finish` copies them to
their exact length.

## What stays the same

For every input, the packer gives the same results as before:

- the same four packed arrays, byte for byte, each in a buffer of exactly its length;
- the same byte counts from `add`;
- the same `null` for a batch over its budget, with nothing appended.

Coordinates, grid fields and heights are read in the same order. Each value goes through the
same conversion, now when it is stored rather than in `finish`.

Both versions keep sort keys in a module-level buffer. A coordinate or grid getter that called
`add` again from inside `add` would corrupt either version, in different ways. This cannot
happen in practice: the only caller, `flush` in `src/browser/terrainHeightBatches.ts`, passes a
plain number array and engine grid objects, so no outside code runs during `add`.

## Validation

All checks passed:

- **Frozen-reference differential** (engine `build/perf-oct24b/heights.test.ts`). It compares
  `add` results, every packed byte, and that table, heights and indices fill their buffers. It
  ran:
  - 160 batches captured from a C172 flight, packed 20 per request;
  - 500 random requests with neighbour rings, clustered and repeated points, and tight budgets;
  - 500 malformed requests with:
    - sizes 0, 1, 2.5, −3, 4097, 8192 and 2^17;
    - coarser and repeated neighbours, and more than 260 neighbours;
    - NaN, infinite and off-tile points;
    - empty batches.

  3,529 batches took the fallback, 2,627 of them after collecting keys of the new kind.
- **Permanent test**. A new case packs a request against `collectTerrainHeightPixels` and checks
  that every array fills its buffer. The request has:
  - a first batch that outgrows every buffer at once;
  - a neighbour past slot 255, read after slot 1;
  - a 5000-pixel grid with indices above 2^24;
  - a narrow batch after those.
- **Mutants**. Every one of the 16 non-equivalent mutants fails at least one suite:
  - slot bound;
  - index bound;
  - integer check;
  - sign check;
  - conversion on fallback;
  - keys dropped on fallback;
  - keys dropped when either key buffer grows;
  - output growth without the needed size, for pixels or for coordinates;
  - a fixed key unit;
  - a closed slot range;
  - duplicates kept;
  - the budget boundary;
  - views returned instead of copies;
  - unread neighbours kept.

  The differential misses wide-key growth and the budget boundary, and the permanent test kills
  both. The permanent test misses an index of exactly 2^24, the integer check and the sign
  check: they need sizes the worker rejects, and the differential kills them. One equivalent
  mutant survives both: a batch left on the old keys still packs exactly.
- **Engine checks**. Typecheck, ESLint on the changed files, and the full engine suite
  (129 files, 1,391 tests).

Packing the captured flight batches five times took a median 8.44 ms before and 5.29 ms after,
over 30 interleaved rounds.

## Browser A/B

The pinned C172 A/B (`pkab`, three interleaved pairs, 8-second still profiles at each CPU rate)
used pinned builds of one source snapshot. The before arm is the display-tree build (engine
`5931043`). The after arm adds both of today's changes: this one and the one in `loaded-pages.md`.
Each function row belongs to one change; the frame rates belong to both together. Inclusive
times come from `profile-tree.mjs`, which counts each sample once.

| Metric | Before | After |
| --- | ---: | ---: |
| `loadedImageryPages`, 4×, inclusive ms/s | 4.5–14.1 | 3.0–3.6 |
| Packer `add`, 4×, self ms/s | 18.2–23.7 | 10.1–12.5 |
| `terrainHeightPixels.ts`, 4×, self ms/s | 22.0–28.4 | 16.3–17.7 |
| Height `flush`, 4×, inclusive ms/s | 27.7–32.1 | 19.0–20.4 |
| Height `flush`, 1×, inclusive ms/s | 10.0–11.6 | 7.3–8.0 |
| `syncDistribution`, 4×, inclusive ms/s | 102.7–113.3 | 83.1–93.3 |
| Frames/s, 1× | 58.7–59.0 | 58.6–58.8 |
| Frames/s, 4× | 23.4–25.4 | 24.0–27.2 |
| p95 frame, 4× | 50 ms | 50 ms |

Every 4× function row, and the 1× `flush` row, separates in every pair. The after arm had the
higher 4× frame rate in each pair, by 0.6–2.5 frames/s, though the ranges overlap across pairs.
At 1× the page already holds about 59 frames/s.

`syncDistribution` contains the page scan but not the packer, and fell by more than the scan's
own share. The rest may be fewer short-lived key strings to collect, or run-to-run variation,
and is not claimed. No build or test ran while Chrome ran, every run completed, and clone
cleanup ran after each one.

## Reproduction material

All of it is local and ignored:

- Engine `build/perf-oct24b/`:
  - `terrainHeightPixels.before.ts`, the frozen reference;
  - `heights.json`, the captured batches;
  - `heights.test.ts` and `vitest.config.ts`, the differential and timing harness;
  - `mutants.py`, the mutant runner.
- Fly `build/perf-oct24/`:
  - `pk.json` and `arms/*.pk.ts`, the overrides;
  - `runs.txt`, the run index (label `pkab`).
- Fly `build/perf/oct24-tree` and `oct24-pk`: the two bundles, with source maps.
