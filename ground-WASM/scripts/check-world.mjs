// Picks world rays with Babylon's scene.pickWithRay and getNormal(true, false), and with ground.wasm's world
// batches, and requires every value of every row to be identical with Object.is: mesh, distance, face, bu, bv,
// point and normal. Babylon stores matrices as Float32Array, or as float64 numbers with useHighPrecisionMatrix;
// a process can only pick one, so this runs once per precision:
// node ground-WASM/scripts/check-world.mjs <float32|float64>. scripts/check-index.mjs runs both.
import { readFileSync } from "node:fs";
import { Matrix, Mesh, NullEngine, Quaternion, Ray, Scene, StandardMaterial, TmpVectors, Vector3, VertexData } from "@babylonjs/core";
import { buildGroundBvh } from "@foss-earth/engine/ground-TS";
import { instantiateGroundCore, WORLD } from "../index.js";

const precision = process.argv[2] ?? "float32";
if (!["float32", "float64"].includes(precision)) throw new Error("usage: check-world.mjs <float32|float64>");
const engine = new NullEngine({ useHighPrecisionMatrix: precision === "float64" });
const scene = new Scene(engine);
// Without a material Babylon picks the bounding box, not the triangles.
const material = new StandardMaterial("ground", scene);
const core = await instantiateGroundCore(readFileSync(new URL("../single/ground.wasm", import.meta.url)));

let seed = 0x2545f491;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

function grid(n, offset = [0, 0, 0]) {
  const positions = new Float32Array(n * n * 3), indices = new Uint32Array((n - 1) * (n - 1) * 6);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const at = (y * n + x) * 3;
    positions[at] = offset[0] + x * 10; positions[at + 2] = offset[2] + y * 10;
    positions[at + 1] = offset[1] + 40 * Math.sin(x * 0.11) * Math.cos(y * 0.07) + 3 * Math.sin(x * y * 0.013);
  }
  for (let y = 0, k = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
    indices.set([a, c, b, b, c, d], k); k += 6;
  }
  return { positions, indices };
}
// Random faces with signed zeros, repeats and degenerate faces, over vertices some of which no face uses, so
// Babylon's bounding box is larger than the index's root box.
function soup(vertices, faces) {
  const positions = new Float32Array(vertices * 3);
  for (let i = 0; i < positions.length; i++) { const r = random(); positions[i] = r < 0.03 ? -0 : r < 0.05 ? 0 : (random() - 0.5) * 300; }
  const used = Math.floor(vertices * 0.8), indices = new Uint32Array(faces * 3);
  for (let f = 0; f < faces; f++) {
    const r = random();
    if (f > 0 && r < 0.05) { const g = Math.floor(random() * f); indices.copyWithin(f * 3, g * 3, g * 3 + 3); continue; }
    const a = Math.floor(random() * used);
    indices.set([a, r < 0.08 ? a : Math.floor(random() * used), Math.floor(random() * used)], f * 3);
  }
  return { positions, indices };
}

const geometries = [["grid 48", grid(48)], ["grid 24 off origin", grid(24, [5e4, 120, -3e4])], ["soup 1500, unused vertices", soup(1200, 1500)]];
const axis = (x, y, z, angle) => Quaternion.RotationAxis(new Vector3(x, y, z).normalize(), angle);
// [name, position, rotation, scaling]
const transforms = [
  ["identity", [0, 0, 0], null, [1, 1, 1]],
  ["ECEF far", [-2_611_250.5, -4_293_418.25, 3_852_904.75], axis(0.3, 0.8, 0.5, 1.1), [1, 1, 1]],
  ["rotated", [12, -3, 7], axis(1, 0.2, -0.4, -2.3), [1, 1, 1]],
  ["uniform scale", [-40, 5, 22], axis(0, 1, 0, 0.7), [2.5, 2.5, 2.5]],
  ["non-uniform scale", [3, 1, -9], axis(0.5, 0.5, 0.1, 0.4), [1.5, 3, 0.5]],
  ["mirrored", [0, 2, 0], axis(0, 0, 1, 0.2), [-1, 1, 1]],
  ["mirrored non-uniform", [8, 0, 8], null, [-2, 1, 0.75]],
];

