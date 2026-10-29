import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildGroundBvh, queryGroundBvh, validateGroundBvh } from "@foss-earth/engine/ground-TS";
import { createGroundCore, instantiateGroundCore } from "../index.js";

// Check the real ground.wasm against ground-TS's buildGroundBvh, as built in dist/: every snapshot
// value with Object.is, so the sign of zero counts, and every hit of 4,096 rays per mesh, for the index
// built here and for ground-TS's imported. Then imports of broken indexes, the page guard, and world
// batches against Babylon's pick at both matrix precisions (scripts/check-world.mjs).
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
function sameSnapshot(name, actual, expected) {
  if (actual.length !== expected.length) throw new Error(`${name}: snapshot length ${actual.length} versus ${expected.length}`);
  for (let at = 0; at < expected.length; at++) if (!Object.is(actual[at], expected[at])) throw new Error(`${name}: snapshot differs at ${at}: ${actual[at]} versus ${expected[at]}`);
}
/** Every ray's hit from `mesh` against queryGroundBvh on `snapshot`. */
function sameHits(name, mesh, snapshot, positions, indices, probe) {
  const wasm = mesh.query(probe);
  let found = 0;
  for (let at = 0; at < probe.length; at += 8) {
    const hit = queryGroundBvh(snapshot, positions, indices, { origin: { x: probe[at], y: probe[at + 1], z: probe[at + 2] }, length: probe[at + 3],
      direction: { x: probe[at + 4], y: probe[at + 5], z: probe[at + 6] }, epsilon: probe[at + 7] });
    if (wasm[at] !== (hit ? 1 : 0) || (hit ? !Object.is(wasm[at + 1], hit.distance) || wasm[at + 2] !== hit.face || !Object.is(wasm[at + 3], hit.bu)
      || !Object.is(wasm[at + 4], hit.bv) : wasm[at + 1] !== -1 || wasm[at + 2] !== -1)) throw new Error(`${name}: ray ${at / 8} differs`);
    if (hit) found++;
  }
  return found;
}
let snapshotValues = 0, rayCount = 0, hits = 0, importedValues = 0;
for (const [name, { positions, indices }] of meshes) {
  const expected = buildGroundBvh(positions, indices), mesh = core.buildBvh(positions, indices, { generation: 0 });
  const imported = core.importSnapshot(expected, positions, indices, { generation: 0 });
  try {
    const actual = mesh.snapshot();
    validateGroundBvh(actual, indices.length / 3, { positions, indices });
    sameSnapshot(name, actual, expected);
    snapshotValues += expected.length;
    sameSnapshot(`${name}, imported`, imported.snapshot(), expected);
    importedValues += expected.length;
    const probe = rays(positions, 4096);
    hits += sameHits(name, mesh, expected, positions, indices, probe);
    sameHits(`${name}, imported`, imported, expected, positions, indices, probe);
    rayCount += probe.length / 8;
  } finally { mesh.dispose(); imported.dispose(); }
}

