import type { LocationSearchResult, LocationSearchProvider } from "./types";
import type { AirportMode } from "../airports/types";

interface Place {
  place_id: number; osm_type?: string; osm_id?: number;
  display_name: string; name?: string; lat: string; lon: string;
  type?: string; addresstype?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string>;
}
interface AirportSummary {
  code: string; iata?: string; icao?: string; name: string; latitude: number; longitude: number;
  type?: string; distance_km?: number;
  municipality?: string; region_name?: string; country_name?: string;
}
const cache = new Map<string, { expires: number; value: unknown }>();
let geocoderQueue: Promise<unknown> = Promise.resolve();
let lastGeocoderRequest = 0;

async function json(url: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.value;
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  if (!response.ok) throw new Error(`Location lookup failed (${response.status}). Try again.`);
  const value: unknown = await response.json();
  signal.throwIfAborted();
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(url, { expires: Date.now() + 86400000, value });
  return value;
}

async function geocode(params: Record<string, string>, signal: AbortSignal): Promise<Place[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  for (const [key, value] of Object.entries({ format: "jsonv2", limit: "6", addressdetails: "1", extratags: "1", ...params })) url.searchParams.set(key, value);
  // The public geocoder allows one request/second and submit-based search, not autocomplete.
  const request = geocoderQueue.catch(() => {}).then(async () => {
    signal.throwIfAborted();
    if ((cache.get(url.href)?.expires ?? 0) <= Date.now()) {
      const delay = Math.max(0, lastGeocoderRequest + 1100 - Date.now());
      if (delay) await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, delay);
        signal.addEventListener("abort", cancel, { once: true });
      });
      signal.throwIfAborted();
      lastGeocoderRequest = Date.now();
    }
    const result = await json(url.href, signal);
    if (!Array.isArray(result)) throw new Error("Invalid location search response.");
    return result as Place[];
  });
  geocoderQueue = request;
  return request;
}
const isCity = (place: Place) => ["city", "town", "village", "municipality"].includes(place.addresstype ?? place.type ?? "");
const validCoordinates = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