function babylonMesh(name, { positions, indices }, [, position, rotation, scaling]) {
  const mesh = new Mesh(name, scene);
  Object.assign(new VertexData(), { positions, indices }).applyToMesh(mesh);
  mesh.material = material;
  mesh.position.set(...position);
  if (rotation) mesh.rotationQuaternion = rotation.clone();
  mesh.scaling.set(...scaling);
  mesh.computeWorldMatrix(true);
  return mesh;
}
// The matrices Babylon's pick uses: the inverse it makes per pick, the world matrix, and getNormal's, made in
// getNormal's own TmpVectors matrices, which stay Float32Array even with useHighPrecisionMatrix.
function transformOf(mesh) {
  const world = mesh.getWorldMatrix(), inverse = new Matrix();
  world.invertToRef(inverse);
  const transform = { worldToLocal: inverse.m, localToWorld: world.m };
  if (mesh.nonUniformScaling) {
    const normal = TmpVectors.Matrix[0];
    normal.copyFrom(world); normal.setTranslationFromFloats(0, 0, 0); normal.invert(); normal.transposeToRef(TmpVectors.Matrix[1]);
    transform.normalToWorld = TmpVectors.Matrix[1].m.slice();
  }
  return transform;
}
function boundsOf(mesh) {
  const { boundingBox: box, boundingSphere: sphere } = mesh.getBoundingInfo();
  return [...box.minimum.asArray(), ...box.maximum.asArray(), ...sphere.center.asArray(), sphere.radius];
}

// Rays at the meshes' world boxes: aimed at points inside, some stopping short; axis-aligned, with exact zeros;
// with components under the box test's 1e-7; random; directions not always unit. Babylon's default epsilon,
// 1e-6 and 0.
function worldRays(meshes, count) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const box = mesh.getBoundingInfo().boundingBox;
    for (let a = 0; a < 3; a++) { low[a] = Math.min(low[a], box.minimumWorld.asArray()[a]); high[a] = Math.max(high[a], box.maximumWorld.asArray()[a]); }
  }
  const span = high.map((h, a) => h - low[a]), size = Math.hypot(...span);
  const inside = () => [0, 1, 2].map(a => low[a] + random() * span[a]);
  const values = new Float64Array(count * WORLD.rayStride);
  for (let i = 0; i < count; i++) {
    const kind = i % 5, target = inside();
    let origin, direction, length;
    if (kind === 0 || kind === 1) {
      origin = target.map(v => v + (random() - 0.5) * size);
      direction = target.map((v, a) => v - origin[a]);
      const reach = Math.hypot(...direction);
      length = reach * (kind === 0 ? 2 : 0.5 + random());
      if (i % 3 === 0) direction = direction.map(v => v / reach);
    } else if (kind === 2) {
      const a = Math.floor(random() * 3), sign = random() < 0.5 ? -1 : 1;
      direction = [0, 0, 0]; direction[a] = sign * (random() < 0.5 ? 1 : 3);
      origin = target.slice(); origin[a] = sign > 0 ? low[a] - 10 : high[a] + 10;
      length = span[a] + 20;
    } else if (kind === 3) {
      direction = [(random() - 0.5) * 1e-7, -1, (random() - 0.5) * 1e-7];
      origin = [target[0], high[1] + 5, target[2]];
      length = span[1] + 10;
    } else {
      origin = inside().map((v, a) => v + (random() - 0.5) * span[a]);
      direction = [random() - 0.5, random() - 0.5, random() - 0.5];
      length = size * 2;
    }
    values.set([...origin, ...direction, length, [0.001, 1e-6, 0][i % 3]], i * WORLD.rayStride);
  }
  return values;
}

