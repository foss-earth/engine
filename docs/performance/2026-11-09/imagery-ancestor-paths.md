# Reuse imagery ancestor paths — 9 November 2026

P-158 in the performance ledger, part of P-087. Baseline: engine `4b3997a`.
The source and test are local, uncommitted changes.

`buildImageryDisplay` already remembers which ancestors it searched, but
`PageTree.ancestorsOf` still walked from the root to every missing leaf's
parent before reading that memo. Neighbouring leaves repeat most of that walk.

The builder now keeps the last search's coordinates and depth beside its
existing path array. Integer coordinates aligned at level 30 share one
leading bit per common level. `Math.clz32` on the two coordinate differences
finds that prefix, bounded by the new tile's depth and the old path's filled
depth. `ancestorsOf` completes only the remaining path. The search itself,
including every callback, runs as before. There are no new buffers or
objects per leaf, and the cached path does not outlive a display build.

## Why the path stays valid

- Only integer tiles at levels 0–30 enter this path. Their aligned x and y
  fit in 30 bits; the two high zero bits are excluded from the prefix count.
- A path entry names an ancestor node by its stable array index. Adding
  another page, growing the tree's arrays, and setting page/search flags
  never remove or renumber nodes.
- The cached depth ends at the previous leaf's parent, not the leaf itself.
  Shallower searches lower that bound. The root works without any entries
  below level zero, and unrelated paths start at the root again.
- Resident leaves and off-grid inputs do not write the search path. Off-grid
  pages and queries retain the string-keyed fallback.
- All state is local to one build, so callbacks that build another display
  cannot overwrite it.

## Evidence

- A frozen baseline replay: 1,200 seeded displays, 151,127 leaves and
  32,916 table comparisons. Equal callback logs in order, fallback counts,
  slots and their image identities, ambiguous slots, keyed page and ancestor
  insertion order, shown pages, depth/cap results, metadata and every table
  byte, including dirty reused buffers. Cases include levels 0 and 30,
  mixed depths, neighbouring and unrelated tiles, variants, missing pages,
  slot collisions, and off-grid inputs. Zero differences.
- `tests/imageryDisplayPaths.test.ts` pins the old implementation's digest
  `882897beeb4146e51b5344d8113fe99ec6e4d0f2c41cf1fd5dd58dcd46827f57`.
  It hashes callbacks, page identities and order, and table bytes before
  materializing the keyed views, over 32 workloads with both axes, mixed
  depths and tree growth. It passes on the baseline and the change.
- The permanent test catches all 11 source mutants: either old coordinate
  forgotten, either coordinate ignored, AND instead of OR, no old-depth
  bound, an unwritten leaf depth reused, wrong alignment, wrong leading-bit
  count, wrong starting node, and a skipped level. An unchanged root-walk
  control passes.
- Engine checks: 145 files / 1,544 tests, typecheck, lint, build, public
  consumer checks and all core parity checks pass. The app typecheck passes.

## Timing

Node 26.9.0 on the M5, on a shared machine. Fifty saved flight displays
(29,051 leaves and 5,765 patch queries), repeated four times per timing.
Five warmups, then 16 alternating adjacent A/B pairs, each beside an A/A
control pair. Only the binding module differs. Medians, milliseconds per
200 display builds:

| Work | Before | After | Median paired time saved |
| --- | ---: | ---: | ---: |
| Build displays | 10.005 | 8.815 | 11.5% |
| Build, shown-page queries, depth and tables | 20.417 | 19.346 | 5.2% |

Both workloads are faster in all 16 pairs. Build savings range from
9.1–14.2%, against −2.4–2.7% in the controls. Complete-workload savings are
3.2–6.3%, against −2.3–0.7% in the controls. These are isolated Node timings;
there is no browser, phone, power or frame-rate measurement.

Caching the path for resident-page insertion alone was also tried and
rejected: complete-workload timings did not improve. That variant remains
only in ignored scratch.

## Reproduce

Local scratch: `engine/build/perf-display-path-20261109/`. From engine:

```sh
node build/perf-display-path-20261109/bench.mjs
node build/perf-display-path-20261109/differential.mjs
node build/perf-display-path-20261109/mutants.mjs
../node_modules/.bin/vitest run tests/imageryDisplayPaths.test.ts tests/imageryBinding.test.ts --maxWorkers=2
```

`baseline.ts` freezes `4b3997a`'s module; `candidate.ts` is the tested source.
`results.json`, `differential-results.json` and `mutation-results.json` retain
the evidence. The benchmark reads the saved corpus in
`engine/build/perf-oct24/samples.json`; none of it is a runtime dependency.
