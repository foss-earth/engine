# Performance handoff — 28 October 2026

Read [the ledger](https://github.com/foss-earth/docs/blob/main/docs/performance-ledger.md)
before choosing work. This note is the state after the 27 October evening
session. The October 22 agent-state document is history.

## What is already done

Engine `main` is one commit ahead of `origin/main`, unpushed:

`deed8b5` — "Reuse exact imagery measurements and compact sparse height keys."

That commit is three exact changes, recorded as P-103, P-104, and P-088:

- Selection reuses a ready 65×65 lattice, the nearest corner's hull
  positions, and the hull sphere. Node selection plus loaded-detail was
  337.2 → 299.7 ms, 10.87% against an unchanged control, 28 of 30 pairs.
  Report: [selector](selector.md).
- The imagery runtime collects visible bindings and loaded pages in one
  pass and compares page keys as sets. Report: [runtime](runtime.md).
- Height pixels compact unique keys into the sort buffer during the counting
  pass. Node captured batches 4.304 → 4.021 ms. Report:
  [heights](../2026-10-26/heights.md).

None of those three is a frame-rate claim. The browser cohort that night
could not separate a frames-per-second change. See [browser](browser.md).

Three further exact changes are uncommitted, in the engine working tree only:

- P-101. `src/babylon/imagery/terrainLightPlugin.ts` and
  `tests/terrainLightPlugin.test.ts`. Skip identical `updateFloat4` and
  `updateFloatArray` writes per uniform buffer. Note: [terrain light](terrain-light.md).
- P-102. `src/terrain/imagery/imageryResidency.ts` and
  `tests/imageryResidency.test.ts`. Cache `stats()` until the next real
  mutation. Note: [residency stats](residency-stats.md).
- P-106, 28 October. In those same residency files, skip `fillQueue()`'s
  demand-order missing scan when the private missing map is empty. Isolated
  paired Node: 30.85–36.12% median saving at 256 and 4,000 residents, 30/30
  pairs each, outside the unchanged control range. Nonempty missing and
  public `pump()` timings are inconclusive. Not a frame-rate claim.
  Proof, tests and timing: [residency stats](residency-stats.md#p-106-empty-missing-set-queue-scan--28-october).

Notes that belong with them, also untracked:

- [view scratch](view-scratch.md) (P-100, rejected)
- [terrain light](terrain-light.md)
- [residency stats](residency-stats.md)
- this file

Do not commit unless asked. If a commit is asked for, stage only these
paths. Leave every other dirty file out.

## Do not touch

Another agent owns ground contact, the globe and tile runtime, and anything
under `~/gh/0sfs`. As of 28 October the dirty engine paths that are not this
work were:

- `ground-WASM/**`
- `src/babylon/createGlobeRuntime.ts`
- `src/babylon/createTilesRuntime.ts`
- `src/babylon/globeRuntimePorts.ts`
- `src/babylon/groundAcceleration.ts`
- `src/babylon/surfaceQuery.ts`
- `src/browser/groundBvhPreparer.ts`
- `src/browser/groundBvhProtocol.ts`
- `src/browser/groundBvhWorker.ts`
- `src/settings/mapRuntimeConfig.ts`
- `src/surface/contracts.ts`
- `src/surface/currentReadiness.ts`
- `tests/createTilesRuntime.test.ts`
- `tests/globeRuntime.test.ts`
- `tests/groundAcceleration.test.ts`
- `tests/mapRuntimeConfig.test.ts`
- `tests/surfaceQuery.test.ts`

The docs repo also has unrelated edits (`README.md`, `docs/agent-start.md`,
the sky handoff, and untracked proposals). Leave those alone. The ledger
rows for P-088, P-100 through P-104, and P-106 are this work; P-105 records
the remaining queue work.

Do not `git stash`, `git checkout`, or `git restore` a dirty file you do
not own. Restore a baseline for a bench with `git show HEAD:path`, written
to a scratch copy.

Do not run the full engine suite while those files are dirty. It mixes this
work with the other agent's unfinished tree. Typecheck, lint the files you
edit, and run the tests that cover them.

## Rejected, do not retry

| ID | Idea | Why it stays rejected |
| --- | --- | --- |
| P-046 | Selector screen-area rewrite | Inside the noise |
| P-047 | Delayed hull | Inside the noise |
| P-048 | `Math.hypot` rewritten as `sqrt` | Result bits differ |
| P-049 | Cache the canvas size in `applyWorldViewport` | Not exact |
| P-051 | Cache an old imagery view | Not the same view |
| P-052 | Hash-only table equality | Misses a collision the byte compare catches |
| P-100 | `evaluateView` scratch, `measureFocus` hull reuse, optional `toScreen` out | Bit-identical, including the shipped digest, and not faster when paired |

P-100 is the method lesson. An unpaired run looked like about 12% (a quiet
interval, plus four baseline samples from 492 to 661 ms). The paired repeat,
swapping only the two files, was median 158.9 → 159.5 ms over 16 rounds and
was reverted. Identity held. Speed did not. The candidate text is only under
`engine/build/perf-evalview-20261027/`.

Binding experiments the same day also failed and are recorded in
[binding](binding.md): a prefix cache, a `Uint32` table compare, and an
unrolled compare. `imageryBinding.ts` stayed at about 21.8 ms/s self in the
profile taken after `deed8b5`.

These need a user decision before any change: loaded-detail cadence (P-074),
one raster update per frame (P-072), and the Activity outline default
(P-071). Worker scheduling and 0SFS flight, exhaust, and aircraft work are
out of scope.

## What the 27 October profile still shows

Profile, taken after `deed8b5`, headless Chrome, WebGPU, C172, still, 30 s,
4×. Local scratch, not a committed artifact:

`research/build/benchmarks/startup-audit/profile-fly-final-pair3-oct27-final/2026-10-27_091811/summary.md`

Self time, ms/s, that is still open and is not ground or 0SFS:

| Function | 4× self | Where to look |
| --- | ---: | --- |
| `applyWorldViewport` | 48.6 | P-090. P-049 is not exact. Needs a proof that HUD writes never move the canvas |
| `evaluateView` | 44.5 (111.8 inclusive) | P-086. Do not retry P-100 |
| `surfaceSamples` | 24.3 | P-086 |
| `writeBuffer` | 22.3 | P-092. P-101 does not cover Babylon's own buffer compare |
| `footprintFrom` | 20.8 | P-086 |
| `imageryBinding.ts` file | 21.8 | Prefix, uint32, and unroll already failed |
| `measureFocus` | 13.6 | P-086. Hull reuse already failed |
| `fillQueue` | 9.4 | Same residency file as P-102. The cache does not cover this |
| `heightsAt` | 8.2 | P-086. Callers may keep the coordinates array, so it must stay freshly allocated |
| Babylon uniform-buffer file | 41.2 | P-092, after P-101 |

`refreshLoadedDetail` was about 87 inclusive. Its children are
`measureImageryView`. The cadence is P-074, which is a user decision.
`createRasterTilesRuntime.ts` was about 38 self. Leave it alone while the
ground agent is in the globe and tile runtime.

`stats` was about 14.2 in that profile. P-102 removes the repeated walks.
It has not been measured in a browser, so do not claim a frame-rate change
for it or for P-101.

P-106 now skips the empty missing-map scan in `fillQueue`; its remaining
entry and ordered-demand walks and nonempty missing path stay open as P-105.
The profile above predates P-106. On 28 October, 84 targeted tests and a
600-seed differential replay passed, as did edited-file typecheck and lint.
Engine-wide typecheck reports a preserved P-101 error at
`terrainLightPlugin.ts:516` (`_currentEffect` intersection reduces to `never`
because the Babylon property is private). P-101's source and test are
byte-for-byte unchanged; do not silently fix them as part of queue work.

## How to prove the next change

Keep selection, publication, and pixels identical. `Object.is` for signed
zero and NaN. Keep floating-point operation order. The shipped selector
digests in `tests/terrain/imagery/imagerySelectionIdentity.test.ts` are
`b2a7e123117cd19b3ce19096c5d40df6524d12468d361f1490b4a4750eed8100` and
`d28ae1399bcaf036109288e05c3bc881e7a91d11fb3bb85b989f8e32fafeb225`.

Time the isolated function in Node. Swap only the files under test, back to
back, against an unchanged control. Two warmups, then enough rounds that a
quiet interval cannot look like a win. Revert when the candidate sits inside
the control's range. Node timings are not frame-rate claims.

Scratch goes in each repo's gitignored `build/`. From `engine/`, vitest is
`../node_modules/.bin/vitest`. A config that lives under `build/` must set
its root with `new URL`, or vitest will look for tests in the wrong place.
`TMPDIR=$PWD/build/tmp`. In zsh, quote globs. macOS has no `timeout`. Vitest
hides passing `console` logs. `toBe` treats `-0` as not `0`.

Hull positions stored on a tile must be new objects. Scratch that the next
call overwrites cannot be stored. A reentrant height callback needs a depth
stack if scratch is reused. `measureFocus` must not push onto the stored
positions array.

## Next free ledger ID

P-105 is the remaining `fillQueue` work, still open. P-106 is the kept empty
missing-map scan cut. The next item is P-107.
