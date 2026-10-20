import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prepareTerrainNumericGeometry } from "@foss-earth/engine/terrain-TS";
import { instantiateTerrainCore } from "../index.js";

// Check the real terrain.wasm against terrain-TS's prepareTerrainNumericGeometry, as built in dist/
const bytes = readFileSync(new URL("../single/terrain.wasm", import.meta.url));
const sha = value => createHash("sha256").update(value).digest("hex");
const wasmDigest = sha(bytes);
const core = await instantiateTerrainCore(bytes, { workerRealm: true });

const sameBits = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

function same(a, b, path = "") {
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || !sameBits(a, b)) {
      throw new Error(`differs at ${path}`);
    }
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) same(a[key], b[key], `${path}.${key}`);
    return;
  }
  if (!Object.is(a, b)) throw new Error(`differs at ${path}: ${a} vs ${b}`);
}

const TILES = [
  { z: 0, x: 0, y: 0 },
  { z: 1, x: 0, y: 1 },
  { z: 4, x: 5, y: 6 },
  { z: 8, x: 120, y: 85 },
  { z: 12, x: 1045, y: 1478 },
  { z: 14, x: 4210, y: 5912 },
];
const SEGMENTS = [1, 2, 4, 8, 16, 64];

let cases = 0;
let sharedHeightCases = 0;
let vertexValues = 0;
let targetValues = 0;

for (const tile of TILES) {
  for (const segments of SEGMENTS) {
    // 1. Without grid (fallback global/spherical)
    {
      const req = { tile, segments, withUvs: true };
      const expected = prepareTerrainNumericGeometry(req);
      const actual = core.buildSurface(req);
      same(actual.positions, expected.positions, `no-grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} positions`);
      same(actual.targetPositions, expected.targetPositions, `no-grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} targetPositions`);
      same(actual.uvs, expected.uvs, `no-grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} uvs`);
      same(actual.indices, expected.indices, `no-grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} indices`);
      same(actual.heightBounds, expected.heightBounds, `no-grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} bounds`);
      cases++;
      vertexValues += expected.positions.length;
      targetValues += expected.targetPositions.length;
    }

    // 2. With grid and varying heights
    const size = 16;
    const heights = new Float32Array(size * size);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = ((i * 1013 + tile.x * 37 + tile.y * 19) % 3000) - 500;
    }
    const grid = { z: tile.z, x: tile.x, y: tile.y, size, heights };

    {
      const req = { tile, grid, segments, withUvs: false };
      const expected = prepareTerrainNumericGeometry(req);
      const actual = core.buildSurface(req);
      same(actual.positions, expected.positions, `grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} positions`);
      same(actual.targetPositions, expected.targetPositions, `grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} targetPositions`);
      same(actual.indices, expected.indices, `grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} indices`);
      same(actual.heightBounds, expected.heightBounds, `grid [${tile.z}/${tile.x}/${tile.y}] seg=${segments} bounds`);
      cases++;
      vertexValues += expected.positions.length;
      targetValues += expected.targetPositions.length;
    }

    // 3. With grid and neighbors
    if (tile.z > 0 && segments <= 16) {
      const nHeights = new Float32Array(size * size);
      for (let i = 0; i < nHeights.length; i++) {
        nHeights[i] = ((i * 997 + tile.x * 23) % 2500) - 200;
      }
      const neighbor = { z: tile.z, x: (tile.x + 1) % (2 ** tile.z), y: tile.y, size, heights: nHeights };
      const gridWithNeighbors = { ...grid, neighbors: [neighbor] };
      const req = { tile, grid: gridWithNeighbors, segments, withUvs: true };
      const expected = prepareTerrainNumericGeometry(req);
      const actual = core.buildSurface(req);
      same(actual.positions, expected.positions, `neighbor [${tile.z}/${tile.x}/${tile.y}] seg=${segments} positions`);
      same(actual.targetPositions, expected.targetPositions, `neighbor [${tile.z}/${tile.x}/${tile.y}] seg=${segments} targetPositions`);
      same(actual.uvs, expected.uvs, `neighbor [${tile.z}/${tile.x}/${tile.y}] seg=${segments} uvs`);
      same(actual.indices, expected.indices, `neighbor [${tile.z}/${tile.x}/${tile.y}] seg=${segments} indices`);
      same(actual.heightBounds, expected.heightBounds, `neighbor [${tile.z}/${tile.x}/${tile.y}] seg=${segments} bounds`);
      // Heights in shared memory, as decode workers publish them, build the same surface.
      const shared = values => { const copy = new Float32Array(new SharedArrayBuffer(values.byteLength)); copy.set(values); return copy; };
      const fromShared = core.buildSurface({ ...req, grid: { ...grid, heights: shared(heights), neighbors: [{ ...neighbor, heights: shared(nHeights) }] } });
      for (const key of ["positions", "targetPositions", "uvs", "indices", "heightBounds"]) same(fromShared[key], expected[key], `shared [${tile.z}/${tile.x}/${tile.y}] seg=${segments} ${key}`);
      sharedHeightCases++;
      cases++;
      vertexValues += expected.positions.length;
      targetValues += expected.targetPositions.length;
    }
  }
}

core.dispose();

mkdirSync(new URL("../../build/terrain-WASM/", import.meta.url), { recursive: true });
const result = {
  wasm: "terrain-WASM/single/terrain.wasm",
  wasmSha256: wasmDigest,
  cases,
  sharedHeightCases,
  vertexValues,
  targetValues,
  parity: "bit-identical",
  stamp: new Date().toISOString(),
};
writeFileSync(new URL("../../build/terrain-WASM/terrain-parity.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(`[check-terrain] OK: ${cases} cases, ${vertexValues} vertex coordinates, ${targetValues} target position values bit-identical.`);
