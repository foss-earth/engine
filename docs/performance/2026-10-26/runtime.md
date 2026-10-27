# Imagery runtime continuation — 27 October 2026

Historical preparation checkpoint. See the [completed October 27 investigation](../2026-10-27/runtime.md) for validation, measurements and final disposition.

Status: a frozen scratch candidate is prepared, with no production runtime edit
and no measurement yet. Source began clean at engine `006034f`; the held height
packing and other agents' owned paths are outside this runtime investigation.

The fresh C172 baseline profile's runtime source costs 15.5 ms/s self at 1× and
55.9 at 4×. `syncDistribution` costs 2.1/8.9 self and 23.2/76.7 inclusive ms/s;
these overlap its children. The profile is local research
`build/benchmarks/startup-audit/profile-fly-fresh-oct27-base/2026-10-27_002056/`.
It identifies a caller; one run cannot establish a new saving.

## First hypothesis: collect visible bindings in one pass

`syncDistribution` snapshots every patch, filters visible patches, then flatMaps
their bindings through a temporary array per bound patch. A single private-map
scan can count visible patches and collect the same binding references in the
same order. `refreshLoadedDetail` similarly snapshots, filters and maps the same
private fields; its binding collection can use one scan.

No cache is retained. The source check, measurements, publications, scheduling,
callbacks, revision checks and public snapshots remain in place. Private patch
fields are ordinary records maintained only by this runtime. No host callback
runs inside these collection loops.

## Frozen local material

Engine `build/perf-runtime-20261027/` is ignored:

- `before.ts`: frozen runtime, relative import paths adjusted only;
  SHA-256 `172777dc40ef20dcf381f44ee2e222885e9e0e71c8387007ebf63173c6a39553`.
- `collect.ts`: single-pass candidate;
  SHA-256 `6779401994a0a3e192c495405d3cb9f1f71d84b9b9b0ccf06eabefd3681569f2`.
- `collector-check.mjs`: binding reference/order/count differential over 3,000
  deterministic visibility, binding and map-order mutations.
- `collector-bench.mjs`: interleaved A/A and A/B for the collection operation,
  with different patch counts and visibility fractions. This measures only
  collection, not the entire runtime function or flight.
- `before.config.ts` and `collect.config.ts`: run the existing real selection,
  managed acknowledgement and continuity suites against each frozen arm.

After the root grants the machine-wide slot, from engine:

```sh
TMPDIR="$PWD/build/tmp" node build/perf-runtime-20261027/collector-check.mjs
TMPDIR="$PWD/build/tmp" node build/perf-runtime-20261027/collector-bench.mjs
TMPDIR="$PWD/build/tmp" ../node_modules/.bin/vitest run \
  --config build/perf-runtime-20261027/collect.config.ts
```

No source edit is justified before the operation is exact and faster, the actual
runtime suites pass, and a candidate browser comparison is frozen by the root.
