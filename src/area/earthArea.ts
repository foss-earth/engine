/**
 * An area of the earth: corners in order, each a latitude and longitude, and
 * one optional height. The ring closes from the last corner back to the first.
 * Without a height the area lies on the ground. With one, it extends that many
 * metres straight up from the ground.
 */
export interface EarthAreaPoint {
  readonly latDeg: number;
  readonly lonDeg: number;
}

export interface EarthArea {
  readonly points: readonly EarthAreaPoint[];
  /** Metres above the ground. Omitted: the area stays on the ground. */
  readonly heightMeters?: number;
}

/** One area as the world draws it: the corners, the ground under each, and whether it is the one being edited. */
export interface EarthAreaDrawing {
  readonly area: EarthArea;
  readonly groundMeters: readonly number[];
  readonly active: boolean;
}

/** The most corners one area keeps. */
export const EARTH_AREA_MAX_CORNERS = 128;
/** The most a height may extend, metres: 100 km. */
export const EARTH_AREA_MAX_HEIGHT_METERS = 100_000;

/** A finite latitude and longitude, or null when either is out of range. */
export function earthAreaPoint(latDeg: number, lonDeg: number): EarthAreaPoint | null {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) return null;
  return Object.freeze({ latDeg, lonDeg });
}

/**
 * What a height field holds. Empty, or zero, is no height. A finite number of
 * metres up to {@link EARTH_AREA_MAX_HEIGHT_METERS} is that height. Anything
 * else is rejected (`null`).
 */
export function earthAreaHeight(text: string): number | undefined | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > EARTH_AREA_MAX_HEIGHT_METERS) return null;
  return value === 0 ? undefined : value;
}

/** "44.97780°N 93.26501°W", the same order as the position readout. */
export function formatEarthAreaPoint(point: EarthAreaPoint): string {
  const lat = `${Math.abs(point.latDeg).toFixed(5)}°${point.latDeg >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(point.lonDeg).toFixed(5)}°${point.lonDeg >= 0 ? "E" : "W"}`;
  return `${lat} ${lon}`;
}

/** "120 m", or "120.5 m" when the tenth matters. */
export function formatEarthAreaHeight(meters: number): string {
  const rounded = Math.round(meters * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} m`;
}

/** What the Select area tab says under its controls. */
export function earthAreaStatusMessage(area: EarthArea | undefined, placing: boolean, missed: boolean): string {
  const count = area?.points.length ?? 0;
  if (placing && count >= EARTH_AREA_MAX_CORNERS) return "This area has as many corners as it can. Esc cancels.";
  if (placing && missed) return "No ground there. Click or tap another place, or press Esc to cancel.";
  if (placing) return "Click or tap the map to add a corner. Esc cancels.";
  if (count >= EARTH_AREA_MAX_CORNERS) return "This area has as many corners as it can.";
  if (count < 3) return "Add at least three corners. Height is optional.";
  if (area?.heightMeters === undefined) return "On the ground.";
  return `${formatEarthAreaHeight(area.heightMeters)} above the ground.`;
}
