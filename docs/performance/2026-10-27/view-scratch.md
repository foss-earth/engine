# Selector scratch reuse — October 27, 2026

`evaluateView` reused one scratch frame per call, and `measureFocus` reused grid hull positions already stored for the same heights. `toScreen` gained an optional output point. Selection, publication and pixels stay on the shipped digests. A back-to-back Node replay shows no speedup, so both sources are restored to HEAD. The candidate text is kept under `build/perf-evalview-20261027/`.

## Change

`imagerySelector.ts` and `imageryGeometry.ts` only. `positionOnTileBasis` already accepted an output vector.

- `toScreen` writes the same viewport coordinates into an optional `out` point. Callers that omit it still receive a new point.
- `evaluateView` borrows a frame (`borrowEval`) for the hull points, positions, measured samples, outside list, screen points, bisection fractions and ground-ray list. A depth counter gives a re-entrant height callback its own frame, and `finally` returns the frame.
- `surfaceSamples` fills a caller-owned sample list when one is passed. Lattice indices come from `borrowLattice`, also stacked for re-entry. The coordinates passed to `heightsAt` are still a new array.
- `groundInsideTile` walks the view's existing ground list. It counts rays in that order and, when asked, writes tile-local positions into the borrowed ray list.
- When the view measurement has already stored the 3×3 grid at the same low and high heights (`Object.is` on both, 18 positions), `measureFocus` uses those positions and then appends the nearest point's low and high positions. A missing or mismatched store is filled in that same order.
- The screen-area clamps are the same `Math.max(0, Math.min(bound, value))` expressions, written inline.

## Identity

Run on the candidate, before the restore, with vitest 4.1.6:

| File | Result |
| --- | --- |
| `tests/terrain/imagery/imagerySelectionIdentity.test.ts` | passed |
| `tests/imagerySelector.cachedSamples.test.ts` | passed |

8 tests, 26.03 s. The shipped digests were not edited:

- `SHIPPED_DIGEST` `b2a7e123117cd19b3ce19096c5d40df6524d12468d361f1490b4a4750eed8100`
- `SHIPPED_RANDOM_DIGEST` `d28ae1399bcaf036109288e05c3bc881e7a91d11fb3bb85b989f8e32fafeb225`

The identity file still requires both, including packed heights, revision changes, kept measurements and bounds that move without a revision. The cached-sample test still requires nested queries and a bounds change with no revision.

ESLint on the two candidate sources exited 0. `npm run typecheck` from `engine/` exited 0.

## Bench

Harness: `build/perf-evalview-20261027/bench.test.ts`, vitest, one worker. Two warmups, then 16 rounds. Each round times 12 passes over five views (plain, oblique, focus both, focus around, near the horizon). Each pass selects with `step` and measures the plan's leaves. The median is the average of the 8th and 9th sorted samples. HEAD was written with `git show HEAD:src/terrain/imagery/imagerySelector.ts` and the same for `imageryGeometry.ts`, then the saved candidate files were copied back. No checkout and no stash.

The first unpaired run, kept as `baseline.json` and `candidate.json`, was the one that looked like about 12%. Its HEAD median is 185.932 ms (168.318–660.834), with four samples from 492 to 661 ms; the other twelve sit at 168.318–235.136 and their median is 181.560 ms. Its candidate median is 160.503 ms, and all 16 samples sit between 158.318 and 173.621 ms.

The paired repeat, `baseline-repeat.json` and `candidate-repeat.json`:

| Arm | Median ms | Min | Max |
| --- | ---: | ---: | ---: |
| HEAD | 158.862 | 148.171 | 196.085 |
| Candidate | 159.454 | 151.570 | 171.520 |

Candidate minus HEAD is +0.593 ms (+0.37%). The candidate range lies inside the HEAD range.

HEAD samples, low to high: 148.171, 150.635, 152.264, 154.846, 155.399, 155.651, 158.014, 158.307, 159.416, 159.968, 164.218, 164.579, 164.828, 190.871, 195.259, 196.085.

Candidate samples, low to high: 151.570, 152.970, 155.292, 156.139, 157.525, 157.887, 158.355, 158.726, 160.182, 162.327, 162.706, 162.851, 164.623, 165.076, 169.793, 171.520.

HEAD on this quiet interval lands on the first run's candidate median. The paired gap is gone, so the sources are back at HEAD. Logs: `baseline-repeat.log`, `candidate-repeat.log`.
