import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildGroundBvh, queryGroundBvh, validateGroundBvh } from "@foss-earth/engine/ground-TS";
import { instantiateGroundCore } from "../index.js";

// Check the real ground.wasm against ground-TS's buildGroundBvh, as built in dist/: every snapshot
// value with Object.is, so the sign of zero counts, and every hit of 4,096 rays per mesh.
const bytes = readFileSync(new URL("../single/ground.wasm", import.meta.url));
const core = await instantiateGroundCore(bytes);

let seed = 0x9e3779b9;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

function grid(n, jitter = 0) {
  const positions = new Float32Array(n * n * 3), indices = new Uint32Array((n - 1) * (n - 1) * 6);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const at = (y * n + x) * 3;
    positions[at] = x * 10 + jitter * (random() - 0.5);
    positions[at + 1] = 40 * Math.sin(x * 0.11) * Math.cos(y * 0.07) + 3 * Math.sin(x * y * 0.013);
    positions[at + 2] = y * 10 + jitter * (random() - 0.5);
  }
  let k = 0;
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
    indices[k++] = a; indices[k++] = c; indices[k++] = b; indices[k++] = b; indices[k++] = c; indices[k++] = d;
  }
  return { positions, indices };
}

// Repeated faces (centroid ties), degenerate faces, signed zeros and magnitudes up to 5 × 10^5.
function soup(vertices, faces) {
  const positions = new Float32Array(vertices * 3);
  for (let i = 0; i < positions.length; i++) {
    const r = random();
    positions[i] = r < 0.02 ? -0 : r < 0.04 ? 0 : (random() - 0.5) * (r < 0.1 ? 1e6 : 500);
  }
  const indices = new Uint32Array(faces * 3);
  for (let f = 0; f < faces; f++) {
    const r = random();
    if (f > 0 && r < 0.1) { const g = Math.floor(random() * f); indices.copyWithin(f * 3, g * 3, g * 3 + 3); continue; }
    const a = Math.floor(random() * vertices);
    indices[f * 3] = a;
    indices[f * 3 + 1] = r < 0.15 ? a : Math.floor(random() * vertices);
    indices[f * 3 + 2] = Math.floor(random() * vertices);
  }
  return { positions, indices };
}

// Faces in x order, with a block of exactly -0 and +0 x centroids, alternating by face ID, around the
// root median: the reference ties them by face ID.
function zeroCentroids(faces, zeros) {
  const positions = new Float32Array(faces * 9), indices = new Uint32Array(faces * 3), mid = faces / 2;
  for (let f = 0; f < faces; f++) {
    const block = f - (mid - zeros / 2);
    const x = block >= 0 && block < zeros ? (block % 2 ? -0 : 0) : Math.sign(f - mid + 0.5) * (1 + Math.abs(f - mid)) * 3;
    const y = random() * 2, z = random() * 2;
    positions.set([x, y, z, x, y + 1, z, x, y, z + 1], f * 9);
    indices.set([f * 3, f * 3 + 1, f * 3 + 2], f * 3);
  }
  return { positions, indices };
}

// Downward, vertical and oblique rays across the mesh, some with zero epsilon.
function rays(positions, count) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {
    low[a] = Math.min(low[a], positions[i + a]); high[a] = Math.max(high[a], positions[i + a]);
  }
  const values = new Float64Array(count * 8);
  for (let i = 0; i < count; i++) {
    const span = high.map((h, a) => h - low[a]);
    const origin = [0, 1, 2].map(a => low[a] + random() * span[a]);
    const kind = i % 4;
    origin[1] = kind === 0 ? high[1] + 10 : origin[1];
    const direction = kind === 0 ? [0.01 * Math.sin(i), -1, 0.01 * Math.cos(i)]
      : kind === 1 ? [0, -1, 0] : [random() - 0.5, random() - 0.5, random() - 0.5];
    values.set([...origin, 4 * Math.max(...span) + 100, ...direction, kind === 3 ? 0 : 1e-6], i * 8);
  }
  return values;
}

const meshes = [
  ["grid 64", grid(64)], ["grid 128", grid(128)], ["grid 256, jittered", grid(256, 3)], ["grid 363", grid(363)],
  ["soup 9", soup(3000, 9)], ["soup 20000", soup(3000, 20_000)], ["soup 200000", soup(50_000, 200_000)],
  // A 17-face node's 8-face half becomes a leaf straight from a median selection.
  ["soup 17", soup(100, 17)], ["soup 139", soup(500, 139)], ["soup 1088", soup(2000, 1088)], ["soup 139264", soup(50_000, 139_264)],
  ["zero centroids 1088", zeroCentroids(1088, 64)], ["zero centroids 18", zeroCentroids(18, 6)],
];
let snapshotValues = 0, rayCount = 0, hits = 0;
for (const [name, { positions, indices }] of meshes) {
  const expected = buildGroundBvh(positions, indices), mesh = core.buildBvh(positions, indices, { generation: 0 });
  try {
    const actual = mesh.snapshot();
    validateGroundBvh(actual, indices.length / 3, { positions, indices });
    if (actual.length !== expected.length) throw new Error(`${name}: snapshot length ${actual.length} versus ${expected.length}`);
    for (let at = 0; at < expected.length; at++) if (!Object.is(actual[at], expected[at])) throw new Error(`${name}: snapshot differs at ${at}: ${actual[at]} versus ${expected[at]}`);
    snapshotValues += expected.length;
    const probe = rays(positions, 4096), native = mesh.query(probe);
    for (let at = 0; at < probe.length; at += 8) {
      const hit = queryGroundBvh(expected, positions, indices, { origin: { x: probe[at], y: probe[at + 1], z: probe[at + 2] }, length: probe[at + 3],
        direction: { x: probe[at + 4], y: probe[at + 5], z: probe[at + 6] }, epsilon: probe[at + 7] });
      if (native[at] !== (hit ? 1 : 0) || (hit ? !Object.is(native[at + 1], hit.distance) || native[at + 2] !== hit.face || !Object.is(native[at + 3], hit.bu)
        || !Object.is(native[at + 4], hit.bv) : native[at + 1] !== -1 || native[at + 2] !== -1)) throw new Error(`${name}: ray ${at / 8} differs`);
      if (hit) hits++;
    }
    rayCount += probe.length / 8;
  } finally { mesh.dispose(); }
}
core.dispose();
const result = { implementation: "ground-WASM (Rust) versus ground-TS, the built @foss-earth/engine/ground-TS", wasmSha256: createHash("sha256").update(bytes).digest("hex"),
  meshes: meshes.map(([name, { indices }]) => ({ name, faces: indices.length / 3 })), snapshotValues, index: "identical, bit for bit", rays: rayCount, hits,
  hitResults: "identical", performanceClaim: false };
mkdirSync(new URL("../../build/ground-WASM/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../build/ground-WASM/ground-index-parity.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
