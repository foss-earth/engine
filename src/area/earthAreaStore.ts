/**
 * The areas being selected, for this visit and the next: corners, which area
 * is being edited, and whether the next click on the map adds a corner.
 * The height is one number for the whole area, not one per corner.
 */
import type { MapClickPicker } from "../input/mapClick.js";
import { EARTH_AREA_MAX_CORNERS, EARTH_AREA_MAX_HEIGHT_METERS, earthAreaPoint, type EarthArea, type EarthAreaPoint } from "./earthArea.js";

export const EARTH_AREAS_STORAGE_KEY = "foss-earth.earth-areas.v1";

export interface EarthAreaSnapshot {
  readonly areas: readonly EarthArea[];
  readonly active: number;
  /** The next click or tap on the map adds a corner. */
  readonly placing: boolean;
  /** The last click found no ground. */
  readonly missed: boolean;
}

export interface EarthAreaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EarthAreaStoreOptions {
  storage?: EarthAreaStorage | null;
  key?: string;
  /** The ground under a click, or null when the click misses. */
  groundAt?(client: { readonly x: number; readonly y: number }): { latDeg: number; lonDeg: number } | null;
}

export interface EarthAreaStore {
  snapshot(): EarthAreaSnapshot;
  subscribe(listener: () => void): () => void;
  select(index: number): void;
  addArea(): void;
  /** Removes the active area. The last one is cleared instead, so one remains. */
  deleteActive(): void;
  /** `undefined` keeps the area on the ground. */
  setHeight(meters: number | undefined): void;
  addPoint(point: EarthAreaPoint): void;
  removePoint(index: number): void;
  undoPoint(): void;
  clearPoints(): void;
  /** Arms corner placement, or cancels it when it is already armed. True when it is armed afterwards. */
  togglePlacement(): boolean;
  cancelPlacement(): void;
  /** What the map's click takes while placement is armed. */
  readonly picker: MapClickPicker;
}

interface Draft { points: EarthAreaPoint[]; heightMeters?: number }

function draft(): Draft { return { points: [] }; }

function copyArea(area: Draft): EarthArea {
  return Object.freeze({
    points: Object.freeze(area.points.map(point => Object.freeze({ latDeg: point.latDeg, lonDeg: point.lonDeg }))),
    ...(area.heightMeters === undefined ? {} : { heightMeters: area.heightMeters }),
  });
}

function storedHeight(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= EARTH_AREA_MAX_HEIGHT_METERS ? value : undefined;
}

function storedAreas(raw: string | null): { areas: Draft[]; active: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { areas?: unknown; active?: unknown };
    if (!Array.isArray(parsed.areas)) return null;
    const areas: Draft[] = [];
    for (const entry of parsed.areas) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { points?: unknown; heightMeters?: unknown };
      const points: EarthAreaPoint[] = [];
      if (Array.isArray(record.points)) {
        for (const point of record.points) {
          if (!point || typeof point !== "object") continue;
          const corner = point as { latDeg?: unknown; lonDeg?: unknown };
          const valid = earthAreaPoint(Number(corner.latDeg), Number(corner.lonDeg));
          if (valid && points.length < EARTH_AREA_MAX_CORNERS) points.push(valid);
        }
      }
      const heightMeters = storedHeight(record.heightMeters);
      areas.push(heightMeters === undefined ? { points } : { points, heightMeters });
    }
    if (areas.length === 0) return null;
    const active = typeof parsed.active === "number" && parsed.active >= 0 && parsed.active < areas.length ? Math.floor(parsed.active) : 0;
    return { areas, active };
  } catch {
    return null;
  }
}

