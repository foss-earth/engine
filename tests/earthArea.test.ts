import { describe, expect, it } from "vitest";
import { ecefToGeodetic } from "../src/camera/cameraMath.js";
import { EARTH_AREA_MAX_CORNERS, EARTH_AREA_MAX_HEIGHT_METERS, earthAreaHeight, earthAreaPoint, earthAreaStatusMessage, formatEarthAreaHeight, formatEarthAreaPoint } from "../src/area/earthArea.js";
import { buildEarthAreaMesh } from "../src/area/earthAreaGeometry.js";
import { EARTH_AREAS_STORAGE_KEY, createEarthAreaStore, type EarthAreaStorage } from "../src/area/earthAreaStore.js";

const corner = (latDeg: number, lonDeg: number, groundMeters = 0) => ({ latDeg, lonDeg, groundMeters });

describe("an area of the earth", () => {
  it("keeps a latitude and longitude, and one optional height in metres", () => {
    expect(earthAreaPoint(44.9778, -93.265)).toEqual({ latDeg: 44.9778, lonDeg: -93.265 });
    expect(earthAreaPoint(91, 0)).toBeNull();
    expect(earthAreaPoint(0, 181)).toBeNull();
    expect(earthAreaPoint(Number.NaN, 0)).toBeNull();
    expect(earthAreaHeight("")).toBeUndefined();
    expect(earthAreaHeight("0")).toBeUndefined();
    expect(earthAreaHeight("120.5")).toBe(120.5);
    expect(earthAreaHeight("1,200")).toBe(1200);
    expect(earthAreaHeight("-1")).toBeNull();
    expect(earthAreaHeight(String(EARTH_AREA_MAX_HEIGHT_METERS + 1))).toBeNull();
    expect(formatEarthAreaPoint({ latDeg: 44.9778, lonDeg: -93.26501 })).toBe("44.97780°N 93.26501°W");
    expect(formatEarthAreaHeight(120)).toBe("120 m");
    expect(formatEarthAreaHeight(120.44)).toBe("120.4 m");
    expect(earthAreaStatusMessage({ points: [] }, false, false)).toBe("Add at least three corners. Height is optional.");
    expect(earthAreaStatusMessage({ points: [{ latDeg: 0, lonDeg: 0 }, { latDeg: 0, lonDeg: 1 }, { latDeg: 1, lonDeg: 0 }] }, true, false)).toBe("Click or tap the map to add a corner. Esc cancels.");
    expect(earthAreaStatusMessage({ points: [] }, true, true)).toBe("No ground there. Click or tap another place, or press Esc to cancel.");
    expect(earthAreaStatusMessage({ points: [{ latDeg: 0, lonDeg: 0 }, { latDeg: 1, lonDeg: 0 }, { latDeg: 0, lonDeg: 1 }], heightMeters: 80 }, false, false)).toBe("80 m above the ground.");
    expect(earthAreaStatusMessage({ points: [{ latDeg: 0, lonDeg: 0 }, { latDeg: 1, lonDeg: 0 }, { latDeg: 0, lonDeg: 1 }] }, false, false)).toBe("On the ground.");
  });

  it("follows the ground the short way and rises by the one height", () => {
    const mesh = buildEarthAreaMesh([corner(0, 0, 10), corner(0, 0.01, 10), corner(0.01, 0.01, 10)], 250);
    expect(mesh).not.toBeNull();
    expect(mesh!.footprint[0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(mesh!.footprint).toHaveLength(4);
    expect(mesh!.footprint.at(-1)).toEqual(mesh!.footprint[0]);
    expect(Math.hypot(mesh!.cap[0]!.x, mesh!.cap[0]!.y, mesh!.cap[0]!.z)).toBeCloseTo(250, 3);
    expect(mesh!.uprights).toHaveLength(3);
    expect(mesh!.walls).toHaveLength(3);
    const open = buildEarthAreaMesh([corner(0, 0), corner(0, 0.01)], undefined);
    expect(open!.footprint).toHaveLength(2);
    expect(open!.cap).toEqual([]);
    expect(open!.walls).toEqual([]);
    expect(buildEarthAreaMesh([], 10)).toBeNull();
    const far = buildEarthAreaMesh([corner(0, 0), corner(0, 10)], undefined);
    expect(far!.footprint.length).toBeGreaterThan(20);
  });

  it("crosses the date line the short way", () => {
    const mesh = buildEarthAreaMesh([corner(0, 179), corner(0, -179)], undefined)!;
    const mid = mesh.footprint[Math.floor(mesh.footprint.length / 2)]!;
    const place = ecefToGeodetic(mid.x + mesh.origin.x, mid.y + mesh.origin.y, mid.z + mesh.origin.z);
    expect(Math.abs(place.lonRad)).toBeGreaterThan(Math.PI * 0.9);
  });
});

function memory(): EarthAreaStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe("the selected areas", () => {
  it("edits corners and one height, and keeps them for the next visit", () => {
    const storage = memory();
    const store = createEarthAreaStore({ storage, groundAt: client => client.x < 0 ? null : { latDeg: 12, lonDeg: 34 } });
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.snapshot().areas[0]!.points.length));
    expect(store.togglePlacement()).toBe(true);
    expect(store.picker.armed()).toBe(true);
    expect(store.picker.pickAt({ x: -1, y: 0 })).toBe(false);
    expect(store.snapshot().missed).toBe(true);
    expect(store.picker.pickAt({ x: 1, y: 0 })).toBe(true);
    expect(store.snapshot().placing).toBe(true);
    expect(store.snapshot().areas[0]!.points).toEqual([{ latDeg: 12, lonDeg: 34 }]);
    store.addPoint({ latDeg: 1, lonDeg: 2 });
    store.setHeight(40);
    store.undoPoint();
    expect(store.snapshot().areas[0]).toEqual({ points: [{ latDeg: 12, lonDeg: 34 }], heightMeters: 40 });
    store.setHeight(0);
    expect(store.snapshot().areas[0]!.heightMeters).toBeUndefined();
    store.setHeight(-5);
    store.setHeight(EARTH_AREA_MAX_HEIGHT_METERS + 1);
    expect(store.snapshot().areas[0]!.heightMeters).toBeUndefined();
    store.addPoint({ latDeg: 3, lonDeg: 4 });
    store.removePoint(0);
    expect(store.snapshot().areas[0]!.points).toEqual([{ latDeg: 3, lonDeg: 4 }]);
    store.clearPoints();
    expect(store.snapshot().areas[0]!.points).toEqual([]);
    store.addPoint({ latDeg: 5, lonDeg: 6 });
    store.addArea();
    expect(store.snapshot().active).toBe(1);
    expect(store.snapshot().placing).toBe(false);
    store.select(0);
    store.deleteActive();
    expect(store.snapshot().areas).toHaveLength(1);
    expect(store.snapshot().areas[0]!.points).toEqual([]);
    store.cancelPlacement();
    const again = createEarthAreaStore({ storage });
    expect(again.snapshot().areas).toHaveLength(1);
    expect(JSON.parse(storage.values.get(EARTH_AREAS_STORAGE_KEY)!).version).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    store.addPoint({ latDeg: 200, lonDeg: 0 });
    expect(store.snapshot().areas[0]!.points).toEqual([]);
  });

  it("drops a saved area it cannot read and stops at the corner limit", () => {
    const storage = memory();
    storage.setItem(EARTH_AREAS_STORAGE_KEY, JSON.stringify({
      version: 1, active: 4,
      areas: [{ points: [{ latDeg: 1, lonDeg: 2 }, { latDeg: 99, lonDeg: 0 }], heightMeters: 15 }, { points: "nope" }],
    }));
    const store = createEarthAreaStore({ storage });
    expect(store.snapshot().active).toBe(0);
    expect(store.snapshot().areas[0]).toEqual({ points: [{ latDeg: 1, lonDeg: 2 }], heightMeters: 15 });
    expect(store.snapshot().areas[1]!.points).toEqual([]);
    const full = createEarthAreaStore();
    for (let i = 0; i < EARTH_AREA_MAX_CORNERS + 2; i++) full.addPoint({ latDeg: 0, lonDeg: i / 1000 });
    expect(full.snapshot().areas[0]!.points).toHaveLength(EARTH_AREA_MAX_CORNERS);
    expect(full.togglePlacement()).toBe(false);
    expect(earthAreaStatusMessage(full.snapshot().areas[0], false, false)).toBe("This area has as many corners as it can.");
  });
});
