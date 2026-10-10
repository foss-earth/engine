# Current local displayed surface readiness

Status: source candidate prepared for Flight; changed runtime and fixtures are
unrun and require a separately granted bounded verification. Prior release
qualification applies only to the prior sealed bytes.

`createGlobeRuntime` now supplies `runtime.displayedSurface`. It owns current
local evidence from the same map triangles used by `runtime.surface`, with no
extra map, renderer, clock, selection, preparation or continuous loop.

```ts
import type { GlobeRuntime } from "@foss-earth/engine/babylon";
import type { CurrentSurfaceReadiness } from "@foss-earth/engine/core";

function observeGround(runtime: GlobeRuntime) {
  const observation = runtime.displayedSurface.observe({
    samples: [{ latDeg: 44.973, lonDeg: -93.235 }],
  });
  const unsubscribe = observation.subscribe((snapshot: CurrentSurfaceReadiness) => {
    // Host contact/preparation policy still decides whether quality is enough.
    if (snapshot.state !== "ready" || !observation.isCurrent(snapshot)) return;
    const sample = snapshot.samples[0];
    if (sample.status === "hit") {
      const coordinateHeightMeters = sample.height.meters;
      // physicalDatum remains "unknown"; no geoid conversion is implied.
      void coordinateHeightMeters;
    }
  });
  return { observation, dispose() { unsubscribe(); observation.dispose(); } };
}
```

Public types and the generic authority helper are exported through
`@foss-earth/engine` and `@foss-earth/engine/core`. The Babylon route also exports
the observation/locality types and the actual `GlobeRuntime` contract. The old
nullable query and supplied `createDisplayedSurfaceAccess` API remain available;
that compatibility adapter does not establish authoritative readiness itself.

## Local evidence and meaning

A locality contains 1–25 explicit, finite WGS84 latitude/longitude points.
Latitude is within −90…90 and longitude within −180…180. Inputs are copied and
validated before replacing an existing demand. `updateLocality` moves this
observation; it never creates a focus point or initiates terrain loading.
Hosts can use the existing `terrainReadinessSamples` to choose points, within
the bound. Readiness proves hits at the chosen points, not continuous coverage
of every point between them or of an entire globe/footprint.

`ready` requires a valid, finite displayed-triangle hit at **every** requested
point, in a consistent current geometry revision/source generation. A mesh
elsewhere, an idle queue, completed `prepareTerrain`, or a false streaming flag
cannot establish this fact. Each hit retains its mesh ID, normal, native quality
and Google geometric error where present. The height is explicitly a displayed
geometry WGS84 ellipsoid-coordinate height, with **unknown physical datum**.
No geoid, authoritative survey, contact safety, elevation accuracy, target detail,
GPU/device readiness or minimum-quality acceptance is implied.

Loading, suspension, public pause requests and the last owner load error are
separate diagnostics. `paused` records requests through `runtime.setPaused`;
`simulationRunning` records supplied `setExternalRunning`/`setSimRunning` state
or null outside simulation mode. Calling the borrowed scheduler's pause method
directly is outside this map owner's observations: no scheduler pause getter or
subscription is supplied, so this API does not claim that external state.
Usable retained geometry can be `ready` while loading, suspended or after another
tile fails. When a point is missing, state is `loading` during owner work,
`failed` after a reported owner error or local query failure, and `unavailable`
otherwise. Owner load errors/work are not localized to the requested points;
the per-point missing result does not assert that a particular request caused
the hole. Invalid/nonfinite hits and batches that change revision during query
are explicitly missing. An exception never becomes a synthetic ground height.

## Revision, source changes and lifecycle

Geometry `revision` is monotonic within the globe runtime. It changes with
Google visibility/replacement/disposal, raster adopted coverage (including its
last removal), committed terrain positions/seams, mesh replacement, map-owner
replacement/mode transition and runtime destruction. It does not change merely
because the aircraft moves, an incoming grid arrives, or imagery changes while
the terrain stays put. Raster query hits are normalized from the raster owner's
local counter to this same public global revision. Actual raster buffers and
their advertised `terrainZoom` are published together in the existing commit
path; pending or superseded DEM results cannot advertise new displayed quality.

A buffer/seam failure can leave changed CPU triangles even when the owner
operation throws. Its revision and observation are invalidated in that case,
with dirty work retained for retry and the original failure preserved. This
reports current query evidence; it does not qualify GPU upload success or make
a failed owner operation an accepted contact/preparation result.
If release of an outgoing rebuilt mesh throws, it is disabled and retained by
the same Engine owner for terminal cleanup rather than abandoning its handle.

