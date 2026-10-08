# Preserve displayed imagery detail and explain delivery limits

Status: implemented on 2026-10-08, from
[the work prompt](../imagery-detail-drop-prompt.md); specified 2026-10-07. The
three regressions pass. Each kind of limit is explained in the Map tab and in
the globe's and 0sfs's logs. §7's checks found and fixed three further defects:
shown terrain patches reverting to a parent, unreported limits around the
camera, and a still view reloading terrain. The §8 browser check passes on
WebGPU, WebGL 2 and WebGL 1, and its control fails without the selector
change. What passed, and what remains unproven about the original session:
[Map quality recovery](../validation/map-quality-recovery.md#2026-10-07-late-missing-fallback-drops-resident-detail).

Owner: FOSS Earth. This changes the shared globe's raster imagery selector,
streaming diagnostics and log connection. 0sfs consumes the public package;
it must not implement a second selector, fallback policy or explanation.

## 1. Problem and evidence

The user reports flat basemaps becoming sharper as tiles arrive, sometimes
reaching full detail, then suddenly collapsing to very coarse imagery. Frame
rate can be good, automatic adjustment can be off, and the log gives no cause.
The exact camera and network responses from that session were not captured.

A deterministic cause has now been reproduced with the real imagery selector,
residency manager, atlas allocator and material bindings. The
[runtime continuity test](../../src/engine/babylon/imagery/createImageryRuntime.continuity.test.ts)
uses the USGS Imagery descriptor, default imagery settings, a fixed view near
36.1° N, 112.14° W, and synthetic downloads. It holds optional fallback tile
`13/1544/3214` in flight while finer requested images finish. At a fixed point
whose tile centre is on screen, the material binds level 16. The held request
then reports `ImageryMissingError`. After the normal reselection delay the
same point binds level 6: ten levels, or 1,024 times coarser linear sampling.

The camera, surface, requested target and resource settings have not changed.
Automatic adjustment is off. There are free atlas slots and zero evictions.
Releasing the held request successfully or with a transient error preserves
level 16. Thus GPU budget pressure is not the cause of this reproduction.

The test reads copied page-table upload bytes and material uniforms after
every requested update. It does not infer delivery from the target, download
count, cached tile count or final settled state. NullEngine does not render
GPU pixels; that limitation remains explicit.

Two [selector tests](../../src/terrain/imagery/imagerySelector.test.ts) also
fail when an ancestor one or three levels above resident selected leaves
becomes missing. The no-resident-descendant control passes. The baseline full
suite has 1,347 passing tests and these three failures, across 153 files.
Lint and incremental typecheck pass; CI stops before its production build.
This is the recorded baseline, not a prescribed count for a changing checkout.

The [validation record](../validation/map-quality-recovery.md#2026-10-07-late-missing-fallback-drops-resident-detail)
contains the current reproduction. Neither the user's exact incident nor the
introducing commit is established. Earlier suspicion of `e900f3a` is a lead,
not an attribution.

## 2. Cause and relevant code

| Component | Current behavior and responsibility |
| --- | --- |
| `src/engine/babylon/imagery/createImageryRuntime.ts`, `demand` | Requests optional intermediate ancestors alongside fine leaves when the displayed fallback is far coarser. These responses may complete in either order. |
| `src/engine/babylon/imagery/imageryLoader.ts` | Maps a 404, 204 or blank image to `ImageryMissingError`; ordinary network failures use retry backoff. |
| `src/engine/babylon/imagery/imageryResidency.ts` | Tracks missing images by source/version/variant/tile and expires those records. A changed missing revision invalidates selection. |
| `src/terrain/imagery/imagerySelector.ts`, `decide` | Stops at a missing node, interpreting its missing image as evidence that nothing below it is useful. The all-four-children-missing shortcut makes the same inference. |
| `src/engine/babylon/imagery/imageryBinding.ts` | Publishes the selected leaves or their resident ancestor fallbacks. Finer cached descendants cannot override a coarser selection. This is also how intentional coarsening works. |
| `src/engine/babylon/imagery/createImageryRuntime.ts`, `publish` | Writes tables/direct bindings and pins displayed slots. Reports loaded detail separately from the active request. |
| `src/shell/mapDetailLog.ts` | `connectMapDetailLog` currently subscribes only to `onDetailAdjusted`, whose payload is an Auto frame-time decision. Source, memory and table constraints have no equivalent visible log event. |

The false inference belongs in the selector: one absent image does not
invalidate finer images that have already proved they exist. Changing the
binding layer to show every fine cached page would conceal that error and
break deliberate coarsening.

## 3. Required behavior

### 3.1 Continuity at an unchanged view

At unchanged view, source/version, surface and requested policy, successful
downloads and an optional ancestor's missing response must not discard finer
resident detail that still fits the existing budgets and binding capabilities.
Check every publication, including the interval before eventual recovery.

A missing record remains valid for the exact failed image. Do not erase it,
invent successful data, or retry it every frame. Resident descendant evidence
overrides the inference about its subtree, not the missing result itself.

Preserve the finest already usable fallback on affected selected paths as well
as fully loaded target leaves. A region that has reached level 13 while its
level-16 request is pending must not fall to level 6 merely because an optional
level-10 ancestor reports missing.

### 3.2 Boundaries that still apply

- A missing region with no evidence of usable descendants keeps the current
  conservative pruning behavior. Do not recursively probe all deeper levels
  at a coastline or outside coverage.
- Evidence is spatially precise: a resident descendant in one quadrant does
  not license speculative refinement throughout its three siblings.
- Source ID, version and variant remain part of identity. Evidence from an
  old source, a superseded generation or an evicted image is not proof of
  current residency.
- Source coverage/max level, the terrain binding's level ceiling, node and
  page budgets, request admission, staging and upload limits still apply.
- Coarser user requests, genuine view changes and normal hysteresis can still
  coarsen imagery. Do not permanently pin detail or make the slider ineffective.
- An explicit budget reduction can force lower detail. Preserve usable
  coverage during the change and explain the constraint. Do not increase
  budgets, provider ceilings or presets to make the failing test pass.
- Preserve source-switch readiness, exact missing-image expiry, transient
  failure backoff, context restoration and disposal behavior.

This is not an assertion that every map pixel always gets sharper while the
camera moves. Motion can expose different ground and change its sampling
requirements. Continuity assertions compare the same geographic region under
controlled conditions, rather than unrelated screen averages.

## 4. Selector implementation design

Use a bounded index of proven resident paths when a new traversal begins. The
preferred starting point is the last completed plan's selected leaves and
their ancestors, checked against current availability. Include resident
intermediate fallbacks on those paths, not only exact leaf images. Record
which branches lead to those resident images.

An equivalent index owned by residency is acceptable if it gives the selector
the same narrow, source-scoped evidence without coupling selection to GPU
objects. Choose the smaller change after inspecting the current code.

For a traversal encountering a missing node:

1. Apply source coverage and legal level ceilings as usual.
2. If there is no proven usable descendant path, retain conservative missing
   pruning and the existing source-limit behavior.
3. If such a path exists, allow traversal along it far enough to retain the
   resident image. Do not treat the ancestor's absent pixels as invalidating
   that descendant. Keep unsupported sibling branches bounded.
4. Apply the same evidence rule to the all-four-children-missing shortcut;
   otherwise that shortcut can still discard resident grandchildren.
5. Continue to apply normal projection, hysteresis and resource decisions.
   Missing evidence is not permission to exceed those decisions.

Do not use `previous.split` alone as the exception. A node can have split
before any descendant loaded; preserving all such branches defeats missing
coverage pruning. Likewise, do not make all cached images override the current
plan, or keep a global forever-growing set of once-seen tiles.

The index should be proportional to the bounded relevant plan/residency and
tile depth: for example, O(L × D) to build ancestor paths for L relevant leaves
of maximum depth D, then constant-time membership during traversal. Avoid a
scan of all leaves or all cache entries at every evaluated node. Share common
paths. Its storage and construction must respect the existing work budget;
if construction is appreciable, account for or slice it with selection work.
No new arbitrary retention limits or hidden performance tuning constants.

The traversal may span updates while downloads complete. Define when evidence
is snapshotted and what invalidates it. A safe implementation must not use an
evicted slot, miss a relevant completion forever, or reselect the entire view
for every unrelated download. Current `isResident` checks and a bounded
relevant-revision invalidation can be used; test the chosen lifecycle.

Reset or rebuild this evidence on source/version changes, selector reset,
atlas reallocation and context loss. Revalidate residency when reusing previous
plan paths. Keep settlement cheap: unchanged stationary updates must perform
no additional selection, uploads, table writes, log events or requested frames.

## 5. Explain genuine limits without misreporting the cause

Fixing the missing-ancestor inference is the first deliverable. The second is
the user's missing explanation: when a real source/resource/backend constraint
prevents or reduces delivery, the runtime must provide a useful reason in the
visible log and beside the controlling parameter.

### 5.1 Structured information

Keep `onDetailAdjusted` and its Auto decision semantics intact. Add a small
typed raster delivery/constraint state to the existing feedback contract and
use `getRasterDetailFeedback` / `onRasterDetailFeedback` if they suffice. A
separate narrow event is acceptable if needed to carry publication transitions;
do not add duplicate subscription machinery without a concrete reason. Expose
needed types through `foss-earth/runtime`. The contract is:

- Identify the active source and constraint category.
- Distinguish failure to meet a request from a demonstrated reduction in
  already displayed detail. Do not call every initial load a collapse.
- Identify the controlling parameter when one exists; include its configured
  value/unit and effective capacity where these differ.
- Include observed usage/demand or a measured lower bound sufficient to
  explain the limit. Mark estimates and lower bounds explicitly.
- Include affected-region count or other bounded scope information, and
  recovery/clearing state. Do not store an unbounded history in the runtime.
- Preserve `activeTarget`, `loadedTarget` and `effectiveTarget` meanings.
  Never substitute the requested target for measured delivery.

Build the state at the selection/residency/publication decision that knows
the cause. Reuse this state in feedback, diagnostics, settings readings and
logging. Do not infer causality solely from a falling `loadedTarget`: motion
and a change in visible-area weights can move that estimate.

The existing diagnostics' `plan.regions[].delivered` looks through the display
page map, and can miss a material's page-table exhaustion or depth fallback.
When claiming actual displayed loss, use the published binding information or
correct the diagnostic to account for it. The new continuity test deliberately
reads bindings for this reason.

### 5.2 Required distinctions

| Condition | Explanation and home |
| --- | --- |
| Selector's admitted pages reached | Name `map.imagery.gpuBudget`, configured MiB, atlas capacity and usable selection capacity after reserved coverage/headroom. A selection limit can be real even with free physical atlas slots. |
| Residency cannot admit/upload a required replacement | Report actual allocation pressure and pinned/replacement occupancy; do not conflate it with request queue length. |
| Page-table blocks exhausted | Name `map.imagery.pageTablePatches`, effective block count and count needed by visible multi-page patches. A configured count can be rounded by atlas layout. |
| Binding depth cannot address finer imagery | Explain the actual terrain patch level and imagery/table level ceiling. This is not the GPU byte budget. |
| Selector node cap reached | Name `map.imagery.maxNodes` and examined count; preserve coverage. Do not claim that increasing GPU memory resolves it. |
| Provider actually lacks requested visible imagery | Explain source availability in the Map detail status. Retain the best usable ancestor and expiry/retry behavior. |
| Optional missing ancestor with finer resident coverage | Preserve coverage; this alone is not a visible detail-loss warning or a limit on the fully served region. A bounded debug record may describe it. |
| Requests queued, uploading or temporarily backing off | Describe loading/retry progress. Queue overflow alone is not proof that GPU memory forced coarsening. |
| Explicit atlas replacement or context restoration | If detail must reload, explain that actual cause rather than labelling it Auto or generic memory pressure. Preserve existing readiness guarantees. |

Do not compute an unlimited ideal selection just to print how much memory
would be needed. Record what the bounded traversal actually establishes: e.g.
“at least N additional pages needed,” with the relevant reservation policy.
When the total is unknown, say so. Do not invent an exact required MiB value.

### 5.3 Log and settings integration

Extend the shared `connectMapDetailLog` connection to format the new state
transitions in the existing visible log. The globe and 0sfs already use this
helper. Both must receive explanations; 0sfs changes should be limited to
public API integration, mocks and composition tests where needed.

Log one warning when a limiting condition becomes active, one meaningful
update when its cause or configured limit changes, and one recovery message
when it clears. Aggregate affected tiles by cause. Do not print one line per
tile or frame, restart a warning for minor count fluctuations, or introduce
a periodic logger. Source changes must retire the old state; subscribers
must unsubscribe on disposal. Ordinary camera LOD changes and user slider
changes must not be described as unexplained automatic degradation.

Reuse the Map tab and `settings.setReadingSource` beside existing parameters.
For source availability or binding depth with no direct adjustable budget,
use the existing detail/status home and explain what limits it. Do not add
floating alerts, duplicate settings, a new diagnostics window or a new tuning
parameter merely to display this information. Follow the shared paragraph
grid and input behavior rules.

A useful message names the constraint, its value and observed consequence.
For example, with fixture-supplied numbers: “2D imagery is limited by the
page-table budget: 16 blocks available, 20 needed by visible patches. Four
patches are using coarser coverage.” Numbers must come from the actual state.
Do not call this a frame-time adjustment. Do not log URLs, keys, exact user
locations or other personal information in the explanation.

## 6. Required regression coverage

Keep the existing tests as ordinary assertions. No `.skip`, `.todo`, `.fails`,
weakened level checks, looser budgets, forced frame pumping or changed defaults
to hide the reproduction.

| Scenario | Required assertion |
| --- | --- |
| Existing delayed level-13 missing fallback | Every publication retains the already displayed level-16 page at the same probe. Missing record exists; reselection actually occurred. |
| Same response succeeds or returns transient error | Continuity remains; transient errors retain backoff semantics. |
| Missing ancestor one or three levels above resident leaves | Region-by-region selection retains usable detail; optional ancestor absence adds no false constraint to fulfilled coverage. |
| Partial loading | Retain already usable intermediate fallback and fine pages; unavailable branches still fall back safely. |
| All four children missing, with resident grandchildren | The shortcut does not erase those descendants; no unsupported sibling expansion. |
| No loaded descendants/coastline | Missing pruning still bounds requests and traversal. Prior split history by itself is insufficient evidence. |
| Requested leaf genuinely missing, with no usable finer coverage | Show its best usable ancestor and report a truthful source constraint. The ancestor-preservation fix must not fabricate full delivery. |
| Standard/variant availability differs | A missing standard image does not invalidate a verified resident denser variant at that tile; a missing variant does not invalidate usable standard/other variant imagery. Observe the requested variant policy and actual page levels. |
| Source/version switch, eviction, context reset | No reuse of stale evidence or cross-source slots. Late results do not alter the new source. |
| Sliced traversal with mid-traversal arrivals | Fine imagery published under the previous plan cannot be replaced by a stale coarse result built before those pages arrived. Revalidation terminates under sustained downloads. |
| Explicit coarsening and reduced budget | Intentional coarsening works and stays within limits; fallback coverage remains usable and a real constraint has an explanation. |
| Missing expiry/recovery while stationary | Existing wake/retry regression stays green; no reload or camera nudge needed. |
| Table exhaustion and node cap | Actual bindings and readings/log identify the correct constraint, including configured versus effective capacity. |
| Logging lifecycle | One entry per condition transition, truthful recovery, no frame/tile spam, no events from retired sources, clean unsubscribe. |
| Settled scene | No new selection, upload, table write, log line or frame request on unchanged updates. |

Reuse existing tests where they already establish an invariant. Add only the
missing assertions and scenarios; do not duplicate the whole runtime harness.
The relevant suites include `imagerySelector.test.ts`,
`createImageryRuntime.continuity.test.ts`, `createImageryRuntime.test.ts`,
`imageryResidency.test.ts`, `imageryBinding.test.ts`,
`createRasterTilesRuntime.atlas.test.ts`, shell detail tests and both apps'
composition tests.

For continuity assertions, measure geographic probes that remain visible and
compare actual delivered levels. Capture intermediate updates, not just the
settled endpoint. Keep deterministic downloads and a controlled clock; advance
the configured throttle/retry interval and follow requested frames. Source
network speed, screenshots' apparent sharpness and aggregate FPS are not the
correctness oracle.

The existing continuity test's injected clock stays constant within an update,
so it does not exercise traversal yielding. For the sliced case, advance the
clock within selection or inject a deterministic deadline that forces yields.
Deliver the relevant page between slices, record the fine publication, then
finish the traversal. An endpoint-only assertion would miss a temporary drop.

## 7. Bounded follow-up for the original intermittent report

There is a separate, unproven concern in
`createRasterTilesRuntime.imagerySurface.boundsFor`: it consults only visible
covering records. When a terrain parent becomes hidden as children replace
it, an ancestor query can fall back to `[-500, 9000]`. The nearby
`knownHeightBounds` already preserves cached ancestor bounds for terrain
selection. This could change imagery demand as elevation arrives, but the
current reproduction does not depend on it.

Add a focused integration check in the raster atlas suite: hold view, imagery
target and flat surface heights fixed, then release parent and child terrain
downloads in stages. Sample the same visible imagery probes through adoption.
If detail regresses, preserve that failing case and fix the actual bounds or
binding error in FOSS Earth without loading extra elevation to choose imagery.
If it passes, record it as passing coverage and leave the production path alone.
Do not declare this hypothesis a second root cause without a failing case.

Add a bounded zoom-in/hold sequence over the synthetic surface to exercise the
reported trigger. During the stationary hold, after full useful detail arrives,
late completions must not collapse it. During zoom, account for changed view
and source ceilings rather than asserting an impossible monotonic screen
average. Keep any forced resource reductions separately explained.

## 8. Browser correctness check

After the CPU regressions pass, extend the existing synthetic binding fixture
or add a small validation fixture under `scripts/validation/` that drives the
same delayed-fallback sequence and captures the affected ground before and
after the missing response. Start from
[the map-detail binding harness](../../benchmarks/map-detail/README.md) and
[the no-server harnesses](../validation/README.md). The executing work prompt
explicitly requests this bounded correctness check.

Use identity/level-encoded synthetic imagery and controlled responses. Wait
for drawable materials, reject empty captures, and read pixels plus selected,
resident and bound levels. Run the affected fixture on available WebGPU,
WebGL 2 and WebGL 1 backends; record a backend that cannot run as unavailable,
never as a pass. Confirm the renderer in the report. This is a correctness
check, not an FPS, GPU throughput or device qualification benchmark.

No provider requests, Google key, visible browser, user profile or dev server
is needed. Close Chrome in `finally` with the harness's awaited close; never
kill it after close. Follow [Chrome cleanup policy](../validation/chrome-code-sign-clones.md).
Keep profiles, generated files and logs under the owning repository's dated
`build/` folder. FOSS Earth's helper is `scripts/lib/outputDirectory.mjs`.
Copy only the concise retained evidence to
`validation/evidence/map-detail/<date>-imagery-continuity/` and link it from
the validation document. Record source revision/dirty paths, fixture inputs,
backend and assertions; do not publish raw user state.

## 9. Execution order, checks and completion

1. Read current instructions, inspect `git status` and the regression files.
   The checkout contains unrelated sky work. Preserve it and the existing
   reproduction; do not reset, stash or commit unrelated edits.
2. Re-run the two failing files once with output under a new dated `build/`
   directory. Confirm the same causal failure, not a harness failure. The
   three failures are a known baseline, not unrelated breakage to skip.
3. Implement the selector correction with the partial/stale-evidence guards.
   Run affected tests; fix a failing file directly instead of repeating suites.
4. Add structured constraint state and shared explanation integration. Test
   runtime publication, settings readings, log transitions and both hosts.
5. Complete the terrain-adoption and zoom checks, then the bounded browser
   correctness fixture. Resolve newly reproduced defects in the owning code.
6. Run incremental `npx tsc -b`, related Vitest tests with
   `--maxWorkers=50%`, and lint for changed code. At completion run
   `npm run ci` once in FOSS Earth and once in the linked 0sfs checkout,
   serially, capping workers at half the cores. No concurrent suites.
   Reinstall only if the package/link manifests actually changed. No forced
   typechecks, cache deletion, WASM builds or broad performance sweeps.
7. Update the validation record, this spec's status and the work prompt with
   what actually passed. Remove/close the TODO only if continuity and visible
   explanations are both delivered; otherwise state the precise remainder.

Completion requires the three original regressions green, the new edge cases
covered, bounded work with idle settlement, preserved intentional coarsening,
truthful visible explanations in both applications, recorded browser evidence
or an explicit environmental limitation, and both required repository checks
accounted for. Report unrelated check failures separately with their evidence.
Do not silently relax assertions to obtain green CI.

This task does not authorize a deployment, a rewrite of the map renderer,
provider policy changes, a generic telemetry system, or changes to aircraft,
flight dynamics, sky lighting or controller handling. A concise final report
must distinguish the deterministic defect fixed from the original session
that was not captured.
