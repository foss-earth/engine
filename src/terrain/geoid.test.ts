import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeGeoidGrid, readGeoidGrid, surfaceHeightDatum, type GeoidGridId } from "./geoid";

const folder = new URL("./geoidGrids/", import.meta.url);
const provenance = JSON.parse(readFileSync(new URL("provenance.json", folder), "utf8")) as {
  grids: { file: string; spacingMinutes: number; bytes: number; sha256: string; maxErrorMeters: number }[];
};
const file = (grid: GeoidGridId): Uint8Array => new Uint8Array(readFileSync(new URL(`egm2008-${grid}.bin`, folder)));

/** EGM2008 at points of GeographicLib's 5′ grid (egm2008-5.pgm), exact there to its 3 mm step. */
const EGM2008 = [
  { place: "Minneapolis", latDeg: 44.975, lonDeg: -93.233333, meters: -27.288 },
  { place: "0°N 0°E", latDeg: 0, lonDeg: 0, meters: 17.226 },
  { place: "the lowest, south of India", latDeg: 4.666667, lonDeg: 78.75, meters: -106.908 },
  { place: "the highest, New Guinea", latDeg: -8.416667, lonDeg: 147.333333, meters: 85.737 },
  { place: "Everest", latDeg: 27.983333, lonDeg: 86.916667, meters: -28.344 },
  { place: "the North Pole", latDeg: 90, lonDeg: 0, meters: 14.898 },
  { place: "the South Pole", latDeg: -90, lonDeg: 0, meters: -30.15 },
];

describe("sea level grids", () => {
  it.each(provenance.grids)("ships $file as the generator measured it", async grid => {
    const bytes = file(String(grid.spacingMinutes) as GeoidGridId);
    expect(bytes.byteLength).toBe(grid.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(grid.sha256);
    const model = await readGeoidGrid(bytes);
    expect(model.spacingMinutes).toBe(grid.spacingMinutes);
    for (const point of EGM2008) {
      expect(Math.abs(model.heightMeters(point.latDeg, point.lonDeg) - point.meters), point.place).toBeLessThanOrEqual(grid.maxErrorMeters);
    }
  });

  it("puts sea level 27.3 m below the ellipsoid in Minneapolis, as GeographicLib's GeoidEval does", async () => {
    // docs/proposals/research/panorama-scenes-research.md: EGM2008 −27.30 m at 44.974°N, 93.235°W.
    const model = await readGeoidGrid(file("15"));
    expect(model.heightMeters(44.974, -93.235)).toBeCloseTo(-27.3, 1);
  });

  it("wraps longitude and is one value at each pole", async () => {
    const model = await readGeoidGrid(file("30"));
    expect(model.heightMeters(44.974, -93.235)).toBeCloseTo(model.heightMeters(44.974, 266.765), 9);
    expect(model.heightMeters(10, 179.9)).toBeCloseTo(model.heightMeters(10, -180.1), 9);
    expect(model.heightMeters(90, 0)).toBeCloseTo(model.heightMeters(90, 123), 9);
    expect(model.heightMeters(-90, 0)).toBeCloseTo(model.heightMeters(-90, -45), 9);
    expect(model.heightMeters(95, 0)).toBe(model.heightMeters(90, 0));
  });

  it("reads a grid a server has already decompressed", async () => {
    const plain = gunzipSync(file("60"));
    expect((await readGeoidGrid(new Uint8Array(plain))).heightMeters(0, 0)).toBeCloseTo(17.23, 2);
  });

  it("refuses a file that is not a whole grid", () => {
    const plain = new Uint8Array(gunzipSync(file("60")));
    expect(() => decodeGeoidGrid(plain.subarray(0, plain.byteLength - 2))).toThrow("cut short");
    const wrong = plain.slice();
    wrong[0] = 0;
    expect(() => decodeGeoidGrid(wrong)).toThrow("Not a geoid grid");
  });
});

describe("height datum", () => {
  it("is the ellipsoid for Google 3D Tiles and sea level for raster terrain and the fallback globe", () => {
    expect(surfaceHeightDatum("google-tiles")).toBe("ellipsoid");
    expect(surfaceHeightDatum("raster-basemap")).toBe("geoid");
    expect(surfaceHeightDatum("fallback")).toBe("geoid");
  });
});
