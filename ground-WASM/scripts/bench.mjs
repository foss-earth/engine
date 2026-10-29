import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildGroundBvh, queryGroundBvh, validateGroundBvh } from "@foss-earth/engine/ground-TS";
import { instantiateGroundCore, WORLD } from "../index.js";

// Times one terrain grid in this process with ground-TS or this binary (GROUND_WASM=<file> times another).
// The kernel alone, not a worker round trip, a browser or the app. After `npm run build`:
// node ground-WASM/scripts/bench.mjs <ts|wasm|first|import|world> [grid size, default 363] [runs, default 15]
// - ts, wasm: index build time; snapshotMs is copying the index out and validating it against the mesh, as the
//   worker does.
// - first: the first and second mesh as the app sends them: the preparer creates the worker for the first, and
//   the worker loads and admits the binary before building it. Worker messages are tasks in this process, so
//   there is no thread start. One cold measurement per process.
// - import: adopting ground-TS's index of the grid against building one, copies in included.
// - world: world-space ground picks on one transformed tile, per ray: the WASM world batch against the
//   TypeScript path the page takes today (Ray.TransformToRef, the bounding tests, queryGroundBvh, the pick's
//   point and getNormal(true, false)), and Babylon's own pickWithRay on a sample.
// Correctness is check-index.mjs's job. A laptop's numbers move with power source, thermal state and load; the
// host's CPU and power state print with them. Compare runs only on the same machine in the same state.
const [kind = "wasm", sizeText = "363", runsText = "15"] = process.argv.slice(2);
const size = Number(sizeText), runs = Number(runsText);
if (!["ts", "wasm", "first", "import", "world"].includes(kind) || !Number.isInteger(size) || size < 2 || !Number.isInteger(runs) || runs < 1) {
  throw new Error("usage: bench.mjs <ts|wasm|first|import|world> [grid size] [runs]");
}

const positions = new Float32Array(size * size * 3), indices = new Uint32Array((size - 1) * (size - 1) * 6);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const at = (y * size + x) * 3;
  positions[at] = x * 10; positions[at + 1] = 40 * Math.sin(x * 0.11) * Math.cos(y * 0.07) + 3 * Math.sin(x * y * 0.013); positions[at + 2] = y * 10;
}
for (let y = 0, k = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
  const a = y * size + x, b = a + 1, c = a + size, d = c + 1;
  indices.set([a, c, b, b, c, d], k); k += 6;
}

const bytes = kind === "ts" ? null : readFileSync(process.env.GROUND_WASM ?? new URL("../single/ground.wasm", import.meta.url));
const wasmSha256 = bytes && createHash("sha256").update(bytes).digest("hex"), ms = value => Number(value.toFixed(3));
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const quiet = (command, args) => { try { return execFileSync(command, args, { encoding: "utf8" }).trim(); } catch { return "unknown"; } };
const host = () => ({ node: process.versions.node, cpu: quiet("sysctl", ["-n", "machdep.cpu.brand_string"]), power: quiet("pmset", ["-g", "batt"]).split("\n").slice(0, 2).join(" | ") });
if (kind === "first") {
  const { createGroundBvhPreparer } = await import("../../dist/src/browser/groundBvhPreparer.js");
  const { installGroundBvhWorker } = await import("../../dist/src/browser/groundBvhWorker.js");
  const timers = { set: (callback, delay) => setTimeout(callback, delay), clear: handle => clearTimeout(handle) }, now = () => performance.now(), replies = [];
  let request = () => {};
  const preparer = createGroundBvhPreparer({ kernel: "single", now, timers, createWorker: () => {
    installGroundBvhWorker({ kernel: "single", now, timers, loadNumericCore: () => instantiateGroundCore(bytes), scope: {
      addEventListener: (_type, listener) => { request = listener; },
      postMessage: (message, transfer) => { const data = structuredClone(message, { transfer }); setTimeout(() => { for (const reply of replies) reply({ data }); }, 0); },
    } });
    return { postMessage: (message, transfer) => { const data = structuredClone(message, { transfer }); setTimeout(() => request({ data }), 0); },
      addEventListener: (type, listener) => { if (type === "message") replies.push(listener); }, terminate: () => {} };
  } });
  const meshes = [0, 1].map(() => ({ positions: positions.slice(), indices: indices.slice() }));
  const started = now(), first = await preparer.prepare({ ...meshes[0], generation: 1 }), firstMs = now() - started;
  const second = await preparer.prepare({ ...meshes[1], generation: 2 });
  console.log(JSON.stringify({ kind, wasmSha256, node: process.versions.node, faces: indices.length / 3, firstRoundTripMs: ms(firstMs), firstWorkMs: ms(first.workMs),
    secondRoundTripMs: ms(preparer.status().lastJob.roundTripMs), actual: [first.actual, second.actual], parity: second.parity, fallbackReason: second.fallbackReason }));
  preparer.dispose();
  process.exit(0);
}
const instantiated = performance.now(), core = bytes ? await instantiateGroundCore(bytes) : null, instantiateMs = performance.now() - instantiated;

