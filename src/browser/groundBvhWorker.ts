import { buildGroundBvh, validateGroundBvh, type GroundBvhSnapshot } from "../../ground-TS/groundBvh.js";
import { GROUND_BUILD_QUEUE_FULL, type GroundBvhPreparation, type GroundBvhWorkerRequest, type GroundBvhWorkerScope, type GroundBuildKernel, type GroundNumericCore, type GroundWorkerTimers } from "./groundBvhProtocol.js";

/** Starts no WASM module in the TypeScript arm. The single-threaded core loads with the worker and,
 * before it builds any mesh, must build a fixed fixture's index bit for bit as the reference does. Each
 * mesh is then built once, in WASM, and its index checked against the mesh's own geometry, which gives
 * the reference's hits whatever the tree; the page validates each index against its geometry again.
 * One build at a time, in arrival order: up to `maxQueuedBuilds` wait behind it, and one more is refused
 * with GROUND_BUILD_QUEUE_FULL. Startup is bounded. */
export function installGroundBvhWorker(options: { scope: GroundBvhWorkerScope; kernel: GroundBuildKernel; loadNumericCore?: () => Promise<GroundNumericCore>; now(): number; timers: GroundWorkerTimers; startupTimeoutMs?: number; maxQueuedBuilds?: number }): void {
  let core: GroundNumericCore | null = null, starting: Promise<void> | null = null, building = false;
  const queue: GroundBvhWorkerRequest[] = [], maxQueued = Math.max(0, options.maxQueuedBuilds ?? 16);
  let fallbackReason: string | null = options.kernel === "threaded" ? "threaded-unsupported" : null;
  let parity: GroundBvhPreparation["parity"] = "not-run";
  // A core that trapped cannot release its handles; drop it rather than fail the worker.
  const abandon = () => { try { core?.dispose(); } catch { /* abandoned */ } core = null; };
  const start = (): Promise<void> => starting ??= (async () => {
    if (options.kernel !== "single") return;
    if (!options.loadNumericCore) { fallbackReason = "wasm-core-unavailable"; return; }
    let timer: unknown, cancelled = false;
    try {
      core = await Promise.race([
        options.loadNumericCore().then(value => { if (cancelled) { value.dispose(); throw new Error("startup-timeout"); } return value; }),
        new Promise<never>((_, reject) => { timer = options.timers.set(() => { cancelled = true; reject(new Error("startup-timeout")); }, options.startupTimeoutMs ?? 5000); }),
      ]);
    } catch (error) { fallbackReason = error instanceof Error && error.message === "startup-timeout" ? "startup-timeout" : "startup-failed"; }
    finally { if (timer !== undefined) options.timers.clear(timer); }
    if (!core) return;
    try { parity = admits(core) ? "same" : "different"; } catch { fallbackReason = "wasm-build-failed"; }
    if (parity === "different") fallbackReason = "startup-parity-mismatch";
    if (fallbackReason) abandon();
  })();
  // Start loading and checking the core with the worker; the first build waits for it.
  void start();
  options.scope.addEventListener("message", event => {
    const message = event.data as GroundBvhWorkerRequest;
    if (!message || message.type !== "build" || !Number.isSafeInteger(message.id)) return;
    if (building && queue.length >= maxQueued) { options.scope.postMessage({ type: "failed", id: message.id, message: GROUND_BUILD_QUEUE_FULL }, []); return; }
    queue.push(message);
    if (!building) void drain();
  });
  async function drain(): Promise<void> {
    building = true;
    try { for (let message = queue.shift(); message; message = queue.shift()) await build(message); }
    finally { building = false; }
  }
  async function build(message: GroundBvhWorkerRequest): Promise<void> {
    try {
      await start();
      const started = options.now(), { positions, indices, generation } = message.request;
      if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("Invalid ground generation.");
      let snapshot: GroundBvhSnapshot | null = null;
      let actual: GroundBvhPreparation["actual"] = "typescript";
      if (core && !fallbackReason) {
        let invalid = false;
        try {
          const mesh = core.buildBvh(positions, indices, { generation });
          let built: GroundBvhSnapshot;
          try {
            built = mesh.snapshot();
            try { validateGroundBvh(built, indices.length / 3, { positions, indices }); } catch (error) { invalid = true; throw error; }
          } finally { mesh.dispose(); }
          snapshot = built; actual = "single";
        } catch {
          fallbackReason = invalid ? "wasm-index-invalid" : "wasm-build-failed";
          abandon();
        }
      }
      snapshot ??= buildGroundBvh(positions, indices);
      const result: GroundBvhPreparation = { generation, snapshot, actual, parity, fallbackReason, workMs: options.now() - started };
      options.scope.postMessage({ type: "built", id: message.id, result }, [snapshot.buffer as ArrayBuffer]);
    } catch (error) { options.scope.postMessage({ type: "failed", id: message.id, message: error instanceof Error ? error.message : String(error) }, []); }
  }
}

/** The fixture's index must equal the reference's bit for bit. The core's own ray queries are not
 * compared: the page queries the exported index in TypeScript. */
function admits(core: GroundNumericCore): boolean {
  const { positions, indices } = admissionFixture(), reference = buildGroundBvh(positions, indices);
  const mesh = core.buildBvh(positions, indices, { generation: 0 });
  try {
    const snapshot = mesh.snapshot();
    return snapshot.length === reference.length && snapshot.every((value, at) => Object.is(value, reference[at]));
  } finally { mesh.dispose(); }
}

/** 1,088 faces (17 × 64), so every branch reaches the 17-face nodes whose median selection is not a full
 * sort. West of x = 0, a sloped grid with repeated and degenerate faces; at the root median, faces whose
 * x centroid is exactly -0 or +0, alternating; east, a tower that splits on y and z. */
function admissionFixture(): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [], indices: number[] = [];
  const face = (...corners: number[]) => { const base = positions.length / 3; positions.push(...corners); indices.push(base, base + 1, base + 2); };
  for (let i = 0; i < 512; i++) {
    const x = -4096 + (i % 32) * 128, y = Math.sin(i * 0.37) * 300, z = Math.floor(i / 32) * 64;
    if (i % 16 === 15) indices.push(...indices.slice(-3));
    else face(x, y, z, x + 100, y + 40, z, ...(i % 32 === 7 ? [x + 100, y + 40, z] : [x, y - 25, z + 60]));
  }
  for (let i = 0; i < 64; i++) { const x = i % 2 ? -0 : 0, y = i * 3, z = 100 + (i % 8) / 1024; face(x, y, z, x, y + 2, z, x, y, z + 2); }
  for (let i = 0; i < 512; i++) {
    const x = 50_000 + (i % 4) / 64, y = i * 50, z = 200 + (i % 3 === 0 ? 10_000 : (i % 5) / 4096);
    face(x, y, z, x + 3, y + 40, z, x, y + 20, z + 7);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
