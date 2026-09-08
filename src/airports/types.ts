export type AirportMode = "departure" | "arrival";
export interface AirportPoint { latDeg: number; lonDeg: number }
export interface AirportRunway {
  id: string;
  label: string;
  start: AirportPoint;
  end: AirportPoint;
  headingDeg: number;
  lengthMeters: number;
  elevationMeters?: number;
}
export interface Airport {
  code: string;
  name: string;
  latDeg: number;
  lonDeg: number;
  elevationMeters?: number;
  runways: AirportRunway[];
}
/** Aircraft-specific speed/configuration is chosen by the flight host. */
export interface AirportFlightPreset {
  mode: AirportMode;
  headingDeg: number;
  groundElevationMeters: number;
  flightPathDeg: number;
}
