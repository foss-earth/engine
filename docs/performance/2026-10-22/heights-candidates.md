# Terrain height packing candidates

Read-only investigation on 22 October 2026; no shipping change is established here. The shared
handoff is in `0sfs/fly/docs/performance/2026-10-22/session-handoff.md`; the independent agent
brief is its adjacent `agent-prompts.md`, Agent 3. Preserve worker verification and all defaults.

`packTerrainHeightPixels` in `src/browser/terrainHeightPixels.ts` encodes every visited leaf
pixel as `slot * 2**32 + index` in a reusable `Float64Array`, sorts the keys, counts unique keys
for byte-budget enforcement, then scans them again while copying unique pixels. The historical
height-pixel component cost about 8.3 ms/s self at 1×; this is not a saving estimate.

Two hypotheses are worth a bounded experiment:

- Compact unique keys in place during the counting pass, then copy only that unique prefix.
  This avoids a second traversal and comparison of duplicate entries without changing key
  representation. More writes in the first pass may erase the saving for dispersed queries.
  A frozen-reference scratch experiment is prepared in `build/perf-heights/`; it has not been
  run. A new height agent owns the decision to measure or revise it in its own scratch directory.
- Supported worker grids have at most 4096² pixels and 33 source slots. Encoding a key as
  `slot * 2**24 + index` fits in a `Uint32Array` (largest key 553,648,127), halving sort scratch
  storage. Earlier `a3b213c` introduced typed sorting and `545c5cb` combined keys in Float64;
  neither is this narrower encoding. Sorting speed and per-visit guard cost remain unmeasured.

The second hypothesis cannot silently narrow malformed or out-of-range inputs: packing is
exported, while validation happens later. One possible exact fallback is to promote the current
request back to the original Float64 encoding on the first unrepresentable slot/index, converting
already collected keys without revisiting coordinates or changing getter read order. It needs
careful differential proof; no implementation or speed claim is made here.

Compare all four packed arrays byte-for-byte, `add` results, budget boundaries, errors and partial
state after a rejected batch. Cover clustered/dispersed queries, edges/mixed zooms, repeated neighbor
objects and first-covering tie order, absent versus empty neighbors, maximum valid indices/slots,
fractional/overflow metadata, NaN/infinity, signed zero, mutation and reentrancy. Do not lose source
provenance, revision checks, stale reply handling, fallback or retirement behavior. The shared
scratch buffer itself deserves scrutiny under nested packers; do not claim that case is already
safe without testing it.

Run existing pixel/batch/adversarial suites, selector identity guards and relevant native parity
after a candidate shows exactness. Benchmark small and large batches across spatial spreads,
interleaved with the frozen reference, then use a pinned flight A/B if the gain survives. All
benchmarks must wait for the shared exclusive measurement slot; no CPU-heavy work during Chrome.

The earlier `nimg` placement experiment removed batching and memoization as well as verification
and was slower overall. It cannot answer whether verification alone is worth its cost.
