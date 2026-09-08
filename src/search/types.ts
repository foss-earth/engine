import type { Airport, AirportFlightPreset, AirportMode } from "../airports/types";

export interface GeodeticLocation {
  latDeg: number;
  lonDeg: number;
  zoomMeters?: number;
  altMeters?: number;
  flightPreset?: AirportFlightPreset;
}
export interface LocationSearchResult extends GeodeticLocation {
  id: string;
  label: string;
  subtitle?: string;
  kind?: "place" | "city" | "airport";
  airport?: Airport;
  airportMode?: AirportMode;
  childrenLabel?: string;
  loadChildren?: (signal: AbortSignal) => Promise<readonly LocationSearchResult[]>;
  /** Fetch full detail only after this result is selected. */
  resolve?: (signal: AbortSignal) => Promise<LocationSearchResult>;
}
export type LocationSearchProvider = (query: string, signal: AbortSignal) => Promise<readonly LocationSearchResult[]>;
