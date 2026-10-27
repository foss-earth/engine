# Imagery selector — October 27, 2026

The retained candidate combines exact reuse of ready lattice samples, nearest
corner positions and a hull sphere. Baseline is engine `006034f`; selector
source is unchanged since `497e013`. It includes all October 24 changes.
The earlier [preparation](../2026-10-26/selector.md) is historical and superseded
by this report. No defaults, traversal budgets, publication cadence or detail
levels change. Final browser and commit disposition is in the session handoff.

## Change and cache ownership

`surfaceSamples` first gathers complete samples at the exact fallback height.
Only a fully ready lattice takes the shortcut. A miss follows the complete
original callback/rebuild path, preserving nested surface-query behavior.

When the nearest point is a tile corner, `evaluateView` reuses the same low/high
positions already stored in its 3×3 hull. Position ordering and every projection
operation remain the same. Its bounding sphere is retained inside that existing
hull, keyed additionally by exact nearest u/v. Hull low/high changes and surface
revision invalidation therefore retire the sphere together with its positions.
The nearest point is essential: keeping only a tile/bounds key can produce a
stale conservative sphere even when final selection happens to stay unchanged.

## Exactness

The independent ready-sample and corner candidates passed unchanged identity
digests, callback/revision/reentry fixtures and moving-view comparisons. The
final combination and corner+samples alternative passed 20 tests in 71.35 s:
complete plans, Float64 query/callback digests, 80 revision/reentry sequences,
and 160 moving-view frames with changing bounds/revisions and unknown heights.
A scalar surface independently checked cached measurements.

A separate audited clone rebuilt every hull position using the original
arithmetic and checked every component with `Object.is`; it also rebuilt the
ordered sphere and checked center/radius. The audit passed. A mutant omitting
nearest u/v from the sphere key failed that audit in 63 ms, establishing that
the guard detects the stale-sphere error even when plan comparisons do not.
Audit code is absent from the timed/browser/production candidate.

A permanent cached-sample regression covers nested queries, unknown heights and
fallback-bound changes without a revision. Existing golden digests were not
changed. The final engine suite passed 130 files / 1,401 tests, plus typecheck,
changed-file lint, build and consumer checks.

## Balanced timing

Five separately loaded arms ran six warmups and 30 rounds. Cyclic positions and
reversed order balance the five arms; there was no concurrent build/test/browser
load. Raw arrays and source identities are retained in [measurements.json](measurements.json).
The log prints the upper-middle median; the following medians use the average
of the two middle observations. Workloads measure selection plus loaded-detail
measurement, not frame rate or energy.

| Arm | Median ms | Paired improvement against unchanged control |
| --- | ---: | ---: |
| Baseline | 336.315 | −0.067% |
| Independent unchanged control | 337.175 | — |
| Corner positions | 325.460 | 3.02% |
| Corner + ready samples | 315.095 | 6.56% |
| All three | 299.715 | 10.87% |

The combination wins 28/30 pairs against each unchanged arm. Its paired
bootstrap 95% interval against control is 10.11–11.93%; the baseline/control
interval spans zero. These are empirical intervals for this captured workload,
not a guarantee about different flights. Earlier un-warmed eight-round results
were superseded by this run. Mercator normalization had inconsistent/slower
results and was not retained. Sphere reuse alone was inconclusive; the balanced
combined workload establishes the benefit of the final combination.

Scratch: `build/perf-selector-20261027/`; `combined.patch` is the exact production
patch. `combined-exactness.log`, `combined-mutant.log`, `combined-timing.log`,
`arm-identities.json` and `combined-statistics.json` identify the evidence.
The frozen combined source SHA-256 is
`9f47e69c57be9cce7ea52a13ac5e7e3171eb3167693ae837f0fcd2bd59a984cb`.

The [numeric audit patch](selector-numeric-audit.patch) and its
[missing-nearest-key mutant](selector-missing-nearest-mutant.patch) are retained
as documentation so the proof can be reconstructed after ignored scratch is
removed. Apply them with `git apply --unidiff-zero` only to an isolated test arm at
the recorded combined-source hash, never the shipping runtime.
The cache retains one sphere per existing hull; heap/power savings were not
measured and are not claimed.
