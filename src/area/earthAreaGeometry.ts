/**
 * The lines and walls of an area, in metres, relative to its first corner so
 * the drawing stays precise far from the Earth's centre. Edges follow the
 * ground the short way, including across the date line, instead of cutting
 * through the Earth.
 */
import { DEG_TO_RAD, geodeticToEcef, type EcefCoord } from "../camera/cameraMath.js";
import type { EarthArea } from "./earthArea.js";

/** The longest ground step between samples of an edge, metres. */
export const EARTH_AREA_SEGMENT_METERS = 25_000;
/** How many steps one edge may be split into. */
export const EARTH_AREA_MAX_SEGMENTS = 64;
/** Lifts the drawing just clear of the ground it was measured on, metres. */
export const EARTH_AREA_SURFACE_LIFT_METERS = 0.6;

export interface EarthAreaSample {
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly groundMeters: number;
}

export interface EarthAreaMesh {
  /** ECEF of the first corner, after the surface lift. Line coordinates are relative to it. */
  readonly origin: EcefCoord;
  /** The footprint. A ring of three or more corners repeats its first point at the end. */
  readonly footprint: readonly EcefCoord[];
  /** The same path, `heightMeters` straight up. Empty when the area stays on the ground. */
  readonly cap: readonly EcefCoord[];
  /** One upright at each corner: footprint, then cap. */
  readonly uprights: readonly (readonly [EcefCoord, EcefCoord])[];
  /** One wall quad per step: bottom-left, bottom-right, top-right, top-left. */
  readonly walls: readonly (readonly [EcefCoord, EcefCoord, EcefCoord, EcefCoord])[];
}

function usable(sample: EarthAreaSample): boolean {
  return Number.isFinite(sample.latDeg) && Math.abs(sample.latDeg) <= 90
    && Number.isFinite(sample.lonDeg) && Math.abs(sample.lonDeg) <= 180
    && Number.isFinite(sample.groundMeters);
}

/** Corners paired with the ground height under each, dropping any that are not finite. */
export function earthAreaSamples(points: readonly { latDeg: number; lonDeg: number }[], groundMeters: readonly number[]): EarthAreaSample[] {
  const samples: EarthAreaSample[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    const sample = { latDeg: point.latDeg, lonDeg: point.lonDeg, groundMeters: groundMeters[i] ?? 0 };
    if (usable(sample)) samples.push(sample);
  }
  return samples;
}

function upOf(latDeg: number, lonDeg: number): EcefCoord {
  const lat = latDeg * DEG_TO_RAD, lon = lonDeg * DEG_TO_RAD, c = Math.cos(lat);
  return { x: c * Math.cos(lon), y: c * Math.sin(lon), z: Math.sin(lat) };
}

function lifted(sample: EarthAreaSample): EcefCoord {
  return geodeticToEcef(sample.latDeg * DEG_TO_RAD, sample.lonDeg * DEG_TO_RAD, sample.groundMeters + EARTH_AREA_SURFACE_LIFT_METERS);
}

function raised(point: EcefCoord, direction: EcefCoord, scale: number): EcefCoord {
  return { x: point.x + direction.x * scale, y: point.y + direction.y * scale, z: point.z + direction.z * scale };
}

function relative(point: EcefCoord, origin: EcefCoord): EcefCoord {
  return { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
}

function chord(a: EcefCoord, b: EcefCoord): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The short way from `from` toward `to`: longitude wraps across the date line. */
function mix(from: EarthAreaSample, to: EarthAreaSample, t: number): EarthAreaSample {
  let lonDelta = to.lonDeg - from.lonDeg;
  if (lonDelta > 180) lonDelta -= 360;
  else if (lonDelta < -180) lonDelta += 360;
  let lonDeg = from.lonDeg + lonDelta * t;
  if (lonDeg > 180) lonDeg -= 360;
  else if (lonDeg <= -180) lonDeg += 360;
  return {
    latDeg: from.latDeg + (to.latDeg - from.latDeg) * t,
    lonDeg,
    groundMeters: from.groundMeters + (to.groundMeters - from.groundMeters) * t,
  };
}

/** From `from` inclusive to `to` exclusive. */
function edge(from: EarthAreaSample, to: EarthAreaSample): EarthAreaSample[] {
  const count = Math.min(EARTH_AREA_MAX_SEGMENTS, Math.max(1, Math.ceil(chord(lifted(from), lifted(to)) / EARTH_AREA_SEGMENT_METERS)));
  const samples: EarthAreaSample[] = [];
  for (let i = 0; i < count; i++) samples.push(i === 0 ? from : mix(from, to, i / count));
  return samples;
}

function pathOf(corners: readonly EarthAreaSample[], closed: boolean): EarthAreaSample[] {
  if (corners.length === 1) return [corners[0]!];
  const path: EarthAreaSample[] = [];
  const edges = closed ? corners.length : corners.length - 1;
  for (let i = 0; i < edges; i++) path.push(...edge(corners[i]!, corners[(i + 1) % corners.length]!));
  path.push(closed ? corners[0]! : corners[corners.length - 1]!);
  return path;
}

/** The drawing of these corners. Null when none of them are usable. `heightMeters` at or below zero stays on the ground. */
export function buildEarthAreaMesh(samples: readonly EarthAreaSample[], heightMeters: number | undefined): EarthAreaMesh | null {
  const corners = samples.filter(usable);
  if (corners.length === 0) return null;
  const closed = corners.length >= 3;
  const path = pathOf(corners, closed);
  const origin = lifted(corners[0]!);
  const height = heightMeters !== undefined && Number.isFinite(heightMeters) && heightMeters > 0 ? heightMeters : 0;
  const at = (sample: EarthAreaSample, extra: number): EcefCoord => relative(raised(lifted(sample), upOf(sample.latDeg, sample.lonDeg), extra), origin);
  const footprint = path.map(sample => at(sample, 0));
  const cap = height > 0 ? path.map(sample => at(sample, height)) : [];
  const uprights = height > 0 ? corners.map(corner => [at(corner, 0), at(corner, height)] as const) : [];
  const walls = height > 0 && footprint.length >= 2
    ? footprint.slice(0, -1).map((point, index) => [point, footprint[index + 1]!, cap[index + 1]!, cap[index]!] as const)
    : [];
  return { origin, footprint, cap, uprights, walls };
}

/** {@link buildEarthAreaMesh} for one area and the ground height under each of its corners. */
export function earthAreaMesh(area: EarthArea, groundMeters: readonly number[]): EarthAreaMesh | null {
  return buildEarthAreaMesh(earthAreaSamples(area.points, groundMeters), area.heightMeters);
}
