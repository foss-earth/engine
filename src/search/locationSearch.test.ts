import { afterEach, expect, it, vi } from "vitest";
import { nearbyAirports, searchLocations } from "./locationSearch";
const city = { place_id: 1, osm_type: "relation", osm_id: 1, display_name: "New York, United States", lat: "40.71", lon: "-74.00", addresstype: "city" };
afterEach(() => { vi.unstubAllGlobals(); });

it("sends abbreviations unchanged to the geocoder and loads airport summaries only on expansion", async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("nominatim") ? [city] : { data: [
    { code: "TEST", name: "Small airfield", latitude: 40.7, longitude: -74, type: "small_airport", distance_km: 1, municipality: "Newark", region_name: "New Jersey", country_name: "United States" },
    { code: "KJFK", iata: "JFK", name: "John F. Kennedy", latitude: 40.64, longitude: -73.78, type: "large_airport", distance_km: 20, municipality: "New York", region_name: "New York", country_name: "United States" },
    { code: "HEL", name: "Heliport", latitude: 40.7, longitude: -74, type: "heliport" },
  ] } }));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  const results = await searchLocations("nyc", signal);
  expect(new URL(fetcher.mock.calls[0][0]).searchParams.get("q")).toBe("nyc");
  expect(results[0]).toMatchObject({ kind: "city", latDeg: 40.71 });
  expect(fetcher).toHaveBeenCalledOnce();
  const airports = await results[0].loadChildren!(signal);
  expect(airports.map(a => a.id)).toEqual(["airport:KJFK", "airport:TEST"]);
  expect(airports[0].subtitle).toBeUndefined();
  expect(airports[1].subtitle).toBe("Newark, New Jersey, United States · 1 km from New York");
  expect(airports[0].resolve).toBeTypeOf("function");
  expect(fetcher.mock.calls.every(([url]) => !url.includes("overpass"))).toBe(true);
  await results[0].loadChildren!(signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("builds a city group from an airport's returned address without losing the airport match", async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => new URL(url).searchParams.has("city")
    ? [{ ...city, osm_id: 2, display_name: "Minneapolis, Minnesota", lat: "44.97", lon: "-93.26" }]
    : [{ place_id: 2, display_name: "Minneapolis-Saint Paul International Airport", name: "Minneapolis-Saint Paul International Airport", type: "aerodrome", lat: "44.88", lon: "-93.22",
      extratags: { icao: "KMSP" }, address: { city: "Minneapolis", state: "Minnesota", country_code: "us" } }] }));
  vi.stubGlobal("fetch", fetcher);
  const results = await searchLocations("msp", new AbortController().signal);
  expect(results[0]).toMatchObject({ kind: "city", label: "Minneapolis, Minnesota" });
  expect(results[1]).toMatchObject({ kind: "airport", id: "airport:KMSP" });
  expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("city")).toBe("Minneapolis");
});

it("keeps coordinate search offline and rejects cancelled requests", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect(await searchLocations("45, -93", new AbortController().signal)).toEqual([{ id: "coordinates", label: "45, -93", latDeg: 45, lonDeg: -93 }]);
  const controller = new AbortController(); controller.abort();
  await expect(nearbyAirports(1, 2, controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