interface NearbyCity { name: string; state?: string; country?: string }
const normalizeName = (name: string) => name.trim().normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function airportResult(airport: AirportSummary, mode?: AirportMode, city?: NearbyCity): LocationSearchResult {
  const location = [...new Set([airport.municipality, airport.region_name, airport.country_name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(value => value.trim()))].join(", ");
  const distance = typeof airport.distance_km === "number" && Number.isFinite(airport.distance_km) && airport.distance_km >= 0
    ? `${Math.round(airport.distance_km)} km ${city ? `from ${city.name}` : "away"}` : "";
  const inCity = city && airport.municipality && normalizeName(airport.municipality) === normalizeName(city.name)
    && (!city.state || !airport.region_name || normalizeName(city.state) === normalizeName(airport.region_name))
    && (!city.country || !airport.country_name || normalizeName(city.country) === normalizeName(airport.country_name));
  const subtitle = inCity ? "" : [location, distance].filter(Boolean).join(" · ");
  return {
    id: `airport:${airport.code}`, kind: "airport", label: `${airport.iata ?? airport.code} · ${airport.name}`,
    latDeg: airport.latitude, lonDeg: airport.longitude, airportMode: mode, subtitle: subtitle || undefined,
    resolve: async signal => {
      const { searchAirports } = await import("../airports/searchAirports");
      const lookupCode = airport.icao ?? airport.iata ?? airport.code;
      const matches = await searchAirports(lookupCode, signal);
      const full = matches.find(item => item.code === airport.code) ?? matches[0];
      if (!full) throw new Error("Runway details are unavailable for this airport.");
      return { id: `airport:${full.code}`, kind: "airport", label: `${full.code} · ${full.name}`,
        latDeg: full.latDeg, lonDeg: full.lonDeg, airport: full, airportMode: mode, subtitle: subtitle || undefined };
    },
  };
}

export async function nearbyAirports(latDeg: number, lonDeg: number, signal: AbortSignal, city?: NearbyCity): Promise<readonly LocationSearchResult[]> {
  if (!validCoordinates(latDeg, lonDeg)) throw new Error("Invalid city coordinates.");
  const url = new URL("https://api.freeairportdb.com/v1/airports/nearby");
  for (const [key, value] of Object.entries({ lat: String(latDeg), lng: String(lonDeg), radius: "80", limit: "50" })) url.searchParams.set(key, value);
  const response = await json(url.href, signal) as { data?: AirportSummary[] };
  if (!Array.isArray(response.data)) throw new Error("Nearby airports are temporarily unavailable.");
  const rank = (type?: string) => type === "large_airport" ? 0 : type === "medium_airport" ? 1 : 2;
  const unique = new Map<string, AirportSummary>();
  for (const airport of response.data) {
    if (typeof airport.code !== "string" || !airport.name || !validCoordinates(airport.latitude, airport.longitude)) continue;
    if (!["large_airport", "medium_airport", "small_airport"].includes(airport.type ?? "")) continue;
    unique.set(airport.code, airport);
  }
  return [...unique.values()].sort((a, b) => rank(a.type) - rank(b.type) || (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity))
    .slice(0, 12).map(airport => airportResult(airport, undefined, city));
}

function placeResult(place: Place, query: string, mode?: AirportMode): LocationSearchResult | null {
  const latDeg = Number(place.lat), lonDeg = Number(place.lon);
  if (!validCoordinates(latDeg, lonDeg)) return null;
  if (place.type === "aerodrome" || place.addresstype === "aerodrome") {
    const code = place.extratags?.icao ?? place.extratags?.iata ?? (/^[a-z0-9]{3,4}$/i.test(query) ? query.toUpperCase() : undefined);
    if (code) return airportResult({ code, name: place.name ?? place.display_name, latitude: latDeg, longitude: lonDeg,
      municipality: place.address?.city ?? place.address?.town, region_name: place.address?.state, country_name: place.address?.country }, mode);
  }
  const city = isCity(place);
  return { id: `${place.osm_type ?? "place"}:${place.osm_id ?? place.place_id}`, label: place.display_name,
    latDeg, lonDeg, kind: city ? "city" : "place",
    ...(city ? { childrenLabel: "Airports nearby", loadChildren: async (signal: AbortSignal) =>
      (await nearbyAirports(latDeg, lonDeg, signal, {
        name: place.address?.city ?? place.address?.town ?? place.address?.village ?? place.name ?? place.display_name.split(",")[0].trim(),
        state: place.address?.state, country: place.address?.country,
      })).map(result => ({ ...result, airportMode: mode,
        resolve: result.resolve ? async (detailSignal: AbortSignal) => ({ ...await result.resolve!(detailSignal), airportMode: mode }) : undefined })) } : {}),
  };
}

/** Resolve names/abbreviations on the API; there is no local city or alias dataset. */
export const searchLocations: LocationSearchProvider = async (text, signal) => {
  const coordinates = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (coordinates) {
    const latDeg = Number(coordinates[1]), lonDeg = Number(coordinates[2]);
    return validCoordinates(latDeg, lonDeg) ? [{ id: "coordinates", label: `${latDeg}, ${lonDeg}`, latDeg, lonDeg }] : [];
  }
  const suffix = text.trim().match(/^(.+?)\s+(departure|arrival)$/i);
  const query = suffix?.[1] ?? text.trim();
  const mode = suffix?.[2].toLowerCase() as AirportMode | undefined;
  const places = await geocode({ q: query }, signal);
  const results = places.map(place => placeResult(place, query, mode)).filter((r): r is LocationSearchResult => r !== null);
  const first = places[0];
  if (first && (first.type === "aerodrome" || first.addresstype === "aerodrome")) {
    const cityName = first.address?.city ?? first.address?.town;
    if (cityName) {
      try {
        const cities = await geocode({ city: cityName, state: first.address?.state ?? "", countrycodes: first.address?.country_code ?? "" }, signal);
        const city = cities.find(isCity);
        if (city) {
          const group = placeResult(city, query, mode);
          if (group && !results.some(result => result.id === group.id)) results.unshift(group);
        }
      } catch { signal.throwIfAborted(); /* Keep the exact airport match if city enrichment fails. */ }
    }
  }
  if (!results.length && /^[a-z0-9]{3,4}$/i.test(query)) {
    const { searchAirports } = await import("../airports/searchAirports");
    return (await searchAirports(query, signal)).map(airport => ({ id: `airport:${airport.code}`, label: `${airport.code} · ${airport.name}`,
      kind: "airport", latDeg: airport.latDeg, lonDeg: airport.lonDeg, airport, airportMode: mode }));
  }
  return results;
};
