# Selector cached-sample candidate — prepared, unrun

Historical preparation checkpoint. The completed investigation and final
disposition are in [the October 27 report](../2026-10-27/selector.md).

Prepared on 26 October 2026 against engine `006034f`. The selector source is unchanged from
`497e013`; the working tree was clean at capture. The October 24 display-tree, loaded-page and
height-key changes are already present and are not part of this experiment.

**Status: unmeasured and unvalidated. No runtime or permanent test source changed.** The shared
measurement lock remained owned by the earlier `perf-oct24` session, so no benchmark, test,
build or browser run was started. There is no speed, exactness, rendering or FPS result.

## Hypothesis and prepared candidate

`surfaceSamples` currently computes lattice indices, calls `Map.has` for every point to choose
height-query slots, and then calls `Map.get` for those same cached points to return samples.
The scratch candidate gathers existing records with `Map.get` first. If every point is known,
it reuses those records directly and omits slot construction. If any point is missing or off the
lattice, it follows the complete reference path, including its height callback and later lookups.
It retains the original lattice computation, revision lookup, fallback checks and Float64 math.

The candidate is an investigation rather than a proposed source change. Gathering records in
advance still needs adversarial review: a tile accessor invoked while rebuilding a sample could
reenter selection and replace a later record. The benchmark must also show whether the miss-path
preflight overhead outweighs saved lookups. Do not promote it on allocation counts alone.

The previously rejected screen-area loop and delayed-hull rewrites were not repeated.

## Reproduction material

All scratch lives in ignored `engine/build/perf-selector-20261026/`:

- `baseline-identities.json`: baseline commit and SHA-256 identities of selector, geometry and
  camera-math source;
- `baseline/` and `candidate/`: independent captured selector dependencies and the one-file
  candidate;
- `shared.ts` and `selection.test.ts`: moving-view selection/measurement workload adapted from
  `build/evq/`, with eight alternating rounds over four view types;
- `identity.test.ts`: the existing identity suite, copied to import the scratch candidate with
  both shipped golden digests unchanged;
- `fixtures.ts` and `differential.test.ts`: 80 deterministic cases comparing complete plan
  digests, callback order and Float64 query digests across cached reuse, unknown heights,
  revision invalidation and a nested measurement callback;
- `vitest.config.ts`: the scratch-only configuration, one test worker.

No browser arms, source maps or profile identities exist for this candidate.

After obtaining the exclusive measurement slot and checking for older uncoordinated runs,
from `~/gh/foss-earth/engine`:

```sh
mkdir -p build/tmp
TMPDIR="$PWD/build/tmp" ../node_modules/.bin/vitest run \
  --config build/perf-selector-20261026/vitest.config.ts differential identity
TMPDIR="$PWD/build/tmp" ../node_modules/.bin/vitest run \
  --config build/perf-selector-20261026/vitest.config.ts selection \
  > build/perf-selector-20261026/selection.log 2>&1
```

Review the reentrancy concern before treating successful fixture tests as proof. If correctness
holds and the interleaved microbenchmark wins, request controlled pinned flight arms from the
measurement coordinator. Compare selection and loaded-detail measurement separately. Preserve
all existing identity digests and callback/publication cadence; do not add a cache of an old view.
