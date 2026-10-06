import type { Airport, AirportPoint, AirportRunway } from "./types";
import { bearing, distance } from "./geometry";
import { searchTuning } from "../search/searchTuning";
import { aliasLookup, cachedLookup } from "../search/lookupCache";
import { isAirport } from "./validateAirport";

interface Element {
  type: string; id: number; lat?: number; lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
interface AirportLookup { airports: Airport[]; aliases: string[] }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function validLookup(value: unknown): value is AirportLookup {
  return record(value) && Array.isArray(value.airports) && value.airports.every(isAirport)
    && Array.isArray(value.aliases) && value.aliases.every(code => typeof code === "string" && /^[A-Z0-9]{3,4}$/.test(code));
}
function validElements(value: unknown): value is Element[] {
  const coordinates = (p: unknown) => record(p) && typeof p.lat === "number" && typeof p.lon === "number";
  return Array.isArray(value) && value.every(element => record(element) && typeof element.type === "string"
    && typeof element.id === "number" && (element.tags === undefined || (record(element.tags)
      && Object.values(element.tags).every(tag => typeof tag === "string")))
    && (element.center === undefined || coordinates(element.center))
    && (element.geometry === undefined || (Array.isArray(element.geometry) && element.geometry.every(coordinates))));
}
const lookupKey = (code: string) => `airport-runways:${code}`;
const point = (p: { lat: number; lon: number }): AirportPoint => ({ latDeg: p.lat, lonDeg: p.lon });
const validPoint = (p: AirportPoint) => Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg) && Math.abs(p.latDeg) <= 90 && Math.abs(p.lonDeg) <= 180;
function elevation(value?: string): number | undefined {
  if (!value?.trim()) return undefined;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(m|ft)?$/i);
  return match ? Number(match[1]) * (match[2]?.toLowerCase() === "ft" ? 0.3048 : 1) : undefined;
}
const angleDifference = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Parse only usable runway centerlines, never threshold markings or closed surfaces. */
export function parseAirports(elements: Element[], code: string): Airport[] {
  const airportElements = elements.filter(e => e.tags?.aeroway === "aerodrome"
    && [e.tags.icao, e.tags.iata].some(value => value?.toUpperCase() === code));
  const airports: Airport[] = [];
  for (const element of airportElements) {
    const center = element.center ?? (element.lat !== undefined && element.lon !== undefined ? { lat: element.lat, lon: element.lon } : undefined);
    if (!center || !validPoint(point(center))) continue;
    const tags = element.tags!;
    const airport: Airport = { code: tags.icao ?? tags.iata ?? code, name: tags.name ?? code,
      ...point(center), elevationMeters: elevation(tags.ele), runways: [] };
    for (const way of elements) {
      const t = way.tags;
      if (way.type !== "way" || t?.aeroway !== "runway" || t.runway === "displaced_threshold"
        || t.area === "yes" || t.disused === "yes" || t.abandoned === "yes" || t.access === "no" || t.surface === "water") continue;
      const geometry = way.geometry?.map(point);
      if (!geometry || geometry.length < 2 || !geometry.every(validPoint)) continue;
      let start = geometry[0], end = geometry[geometry.length - 1];
      if (distance(start, end) < 200) continue;
      // Associate each runway with the closest returned airport; reject distant matches.
      const mid = geometry[Math.floor(geometry.length / 2)];
      if (distance(airport, mid) > 8000) continue;
      if (airportElements.some(other => other !== element && other.center && distance(point(other.center), mid) < distance(airport, mid))) continue;
      // Displaced threshold segments end at the landing threshold. Exclude them from the usable centerline.
      for (const segment of elements.filter(e => e.tags?.runway === "displaced_threshold")) {
        const g = segment.geometry;
        if (!g || g.length < 2) continue;
        const a = point(g[0]), b = point(g[g.length - 1]);
        if (distance(a, start) < 5) start = b;
        else if (distance(b, start) < 5) start = a;
        if (distance(a, end) < 5) end = b;
        else if (distance(b, end) < 5) end = a;
      }
      const names = (t.ref ?? t.name ?? "").split("/").map(s => s.trim());
      const heading = bearing(start, end);
      // OSM way direction need not follow the order of runway numbers.
      if (/^\d{2}[LCR]?$/.test(names[0]) && angleDifference(heading, Number(names[0].slice(0, 2)) * 10) > 90) {
        [start, end] = [end, start];
      }
      const lengthMeters = distance(start, end);
      if (lengthMeters < 200) continue;
      for (const [index, from, to] of [[0, start, end], [1, end, start]] as const) {
        const headingDeg = bearing(from, to);
        const runway: AirportRunway = { id: `${way.id}:${index}`, label: names[index] || `${Math.round(headingDeg)}° true`,
          start: from, end: to, headingDeg, lengthMeters, elevationMeters: elevation(t.ele) ?? airport.elevationMeters };
        airport.runways.push(runway);
      }
    }
    airport.runways.sort((a, b) => b.lengthMeters - a.lengthMeters || a.label.localeCompare(b.label));
    if (!airports.some(a => a.code === airport.code)) airports.push(airport);
  }
  return airports;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(searchTuning().timeoutMs)]) });
  if (!response.ok) throw new Error(`Airport lookup failed (${response.status}). Try again.`);
  const value: unknown = await response.json();
  signal.throwIfAborted();
  return value;
}

