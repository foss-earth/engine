# Work prompt: fix the reproduced raster imagery detail collapse

**Done on 2026-10-08.** The correction, the explanations, §7's checks and the
§8 browser check are implemented and recorded in
[Map quality recovery](validation/map-quality-recovery.md#2026-10-07-late-missing-fallback-drops-resident-detail),
with the repository checks it ran. Kept as the record of what was asked.

Execute this task when the user gives you this prompt. Implement and validate
the correction; do not stop at a plan or at another reproduction.

Work in `/Users/felg/gh/foss-earth`, the owner of shared globe imagery and its
UI/logging. Read current `AGENTS.md` and these documents first:

1. [Implementation specification](proposals/imagery-detail-continuity.md).
2. [Reproduction and baseline](validation/map-quality-recovery.md#2026-10-07-late-missing-fallback-drops-resident-detail).
3. [Map detail contract](proposals/map-detail-control.md), especially selection,
   residency, binding and validation.
4. [Render on demand](render-on-demand.md), [UI layout](ui-layout.md), and
   [0sfs package boundary](../../0sfs/docs/foss-earth-relationship.md).

Inspect `git status` before editing. This checkout has unrelated sky work and
the new regression tests may be uncommitted/untracked. Preserve all of them;
do not reset, stash or overwrite other work. New shared modules belong in
FOSS Earth. 0sfs may only consume public exports and adapt its integration.

## Established defect

Flat basemaps can sharpen and then abruptly become coarse with Auto off and
no explanation. We now have three ordinary failing assertions, not merely a
suspected GPU budget issue:

- `src/engine/babylon/imagery/createImageryRuntime.continuity.test.ts` holds
  optional fallback tile `13/1544/3214` in flight while fine imagery loads.
  With a fixed USGS Imagery view, a delayed `ImageryMissingError` makes the
  same on-screen ground point's actual material binding drop from level 16
  to level 6. The atlas has free slots, no evictions, and unchanged settings.
  Successful and transient-error responses preserve detail.
- `src/terrain/imagery/imagerySelector.test.ts` has two failures for a missing
  ancestor one or three levels above resident selected leaves. Its control
  with no resident descendants correctly stops speculative refinement.

The causal path is `createImageryRuntime.demand` requesting optional ancestors,
then `imageryResidency` recording a missing result, then
`imagerySelector.decide` pruning that ancestor's whole subtree. The binding
correctly follows the new coarse plan and stops showing its finer residents.
The all-four-children-missing shortcut needs the same scrutiny.

The baseline full suite recorded 1,347 passing tests and these three failures
across 153 files; lint/typecheck passed and CI stopped before build. Recheck
the current files and preserve the failure before fixing. Do not skip tests,
mark them expected failures, weaken assertions or raise budgets/defaults.

## Implement

1. Repair the selector's inference with bounded, current, source/version/variant
   residency evidence. Preserve both resident selected descendants and sharper
   resident fallbacks on their paths. A missing image remains missing; its
   absence must not invalidate proven usable descendants. Previous split
   history or in-flight requests alone are not positive evidence.
2. Preserve conservative pruning of unsupported branches, source and binding
   ceilings, all resource budgets, intentional user coarsening, hysteresis,
   source switches, missing expiry and idle settlement. Keep evidence local
   to relevant paths and bounded. Do not make all cached fine images override
   a coarse selection in `imageryBinding`.
3. Handle partial loading, the all-children-missing shortcut, stale/evicted
   evidence and sliced traversals. A page arriving after traversal begins
   must not be shown and then discarded by a stale result. Check each
   publication, not just the final state; avoid endless restarts under loading.
4. Give genuine source, byte-budget, table-capacity, binding-depth and node-cap
   constraints structured, truthful explanations. Reuse raster feedback and
   the shared `connectMapDetailLog` where possible. Keep Auto events distinct.
   Show reasons in both the globe and 0sfs logs and beside existing Map settings.
   Aggregate transitions and recovery; no per-frame/tile spam or logging-only
   render loop. Report configured versus effective capacity and measured demand
   or a labelled lower bound; never invent exact required memory. Do not warn
   of detail loss for an optional missing tile whose descendants still serve it.
5. Add the spec's focused terrain-adoption and zoom/hold checks. The visible-only
   imagery height-bounds concern is unproven: change that production path only
   if a regression establishes the failure. Do not broaden into a renderer rewrite.

## Validate and finish

First run the two regression files, retaining output in a new dated `build/`
folder. Run affected tests while implementing, then the required incremental
typecheck and lint. Use at most half the cores, never alongside another suite.

Perform the spec's bounded, no-server headless browser correctness check with
synthetic level-encoded imagery and controlled responses. This prompt requests
that check on available WebGPU, WebGL 2 and WebGL 1 backends. Start from the
existing map-detail binding harness; inspect actual pixels/bindings and reject
empty captures. Use no provider network, user profile or visible browser. Await
Chrome close in `finally`. Report unavailable backends honestly. Do not run
performance sweeps, unrelated GPU benchmarks, phone checks or WASM builds.

When implementation is complete, run `npm run ci` once in FOSS Earth and once
in linked `/Users/felg/gh/0sfs`, serially with capped workers. Retain logs under
each owner's `build/`; never delete existing scratch/evidence. Diagnose failures
with affected-only reruns. Account for unrelated failures without modifying
unrelated features. Reinstall links only if their manifests changed.

Retain concise correctness evidence under `validation/evidence/map-detail/`.
Update `docs/validation/map-quality-recovery.md`, the spec status and this
prompt. Close the TODO only when continuity and explanations are delivered;
otherwise name the precise remainder. Do not deploy.

Finish with the cause, implementation, tests and browser results, remaining
limitations, and relevant file links. Distinguish the deterministic defect
from the user's uncaptured original session; do not attribute it to a commit
without evidence. Continue through the implementation and validation instead
of asking whether to begin.
