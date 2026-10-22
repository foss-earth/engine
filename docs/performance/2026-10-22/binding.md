# Stop imagery depth traversal when both bounds are known

Measured on 22 October 2026 against engine `b7a0bbb`. The source change is confined to
`src/terrain/imagery/imageryBinding.ts`, with a focused edge-case test in
`tests/imageryBinding.test.ts`. Preexisting `AGENTS.md` and `docs/agent-native.md` work is preserved.

`patchTableDepth` returns the deepest displayed page within the table's six levels, plus whether
deeper pages were capped. Once it has found both a page at the last addressable level and a
descendant beyond that level, neither result can change. The traversal now returns immediately
from remaining branches in that case. It also constructs each visited tile key once for the page
and ancestor lookups. Publication, table building, diagnostic values and update cadence are unchanged.

The two conditions must be independent: a capped descendant alone does not imply a page at the
last addressable level, and a page at that level alone does not imply capping. The new test covers
both conditions in separate branches, in either traversal order, plus each condition alone.

Validation passed:

- A frozen-reference differential checked 60 displays × 41 patch queries: identical depth/cap
  results, table metadata and every byte of every resulting table (2,460 cases).
- All 35 binding and selector identity tests; changed-path ESLint; engine typecheck.
- Both pinned flight builds, with no unpinned-source warnings. Browser arms use the same old
  snapshot and identical overrides except for the binding source, captured before each build.

In a synthetic mixture containing widely distributed fine pages, 12 interleaved rounds of
19,680 depth queries each had medians 548.5 ms before and 54.1 ms after. This workload frequently
reaches both bounds early, so its approximately 90% reduction is not a flight saving estimate.

The pinned C172 browser A/B (`depthq`, two interleaved pairs, 8-second profiles at each CPU rate)
uses the same method as `0sfs/fly/docs/performance/2026-10-22/flight-frame.md`:

| Metric | Before | After |
| --- | ---: | ---: |
| `patchTableDepth`, 1×, inclusive ms/s | 3.1–3.4 | 2.8–3.3 |
| `patchTableDepth`, 4×, inclusive ms/s | 18.9–21.3 | 14.3–15.3 |
| Frames/s, 1× | 58.6–58.7 | 58.5–58.8 |
| Frames/s, 4× | 28.2–28.6 | 28.3–28.7 |
| p95 frame, 4× | 50 ms | 50 ms |

The 4× function reduction is repeatable in both pairs. The 1× ranges overlap; FPS does not
demonstrate an improvement. Inclusive costs are not additive. Exactness evidence is the unchanged
algorithmic result and byte-identical tables; no new whole-scene screenshot comparison was made.
No benchmark or build ran during Chrome. Every browser run completed and clone cleanup ran.

Reproduction material, all local and ignored:

- Engine `build/perf-binding/`: frozen original/reference, differential and timing harness,
  `bench.log`, `tests.log`, and typecheck state. The initial differential used a slow generic
  typed-array assertion and timed out; byte-for-byte Buffer comparison completed the same cases.
- Fly `build/osfs-night/depthq0.json`, `depthq1.json`, and
  `arms/imageryBinding.depthq-{before,after}.ts`: immutable source overrides of `snap-0.json`.
- Fly `build/perf/osfs-depthq0` and `osfs-depthq1`: matching bundles and source maps.
- Fly `build/osfs-night/depthq.runs`, `cmp-depthq.txt`, individual run logs and
  `depthq-cleanup.log`: profile index, analysis and cleanup evidence.
- Fly `build/osfs-night/ab-depthq.sh`: stops on failed runs, validates profile artifacts before
  indexing them, and separates cleanup output from profiler logs. It is specific to these arms;
  use a new label/runner for future work.

Future binding work can start after this checkpoint. The historical publication/cadence
decisions remain pending. Use a fresh source baseline and preserve the independent selector,
height-packing and exhaust agents' file ownership and exclusive measurement slots.