export function createEarthAreaStore(options: EarthAreaStoreOptions = {}): EarthAreaStore {
  const storage = options.storage ?? null;
  const key = options.key ?? EARTH_AREAS_STORAGE_KEY;
  let loaded: { areas: Draft[]; active: number } | null = null;
  if (storage) {
    try { loaded = storedAreas(storage.getItem(key)); }
    catch { loaded = null; }
  }
  const areas: Draft[] = loaded?.areas ?? [draft()];
  let active = loaded?.active ?? 0;
  let placing = false;
  let missed = false;
  const listeners = new Set<() => void>();

  function persist(): void {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify({
        version: 1,
        active,
        areas: areas.map(area => ({
          points: area.points.map(point => ({ latDeg: point.latDeg, lonDeg: point.lonDeg })),
          ...(area.heightMeters === undefined ? {} : { heightMeters: area.heightMeters }),
        })),
      }));
    } catch { /* A private window or a full disk keeps the areas for this visit only. */ }
  }

  function notify(): void {
    persist();
    for (const listener of [...listeners]) listener();
  }

  function current(): Draft | undefined { return areas[active]; }

  function stopPlacing(): void {
    placing = false;
    missed = false;
  }

  function addPoint(point: EarthAreaPoint): void {
    const area = current();
    const valid = earthAreaPoint(point.latDeg, point.lonDeg);
    if (!area || !valid || area.points.length >= EARTH_AREA_MAX_CORNERS) return;
    area.points.push(valid);
    missed = false;
    notify();
  }

  function cancelPlacement(): void {
    if (!placing && !missed) return;
    stopPlacing();
    notify();
  }

  const picker: MapClickPicker = {
    armed: () => placing,
    pickAt(client) {
      if (!placing) return false;
      const found = options.groundAt?.(client) ?? null;
      const point = found ? earthAreaPoint(found.latDeg, found.lonDeg) : null;
      if (!point) { missed = true; notify(); return false; }
      const area = current();
      if (area && area.points.length >= EARTH_AREA_MAX_CORNERS) { missed = false; notify(); return true; }
      addPoint(point);
      return true;
    },
    cancel: cancelPlacement,
  };

  return {
    snapshot: () => Object.freeze({ areas: Object.freeze(areas.map(copyArea)), active, placing, missed }),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    select(index) {
      if (!Number.isInteger(index) || index < 0 || index >= areas.length || index === active) return;
      active = index;
      stopPlacing();
      notify();
    },
    addArea() {
      areas.push(draft());
      active = areas.length - 1;
      stopPlacing();
      notify();
    },
    deleteActive() {
      const area = current();
      if (!area) return;
      if (areas.length <= 1) {
        if (area.points.length === 0 && area.heightMeters === undefined && !placing) return;
        area.points = [];
        delete area.heightMeters;
        stopPlacing();
        notify();
        return;
      }
      areas.splice(active, 1);
      if (active >= areas.length) active = areas.length - 1;
      stopPlacing();
      notify();
    },
    setHeight(meters) {
      const area = current();
      if (!area) return;
      const next = meters === undefined || !Number.isFinite(meters) || meters <= 0 || meters > EARTH_AREA_MAX_HEIGHT_METERS ? undefined : meters;
      if (meters !== undefined && next === undefined && meters !== 0) return;
      if (area.heightMeters === next) return;
      if (next === undefined) delete area.heightMeters;
      else area.heightMeters = next;
      notify();
    },
    addPoint,
    removePoint(index) {
      const area = current();
      if (!area || !Number.isInteger(index) || index < 0 || index >= area.points.length) return;
      area.points.splice(index, 1);
      missed = false;
      notify();
    },
    undoPoint() {
      const area = current();
      if (!area || area.points.length === 0) return;
      area.points.pop();
      missed = false;
      notify();
    },
    clearPoints() {
      const area = current();
      if (!area || area.points.length === 0) return;
      area.points = [];
      missed = false;
      notify();
    },
    togglePlacement() {
      if (placing) { cancelPlacement(); return false; }
      const area = current();
      if (!area || area.points.length >= EARTH_AREA_MAX_CORNERS) return false;
      placing = true;
      missed = false;
      notify();
      return true;
    },
    cancelPlacement,
    picker,
  };
}