`sourceGeneration` separately versions selection of Google/raster, a raster
provider ID/version/URL change, or a requested elevation provider change. URL
comparison stays private; snapshots never contain request URLs or keys.
The new observation error removes embedded request URLs entirely, including
credentials, signed paths, query strings and fragments. Legacy status/debug
diagnostics retain their existing behavior; other provider error text remains.
`selectedSource` names the selected policy source, while `displayedSources`
names the currently adopted map owners (`google` and/or `raster`). These owner
names do not establish the physical provenance of every retained outgoing
triangle. A requested elevation replacement can retain outgoing geometry.
Outgoing raster/Google triangles remain queryable during the normal source
handoff; retirement follows the existing map adoption path. A local hole after
retirement remains a hole even if geometry elsewhere is visible.

`sequence` versions meaningful changes for an observation, including local
demand, geometry/source, loading/error/suspension and terminal disposal.
`isCurrent(snapshot)` rejects an old retained snapshot after any such change.
It establishes current identity, not a host's time-based freshness/contact
policy. Snapshots and copied evidence are immutable. Reentrant publications are
queued after the captured callback batch so subscriber sequences stay ordered.
Unchanged owner frames do
not re-traverse the requested triangles or emit repeated callbacks.

The map's actual visibility/disposal/adoption, terrain commit, asynchronous load
and error events publish subscriptions while external simulation is paused.
Google's promise queues can decrement their job counters after a load-content
or model event; raster reservation retirement can similarly follow its grid
callback. Loading events therefore refresh immediately and coalesce **one**
post-settlement read with the existing injected `clock.after(..., 0)`. That read
starts no paint, loading, selection, preparation or recurring wakeup. It reads
the current owner, is cancelled on source supersession and destruction, and
does not replay an outgoing source snapshot. Suspension preserves usable hits.
The settlement handle is armed before calling the host port, so a synchronous
`after` callback cannot retain an already-finished handle or block later events.
A refresh listener that disposes the runtime prevents a subsequent timer arm.

`subscribe` immediately supplies the current snapshot and returns an idempotent
unsubscribe. Disposing an observation or the globe publishes one terminal
unavailable snapshot, detaches its listeners and rejects future observation
creation/locality updates. Callback failures are collected after all subscribers
are attempted; disposal still releases every observation. The host's borrowed
scene, renderer, clock and scheduler remain host-owned.

## Source fixtures and requested qualification

The new source fixtures are intentionally unrun:

- `tests/surfaceReadiness.test.ts`: bounded locality/holes, retained loading and
  suspended hits, immutable datum metadata, no settled repeated query work,
  geometry/source/currentness transitions, mixed-revision rejection,
  nonfinite/query failures, reentrant callback snapshots and disposal/unsubscription.
- `tests/createGlobeSurfaceReadiness.test.ts` and
  `fixtures/surface-readiness/mapHost.ts`: actual public globe wiring and real
  CPU triangle picks with supplied transport/traversal leaves; distant local
  holes despite visible/idle Google, paused removal/replacement, raster/Google
  handoff and same-ID imagery-version switch, one-shot queue-finally retirement,
  public pause/simulation state, async failure, disposal and event detachment.
  Synchronous injected settlement and disposal-during-refresh fixtures verify
  timer handback without adding implicit timers.
  These are not browser/GPU visual
  or native backend qualification.
- New causal cases in the existing Google/raster owner suites: asynchronous
  owner event hooks; terminal revisions; pending DEM buffers/quality remaining
  unchanged until commit; stale completion after elevation supersession; failed
  commit revision invalidation and all-attempt Google disposal.
- `fixtures/surface-readiness/public-consumer.ts`: strict TypeScript consumer of
  only public core/Babylon exports. Compile it against the newly built and
  installed candidate with `skipLibCheck: false`; old artifacts do not include
  these new exports.
- `fixtures/surface-readiness/public-consumer.mjs`: bare public core runtime
  import with browser-global poison, actual local hole/revision/source/currentness
  and disposal invariants; run against emitted build and newly installed archive.

The primary must request and receive a new bounded Engine grant before running
typecheck/lint, the four affected causal suites plus the existing globe lifecycle
suite, the full owner suite as needed for changed raster commitments, build,
strict installed consumer, packing and source/CI/full-ref seals. Use Node1 and
Vitest at most50%; preserve prior archives/logs. Actual browser/GPU/contact
validation and Flight's compiled application checks require their own recorded
scope. No current source candidate is claimed released or runtime-qualified.
