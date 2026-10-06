import type { Airport, AirportMode } from "../../airports/types";
import { isAirport } from "../../airports/validateAirport";
import { isLocationResultSnapshots, type LocationResultSnapshot } from "./locationResults";

/** The editor's draft is a preference, separate from expiring service responses. */
export interface LocationDraft {
  query: string;
  lat: string;
  lon: string;
  altitude: string;
  airport: Airport | null;
  airportMode: AirportMode;
  runwayId: string;
  resultQuery?: string;
  results?: readonly LocationResultSnapshot[];
}

const storageKey = (airportPresets: boolean) => `foss-earth.location-draft.v1.${airportPresets ? "airport" : "place"}`;

export function readLocationDraft(airportPresets: boolean): LocationDraft {
  const empty: LocationDraft = { query: "", lat: "", lon: "", altitude: "", airport: null, airportMode: "departure", runwayId: "" };
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(airportPresets)) ?? "null") as Partial<LocationDraft> | null;
    if (!value || typeof value !== "object"
      || ![value.query, value.lat, value.lon, value.altitude, value.runwayId].every(item => typeof item === "string")
      || (value.airportMode !== "departure" && value.airportMode !== "arrival")
      || (value.airport !== null && !isAirport(value.airport))) return empty;
    if (value.airport && value.airport.runways.length && !value.airport.runways.some(runway => runway.id === value.runwayId)) return empty;
    return { ...value as LocationDraft, airport: airportPresets ? value.airport : null,
      resultQuery: typeof value.resultQuery === "string" ? value.resultQuery : value.query,
      results: isLocationResultSnapshots(value.results) ? value.results : [] };
  } catch { return empty; }
}

export function writeLocationDraft(airportPresets: boolean, draft: LocationDraft): void {
  try { localStorage.setItem(storageKey(airportPresets), JSON.stringify(draft)); }
  catch { /* Editing and applying still work when browser storage is unavailable. */ }
}
