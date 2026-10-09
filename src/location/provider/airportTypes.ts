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
