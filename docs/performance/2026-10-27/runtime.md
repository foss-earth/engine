# Imagery runtime collections — October 27, 2026

Baseline engine `006034f`. The retained candidate changes private collection
work in `src/babylon/imagery/createImageryRuntime.ts`. No scheduling, measurement,
feedback publication, selection or residency policy is removed. Final browser
and commit disposition is recorded in the session handoff.

`syncDistribution` collects visible count and ordered bound patches in one pass
instead of array-copy/filter/flatMap. `refreshLoadedDetail` similarly builds its
ordered binding list in one pass. All patch objects belong to the runtime;
there is no external accessor/callback during either collection.

Already-deduplicated loaded tile keys are compared as exact string sets instead
of sorting and joining a canonical string each refresh. This is full membership
and cardinality equality, with no hashes. Tile coordinates are numeric and their
keys contain no comma, so this preserves the original canonical-string equality.
Key collection, surface revision read, conditional measurement, cache assignment
and distribution publication retain their order. Cache clearing replaces the
set, preserving revision/measurement reentry behavior. View and surface keys
still invalidate the measurement; a change of members at unchanged cardinality
also invalidates it. No binding-result cache or public interface was added.

## Validation and measurements

`build/perf-runtime-20261027/run-collections.sh` ran serialized on AC power.
3,000 ordered collector identity cases and 5,000 page-set/cache-clear/revision/
measurement cases matched; 4,464 measurement callbacks occurred in both arms.
The three actual runtime suites passed 46 tests against the combined frozen
candidate. The final full engine suite passed 130 files / 1,401 tests with
production source, plus typecheck, changed-file lint, build and consumer checks.

Two independent plain-Node cohorts each kept 30 rounds after three warmups,
alternating arm order. Every sample visited about 200,000 patch/page keys.
The synthetic collectors retain the resulting arrays and checksums; they do
not measure the selector, network, renderer or complete runtime.
Full medians and raw rounds are saved in [measurements.json](measurements.json).

| Isolated operation | Cohort 1 | Cohort 2 |
| --- | ---: | ---: |
| Distribution collection, 256 patches, 70% visible | 2.251 → 0.464 ms | 2.258 → 0.464 ms |
| Loaded bindings, 256 patches | 0.772 → 0.468 ms | 0.727 → 0.430 ms |
| Page-key equality, 64 moving pages | 17.451 → 15.368 ms | 16.412 → 14.505 ms |
| Page-key equality, 256 moving pages | 20.393 → 16.388 ms | 19.275 → 15.785 ms |
| Page-key equality, 1,024 moving pages | 25.203 → 15.845 ms | 24.149 → 15.426 ms |

Collector A/A controls varied by about 6%, much smaller than the retained
collection effect; page-key A/A varied 0.7–0.8%. Sixteen-page results were mixed
(−1.5% to +4.9%), so no improvement is claimed for that population. Two-page
keys improved about 15–18%; at 64–1,024 pages gains were about 11–38%.
These percentages apply only to the isolated operations, not overall runtime,
frame rate, memory footprint or power. The final browser cohort tests the three
engine changes together and cannot isolate this candidate's contribution.

A proposed pinned-key iterable/API change was never measured or applied and
is excluded. No additional runtime hypothesis was started during wrap-up.
