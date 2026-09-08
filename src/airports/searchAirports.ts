import type { Airport, AirportPoint, AirportRunway } from "./types";
import { bearing, distance } from "./geometry";

interface Element {
  type: string; id: number; lat?: number; lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
const CACHE_TTL = 24 * 60 * 60 * 1000;
const cache = new Map<string, { expires: number; airports: Airport[] }>();
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
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 20000);
  if (signal.aborted) cancel();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Airport lookup failed (${response.status}). Try again.`);
    return await response.json();
  } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
}

/** On-demand, keyless browser lookup. No airport dataset is shipped with the app. */
export async function searchAirports(rawCode: string, signal: AbortSignal): Promise<Airport[]> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(code)) throw new Error("Enter a 3-letter IATA or 4-character ICAO airport code.");
  signal.throwIfAborted();
  const cached = cache.get(code);
  if (cached && cached.expires > Date.now()) return cached.airports;
  const key = code.length === 3 ? "iata" : "icao";
  const query = `[out:json][timeout:15];nwr["aeroway"="aerodrome"]["${key}"="${code}"];out center tags;way(around:5000)["aeroway"="runway"];out geom;`;
  const payload = await getJson(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, signal) as { elements?: Element[]; remark?: string };
  if (payload.remark || !Array.isArray(payload.elements)) throw new Error("Airport lookup is temporarily unavailable. Try again.");
  const airports = parseAirports(payload.elements, code);
  for (const airport of airports) {
    if (airport.elevationMeters !== undefined) continue;
    try {
      const response = await getJson(`https://api.freeairportdb.com/v1/airports/${encodeURIComponent(airport.code)}`, signal) as { data?: { elevation?: number } };
      const meters = response.data?.elevation;
      if (typeof meters === "number" && Number.isFinite(meters)) {
        airport.elevationMeters = meters;
        for (const runway of airport.runways) runway.elevationMeters ??= meters;
      }
    } catch { signal.throwIfAborted(); /* Unknown elevation stays unavailable; never assume sea level. */ }
  }
  signal.throwIfAborted();
  if (airports.length) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(code, { expires: Date.now() + CACHE_TTL, airports });
  }
  return airports;
}
