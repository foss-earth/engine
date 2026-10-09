# Map cache presentation contracts

This source-only increment retains immutable Earth's `src/shell/MapCachePanel.tsx` from `90e23b3ee96f53ec5900afc5991a21fffa58649d`. It is prepared and **UNRUN**. No dedicated original MapCachePanel test file exists in that input; the existing managed-cache tests remain unchanged, and new cases exercise the actual React component and Engine cache through supplied ports. It creates no cache, renderer, timer or independent frame authority.

`MapCachePanel` and `MapCachePanelProps` are public at `@foss-earth/engine/react`. The former keeps its name and original class/heading/text structure; its old no-argument singleton contract is deliberately replaced by required host composition:

| Required prop | Authority |
| --- | --- |
| `cache: MapCacheAccess` | The existing public Engine cache's `inspect()` and `clear()` methods. The host constructs/configures one cache and supplies it; the panel constructs none. |
| `refresh: {subscribe(listener): stop}` | The existing shared presentation pulse. No private setInterval/RAF is used. |
| `visibility: {isVisible():boolean,subscribe(listener):stop}` | Host tab/content visibility. Hidden panels start no inspection or clear action. Reopening asks for an immediate inspection; the host owns actual DOM/window visibility. |
| `nowMs()` | The same host monotonic presentation clock, used only for cadence. Persisted tile freshness remains the existing cache's epoch-clock responsibility. |
| `policy: MapCachePresentationPolicy` | Live `rowLimit()` and `refreshIntervalMs()` getters, bound to the one host settings registry. |

`createMapCache` at `@foss-earth/engine/browser` already supplies the public inspect/clear API. `MapCacheAccess`, policy/refresh/visibility types, defaults, IDs and `createMapCachePresentationPolicy(settings)` are public through `./settings` and `./panels`. No default registry or catalogue is registered by the helper. The primary alone must register and bind the new Engine catalogue in the canonical application.

| New named ID | Home | Unit | Bounds | Retained default |
| --- | --- | --- | --- | --- |
| `map.cache.rowsShown` | Map → loading → all | count per provider | 1–4096 | 40 |
| `map.cache.inspectInterval` | Map → loading → all | ms | 250–60000 | 2000 |

`MAP_CACHE_PRESENTATION_PARAMETERS` preserves the previous 40-row and two-second behavior while exposing their costs. Row count is floored; invalid supplied values use the original defaults. Cadence is a minimum on the host pulse, not a promise of an independently scheduled inspection. Bounds are editable presentation policy, not a device measurement or provider quota. No prior saved record exists for these formerly fixed costs, so no invented record migration is added. Existing cache limit IDs and saved tile namespaces are unchanged.

`createMapCacheSection` remains public at `./panels` with its original DOM classes. It now requires `rowLimit()` alongside its existing injected cadence/clock/refresh ports; pass the same policy's getters to both presentations. A visible pulse updates a changed row limit without another cache inspection. All entries still contribute to provider count and byte totals; only displayed rows are limited. The original generic DOM section and its existing late-clear assertions remain intact.

Typical host binding uses public entries:

```tsx
import { MapCachePanel } from '@foss-earth/engine/react';
import { MAP_CACHE_PRESENTATION_PARAMETERS, createMapCachePresentationPolicy }
  from '@foss-earth/engine/settings';
import { createMapCacheSection } from '@foss-earth/engine/panels';
import '@foss-earth/engine/map-cache.css';
import '@foss-earth/ui/styles.css';

settings.register(MAP_CACHE_PRESENTATION_PARAMETERS);
const policy = createMapCachePresentationPolicy(settings);
const reactContent = <MapCachePanel cache={mapCache} policy={policy}
  refresh={hostRefresh} visibility={hostMapVisibility} nowMs={hostNowMs} />;
const domContent = createMapCacheSection({ document: hostDocument,
  inspect: mapCache.inspect, clear: mapCache.clear, refresh: hostRefresh,
  nowMs: hostNowMs, rowLimit: policy.rowLimit,
  refreshIntervalMs: policy.refreshIntervalMs });
```

These are alternative host presentations of one existing cache, not an instruction to mount a duplicate setting/tab. Each setting keeps its one Map/loading home. Stable supplied cache/pulse/visibility/clock/policy identities avoid unnecessary detach/rebind; changed bindings retire their old session before accepting new answers.

The React panel retains provider grouping, counts/bytes/expiration rows, availability/empty text, progress, clear status, browser-request counts and the distinction between managed storage and browser HTTP caching. Its budget summary and explanatory note now use actual `snapshot.maxBytes` instead of the obsolete fixed 128 MB claim. Clearing saved tiles keeps tiles already in the scene visible; it cannot enumerate or clear browser-managed HTTP cache. The existing Engine cache's public-request admission continues to exclude Google/keyed/signed/session URLs. The panel displays URL pathname only, never credentials/query/fragment, and never inserts provider errors into status text. This is not a guarantee for arbitrary host-crafted path/provider strings; use the supplied existing Engine cache.

Inspection is deduplicated. Clear actions lock synchronously before React commits, invalidate older inspection publication and read the post-clear answer only while still mounted and visible. A requested clear itself may finish after hiding/unmounting because the existing cache clear method has no cancellation port; it performs no late panel inspection/state update. Cache-binding replacement retires old answers. Both refresh/visibility subscriptions are detached even if one acquired stop throws; single cleanup errors retain identity and multiple errors aggregate. Native/pulse port callbacks should be nonthrowing, stable and synchronous at their documented boundaries. The host owns side effects of a subscription constructor throwing before returning its stop handle.

`./map-cache.css` contains only the original React `.foss-earth-map-cache` rules and a scoped tile selector from mixed `src/styles/hud.css`. No generic `.foss-earth-map-cache-section` rule is copied into Engine; those shared list/progress styles are UI-owned at the new `@foss-earth/ui/styles.css` source entry. Class names and original React cache spacing/progress/button/details/list/note styles are retained. That UI stylesheet and its new contracts need a checked current artifact; no old frozen archive is equivalent.

Ten source cases in `tests/MapCachePanel.test.tsx` cover actual-cache provider/policy/budget behavior, shared visibility/pending inspection, repeated clear/stale answers, hidden/unmounted clear, binding replacement, unavailable/empty/secret-free presentation, inspection and clear failures/retry, partial subscription setup and all-stop detach. One added DOM case covers shared live row policy without extra inspection, retaining the prior three DOM lifecycle cases. `fixtures/map-cache-consumer.mjs` prepares a real installed public React/cache/policy/CSS host fixture with fake IO and explicit host subscriptions. `fixtures/publicEntries.ts` covers actual public declaration names. The existing guarded installed consumer copies and runs this fixture in its isolated workspace only after a separately granted slot and exact full archive closure. No fixture/check/import has run here, and no consumer adoption/platform qualification is claimed.

Rollback keeps canonical Earth and prior artifacts until packed checked adoption passes, retains managed cache rows/limits/browser behavior, and returns to original 40/two-second presentation when new policy controls are absent. The old no-argument component must remain in the old app until the primary injects these required ports; no hidden singleton fallback is supplied. New source/declarations/CSS pins, original tests, shared conformance, actual intended-ref audit, checked UI source artifact and remote admission remain acceptance gates.
