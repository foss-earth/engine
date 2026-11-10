# Performance continuation — 9 November 2026

The user asked to resume FOSS Earth optimizations autonomously while another
agent works on `0sfs`. Work stayed in FOSS Earth. No servers were started,
and nothing was pushed or deployed. Engine and docs were clean at the start.

**Active continuation:** the user explicitly said not to stop unless nothing
remains and no further work can be found. Completing one batch is not a reason
to end this task. Continue investigating and implementing qualified gains;
preserve the parallel `0sfs` work. The sections below record the earlier batch,
not completion of the overall performance work.

Currently being qualified after P-160 (reserved IDs P-161–P-163): sparse
terrain bilinear rows use one search for both adjacent keys, in WASM and
TypeScript. Both sources, the binary, receipt and
`tests/terrainWasmSparseRows.test.ts` are already edited. The WASM
frozen differential and full core parity pass; 8/9 mutants are caught, with
the remaining comparison mutant equivalent because the second key check
still refuses every missing first key. Initial paired timings show a sparse
batch saving near 36%; final timing and documentation remain. TypeScript
scratch is `build/perf-height-pairs-ts-20261109/`, showing about 24% on the
normal sparse workload; its expanded replay matched 1,024,244 output bits and
409,356 refusals, and 8 mutants are caught with a full-search control passing.
WASM scratch: `build/perf-terrain-pairs-20261109/`. Keep its baseline, which
includes P-159, separate from the older `4b3997a` baseline.

P-163 is a scratch-only queue-completion memo in
`build/perf-queue-complete-20261109/`: a complete fill with no missing or
failed entries and no overflow is a no-op until residency changes. A new
1,000-seed / 250,000-operation replay passes. Its initial timing is running.
Two new tests in `imageryResidency.test.ts` are already added: the demand-read
performance guard intentionally fails on the current production source until
the candidate is applied; retry/missing-expiry semantics also get coverage.
Apply the candidate only after timing qualifies it, then run the tests and
mutants. Final full-suite, final timings and reports remain for this batch.

## Local changes ready for review

Baseline engine `4b3997a`, docs `9de060e`, both on `main`.
These changes are **uncommitted**:

| Item | Paths | Result |
| --- | --- | --- |
| [P-158: imagery ancestor paths](imagery-ancestor-paths.md) | `src/terrain/imagery/imageryBinding.ts`, `tests/imageryDisplayPaths.test.ts` | Same pages, callbacks and table bytes. Saved workload's display builds 11.5% cheaper; builds and queries 5.2% cheaper in paired Node timings |
| [P-159: terrain sampling scales](terrain-sampling-scales.md) | `terrain-WASM/crates/earth-terrain/src/lib.rs`, `terrain-WASM/single/terrain.wasm`, `terrain-WASM/build-metadata.json`, `tests/terrainWasmSamplingScales.test.ts` | Same result bits and errors, using the realm's same Math.pow. Dense kept height batch 21.0% cheaper; sparse per-job batch 7.6% cheaper in paired Node timings |
| [P-160: imagery queue index](imagery-queue-index.md) | `src/terrain/imagery/imageryResidency.ts`, `tests/imageryResidency.test.ts` | Queue counts and empty-queue collection no longer scan resident entries; loading-entry collection skips the all-entry copy. Same lifecycle and admission. Settled public pump 23.8–37.6% cheaper in paired Node fixtures |
| Evidence | This directory and docs' `docs/performance-ledger.md` | Proofs, timings and scratch reproduction commands |

No frame-rate, browser, phone or power improvement is claimed. A mesh
speedup and an interior-only batch improvement were inside the timing
controls' noise and are not results. The resident-page path-cache prototype
was rejected and left in scratch only.

## Checks completed

- Engine suite: **145 files, 1,544 tests**, with two workers.
- Engine typecheck, whole-repository lint, build and public consumer checks.
- All engine core parity checks: raster, terrain meshes and batches, ground.
- Rust tests and terrain's source/binary receipt validation.
- App typecheck, resolving the engine's sources.
- Frozen display differential: 151,127 leaves / 32,916 tables, no differences.
- Frozen terrain differential: 2,007,834 heights and 19,822,968 mesh values,
  bit-identical, including NaN payloads; the same failures.
- Mutants: 11/11 display and 8/8 compiled Rust mutants caught by permanent
  tests. A root-walk control still passes. Tests against the baseline pass
  for identity and fail only the terrain power-call performance guard.
- Queue replay: 1,000 seeds / 250,000 operations, equal after every operation;
  8/8 queue-index mutants caught and a scan-based control passes. The new
  lifecycle tests also pass against the frozen baseline.

Scratch and raw logs live in `engine/build/perf-display-path-20261109/`
and `engine/build/perf-terrain-scales-20261109/`, with queue work in
`engine/build/perf-imagery-queue-20261109/`. They include frozen source
and binary baselines; do not regenerate the baselines from a later HEAD.
The final terrain timing ran without this session's other checks running;
the earlier overlapping timing is preserved as `first-results.json` and
is not the reported result.

## Continue from here

Read the [ledger](https://github.com/foss-earth/docs/blob/main/docs/performance-ledger.md)
before selecting another item. The October handoffs are history; many of
their open items shipped in November. In particular, P-071, P-074, L6, L8,
L19, L20, L21, L23 and L26 are already handled, and P-157 changed several
defaults at the user's request. Do not reapply the old prototypes.

The large remaining architecture candidates are the growing imagery atlas
(L22), GPU imagery feedback (L4), shared terrain geometry (L10/R5), and
Google texture memory (L5/L13). Read their exactness and admission constraints
before implementing. Sharing terrain GPU index buffers remains unsafe through
the plain Babylon setter alone: it discards CPU indices and does not supply
the previous context-loss rebuild behaviour. No implementation was kept.

Smaller measured leads remain P-086 (selection), P-087 (the rest of display
building), P-089 (distribution), P-092 (uniforms) and P-105 (the remaining
demand and missing-image queue walks). P-158 only shortens the ancestor-path
walk; P-160 only indexes queued identities and removes temporary full-cache
arrays. Preserve floating-point order,
callback behaviour, failure cleanup and render on demand. Do not retry the
rejected selector scratch or canvas-box caches as exact changes.

Use the saved profiles first. Keep local timings short and paired with an
unchanged control; leave sustained browser/phone/power runs for a dedicated
machine or the existing cloud-run list. No exclusive run was authorized:
the machine is shared with the `0sfs` work.

No new push or deployment is authorized. After review and commits, the
source-only push commands would be:

```sh
git -C /Users/felg/gh/foss-earth/engine push origin main
git -C /Users/felg/gh/foss-earth/docs push origin main
```

Both push remotes were inspected: `https://github.com/foss-earth/engine.git`
and `https://github.com/foss-earth/docs.git`. These commands do not publish
an app. Keep any later unrelated edits out of the commits.
