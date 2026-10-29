import { GROUND_BUILD_QUEUE_FULL, type GroundBvhBuild, type GroundBvhPreparation, type GroundBvhPreparer, type GroundBvhPreparerStatus, type GroundBvhWorkerPort, type GroundBvhWorkerReply, type GroundBuildKernel, type GroundWorkerTimers } from "./groundBvhProtocol.js";
import type { ComputeLease } from "./computeAdmission.js";

interface Job { id: number; request: GroundBvhBuild; sent: number; inputBytes: number; timer: unknown; abort: AbortController; lease?: ComputeLease; resolve(value: GroundBvhPreparation): void; reject(error: Error): void }

/** Builds one index at a time, in the order asked, each under its own compute lease. Up to
 * `maxQueuedBuilds` more wait their turn; one past that is refused with GROUND_BUILD_QUEUE_FULL. */
export function createGroundBvhPreparer(options: { createWorker(): GroundBvhWorkerPort | null; kernel: GroundBuildKernel; now(): number; timers: GroundWorkerTimers; timeoutMs?: number; maxQueuedBuilds?: number }): GroundBvhPreparer {
  const status: GroundBvhPreparerStatus = { kernel: options.kernel, state: "idle", actual: null, parity: "not-run", failure: null, jobs: 0, queued: 0, lastJob: null };
  const waiting: Job[] = [], maxQueued = Math.max(0, options.maxQueuedBuilds ?? 16);
  let worker: GroundBvhWorkerPort | null = null, nextId = 0, active: Job | null = null;
  function retire(reason: string, state: "failed" | "disposed"): void {
    if (status.state === "failed" || status.state === "disposed") return;
    status.state = state; status.failure = reason;
    const current = active, queued = waiting.splice(0); active = null; status.queued = 0;
    if (current) { if (current.timer !== null) options.timers.clear(current.timer); current.abort.abort(new Error(reason)); current.reject(new Error(reason)); }
    for (const job of queued) job.reject(new Error(reason));
    const previous = worker; worker = null;
    try { previous?.terminate(); } finally { current?.lease?.release("retired"); }
  }
  function next(): void {
    if (active || status.state === "failed" || status.state === "disposed") return;
    const job = waiting.shift(); status.queued = waiting.length;
    if (!job) { status.state = "idle"; return; }
    active = job; status.state = "busy";
    const dispatch = (lease?: ComputeLease): void => {
      if (active !== job) { lease?.release("stale"); return; }
      job.lease = lease; job.sent = options.now();
      job.timer = options.timers.set(() => retire("worker-timeout", "failed"), options.timeoutMs ?? 15_000);
      try { worker!.postMessage({ type: "build", id: job.id, request: job.request }, [job.request.positions.buffer as ArrayBuffer, job.request.indices.buffer as ArrayBuffer]); }
      catch (error) { retire(`worker-post-failed: ${error instanceof Error ? error.message : String(error)}`, "failed"); }
    };
    if (worker!.compute) void worker!.compute.acquire({ signal: job.abort.signal }).then(dispatch, () => { if (active === job) retire("compute-admission-ended", "disposed"); });
    else dispatch();
  }
  const onMessage = (event: { data?: unknown }): void => {
    const reply = event.data as GroundBvhWorkerReply;
    if (!reply || !active || reply.id !== active.id) return;
    if (reply.type === "failed") { retire(reply.message, "failed"); return; }
    if (reply.type !== "built") return;
    const current = active; active = null; options.timers.clear(current.timer);
    current.lease?.release();
    status.jobs++; status.actual = reply.result.actual; status.parity = reply.result.parity; status.failure = reply.result.fallbackReason;
    status.lastJob = { workMs: reply.result.workMs, roundTripMs: options.now() - current.sent, inputBytes: current.inputBytes, outputBytes: reply.result.snapshot.byteLength };
    current.resolve(reply.result);
    next();
  };
  return {
    prepare(request: GroundBvhBuild) {
      if (status.state === "failed" || status.state === "disposed") return Promise.reject(new Error(status.failure ?? "Ground preparer disposed."));
      if (waiting.length >= maxQueued && active) return Promise.reject(new Error(GROUND_BUILD_QUEUE_FULL));
      if (!worker) {
        try { worker = options.createWorker(); } catch { worker = null; }
        if (!worker) { retire("worker-unavailable", "failed"); return Promise.reject(new Error("worker-unavailable")); }
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", event => retire(`worker-failed: ${event.message ?? "error"}`, "failed"));
        worker.addEventListener("messageerror", () => retire("worker-message-error", "failed"));
      }
      return new Promise<GroundBvhPreparation>((resolve, reject) => {
        waiting.push({ id: ++nextId, request, timer: null, sent: 0, abort: new AbortController(), inputBytes: request.positions.byteLength + request.indices.byteLength, resolve, reject });
        status.queued = waiting.length; status.state = "busy";
        next();
      });
    },
    status: () => ({ ...status, lastJob: status.lastJob && { ...status.lastJob } }),
    dispose: () => retire("disposed", "disposed"),
  };
}