// Imports of broken indexes of grid 64: ground-TS's validateGroundBvh rejects each, and the import fails
// with status 6. "stricter" ones it accepts, where the import requires indices in fields the traversal
// ignores, or depth at most 48. A valid reordering is adopted as it is.
const rejections = [];
{
  const { positions, indices } = meshes[0][1], valid = buildGroundBvh(positions, indices), nodes = valid[0], faces = valid[1], faceAt = 2 + nodes * 10;
  const node = k => 2 + k * 10, internal = [...Array(nodes).keys()].filter(k => valid[node(k) + 9] === 0), leaves = [...Array(nodes).keys()].filter(k => valid[node(k) + 9] > 1);
  const [inner, leaf] = [internal[1], leaves[0]];
  const edit = change => { const copy = valid.slice(); change(copy); return copy; };
  const cases = [
    ["node count past twice the faces", edit(v => { v[0] = 2 * faces + 1; })],
    ["fractional node count", edit(v => { v[0] = nodes - 0.5; })],
    ["face count", edit(v => { v[1] = faces - 1; })],
    ["length", valid.subarray(0, valid.length - 1)],
    ["NaN bound", edit(v => { v[node(leaf)] = NaN; })],
    ["infinite bound", edit(v => { v[node(leaf) + 4] = Infinity; })],
    ["inverted bound", edit(v => { v[node(leaf)] = v[node(leaf) + 3] + 1; })],
    ["child outside its parent", edit(v => { v[node(leaf) + 4] += 1000; })],
    ["corner outside its leaf", edit(v => { v[node(leaf) + 3] = v[node(leaf)]; })],
    ["duplicate face", edit(v => { v[faceAt + 1] = v[faceAt]; })],
    ["missing face", edit(v => { v[node(leaf) + 9] -= 1; })],
    ["fractional face", edit(v => { v[faceAt] += 0.5; })],
    ["cycle", edit(v => { v[node(inner) + 7] = 0; })],
    ["shared child", edit(v => { v[node(inner) + 7] = v[node(inner) + 6]; })],
    ["child past the nodes", edit(v => { v[node(inner) + 6] = nodes; })],
    ["fractional child", edit(v => { v[node(inner) + 6] += 0.5; })],
    ["negative count", edit(v => { v[node(leaf) + 9] = -1; })],
    ["leaf range past the faces", edit(v => { v[node(leaf) + 8] = faces; })],
    ["stricter: fractional child of a leaf", edit(v => { v[node(leaf) + 6] = 0.5; })],
    ["stricter: NaN start of an internal node", edit(v => { v[node(inner) + 8] = NaN; })],
  ];
  for (const [name, snapshot] of cases) {
    let ts = "accepted", status = null;
    try { validateGroundBvh(snapshot, faces, { positions, indices }); } catch (error) { ts = error.message; }
    try { core.importSnapshot(snapshot, positions, indices).dispose(); } catch (error) { status = error.status ?? error.message; }
    const stricter = name.startsWith("stricter");
    if (status !== 6 || (ts === "accepted") !== stricter) throw new Error(`${name}: ground-TS ${ts}, import ${status ?? "accepted"}`);
    rejections.push({ name, groundTS: ts, importStatus: status });
  }
  // A caterpillar index, one face peeled off per level: 48 levels import, 49 do not, though ground-TS takes both.
  const caterpillar = (depth, count) => {
    const p = new Float32Array(count * 9), f = new Uint32Array(count * 3).map((_, i) => i);
    for (let k = 0; k < count; k++) p.set([k, 0, 0, k + 0.5, 0, 1, k, 0, 1], k * 9);
    const rows = [];
    for (let k = 0; k < depth; k++) rows.push([k, 0, 0, count, 0, 1, depth + k, k + 1 < depth ? k + 1 : 2 * depth, k, 0]);
    for (let k = 0; k < depth; k++) rows.push([k, 0, 0, count, 0, 1, 0, 0, k, 1]);
    rows.push([depth, 0, 0, count, 0, 1, 0, 0, depth, count - depth]);
    return { snapshot: Float64Array.from([rows.length, count, ...rows.flat(), ...Array.from({ length: count }, (_, k) => k)]), positions: p, indices: f };
  };
  for (const [depth, accept] of [[48, true], [49, false]]) {
    const { snapshot, positions: p, indices: f } = caterpillar(depth, 51);
    validateGroundBvh(snapshot, 51, { positions: p, indices: f });
    let status = null;
    try { const mesh = core.importSnapshot(snapshot, p, f); sameSnapshot(`caterpillar ${depth}`, mesh.snapshot(), snapshot); mesh.dispose(); } catch (error) { status = error.status ?? error.message; }
    if ((status === null) !== accept || (!accept && status !== 6)) throw new Error(`caterpillar of depth ${depth}: import ${status ?? "accepted"}`);
    rejections.push({ name: `${accept ? "valid" : "stricter"}: leaves ${depth} levels deep`, groundTS: "accepted", importStatus: status });
  }
  // Children swapped and a leaf's faces reversed: valid, so adopted as it is and queried alike.
  const reordered = edit(v => {
    [v[node(inner) + 6], v[node(inner) + 7]] = [v[node(inner) + 7], v[node(inner) + 6]];
    const start = faceAt + v[node(leaf) + 8], count = v[node(leaf) + 9];
    v.set(v.slice(start, start + count).reverse(), start);
  });
  validateGroundBvh(reordered, faces, { positions, indices });
  const mesh = core.importSnapshot(reordered, positions, indices);
  try {
    sameSnapshot("reordered", mesh.snapshot(), reordered);
    sameHits("reordered", mesh, reordered, positions, indices, rays(positions, 1024));
  } finally { mesh.dispose(); }
  rejections.push({ name: "valid: children swapped, a leaf's faces reversed", groundTS: "accepted", importStatus: null, adopted: "as it is" });
  // Boxes padded past the float64 range, by a huge epsilon or as imported, are entered at 0 as ground-TS
  // enters them; a huge epsilon leaves small boxes finite, so a pair test can mix the two.
  const wide = edit(v => { for (const k of [0, v[node(0) + 6]]) for (let a = 0; a < 3; a++) { v[node(k) + a] = -1e308; v[node(k) + 3 + a] = 1e308; } });
  validateGroundBvh(wide, faces, { positions, indices });
  const probe = rays(positions, 1024), huge = probe.slice();
  for (let at = 7; at < huge.length; at += 8) huge[at] = 1e307;
  const padding = {};
  for (const [name, snapshot, cast] of [["huge epsilon", valid, huge], ["boxes padded past range", wide, probe], ["both", wide, huge]]) {
    const padded = core.importSnapshot(snapshot, positions, indices);
    try { padding[name] = `${sameHits(name, padded, snapshot, positions, indices, cast)} of 1024 rays hit`; } finally { padded.dispose(); }
  }
  rejections.push({ name: "valid: root and a child bounded by ±1e308, queried alike with and without epsilon 1e307", groundTS: "accepted", importStatus: null, padding });
}
core.dispose();

