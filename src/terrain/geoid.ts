import type { RuntimeMode } from "../engine/babylon/createBabylonRuntime";

/**
 * Mean sea level: the EGM2008 geoid's height above the WGS84 ellipsoid, from a
 * grid shipped with the app. scripts/geoid/build-geoid-grids.mjs makes the
 * grids from NGA's model and measures each against it; geoidGrids/provenance.json
 * holds what it found.
 */

/**
 * What a height is measured from. Google 3D Tiles are drawn at their WGS84
 * ellipsoid heights. Raster terrain enters heights above its source's sea
 * level as ellipsoid heights (docs/streamed-terrain.md), so in that world the
 * ellipsoid is sea level.
 */
export type HeightDatum = "ellipsoid" | "geoid";

/** Arc minutes between the grid's points. */
export type GeoidGridId = "60" | "30" | "15";

export interface GeoidModel {
  spacingMinutes: number;
  /** The geoid's height above the WGS84 ellipsoid, in metres: an ellipsoid height less this is a height above sea level. */
  heightMeters(latDeg: number, lonDeg: number): number;
}

/** What the heights of the world a runtime draws are measured from. */
export function surfaceHeightDatum(mode: RuntimeMode): HeightDatum {
  return mode === "google-tiles" ? "ellipsoid" : "geoid";
}

/** "FEGD", then width, height and spacing as little-endian uint16, then a reserved uint16. */
const MAGIC = [0x46, 0x45, 0x47, 0x44];
const HEADER_BYTES = 12;
/** Values are whole centimetres. */
const METERS_PER_UNIT = 0.01;

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/**
 * Reads a grid as the generator writes it: rows from 90°N to 90°S, each from
 * 0°E eastward, as differences from the point before, the first of a row from
 * the first of the row above. Interpolation is bicubic (Catmull-Rom), through
 * the grid's points; longitude wraps and latitude stops at the poles.
 */
export function decodeGeoidGrid(bytes: Uint8Array): GeoidModel {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER_BYTES || MAGIC.some((byte, index) => bytes[index] !== byte)) throw new Error("Not a geoid grid.");
  const width = view.getUint16(4, true), height = view.getUint16(6, true), spacingMinutes = view.getUint16(8, true);
  if (width * spacingMinutes !== 360 * 60 || (height - 1) * spacingMinutes !== 180 * 60) throw new Error("The geoid grid does not cover the globe.");
  if (bytes.byteLength !== HEADER_BYTES + 2 * width * height) throw new Error("The geoid grid is cut short.");
  const values = new Int16Array(width * height);
  for (let row = 0, index = 0; row < height; row++) {
    for (let column = 0; column < width; column++, index++) {
      const previous = column > 0 ? values[index - 1] : row > 0 ? values[index - width] : 0;
      values[index] = previous + view.getInt16(HEADER_BYTES + 2 * index, true);
    }
  }
  const spacingDeg = spacingMinutes / 60;
  const at = (row: number, column: number): number =>
    values[Math.min(height - 1, Math.max(0, row)) * width + (((column % width) + width) % width)];
  return {
    spacingMinutes,
    heightMeters(latDeg, lonDeg) {
      const y = (90 - Math.min(90, Math.max(-90, latDeg))) / spacingDeg;
      const x = (((lonDeg % 360) + 360) % 360) / spacingDeg;
      const row = Math.floor(y), column = Math.floor(x);
      const tx = x - column, ty = y - row;
      const across = (r: number): number => catmullRom(at(r, column - 1), at(r, column), at(r, column + 1), at(r, column + 2), tx);
      return catmullRom(across(row - 1), across(row), across(row + 1), across(row + 2), ty) * METERS_PER_UNIT;
    },
  };
}

/** A grid file is gzip, unless a server already took that off for the browser. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readGeoidGrid(bytes: Uint8Array): Promise<GeoidModel> {
  return decodeGeoidGrid(await gunzip(bytes));
}

// Literal URLs, so the bundler finds and ships each grid.
const GRID_URLS: Record<GeoidGridId, () => URL> = {
  "60": () => new URL("./geoidGrids/egm2008-60.bin", import.meta.url),
  "30": () => new URL("./geoidGrids/egm2008-30.bin", import.meta.url),
  "15": () => new URL("./geoidGrids/egm2008-15.bin", import.meta.url),
};

/**
 * Each grid is downloaded once a page, when first asked for. A grid that could
 * not load is not asked for again until the page reloads, so a missing file is
 * one failed request, not one a frame.
 */
const loaded = new Map<GeoidGridId, Promise<GeoidModel>>();

export function loadGeoid(grid: GeoidGridId): Promise<GeoidModel> {
  let model = loaded.get(grid);
  if (!model) {
    model = fetch(GRID_URLS[grid]()).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return readGeoidGrid(new Uint8Array(await response.arrayBuffer()));
    });
    loaded.set(grid, model);
  }
  return model;
}