const handles = new Map(), stats = { cases: 0, rays: 0, hits: 0, misses: 0, meshesPerPickMax: 0, rowValues: 0 };
const rowOf = (rows, i) => Array.from(rows.subarray(i * WORLD.rowStride, (i + 1) * WORLD.rowStride));
function expected(ray, eligible) {
  const pick = scene.pickWithRay(ray, mesh => eligible.has(mesh), false);
  if (!pick?.hit) return [0, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0];
  const n = pick.getNormal(true, false), p = pick.pickedPoint;
  return [handles.get(pick.pickedMesh), pick.distance, pick.faceId, pick.bu, pick.bv, p.x, p.y, p.z, n.x, n.y, n.z];
}
/** Babylon and WASM rows for the same rays over `pairs` of [Babylon mesh, WASM mesh], in scene order. */
function compare(name, pairs, rays) {
  const count = rays.length / WORLD.rayStride, batch = core.createWorldBatch(count);
  try {
    batch.rays.set(rays); batch.reset();
    for (const [mesh, wasm] of pairs) batch.run(wasm, transformOf(mesh));
    // A copy: queryWorld below may grow memory, which detaches the batch's views.
    const actual = batch.output.slice(), eligible = new Set(pairs.map(([mesh]) => mesh));
    for (let i = 0; i < count; i++) {
      const at = i * WORLD.rayStride;
      const ray = new Ray(new Vector3(rays[at], rays[at + 1], rays[at + 2]), new Vector3(rays[at + 3], rays[at + 4], rays[at + 5]), rays[at + 6], rays[at + 7]);
      const want = expected(ray, eligible), got = rowOf(actual, i);
      if (!want.every((v, k) => Object.is(v, got[k]))) throw new Error(`${precision} ${name}: ray ${i} differs\n  babylon ${want.join(", ")}\n  wasm  ${got.join(", ")}`);
      if (want[0]) stats.hits++; else stats.misses++;
    }
    stats.rays += count; stats.rowValues += count * WORLD.rowStride; stats.cases++;
    stats.meshesPerPickMax = Math.max(stats.meshesPerPickMax, pairs.length);
    // The copying path answers the same.
    const copied = pairs.reduce((rows, [mesh, wasm]) => wasm.queryWorld(rays, transformOf(mesh), rows), undefined);
    if (!copied.every((v, k) => Object.is(v, actual[k]))) throw new Error(`${precision} ${name}: queryWorld differs from the batch`);
  } finally { batch.dispose(); }
}
const same = (a, b) => a.length === b.length && a.every((v, k) => Object.is(v, b[k]));

const defaultBounds = [];
for (const [geometryName, geometry] of geometries) {
  const snapshot = buildGroundBvh(geometry.positions, geometry.indices);
  for (const transform of transforms) {
    const name = `${geometryName}, ${transform[0]}`, mesh = babylonMesh(name, geometry, transform);
    // One WASM mesh built here with its root box as bounds, one imported from ground-TS's index with Babylon's.
    const built = core.buildBvh(geometry.positions, geometry.indices), imported = core.importSnapshot(snapshot, geometry.positions, geometry.indices);
    try {
      imported.setBounds(boundsOf(mesh));
      const rays = worldRays([mesh], 1536);
      handles.set(mesh, imported.handle);
      compare(`${name}, imported with Babylon's bounds`, [[mesh, imported]], rays);
      // The root box is Babylon's box when every vertex is in a face.
      const root = [...snapshot.subarray(2, 8)], babylon = boundsOf(mesh).slice(0, 6), rootIsBabylon = same(root, babylon);
      if (rootIsBabylon) { handles.set(mesh, built.handle); compare(`${name}, built with root bounds`, [[mesh, built]], rays); }
      if (transform[0] === "identity") defaultBounds.push({ geometry: geometryName, rootBoxIsBabylons: rootIsBabylon });
    } finally { built.dispose(); imported.dispose(); mesh.dispose(); handles.delete(mesh); }
  }
}
// Three overlapping meshes picked as one scene: the nearest wins, the earlier mesh on a tie.
{
  const geometry = geometries[0][1], picks = [transforms[0], ["raised", [0, 6, 0], null, [1, 1, 1]], transforms[2], transforms[0]];
  const pairs = picks.map((transform, k) => {
    const mesh = babylonMesh(`scene ${k}`, geometry, transform), wasm = core.buildBvh(geometry.positions, geometry.indices);
    handles.set(mesh, wasm.handle); return [mesh, wasm];
  });
  try { compare("three meshes and a duplicate in scene order", pairs, worldRays(pairs.map(([mesh]) => mesh), 4096)); }
  finally { for (const [mesh, wasm] of pairs) { wasm.dispose(); mesh.dispose(); } }
}
core.dispose(); scene.dispose(); engine.dispose();
console.log(JSON.stringify({ precision, babylon: `${NullEngine.Version} scene.pickWithRay + getNormal(true, false)`, matrixStorage: precision === "float32" ? "Float32Array" : "float64; getNormal's temporaries Float32Array",
  geometries: geometries.map(([name, { indices }]) => ({ name, faces: indices.length / 3 })), transforms: transforms.map(([name]) => name), defaultBounds,
  ...stats, result: "identical, Object.is in every row value" }));
