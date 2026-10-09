# Existing Location lookup adapter

This is an unbuilt, untested Engine source draft of the existing Earth Location lookup, extracted only from commit `90e23b3ee96f53ec5900afc5991a21fffa58649d`. The optional `@foss-earth/engine/location-provider` entry starts no request, DOM mount, renderer, timer or controller on import. It adds no Search tab or deferred Search repository. Public coordinates, result trees and React Location panels remain in the existing core/React entries.

The actual drafted contracts are:

| Export | Supplied authority and result |
| --- | --- |
| `SEARCH_DEFAULTS`, `SearchTuning` | Existing 24-hour retention, 64 answers and 20-second timeout; tuning uses milliseconds and entry count. |
| `readLocationSearchTuning(settings)`, `createLocationSearchTuning(settings)` | Read the one host UI registry on demand. The latter returns a getter; it registers no catalogue or singleton. |
| `createLocationLookupCache(ports)` | Requires storage or explicit `null`, an epoch-millisecond clock, tuning getter, native controller factory and abort-error factory. Returns `cachedLookup`, `aliasLookup` and idempotent `dispose`. |
| `createLocationLookupTransport(ports)` | Requires fetch, native cancellation/controller and signal-combination ports, request timers, a clock, tuning getter and timeout-error factory. Returns `json`, `wait`, clock and timer ports. |
| `createAirportLookup({cache,transport,copyAirports})` | Existing on-demand runway/elevation lookup. A deep-copy port keeps enrichment from mutating the retained base answer. Returns `searchAirports(code,signal)`; `AirportLookupProvider` is the structural replacement port. |
| `parseAirports`, `bearing`, `distance`, `isAirport` | Existing airport geometry/validation and data contracts, independent of aircraft placement or physics. |
| `createLocationSearch({cache,transport,airports,...contributions})` | Returns `searchLocations(query,signal)` and `nearbyAirports(lat,lon,signal,city?,contribution?)`. Results are `LocationSearchResult<AbortSignal>` from the core contract, with optional supplied metadata in `hostData`. |

Compose one cache and one Location provider per host. Both the Location and airport adapters use that same cache/transport; the Location provider owns its original serialized geocoder queue. Creating multiple providers would create separate queues and would not enforce a combined provider rate. The host must bind a stable epoch clock to persisted-cache timestamps; a monotonic clock can be used separately for transport delays. Both clocks and all timers remain host supplied. The cache creates request controllers only when work is requested, and disposal cancels pending consumers without removing stored answers.

Minimal host composition uses public entries only:

```ts
import { createLocationLookupCache, createLocationLookupTransport,
  createAirportLookup, createLocationSearch, createLocationSearchTuning }
  from '@foss-earth/engine/location-provider';
import { LOCATION_LOOKUP_PARAMETERS } from '@foss-earth/engine/settings';

settings.register(LOCATION_LOOKUP_PARAMETERS); // the host's existing UI registry
const tuning = createLocationSearchTuning(settings);
const cache = createLocationLookupCache({ ...hostCachePorts, tuning });
const transport = createLocationLookupTransport({ ...hostTransportPorts, tuning });
const airports = createAirportLookup({ cache, transport,
  copyAirports: hostCopyAirports });
const provider = createLocationSearch({ cache, transport, airports,
  queryContribution: hostQueryContribution,
  airportContribution: hostAirportContribution });
// Bind provider.searchLocations to the host Location panel using its native
// AbortSignal realm. Retire the shared cache at host shutdown: cache.dispose().
```

The required fetch port accepts a URL and `{signal}` and supplies `{ok,status?,json()}`. Signal combination returns `{signal,dispose()}`; the host owns its native realm and must return a nonthrowing timeout/abort-error value factory. Request and rate-wait cleanup attempt acquired timer/listener handles before settlement. One failed operation is preserved by identity; multiple operation/cleanup failures produce a causal `AggregateError`. Native AbortSignal event operations and controller semantics are required; a hostile custom signal/controller or a port throwing before returning its cleanup handle is not a qualified replacement. IO must honor supplied signals where possible; ignored cancellation cannot populate the cache after invalidation/disposal.

Existing records and homes are preserved:

| ID | Home | Unit | Bounds | Default |
| --- | --- | --- | --- | --- |
| `search.cacheDuration` | Interface → search → main | h | 0.01–720 | 24 |
| `search.cacheEntries` | Interface → search → main | count | 1–4096 | 64 |
| `search.timeout` | Interface → search → main | s | 1–300 | 20 |

The controls retain their original labels, reasons, 0.05 step, log2 scale and live behavior. The tuning getter preserves the original positive fallback and rounds entry count. The setting owner is Engine; the host retains the existing Interface tab/section contribution rather than inventing another copy. Persistence remains `foss-earth.location-lookups.v1`, an array of `{keys:string[],storedAt:number,value:unknown}`. Successful and empty answers persist; failures do not. Alias keys share one answer, one TTL and one LRU entry. Cache hits update recency but never stored time. Damaged, blocked or full storage falls back to memory. Caller cancellation leaves other consumers running; the final consumer aborts upstream work, and late answers are rejected before persistence. New instance creation represents the original module reload. Disposal retains persisted rows for rollback.

The existing request URLs, normalized geocoder cache keys, 1100 ms geocoder spacing, query options, city enrichment, nearby radius/limit/ranking and 12-result cap are retained. The first geocoder request is eligible immediately even when a supplied monotonic clock starts at zero; the old epoch clock masked its initial `0` timestamp. Cached answers bypass the rate queue. Timers exist only for requested work, with no independent refresh or render scheduler.

Airport lookup retains code validation, Overpass parsing and rejection of partial responses, usable runway geometry/direction/displaced-threshold filtering, IATA/ICAO aliases, copied optional elevation enrichment and retry of failed enrichment. Unknown elevation remains unknown; this extraction performs no datum conversion. Service schemas, availability, terms, quotas, attribution and current provider correctness have not been live-qualified by this source task. The fixed values above preserve the original calibration and provider behavior; no benchmark or new public-service policy claim is made.

The previous departure/arrival suffix and aircraft result fields are explicit host contributions. Engine's default query is trimmed text; `queryContribution` can return a stripped query plus opaque contribution. `airportContribution` receives the original airport summary or resolved airport plus that contribution and returns `hostData`. The supplied airport provider can replace the default network lookup. Flight owns `airportSpawn`, runway/preset interpretation, its draft codec, service attribution and any aircraft application. Engine imports no Flight implementation. `fixtures/composition/locationProviderHost.ts` exposes original metadata only as a source-assertion adapter, not as a production Flight module.

The original lookup-cache, Location search and persistence assertions are retained under `tests/location/`, including parameterized storage and alias cases. Four globe-only original airport cases are active source registrations. All five original airport assertions remain in `registerLegacyAirportSourceAssertions(ports)`; the aircraft placement case requires a real Flight-owned adapter and is inactive in Engine alone. Five added causal port/lifecycle cases and the public installed `fixtures/location-consumer.mjs` are prepared and **UNRUN**. No test pass or consumer adoption is claimed.

Rollback keeps the canonical Earth implementation until checked packed adoption passes, keeps existing persisted rows/defaults/homes, and binds original aircraft suffix/result behavior through the host adapter. No archived release or emitted declaration pin exists for this increment. The separate [React cache presentation](map-cache-presentation.md) is now prepared with required host cache/pulse/visibility/policy ports; it and the retained injected DOM cache section remain untested source.
