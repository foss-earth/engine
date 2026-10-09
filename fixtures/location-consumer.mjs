/** Public installed adapter smoke; all IO/cancellation/timers/storage are explicit. */
import assert from "node:assert/strict";
import { createLocationLookupCache, createLocationLookupTransport, createAirportLookup, createLocationSearch, SEARCH_DEFAULTS } from "@foss-earth/engine/location-provider";
let now = 1_800_000_000_000, fetches = 0, nextTimer = 0;
const timers = new Map(), storage = new Map(), tuning = () => ({ cacheMs: SEARCH_DEFAULTS.cacheHours*3600000,cacheEntries: SEARCH_DEFAULTS.cacheEntries,timeoutMs: SEARCH_DEFAULTS.timeoutSeconds*1000 });
const cache = createLocationLookupCache({ nowMs: () => now,tuning,storage: { getItem: key => storage.get(key) ?? null,setItem: (key,value) => storage.set(key,value) },createAbortController: () => new AbortController(),abortError: message => new Error(message) });
const transport = createLocationLookupTransport({ nowMs: () => now,tuning,fetch: async url => { fetches++;return { ok: true,json: async () => url.includes("nominatim") ? [{ place_id: 1,display_name: "Fixture city",lat: "45",lon: "-93",addresstype: "city" }] : { data: [] } }; },
  timers: { setTimeout: callback => { const id=++nextTimer;timers.set(id,callback);return id; },clearTimeout: id => timers.delete(id) },
  createAbortController: () => new AbortController(),combineSignals: signals => ({ signal: AbortSignal.any(signals),dispose() {} }),timeoutError: () => new Error("timeout") });
const airports = createAirportLookup({ cache,transport,copyAirports: value => structuredClone(value) });
const lookup = createLocationSearch({ cache,transport,airports });
try {
  const signal = new AbortController().signal;
  assert.equal((await lookup.searchLocations("45, -93",signal))[0].id,"coordinates");assert.equal(fetches,0);
  const city=(await lookup.searchLocations("Fixture city",signal))[0];assert.equal(city.kind,"city");assert.equal(fetches,1);
  assert.equal((await lookup.searchLocations("FIXTURE  CITY",signal))[0].id,city.id);assert.equal(fetches,1);
  assert.deepEqual(await city.loadChildren(signal),[]);assert.equal(fetches,2);assert.equal(timers.size,0);
  assert.ok(storage.has("foss-earth.location-lookups.v1"));now+=1;
} finally { cache.dispose(); }
console.log("Public Location provider/cache explicit-port offline smoke passed; no real provider requests.");
