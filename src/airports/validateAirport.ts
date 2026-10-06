import type { Airport, AirportPoint, AirportRunway } from "./types";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalElevation = (value: unknown) => value === undefined || finite(value);
function point(value: unknown): value is AirportPoint {
  return record(value) && finite(value.latDeg) && Math.abs(value.latDeg) <= 90
    && finite(value.lonDeg) && Math.abs(value.lonDeg) <= 180;
}
function runway(value: unknown): value is AirportRunway {
  return record(value) && typeof value.id === "string" && typeof value.label === "string"
    && point(value.start) && point(value.end) && finite(value.headingDeg) && finite(value.lengthMeters)
    && value.lengthMeters > 0 && optionalElevation(value.elevationMeters);
}

/** Validate airport geometry restored from device storage before using it. */
export function isAirport(value: unknown): value is Airport {
  return record(value) && typeof value.code === "string" && typeof value.name === "string" && point(value)
    && optionalElevation(value.elevationMeters) && Array.isArray(value.runways) && value.runways.every(runway);
}
