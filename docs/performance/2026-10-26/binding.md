# Table comparison candidate prepared, not measured

Historical preparation checkpoint. The completed investigation and final
disposition are in [the October 27 report](../2026-10-27/binding.md).

Baseline: engine `006034f`, with a clean working tree before this continuation.
Read the October 24 `display-tree.md`, `loaded-pages.md` and `height-keys.md`
reports before using the older October 22 handoff. Those improvements are already
committed and must stay in the baseline.

The candidate compares each four-byte table cell as one `Uint32Array` word for
integer table depths 3–6 with aligned, whole-word input arrays. Small, fractional,
unaligned and partial-word arrays retain the byte comparison. Word equality is
independent of host byte order. It introduces two temporary views per call, so
the captured-flight benchmark must establish whether larger comparisons offset
that allocation cost. It does not hash the data or change publication cadence.

The source tree is unchanged. Local ignored reproduction files are under
`build/perf-binding-20261026/`:

- `imageryBinding.before.ts`: current captured source with local imports adjusted.
- `imageryBinding.work.ts`: candidate, with the same adjusted imports.
- `compare.test.ts`: byte-mutation comparisons for aligned, unaligned, short,
  fractional-depth and NaN-depth inputs; captured flight table comparisons; and
  alternating before/after timings for the captured flight and each table depth.
- `vitest.config.ts`: isolated configuration with a repo-local cache.

No correctness tests, timings, builds or browser runs have run. There is no gain
or exactness claim and nothing is ready to commit. The new scratch differential
must itself be reviewed before its results are used.

The shared measurement lock still names `perf-oct24`, started October 24. Its
legacy shell PID 69184 is absent, and the measurement-process status reports
none. The current `research/scripts/benchmarks/startup-audit/perf-lock.mjs`
explicitly requires user approval before removing another session's lock. That
approval was requested during this continuation and is pending. The lock was
left untouched.

After the coordinator resolves the lock and assigns the exclusive slot, run
from `foss-earth/engine`:

```sh
mkdir -p build/perf-binding-20261026/tmp
TMPDIR="$PWD/build/perf-binding-20261026/tmp" \
  ../node_modules/.bin/vitest run \
  --config build/perf-binding-20261026/vitest.config.ts
```

Reject the edit if the real captured table population shows no repeatable gain.
If it wins, add permanent coverage, run focused checks, and compare immutable
browser arms before applying it to the tracked source. The October 24 flight
snapshot and its override map are under `fly/build/perf-oct24/`; never overwrite
that evidence or use another arm's source maps.