if (kind === "import") {
  const snapshot = buildGroundBvh(positions, indices);
  const timed = make => { const started = performance.now(), mesh = make(), elapsed = performance.now() - started; mesh.dispose(); return elapsed; };
  const build = () => core.buildBvh(positions, indices), adopt = () => core.importSnapshot(snapshot, positions, indices);
  const first = { buildMs: timed(build), importMs: timed(adopt) };
  const builds = [], imports = [];
  for (let run = 0; run < runs; run++) { builds.push(timed(build)); imports.push(timed(adopt)); }
  console.log(JSON.stringify({ kind, wasmSha256, host: host(), faces: indices.length / 3, snapshotValues: snapshot.length, instantiateMs: ms(instantiateMs),
    first: { buildMs: ms(first.buildMs), importMs: ms(first.importMs) }, median: { buildMs: ms(median(builds)), importMs: ms(median(imports)) }, runs }));
  core.dispose();
  process.exit(0);
}

if (kind === "world") {
  const { Matrix, Mesh, NullEngine, PickingInfo, Quaternion, Ray, Scene, StandardMaterial, Vector3, VertexData } = await import("@babylonjs/core");
  const engine = new NullEngine(), scene = new Scene(engine), mesh = new Mesh("tile", scene);
  Object.assign(new VertexData(), { positions, indices }).applyToMesh(mesh);
  mesh.material = new StandardMaterial("ground", scene);
  // A tile placed as the app places one: far from the ECEF origin, turned to its local up.
  mesh.position.set(-2_611_250.5, -4_293_418.25, 3_852_904.75);
  mesh.rotationQuaternion = Quaternion.RotationAxis(new Vector3(0.3, 0.8, 0.5).normalize(), 1.1);
  mesh.computeWorldMatrix(true);
  const world = mesh.getWorldMatrix(), inverse = new Matrix();
  world.invertToRef(inverse);
  const snapshot = buildGroundBvh(positions, indices), wasm = core.importSnapshot(snapshot, positions, indices);
  const count = 1024, rays = new Float64Array(count * WORLD.rayStride), down = Vector3.TransformNormal(new Vector3(0, -1, 0), world);
  let seed = 0x9e3779b9;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  // Vertical probes from 100 m above the tile, as the ground contacts cast them.
  for (let i = 0; i < count; i++) {
    const above = Vector3.TransformCoordinates(new Vector3(random() * (size - 1) * 10, 150, random() * (size - 1) * 10), world);
    rays.set([above.x, above.y, above.z, down.x, down.y, down.z, 300, 0.001], i * WORLD.rayStride);
  }
  const batch = core.createWorldBatch(count), transform = { worldToLocal: inverse.m, localToWorld: world.m };
  batch.rays.set(rays);
  const wasmBatch = () => { batch.reset(); batch.run(wasm, transform); };
  // groundAcceleration.ts's intersect() and the caller's getNormal(true, false), per ray.
  const localRay = new Ray(Vector3.Zero(), Vector3.Up(), 1), worldRays = Array.from({ length: count }, (_, i) => {
    const at = i * WORLD.rayStride;
    return new Ray(new Vector3(rays[at], rays[at + 1], rays[at + 2]), new Vector3(rays[at + 3], rays[at + 4], rays[at + 5]), rays[at + 6], rays[at + 7]);
  });
  const bounds = mesh.getBoundingInfo();
  let sink = 0;
  const typescriptPath = () => {
    for (const ray of worldRays) {
      const local = Ray.TransformToRef(ray, inverse, localRay), pick = new PickingInfo(); pick.ray = ray;
      if (!local.intersectsSphere(bounds.boundingSphere) || !local.intersectsBox(bounds.boundingBox)) continue;
      const hit = queryGroundBvh(snapshot, positions, indices, local);
      if (!hit) continue;
      const worldOrigin = Vector3.TransformCoordinates(local.origin, world), direction = local.direction.scale(hit.distance);
      const pickedPoint = Vector3.TransformNormal(direction, world).addInPlace(worldOrigin);
      pick.hit = true; pick.distance = Vector3.Distance(worldOrigin, pickedPoint); pick.pickedPoint = pickedPoint; pick.pickedMesh = mesh;
      pick.bu = hit.bu || 0; pick.bv = hit.bv || 0; pick.faceId = hit.face;
      sink += pick.getNormal(true, false).y + pick.distance;
    }
  };
  const sample = worldRays.slice(0, 16);
  const babylonPick = () => { for (const ray of sample) { const pick = scene.pickWithRay(ray, m => m === mesh, false); if (pick?.hit) sink += pick.getNormal(true, false).y; } };
  // Batches of the whole ray set after half a second of warmup, so V8 has tiered both up; ns per ray from the
  // median batch.
  function perRay(run, rayCount, batches) {
    for (let i = 0, until = performance.now() + 500; i < 3 || performance.now() < until; i++) run();
    const samples = [];
    for (let b = 0; b < batches; b++) { const started = process.hrtime.bigint(); run(); samples.push(Number(process.hrtime.bigint() - started) / rayCount); }
    return { medianNsPerRay: Math.round(median(samples)), fastestNsPerRay: Math.round(Math.min(...samples)) };
  }
  const wasmTiming = perRay(wasmBatch, count, Math.max(runs, 15)), typescriptTiming = perRay(typescriptPath, count, Math.max(runs, 15));
  const babylonTiming = perRay(babylonPick, sample.length, 3);
  const output = batch.output;
  let hits = 0;
  for (let i = 0; i < count; i++) if (output[i * WORLD.rowStride]) hits++;
  console.log(JSON.stringify({ kind, wasmSha256, host: host(), faces: indices.length / 3, rays: count, hits, rayKind: "vertical, 0.001 epsilon, ECEF-placed tile",
    wasm: { ...wasmTiming, path: "createWorldBatch: reset + run, rays already in WASM memory" },
    typescript: { ...typescriptTiming, path: "Ray.TransformToRef + sphere/box + queryGroundBvh + point + getNormal(true, false)" },
    babylonPickWithRay: { ...babylonTiming, rays: sample.length, path: "scene.pickWithRay brute force + getNormal(true, false)" },
    speedupOverTypescript: Number((typescriptTiming.medianNsPerRay / wasmTiming.medianNsPerRay).toFixed(1)), sink: Number.isFinite(sink) }));
  batch.dispose(); core.dispose(); scene.dispose(); engine.dispose();
  process.exit(0);
}

function once() {
  const started = performance.now();
  if (!core) { buildGroundBvh(positions, indices); return { buildMs: performance.now() - started, snapshotMs: 0 }; }
  const mesh = core.buildBvh(positions, indices, { generation: 0 }), built = performance.now();
  try { validateGroundBvh(mesh.snapshot(), indices.length / 3, { positions, indices }); } finally { mesh.dispose(); }
  return { buildMs: built - started, snapshotMs: performance.now() - built };
}
const first = once(), warm = Array.from({ length: runs }, once);
console.log(JSON.stringify({ kind, wasmSha256, node: process.versions.node, faces: indices.length / 3,
  instantiateMs: core ? ms(instantiateMs) : null, first: { buildMs: ms(first.buildMs), snapshotMs: ms(first.snapshotMs) },
  median: { buildMs: ms(median(warm.map(run => run.buildMs))), snapshotMs: ms(median(warm.map(run => run.snapshotMs))) }, runs }));
core?.dispose();