/** On-demand, keyless browser lookup. No airport dataset is shipped with the app. */
export async function searchAirports(rawCode: string, signal: AbortSignal): Promise<Airport[]> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(code)) throw new Error("Enter a 3-letter IATA or 4-character ICAO airport code.");
  const lookup = await cachedLookup(lookupKey(code), signal, validLookup, async lookupSignal => {
    const key = code.length === 3 ? "iata" : "icao";
    const query = `[out:json][timeout:15];nwr["aeroway"="aerodrome"]["${key}"="${code}"];out center tags;way(around:5000)["aeroway"="runway"];out geom;`;
    const payload = await getJson(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, lookupSignal);
    if (!record(payload) || payload.remark || !validElements(payload.elements)) throw new Error("Airport lookup is temporarily unavailable. Try again.");
    const airports = parseAirports(payload.elements, code);
    const aliases = airports.length === 1 ? payload.elements.filter(element => element.tags?.aeroway === "aerodrome"
      && [element.tags.icao, element.tags.iata].some(value => value?.toUpperCase() === code))
      .flatMap(element => [element.tags?.icao, element.tags?.iata])
      .filter((alias): alias is string => typeof alias === "string" && /^[a-z0-9]{3,4}$/i.test(alias)).map(alias => alias.toUpperCase()) : [];
    return { airports, aliases };
  });
  aliasLookup(lookupKey(code), lookup.aliases.map(lookupKey));
  // Enrichment has its own cached answer: a transient elevation failure can retry
  // without fetching runway geometry again or mutating the cached base airport.
  const airports = structuredClone(lookup.airports);
  for (const airport of airports) {
    if (airport.elevationMeters !== undefined) continue;
    try {
      const url = `https://api.freeairportdb.com/v1/airports/${encodeURIComponent(airport.code)}`;
      const meters = await cachedLookup(url, signal, (value): value is number | null => value === null
        || (typeof value === "number" && Number.isFinite(value)), async lookupSignal => {
        const response = await getJson(url, lookupSignal);
        if (!record(response) || !record(response.data)) throw new Error("Airport elevation is temporarily unavailable.");
        const value = response.data.elevation;
        if (value === undefined || value === null) return null;
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid airport elevation response.");
        return value;
      });
      if (meters !== null) {
        airport.elevationMeters = meters;
        for (const runway of airport.runways) runway.elevationMeters ??= meters;
      }
    } catch { signal.throwIfAborted(); /* Unknown elevation stays unavailable; never assume sea level. */ }
  }
  signal.throwIfAborted();
  return airports;
}
