# The terrain core's Math imports, not bound — 7 November 2026

P-130 in the performance ledger. Engine `c1873a1`; baseline engine
`becd5bc`. Not an item of the performance limits audit. This is the first
step of prompt F2 in 0SFS's audit of 5 November
(`docs/performance/2026-11-05/prompts/F2-terrain-wasm-math.md` in fly).

## What it was

The terrain core (`terrain-WASM/`) builds terrain meshes and samples height
batches in the workers. It is the default since 19 October
(`wasm.tier=single`). The Rust code imports ten of JavaScript's Math
functions: `sin`, `cos`, `atan`, `sinh`, `sqrt`, `pow`, `floor`, `round`,
`min` and `max`.

`instantiateTerrainCore` gave WebAssembly a bound copy of each
(`math[name].bind(math)`). V8 calls an imported Math function from
WebAssembly faster than a bound copy of it. The prompt measured, in Node 22,
`sqrt` at 8.2 ns a call imported as it is against 19–21 ns bound, and
`floor` at 5.2 against 19 ns. The sky's core already passes the functions
themselves (`sky-WASM/index.js` in sky).

## What changed

`terrain-WASM/index.js`: `imports[name] = math[name]`. The check that each
is a function of the worker's own `Math` is unchanged.

## Why it is exact

- Math's functions do not read their receiver (`this`), so a bound copy and
  the function compute the same value.
- The core receives the same functions, from the same realm, as before. No
  host passes its own `math`: the app's mesh and height workers call
  `loadTerrainCore()` with the worker's `Math`.

## Proof

- **Parity** (`npm run check:parity`): every core's outputs are
  bit-identical to their TypeScript references. For terrain these are 97 mesh
  cases (172,908 vertex coordinates and as many target positions) and 267
  height-batch cases (223,737 coordinates: dense, sparse and packed grids).
- **The bench's digest** of a mesh and a height batch is the same at HEAD,
  with the change, and from the TypeScript reference (`e93a2e756af6157a`).
- **`tests/terrainWasmImports.test.ts`**, new: the imports WebAssembly
  receives are `Math`'s functions themselves. It fails with the bound copies
  (`expected [Function bound sin] to be [Function sin]`).
- `npm run typecheck`, and `eslint` on both files, pass. The test passes
  with `tests/terrainLoaderMemory.test.ts`, which reads both kernels.

## Measured

Node 22.22.3 on an Apple M5, on mains power, Low Power Mode off
(`build/terrain-math/bench.mjs`). The kernels only, in plain Node, one
process per run:

- a mesh of 64 segments with UVs for a z14 tile, from a 257-sided grid
  and its 4 neighbours;
- a batch of 16,384 heights from the same grids, through one sampler.

Each run takes the median of 3 timings of 200 calls, after a warm-up. 9
interleaved rounds of the three variants (`bench3.sh`). Medians of the runs,
with their ranges:

| µs a call | HEAD, bound | The change | TypeScript reference |
| --- | ---: | ---: | ---: |
| Mesh | 585.6 (578.3–625.8) | 290.8 (286.6–300.6) | 130.9 (129.3–137.7) |
| 16,384 heights | 1,544.8 (1,476.0–1,616.7) | 723.0 (717.6–746.7) | 505.9 (492.1–513.6) |

An earlier run of 9 rounds of the first two gave 601.7 → 286.8 µs a mesh
and 1,602.9 → 735.6 µs a batch.

- The mesh takes half as long, and so does a batch of heights.
- The WebAssembly core is still slower than the TypeScript reference: 2.2
  times for a mesh and 1.4 times for heights. Paired runs in the app had
  found it slower before (`docs/docs/webassembly-cores.md` in docs).
- This work runs in the workers, so it does not change a frame's time on the
  page directly. It changes how soon a mesh or a batch of heights is ready.
- These are Node timings, not a frame rate. The app's paired
  `typescript-worker` against `single` comparison was not run.

## Left

- F2's second step: compute `sqrt`, `floor` and `round` in WebAssembly
  rather than importing them, with the receipts and import check updated.
  `min` and `max` stay imported: Rust's `f64::min` returns the other argument
  for NaN, where `Math.min` returns NaN.
- A CPU profile of the change's bench puts about a quarter of its samples in
  `heightSampler.js`'s JavaScript: the batch's coordinates and heights are
  copied one number at a time through a `DataView`, where `core.js` copies
  a mesh's arrays whole.
