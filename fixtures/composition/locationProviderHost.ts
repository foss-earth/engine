/** Source assertion adapter only. Production receives these ports from its host. */
import { createLocationLookupCache, createLocationLookupTransport, createAirportLookup, createLocationSearch,
  type LocationSearchPorts, type LocationLookupTransportPorts } from "../../src/location-provider.js";
import type { LocationSearchResult } from "../../src/location/contracts.js";
import type { Airport } from "../../src/location/provider/airportTypes.js";
export function createLocationProviderFixture(options: { storage?: Storage | null; tuning?: () => { cacheMs: number; cacheEntries: number; timeoutMs: number }; fetch?: LocationLookupTransportPorts["fetch"] } = {}) {
  const tuning = options.tuning ?? (() => ({ cacheMs: 60_000,cacheEntries: 64,timeoutMs: 1000 }));
  const cache = createLocationLookupCache({ storage: options.storage === undefined ? globalThis.localStorage ?? null : options.storage,
    tuning,nowMs: () => Date.now(),createAbortController: () => new AbortController(),abortError: message => new DOMException(message,"AbortError") });
  const transport = createLocationLookupTransport({ tuning,nowMs: () => Date.now(),fetch: options.fetch ?? ((url,options) => fetch(url,options)),
    createAbortController: () => new AbortController(),combineSignals: signals => ({ signal: AbortSignal.any([...signals]),dispose() {} }),timeoutError: () => new DOMException("Lookup timed out.","TimeoutError"),
    timers: { setTimeout,clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) } });
  const airports = createAirportLookup({ cache,transport,copyAirports: value => structuredClone(value) as Airport[] });
  const contributions: Pick<LocationSearchPorts,"queryContribution" | "airportContribution"> = {
    queryContribution(text) { const suffix = text.trim().match(/^(.+?)\s+(departure|arrival)$/i); return { query: suffix?.[1] ?? text.trim(),contribution: suffix?.[2].toLowerCase() }; },
    airportContribution: ({ airport,contribution }) => ({ airport,airportMode: contribution }),
  };
  const location = createLocationSearch({ cache,transport,airports,...contributions });
  type LegacyResult = Omit<LocationSearchResult<AbortSignal>, "loadChildren" | "resolve"> & { airport?: Airport; airportMode?: unknown; loadChildren?: (signal: AbortSignal) => Promise<readonly LegacyResult[]>; resolve?: (signal: AbortSignal) => Promise<LegacyResult> };
  const legacy = (result: LocationSearchResult<AbortSignal>): LegacyResult => {
    const data = result.hostData as { airport?: Airport; airportMode?: unknown } | undefined;
    return { ...result,...data,
      loadChildren: result.loadChildren ? async signal => (await result.loadChildren!(signal)).map(legacy) : undefined,
      resolve: result.resolve ? async signal => legacy(await result.resolve!(signal)) : undefined };
  };
  return { cache,transport,airports,location,searchAirports: airports.searchAirports,
    searchLocations: async (text: string,signal: AbortSignal) => (await location.searchLocations(text,signal)).map(legacy),
    nearbyAirports: async (lat: number,lon: number,signal: AbortSignal) => (await location.nearbyAirports(lat,lon,signal)).map(legacy),dispose: () => cache.dispose() };
}
