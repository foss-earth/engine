import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Real Node workers; no quiet wait. Includes dispatch, input clone and output transfer. */
export async function createMeasurement(backend, { createWorker = options => new Worker(new URL("./node-raster-worker.mjs", import.meta.url), options), timeoutMs = 10_000 } = {}) {
  if (!["typescript", "single"].includes(backend)) throw new Error("Unknown benchmark backend");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid measurement timeout");
  const worker = createWorker({ workerData: { backend } });
  let nextId = 0, pending = null, failed = false;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off("message", ready); worker.off("error", fail); worker.off("exit", fail); };
    const fail = () => { cleanup(); void worker.terminate(); reject(new Error("Benchmark worker startup failed or timed out")); };
    const ready = message => { if (message.ready) { if (message.actualBackend !== backend) fail(); else { cleanup(); resolve(); } } };
    const timer = setTimeout(fail, timeoutMs);
    worker.on("message", ready); worker.once("error", fail); worker.once("exit", fail);
  });
  worker.on("message", message => {
    if (!pending || message.id !== pending.id) return;
    const job = pending; pending = null; clearTimeout(job.timer); worker.unref();
    if (message.error || message.actualBackend !== backend || !(message.heights instanceof Float32Array)
      || message.heights.length !== job.expectedElements) job.reject(new Error("Actual worker backend/output is unverified"));
    else job.resolve({ ...message, roundTripMs: performance.now() - job.started });
  });
  const fail = () => { failed = true; const job = pending; pending = null; worker.unref(); if (job) { clearTimeout(job.timer); job.reject(new Error("Benchmark worker failed")); } };
  worker.on("error", fail); worker.on("exit", fail);
  worker.unref();
  const size = 256, iterations = 64, data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([(i * 13) & 255, (i >>> 8) & 255, i & 255, 255], i * 4);
  async function job() {
    if (pending || failed) throw new Error("Concurrent measurement or failed worker");
    worker.ref();
    return new Promise((resolve, reject) => {
      pending = { id: ++nextId, started: performance.now(), expectedElements: size * size, resolve, reject };
      pending.timer = setTimeout(() => { fail(); void worker.terminate(); }, timeoutMs);
      try { worker.postMessage({ id: nextId, data, size, iterations }); } catch { fail(); void worker.terminate(); }
    });
  }
  // Imports, compilation, fixture creation and warmup are outside trial timing.
  for (let i = 0; i < 3; i++) await job();
  const measure = async () => {
    const result = await job();
    return { value: result.roundTripMs,
      digest: createHash("sha256").update(new Uint8Array(result.heights.buffer)).digest("hex"),
      disturbances: { actualBackend: result.actualBackend, size, iterations, kernelAndCopyMs: result.kernelAndCopyMs,
        roundTripMs: result.roundTripMs, scope: "Node worker; excludes PNG/WebP canvas readback and browser rendering" } };
  };
  measure.dispose = async () => { fail(); await worker.terminate(); };
  return measure;
}
