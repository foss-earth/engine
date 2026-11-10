# Compute terrain grid powers once per job — 9 November 2026

P-159 in the performance ledger. Baseline: engine `4b3997a`, with P-130
through P-133 already present. The source, rebuilt binary, receipt and tests
are local, uncommitted changes.

The terrain profile recorded in [P-132](../2026-11-07/terrain-native-math.md)
left `Math.pow(2, z)` calls in the edge sampler. Each bilinear edge sample
reads four pixels, and each pixel called JavaScript to find the world's
width, test source/neighbour coverage and map back into the chosen grid.
Those exponents depend on the grids, not on the pixel.

Each parsed grid now keeps `Math.pow(2, grid.z - source.z)`, and each job's
lookup keeps `Math.pow(2, source.z)`. `pixel` and `covers` reuse them. Both
mesh construction and height batches use this path. Constants live only for
that job; alternating samplers cannot share another grid's scales.

The calls still use the executing worker's trusted `Math.pow`, with the
same arguments. They are not replaced with shifts, ratios, Rust's power
function, or a lower precision. Interpolation, wrapping, clamping,
neighbour order, sparse-pixel lookup, output ownership, error handling and
the ABI are unchanged. TypeScript remains the reference and fallback.

The rebuilt binary is 34,767 bytes (was 34,510), SHA-256
`4dd1f3e95c38115b690dadf0f46b06e79b6b9dab9cff7002766dac2ea018b8b0`.
Its build receipt was refreshed by `terrain-WASM/scripts/build.mjs` with the
installed pinned tools, offline.

## Evidence

- Frozen-binary differential: 770 height-batch cases, 2,007,834 heights,
  including 114,014 NaN results; 2,365 meshes and 19,822,968 mesh values.
  Every result bit matches, including NaN payloads, signed zeros, mesh
  metadata, UVs and indices. The same 454 batches are refused with the same
  errors. Corpus: sizes 1–257, zooms 0–30, missing/empty/present neighbours,
  parent grids, dense/sparse/packed grids, shared and offset views, edge and
  out-of-range coordinates, infinities, subnormals and fractional segment
  counts. Mesh digest `b77b31d3e15b3964`, height digest `3b5ef847065334be`.
- `tests/terrainWasmSamplingScales.test.ts` compares bytes against the
  TypeScript reference with finer, coarser and overlapping neighbours, both
  neighbour orders, poles and antimeridian edges, parent/child mesh zooms
  and alternating samplers at different zooms. It also checks that an edge
  batch 256 times longer makes the same list of power calls, using the
  supplied realm's function. This performance guard fails on the baseline;
  the identity test passes there.
- All 8 compiled Rust mutants are caught by those tests: unit batch scale,
  reversed batch zoom difference, unit mesh scale, mesh target zoom used
  instead of source zoom, wrong world width, coverage ignoring scale,
  interpolation using the primary grid's scale, and replacing the batch's
  imported power with Rust's.
- `check:parity` passes for all three engine cores. Terrain: 97 mesh cases,
  172,908 vertex coordinates and as many targets; 267 batch cases / 223,737
  coordinate pairs against TypeScript, bit-identical.
- Full engine suite: 145 files / 1,544 tests. Typecheck, lint, build, public
  consumer checks, Rust tests and the terrain source/binary receipt check
  pass. The app typecheck passes. No `0sfs` checkout was edited or built.

## Timing

Node 26.9.0 on the M5, shared machine. Same wrapper, different frozen WASM
binaries. Twelve alternating adjacent A/B pairs and an adjacent A/A control
per pair, after three warmups. This final timing ran after this session's
builds, tests and differential checks finished. The initial timing is
retained separately and is not the result quoted here.

The fixture is the same as P-132: a 257-sided z14 grid and four neighbours,
64-segment mesh with UVs, and 8,192 query points over the tile and just past
its edges. Sparse batches include creating and disposing a sampler for
the page's compact pixels. The interior and edge rows isolate those paths.
Microseconds per operation, medians:

| Work | Before | After | Result |
| --- | ---: | ---: | --- |
| Mesh | 174.6 | 165.8 | Inconclusive: two pairs slower, control spikes overlap |
| Batch, dense sampler kept | 192.3 | 153.0 | 21.0% median paired time saved, 12/12 faster |
| Batch, sparse sampler made per job | 596.4 | 551.5 | 7.6% saved, 12/12 faster |
| Batch, entirely interior | 97.3 | 96.1 | Within control noise |
| Batch, entirely at/past edges | 1,506.2 | 561.3 | 62.3% saved, 12/12 faster |

Kept-batch savings are 17.2–27.2% per pair, against −2.1–3.1% in the
controls; sparse savings are 6.7–8.5%, against −1.4–3.7%; edge savings are
61.8–63.9%, against −4.0–1.7%. The edge-only workload explains the saving;
it does not represent the normal mixture. The app's imagery worker uses
compact per-job inputs, so the sparse row is the closer proxy for it.

These are worker/kernel timings in Node, not a browser frame rate, phone or
power result. No new user setting or quality change is involved.

## Reproduce

Local scratch: `engine/build/perf-terrain-scales-20261109/`. From engine:

```sh
node build/perf-terrain-scales-20261109/differential.mjs
node build/perf-terrain-scales-20261109/mutants.mjs
node build/perf-terrain-scales-20261109/bench.mjs
../node_modules/.bin/vitest run tests/terrainWasmSamplingScales.test.ts tests/terrainWasmImports.test.ts --maxWorkers=1
```

`head/terrain.wasm` freezes the baseline. `results.json` retains every
ordered sample; `first-results.json` preserves the initial run. Logs and
mutation results live beside them. Mutants compile in a separate scratch
workspace, never by changing the production crate or binary.
