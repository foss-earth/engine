import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildGroundBvh, validateGroundBvh } from "@foss-earth/engine/ground-TS";
import { createGroundBvhPreparer } from "../../dist/src/browser/groundBvhPreparer.js";
import { installGroundBvhWorker } from "../../dist/src/browser/groundBvhWorker.js";
import { instantiateGroundCore } from "../index.js";

// Index build time on one terrain grid in this process: ground-TS, or this binary (GROUND_WASM=<file>
// times another). The kernel alone, not a worker round trip, a browser or the app; snapshotMs is copying
// the index out and validating it against the mesh, as the worker does. `first` instead times the first
// and second mesh as the app sends them: the preparer creates the worker for the first, and the worker
// loads and admits the binary before building it. Worker messages are tasks in this process, so there is
// no thread start. One cold measurement per process. After `npm run build`:
// node ground-WASM/scripts/bench.mjs <ts|wasm|first> [grid size, default 363] [builds after the first, default 15]
const [kind = "wasm", sizeText = "363", runsText = "15"] = process.argv.slice(2);
const size = Number(sizeText), runs = Number(runsText);
if (!["ts", "wasm", "first"].includes(kind) || !Number.isInteger(size) || size < 2 || !Number.isInteger(runs) || runs < 1) throw new Error("usage: bench.mjs <ts|wasm|first> [grid size] [builds]");

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
if (kind === "first") {
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
function once() {
  const started = performance.now();
  if (!core) { buildGroundBvh(positions, indices); return { buildMs: performance.now() - started, snapshotMs: 0 }; }
  const mesh = core.buildBvh(positions, indices, { generation: 0 }), built = performance.now();
  try { validateGroundBvh(mesh.snapshot(), indices.length / 3, { positions, indices }); } finally { mesh.dispose(); }
  return { buildMs: built - started, snapshotMs: performance.now() - built };
}
const first = once(), warm = Array.from({ length: runs }, once);
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ kind, wasmSha256, node: process.versions.node, faces: indices.length / 3,
  instantiateMs: core ? ms(instantiateMs) : null, first: { buildMs: ms(first.buildMs), snapshotMs: ms(first.snapshotMs) },
  median: { buildMs: ms(median(warm.map(run => run.buildMs))), snapshotMs: ms(median(warm.map(run => run.snapshotMs))) }, runs }));
core?.dispose();
