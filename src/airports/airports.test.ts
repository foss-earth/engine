import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAirports, searchAirports } from "./searchAirports";
import { airportSpawn, distance } from "./geometry";

const elements = [
  { type: "way", id: 1, center: { lat: 45, lon: -93 }, tags: { aeroway: "aerodrome", icao: "KTST", iata: "TST", name: "Test Airport", ele: "300" } },
  // Geometry goes west; ref order starts eastbound.
  { type: "way", id: 2, tags: { aeroway: "runway", ref: "09/27" }, geometry: [{ lat: 45, lon: -92.99 }, { lat: 45, lon: -93.01 }] },
  { type: "way", id: 3, tags: { aeroway: "runway", runway: "displaced_threshold" }, geometry: [{ lat: 45, lon: -93.01 }, { lat: 45, lon: -93.009 }] },
  { type: "way", id: 4, tags: { aeroway: "runway", disused: "yes", ref: "18/36" }, geometry: [{ lat: 45, lon: -93 }, { lat: 45.02, lon: -93 }] },
];
afterEach(() => { vi.unstubAllGlobals(); });

describe("airport positions", () => {
  it("maps runway directions correctly and excludes closed/displaced surfaces", () => {
    const [airport] = parseAirports(elements, "KTST");
    expect(airport.runways).toHaveLength(2);
    const east = airport.runways.find(r => r.label === "09")!;
    expect(east.headingDeg).toBeCloseTo(90, 1);
    expect(east.start.lonDeg).toBe(-93.009);
    expect(east.elevationMeters).toBe(300);
  });
  it("places departure on the centerline and arrival five miles before the threshold", () => {
    const runway = parseAirports(elements, "KTST")[0].runways.find(r => r.label === "09")!;
    const departure = airportSpawn(runway, "departure");
    expect(distance(departure, runway.start)).toBeCloseTo(50, 3);
    expect(departure.lonDeg).toBeGreaterThan(runway.start.lonDeg);
    const arrival = airportSpawn(runway, "arrival");
    expect(distance(arrival, runway.start)).toBeCloseTo(9260, 3);
    expect(arrival.lonDeg).toBeLessThan(runway.start.lonDeg);
    expect(arrival.altMeters).toBeCloseTo(300 + 15.24 + 9260 * Math.tan(Math.PI / 60), 3);
    expect(arrival.flightPreset.headingDeg).toBeCloseTo(90, 1);
    expect(() => airportSpawn({ ...runway, elevationMeters: undefined }, "departure")).toThrow("elevation");
  });
  it("fetches only the requested airport and reuses its cached result", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ elements }) }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const airports = await searchAirports("ktst", signal);
    expect(airports[0].code).toBe("KTST");
    expect(decodeURIComponent(fetcher.mock.calls[0][0] as string)).toContain('["icao"="KTST"]');
    await searchAirports("KTST", signal);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects invalid queries without network requests and propagates cancellation", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(searchAirports('KMSP";out;', new AbortController().signal)).rejects.toThrow("airport code");
    const controller = new AbortController(); controller.abort();
    await expect(searchAirports("KTST", controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects Overpass partial responses instead of caching incomplete runway data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ remark: "timeout", elements: [] }) })));
    await expect(searchAirports("KERR", new AbortController().signal)).rejects.toThrow("temporarily unavailable");
  });
});
