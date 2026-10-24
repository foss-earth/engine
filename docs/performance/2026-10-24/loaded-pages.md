# List loaded imagery pages without a key per cell

Measured on 24 October 2026 against engine `5931043`. The source change is in
`src/terrain/imagery/imageryBinding.ts`, with a test in `tests/imageryBinding.test.ts`.

`loadedImageryPages` lists the pages that adopted bindings sample, for the loaded-detail
distribution. It ran `pageAt` on every live cell of every binding table and built a key string
for each one. Neighbouring cells usually show the same page: the captured flight's 50 publishes
read 31,625 cells for 8,524 pages.

The scan now computes each cell's page inline. A cell is skipped when its page equals the last
page left of it in the same row, or the last page above it in the same column. Both are pages
the call has already added. Adding a page again never changes the list, because the map keeps
each key at its first position. At one level, the cells of a row share a page row and the cells
of a column share a page column, so the left comparison needs only the level and x, and the
column comparison only the level and y.

## What stays the same

For every input, the call returns the same pages in the same order, with the same numbers and
the same field order. The returned tile objects may be different objects with equal contents,
because a skipped cell no longer replaces a page's object with an equal new one. The only
caller reads their fields.

## Validation

All checks passed:

- **Frozen-reference differential** (engine `build/perf-oct24b/pages.test.ts`). It compares the
  list, its order and every number with `Object.is`. It ran:
  - 50 publishes rebuilt from the C172 flight displays captured for the display tree:
    5,765 bindings, 31,625 cells, 8,524 pages;
  - 1,500 random binding sets with blocks, holes, mixed and stray levels, and repeated bindings;
  - 1,500 malformed sets with overflowing shifts, out-of-range and fractional cell counts, and
    fractional, negative and level-40 tiles.
- **Permanent test**. 200 random binding sets, over repeated calls, against a cell-by-cell
  reference written in the test.
- **Mutants**. Eight mutants each fail both the differential and the permanent test:
  - left comparison without x;
  - left comparison without the level;
  - column comparison without the level;
  - column comparison without y;
  - no reset of the column memory per binding;
  - no reset of the left memory per row;
  - pages deeper than their cells shifted the wrong way;
  - rows taken from the tile's x.

  One equivalent mutant survives both: never recording the column memory only skips fewer
  cells.
- **Engine checks**. Typecheck, ESLint on the changed files, and the full engine suite
  (129 files, 1,391 tests).

Replaying the 50 flight publishes took a median 2.48 ms before and 1.54 ms after, over 16
interleaved rounds.

## Browser A/B

The pinned C172 A/B (`pkab`, three interleaved pairs, 8-second still profiles at each CPU rate)
used pinned builds of one source snapshot. The before arm is the display-tree build (engine
`5931043`). The after arm adds both of today's changes: this one and the one in `height-keys.md`.
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
  - `imageryBinding.before.ts`, the frozen reference;
  - `pages.test.ts` and `vitest.config.ts`, the differential and timing harness;
  - `page-mutants.py`, the mutant runner.
- Fly `build/perf-oct24/`:
  - `pk.json` and `arms/*.pk.ts`, the overrides;
  - `runs.txt`, the run index (label `pkab`).
- Fly `build/perf/oct24-tree` and `oct24-pk`: the two bundles, with source maps.
