# Imagery binding continuation — 27 October 2026

Baseline engine `006034f`, clean source at entry. October 24 display-tree and
loaded-page improvements are included, rather than rediscovered. Scratch and
logs are in ignored `build/perf-binding-20261026/`.

## Rejected initial experiments

These experiments were timed first and rejected without promoting source or
spending further validation on candidates without a flight-workload gain.
There is no new source change or exactness claim for these candidates.

- Four-byte `Uint32Array` comparison, aligned larger tables only: captured 5,765
  flight tables took median 2.498 ms before and 2.537 ms after. Dense synthetic
  depth-six tables improved 6.840 to 2.056 ms, but only 202 captured tables had
  depth three or higher (194 at depth three, eight at depth four). The real
  population did not benefit. Log: `compare-timing.log`.
- Finding a patch node and inherited page together rather than two tree walks:
  captured full publishes took median 6.046 ms before and 6.228 ms after. A new
  result object appears to cost more than the short repeated traversal saves;
  that explanation is an inference, not a measured allocation attribution.
  Log: `path-timing.log`.
- Four ordered byte comparisons per loop iteration, retaining fractional tails:
  captured comparisons took median 2.484 ms before and 2.550 ms after. Reject.
  Log: `unroll-timing.log`.

All timings alternate arms. They are small isolated workloads, not FPS or power
results. No browser, build or other test ran during these measurements.

## Common-prefix insertion cache — rejected at wrap-up

`imageryBinding.prefix.ts` caches the previous insertion path in the display's
private page tree, starts the next insertion at the exact common prefix, and
skips ancestor flags already marked on that shared path. The tree never removes
nodes. `ancestorsOf` may add nodes between insertions but existing path indices
remain stable. The completed review and validation below supersede its initial prepared state.


The prepared prefix cache was independently reviewed and fully validated:
60 seeds × 248 mixed `make`/ancestor/find/page operations preserved node IDs,
children, flags, growth, marked/unmarked transitions and signed zero. All 160
captured flight displays, 400 randomized displays and 300 malformed fallback
cases matched byte-for-byte tables, metadata and callback counts. Logs:
`prefix-final-validation.log` and `prefix-final-exactness.log`.

Six warmups followed by 30 balanced cyclic/reversed rounds, each replaying the
captured full publish 80 times, gave upper-middle medians 490.280 ms baseline,
486.355 ms independent unchanged control and 482.220 ms prefix cache. The
candidate saves only 0.85% against control, while unchanged module identities
differ by 0.8%. The earlier 14-round result was similarly below 1%.
This is insufficient practical evidence for the additional cache state and
invalidation obligations. No production binding edit or browser arm was kept.
The validation is useful negative evidence; do not repeat it as an unmeasured
new idea. Source remains the entry baseline.
