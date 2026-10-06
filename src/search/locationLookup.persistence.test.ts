import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./searchTuning", () => ({ searchTuning: () => ({ cacheMs: 60_000, cacheEntries: 64, timeoutMs: 1000 }) }));
const signal = () => new AbortController().signal;
const city = { place_id: 1, display_name: "Minneapolis, Minnesota", lat: "44.97", lon: "-93.26", addresstype: "city" };
const elements = [
  { type: "way", id: 1, center: { lat: 45, lon: -93 }, tags: { aeroway: "aerodrome", icao: "KMSP", iata: "MSP", name: "Minneapolis-Saint Paul" } },
  { type: "way", id: 2, tags: { aeroway: "runway", ref: "35/17" }, geometry: [{ lat: 45, lon: -93 }, { lat: 45.02, lon: -93 }] },
];
const response = (value: unknown) => ({ ok: true, json: async () => value });

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("restores geocoding, nearby airports, runways and elevation without network requests", async () => {
  const fetcher = vi.fn(async (url: string) => response(url.includes("nominatim") ? [city]
    : url.includes("nearby") ? { data: [{ code: "KMSP", iata: "MSP", name: "Minneapolis-Saint Paul", latitude: 45, longitude: -93, type: "large_airport" }] }
      : url.includes("overpass") ? { elements } : { data: { elevation: 256 } }));
  vi.stubGlobal("fetch", fetcher);
  const first = await import("./locationSearch");
  const locations = await first.searchLocations("Minneapolis departure", signal());
  const airports = await locations[0].loadChildren!(signal());
  const selected = await airports[0].resolve!(signal());
  expect(selected).toMatchObject({ airportMode: "departure", airport: { code: "KMSP", elevationMeters: 256 } });
  expect(selected.airport!.runways.find(runway => runway.label === "35")?.elevationMeters).toBe(256);
  expect(fetcher).toHaveBeenCalledTimes(4);
  vi.resetModules();
  const reloaded = await import("./locationSearch");
  const restored = await reloaded.searchLocations("Minneapolis departure", signal());
  const nearby = await restored[0].loadChildren!(signal());
  expect(await nearby[0].resolve!(signal())).toEqual(selected);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("serves geocoder cache hits immediately while another request is waiting for the rate limit", async () => {
  const fetcher = vi.fn(async () => response([city]));
  vi.stubGlobal("fetch", fetcher);
  const { searchLocations } = await import("./locationSearch");
  await searchLocations("cached city", signal());
  const waiting = searchLocations("another city", signal());
  expect(await searchLocations("CACHED  CITY", signal())).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1100);
  await waiting;
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("accepts absent provider metadata without discarding usable nearby airports", async () => {
  const fetcher = vi.fn(async () => response({ data: [{ code: "KMSP", iata: null, icao: null, name: "Minneapolis-Saint Paul",
    latitude: 45, longitude: -93, type: "large_airport", municipality: null, region_name: null, country_name: null }] }));
  vi.stubGlobal("fetch", fetcher);
  const { nearbyAirports } = await import("./locationSearch");
  expect(await nearbyAirports(1, 2, signal())).toMatchObject([{ id: "airport:KMSP", label: "KMSP · Minneapolis-Saint Paul" }]);
  await nearbyAirports(1, 2, signal());
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(["MSP", "KMSP"])("shares runway geometry and elevation between IATA and ICAO codes starting with %s", async firstCode => {
  const fetcher = vi.fn(async (url: string) => response(url.includes("overpass") ? { elements } : { data: { elevation: 256 } }));
  vi.stubGlobal("fetch", fetcher);
  const first = await import("../airports/searchAirports");
  const airport = await first.searchAirports(firstCode, signal());
  vi.resetModules();
  const reloaded = await import("../airports/searchAirports");
  expect(await reloaded.searchAirports(firstCode === "MSP" ? "KMSP" : "MSP", signal())).toEqual(airport);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("remembers empty geocoder, nearby and airport results across reloads", async () => {
  const fetcher = vi.fn(async (url: string) => response(url.includes("nominatim") ? [] : url.includes("nearby") ? { data: [] } : { elements: [] }));
  vi.stubGlobal("fetch", fetcher);
  const firstLocations = await import("./locationSearch");
  const firstAirports = await import("../airports/searchAirports");
  expect(await firstLocations.searchLocations("missing city", signal())).toEqual([]);
  expect(await firstLocations.nearbyAirports(1, 2, signal())).toEqual([]);
  expect(await firstAirports.searchAirports("NONE", signal())).toEqual([]);
  vi.resetModules();
  const locations = await import("./locationSearch");
  const airports = await import("../airports/searchAirports");
  expect(await locations.searchLocations("missing city", signal())).toEqual([]);
  expect(await locations.nearbyAirports(1, 2, signal())).toEqual([]);
  expect(await airports.searchAirports("NONE", signal())).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("retries failed elevation enrichment while keeping successful runway geometry", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ elements }))
    .mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(response({ data: { elevation: 256 } }));
  vi.stubGlobal("fetch", fetcher);
  const { searchAirports } = await import("../airports/searchAirports");
  expect((await searchAirports("MSP", signal()))[0].elevationMeters).toBeUndefined();
  expect((await searchAirports("MSP", signal()))[0].elevationMeters).toBe(256);
  await searchAirports("MSP", signal());
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.filter(([url]) => (url as string).includes("overpass"))).toHaveLength(1);
});

it("does not retain malformed successful HTTP responses", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ data: null })).mockResolvedValue(response({ data: [] }));
  vi.stubGlobal("fetch", fetcher);
  const { nearbyAirports } = await import("./locationSearch");
  await expect(nearbyAirports(1, 2, signal())).rejects.toThrow("unavailable");
  expect(await nearbyAirports(1, 2, signal())).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
