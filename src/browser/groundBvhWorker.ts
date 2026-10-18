import { buildGroundBvh, queryGroundBvh, validateGroundBvh, type GroundBvhSnapshot } from "./groundBvh.js";
import type { GroundBvhPreparation, GroundBvhWorkerRequest, GroundBvhWorkerScope, GroundBuildKernel, GroundNumericCore, GroundWorkerTimers } from "./groundBvhProtocol.js";

/** Starts no native module in the TypeScript arm. One build in flight, with bounded startup. */
export function installGroundBvhWorker(options: { scope: GroundBvhWorkerScope; kernel: GroundBuildKernel; loadNumericCore?: () => Promise<GroundNumericCore>; now(): number; timers: GroundWorkerTimers; startupTimeoutMs?: number }): void {
  let core: GroundNumericCore | null = null, starting: Promise<void> | null = null, busy = false, checked = false;
  let fallbackReason: string | null = options.kernel === "threaded" ? "threaded-unsupported" : null;
  let parity: GroundBvhPreparation["parity"] = "not-run";
  const start = (): Promise<void> => starting ??= (async () => {
    if (options.kernel !== "single") return;
    if (!options.loadNumericCore) { fallbackReason = "native-core-unavailable"; return; }
    let timer: unknown, cancelled = false;
    try {
      core = await Promise.race([
        options.loadNumericCore().then(value => { if (cancelled) { value.dispose(); throw new Error("startup-timeout"); } return value; }),
        new Promise<never>((_, reject) => { timer = options.timers.set(() => { cancelled = true; reject(new Error("startup-timeout")); }, options.startupTimeoutMs ?? 5000); }),
      ]);
    } catch (error) { fallbackReason = error instanceof Error && error.message === "startup-timeout" ? "startup-timeout" : "startup-failed"; }
    finally { if (timer !== undefined) options.timers.clear(timer); }
  })();
  options.scope.addEventListener("message", event => {
    const message = event.data as GroundBvhWorkerRequest;
    if (!message || message.type !== "build" || !Number.isSafeInteger(message.id)) return;
    if (busy) { options.scope.postMessage({ type: "failed", id: message.id, message: "Ground worker queue is full." }, []); return; }
    busy = true;
    void (async () => {
      try {
        await start();
        const started = options.now(), { positions, indices, generation } = message.request;
        if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("Invalid ground generation.");
        let snapshot: GroundBvhSnapshot | null = null;
        let actual: GroundBvhPreparation["actual"] = "typescript";
        if (core && !fallbackReason) {
          try {
            const mesh = core.buildBvh(positions, indices, { generation });
            try {
              snapshot = mesh.snapshot(); validateGroundBvh(snapshot, indices.length / 3);
              if (!checked) {
                const reference = buildGroundBvh(positions, indices);
                const rays = parityRays(positions, indices, snapshot);
                const native = mesh.query(rays);
                for (let at = 0; at < rays.length; at += 8) {
                  const ray = { origin: { x: rays[at], y: rays[at + 1], z: rays[at + 2] }, length: rays[at + 3],
                    direction: { x: rays[at + 4], y: rays[at + 5], z: rays[at + 6] }, epsilon: rays[at + 7] };
                  const hit = queryGroundBvh(reference, positions, indices, ray), exported = queryGroundBvh(snapshot, positions, indices, ray);
                  if (native.length !== rays.length || !sameHit(hit, exported) || native[at] !== (hit ? 1 : 0)
                    || (!hit && (native[at + 1] !== -1 || native[at + 2] !== -1)) || (hit && (!Object.is(native[at + 1], hit.distance)
                    || native[at + 2] !== hit.face || !Object.is(native[at + 3], hit.bu) || !Object.is(native[at + 4], hit.bv)))) {
                    parity = "different"; throw new Error("first-use-parity-mismatch");
                  }
                }
                checked = true; parity = "same";
              }
              actual = "single";
            } finally { mesh.dispose(); }
          } catch (error) {
            fallbackReason = error instanceof Error && error.message === "first-use-parity-mismatch" ? error.message : "native-build-failed";
            snapshot = null; core.dispose(); core = null;
          }
        }
        snapshot ??= buildGroundBvh(positions, indices);
        const result: GroundBvhPreparation = { generation, snapshot, actual, parity, fallbackReason, workMs: options.now() - started };
        options.scope.postMessage({ type: "built", id: message.id, result }, [snapshot.buffer as ArrayBuffer]);
      } catch (error) { options.scope.postMessage({ type: "failed", id: message.id, message: error instanceof Error ? error.message : String(error) }, []); }
      finally { busy = false; }
    })();
  });
}

function sameHit(a: ReturnType<typeof queryGroundBvh>, b: ReturnType<typeof queryGroundBvh>): boolean {
  return a === null ? b === null : b !== null && a.face === b.face && Object.is(a.distance, b.distance) && Object.is(a.bu, b.bu) && Object.is(a.bv, b.bv);
}

/** Broad bounds plus original triangle centroids, both signs on every axis. */
function parityRays(positions: Float32Array, indices: Uint32Array, snapshot: GroundBvhSnapshot): Float64Array {
  const values: number[] = [];
  const span = Math.max(snapshot[5] - snapshot[2], snapshot[6] - snapshot[3], snapshot[7] - snapshot[4], 1);
  const points = [[(snapshot[2] + snapshot[5]) / 2, (snapshot[3] + snapshot[6]) / 2, (snapshot[4] + snapshot[7]) / 2]];
  for (let face = 0; face < Math.min(16, indices.length / 3); face++) points.push([0, 1, 2].map(axis =>
    (positions[indices[face * 3] * 3 + axis] + positions[indices[face * 3 + 1] * 3 + axis] + positions[indices[face * 3 + 2] * 3 + axis]) / 3));
  for (const point of points) for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const origin = [...point], direction = [0, 0, 0]; origin[axis] += sign * (span + 1); direction[axis] = -sign;
    values.push(...origin, 2 * (span + 1), ...direction, 0.001);
  }
  return new Float64Array(values);
}
