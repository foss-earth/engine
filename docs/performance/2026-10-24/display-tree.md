# Answer imagery display lookups from a quadtree

Measured on 24 October 2026 against engine `21de96e`. The source change is in
`src/terrain/imagery/imageryBinding.ts`, with its three lookup loops in
`src/babylon/imagery/createImageryRuntime.ts` replaced by one shared helper, and tests in
`tests/imageryBinding.test.ts`.

`buildImageryDisplay` used to keep the pages it shows, and their ancestors, in two string-keyed
collections. Every later question walked a tile's path towards the root and built a key string at
each level:

- the shown page for a leaf;
- the page for a single-page patch;
- `patchTableDepth`;
- `buildPatchTable`.

A non-resident leaf also searched every ancestor for a standard page, so neighbouring leaves
waiting on the same parent repeated the same search.

The display now records pages in a quadtree of typed arrays: four child indices per node, a flag
byte and a page slot. Building the display, the depth search, table filling and the new
`shownPage` all walk that tree. Each ancestor is searched for a standard page at most once per
build. Pages are still shown in the same order and with the same first-shown-wins rule. The
string-keyed `pages` and `ancestors` views are rebuilt on first read, replaying the shown list in
its original order. Their contents and insertion order are unchanged.

Tiles off the integer grid (non-integer, negative, past `2^z`, or deeper than level 30) keep the
original string-keyed path in every function, as does any display not built here.

## What stays the same

For every input, the new code gives the same results as the old:

- `slots`, `slotImages`, `ambiguousSlots` and `fallbackLeaves`, in the same order;
- the keyed `pages` and `ancestors`;
- the depth and cap from `patchTableDepth`;
- the bytes and metadata of `buildPatchTable`, with or without a reused buffer;
- the page found for every leaf and patch.

`isMissing` is still asked about every selected leaf that is not resident, in the same order. The
only callback difference is that `slotsFor` and `standardKey` are asked about fewer keys. Every
key still asked is one the old code asked about, and the runtime's callbacks are pure lookups.
The input documentation now says that a build may ask once for a key it needs several times.

The old patch lookups had no exit for a tile whose level never reaches 0, such as a negative or
fractional `z`, and looped forever. `shownPage` returns `undefined` for such a tile. Terrain patch
tiles are always whole grid tiles, so this changes no reachable case.

## Validation

All checks passed:

- **Frozen-reference differential** (engine `build/perf-oct24/display.test.ts`). It compares
  every output listed above, the callback logs, and the depth, table and shown-page result for
  every patch and leaf. It ran:
  - 50 displays captured from a C172 flight: 29,051 leaves, 5,765 patch queries;
  - 400 random displays with ambiguous slots, variants, multi-page images and missing images;
  - 300 malformed displays with off-grid, negative, fractional and level-31 tiles and odd page
    counts.
- **Permanent tests**. New tests pin the keyed views' order, the first-shown-wins rule, a
  once-per-ancestor search (which fails on the old code), a page off the grid, and the tree path
  against the string-keyed path on random displays.
- **Mutants**. Nine source mutants each fail both the differential and the permanent tests:
  depth cap, child order, overwriting a shown page, ancestor memo, deepest page, grid edge,
  keyed order, ancestor flag, and the depth early exit.
- **Engine checks**. Typecheck, ESLint on the changed files, and the full engine suite
  (129 files, 1,389 tests).

Replaying the 50 flight displays, with depth, tables and shown pages for every patch and leaf,
took a median 23.9 ms before and 6.6 ms after, over 14 interleaved rounds. `slotsFor` and
`standardKey` calls fell from 223,041 to 50,363.

## Browser A/B

The pinned C172 A/B (`treeab`, three interleaved pairs, 8-second still profiles at each CPU rate)
used pinned builds of one source snapshot. The two arms differ only in the two changed engine
files.

| Metric | Before | After |
| --- | ---: | ---: |
| `publishManaged`, 1×, inclusive ms/s | 26.0–27.2 | 14.5–16.1 |
| `publishManaged`, 4×, inclusive ms/s | 118.6–125.7 | 67.3–75.9 |
| `buildImageryDisplay`, 4×, self ms/s | 31.5–33.8 | 15.6–17.6 |
| Frames/s, 1× | 58.6–58.8 | 58.6–58.9 |
| Frames/s, 4× | 28.3–29.5 | 30.9–32.4 |
| p95 frame, 4× | 50 ms | 33.3–50 ms |

Every 4× row separates in every pair. At 1× the page already holds about 59 frames/s, so only the
function cost shows. Inclusive costs are not additive. No build or test ran while Chrome ran,
every run completed, and clone cleanup ran after each one.

## Reproduction material

All of it is local and ignored:

- Engine `build/perf-oct24/`:
  - `imageryBinding.before.ts`, the frozen reference;
  - `samples.json`, the captured displays;
  - `display.test.ts` and `vitest.config.ts`, the differential and timing harness;
  - `mutants.py`, the mutant runner.
- Fly `build/perf-oct24/`:
  - `snap.json`, the source snapshot;
  - `tree.json` and `arms/*.tree.ts`, the overrides;
  - `run1.sh`, the run script;
  - `runs.txt`, the run index;
  - `ab.mjs`, the summarizer.
- Fly `build/perf/oct24-base` and `oct24-tree`: the two bundles, with source maps.
