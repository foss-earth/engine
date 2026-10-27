# Final browser comparison — October 27, 2026

Six profiles completed before the user’s final stop request. Each window began
with the real C172 aircraft assets ready, no fallback, and engine running. The
bundles share the same 904-file source snapshot; only the three retained engine
candidates differ. Cold and warm visits precede 30 seconds each at 1× and 4× CPU.
Order: baseline/candidate, candidate/baseline, baseline/candidate. Matching source
maps belong to each arm. Raw numeric results and exact source hashes are in
[browser-results.json](browser-results.json).

| Pair | Arm | 1× FPS | 4× FPS | 1× owned self ms/frame | 4× owned self ms/frame |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 59.63 | 56.05 | 1.216 | 4.184 |
| 1 | Candidate | 59.66 | 52.93 | 1.150 | 4.279 |
| 2 | Baseline | 59.62 | 56.02 | 1.226 | 4.238 |
| 2 | Candidate | 59.55 | 56.89 | 1.132 | 3.781 |
| 3 | Baseline | 59.66 | 35.13 | 1.929 | 10.623 |
| 3 | Candidate | 59.64 | 56.25 | 1.125 | 4.007 |

Owned self time adds non-overlapping selector, geometry, runtime and height-pixel
file samples, divided by frame count. Inclusive costs are not summed.
At 1×, the first two pairs reduce this targeted cost about 5–8%; the third has
a much more expensive baseline. The 4× first pair regresses slightly in this
aggregate, the second improves, and the third baseline again differs greatly.

The browser cohort is a successful readiness/build/runtime check, but visit-to-
visit workload variation is too large for a precise whole-flight improvement
or FPS claim. In particular, the 35.13 FPS third baseline must not be presented
as a representative control proving a 60% frame-rate gain. Asset readiness
does not establish identical imagery residency, height availability, selector
node count, thermal state or layout work. No memory/power gain is established.

The source changes are retained on independent, exact captured-workload and
balanced synthetic evidence, with full engine regression/type/consumer checks.
Their individual contribution is not isolated by this combined flight arm. A
future whole-flight performance claim needs a more stable paired workload;
this is recorded as optional off-hours work, not a running task.

After the last run, all Chrome clones were cleaned and the shared measurement
lock was released. No test, build, browser benchmark or server remains running.