// The page guard: a global document refuses the core unless the page opts in.
const page = {};
{
  const { instance } = await WebAssembly.instantiate(bytes, {});
  globalThis.document = {};
  try {
    page.instantiateDefault = await instantiateGroundCore(bytes).then(c => { c.dispose(); return "allowed"; }, () => "refused");
    page.createDefault = (() => { try { createGroundCore(instance.exports).dispose(); return "allowed"; } catch { return "refused"; } })();
    const opted = await instantiateGroundCore(bytes, { page: true });
    page.instantiateOptIn = opted.page ? "allowed" : "flag missing"; opted.dispose();
  } finally { delete globalThis.document; }
  if (page.instantiateDefault !== "refused" || page.createDefault !== "refused" || page.instantiateOptIn !== "allowed") throw new Error(`Page guard: ${JSON.stringify(page)}`);
}

// World batches against Babylon, one process per matrix precision.
const world = ["float32", "float64"].map(precision => {
  const run = spawnSync(process.execPath, ["--no-warnings", fileURLToPath(new URL("./check-world.mjs", import.meta.url)), precision], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`check-world.mjs ${precision} failed:\n${run.stderr}`);
  return JSON.parse(run.stdout.trim().split("\n").at(-1));
});
const result = { implementation: "ground-WASM (Rust) versus ground-TS, the built @foss-earth/engine/ground-TS", wasmSha256: createHash("sha256").update(bytes).digest("hex"),
  meshes: meshes.map(([name, { indices }]) => ({ name, faces: indices.length / 3 })), snapshotValues, index: "identical, bit for bit", rays: rayCount, hits,
  hitResults: "identical", imported: { snapshotValues: importedValues, roundTrip: "identical, bit for bit", hitResults: "identical" }, rejections, page, world,
  performanceClaim: false };
mkdirSync(new URL("../../build/ground-WASM/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../build/ground-WASM/ground-index-parity.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
