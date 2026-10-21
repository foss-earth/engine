import type { GroundBvhBuild, GroundBvhPreparation, GroundBvhPreparer, GroundBvhPreparerStatus, GroundBvhWorkerPort, GroundBvhWorkerReply, GroundBuildKernel, GroundWorkerTimers } from "./groundBvhProtocol.js";
import type { ComputeLease } from "./computeAdmission.js";

export function createGroundBvhPreparer(options: { createWorker(): GroundBvhWorkerPort | null; kernel: GroundBuildKernel; now(): number; timers: GroundWorkerTimers; timeoutMs?: number }): GroundBvhPreparer {
  const status: GroundBvhPreparerStatus = { kernel: options.kernel, state: "idle", actual: null, parity: "not-run", failure: null, jobs: 0, lastJob: null };
  let worker: GroundBvhWorkerPort | null = null, nextId = 0;
  let pending: { id: number; sent: number; inputBytes: number; timer: unknown; abort: AbortController; lease?: ComputeLease; resolve(value: GroundBvhPreparation): void; reject(error: Error): void } | null = null;
  function retire(reason: string, state: "failed" | "disposed"): void {
    if (status.state === "failed" || status.state === "disposed") return;
    status.state = state; status.failure = reason;
    const current = pending; pending = null;
    if (current) { if (current.timer !== null) options.timers.clear(current.timer); current.abort.abort(new Error(reason)); current.reject(new Error(reason)); }
    const previous = worker; worker = null;
    try { previous?.terminate(); } finally { current?.lease?.release("retired"); }
  }
  const onMessage = (event: { data?: unknown }): void => {
    const reply = event.data as GroundBvhWorkerReply;
    if (!reply || !pending || reply.id !== pending.id) return;
    if (reply.type === "failed") { retire(reply.message, "failed"); return; }
    if (reply.type !== "built") return;
    const current = pending; pending = null; options.timers.clear(current.timer);
    current.lease?.release();
    status.jobs++; status.state = "idle"; status.actual = reply.result.actual; status.parity = reply.result.parity; status.failure = reply.result.fallbackReason;
    status.lastJob = { workMs: reply.result.workMs, roundTripMs: options.now() - current.sent, inputBytes: current.inputBytes, outputBytes: reply.result.snapshot.byteLength };
    current.resolve(reply.result);
  };
  return {
    prepare(request: GroundBvhBuild) {
      if (status.state === "failed" || status.state === "disposed") return Promise.reject(new Error(status.failure ?? "Ground preparer disposed."));
      if (pending) return Promise.reject(new Error("Ground build already pending."));
      if (!worker) {
        try { worker = options.createWorker(); } catch { worker = null; }
        if (!worker) { retire("worker-unavailable", "failed"); return Promise.reject(new Error("worker-unavailable")); }
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", event => retire(`worker-failed: ${event.message ?? "error"}`, "failed"));
        worker.addEventListener("messageerror", () => retire("worker-message-error", "failed"));
      }
      status.state = "busy";
      return new Promise<GroundBvhPreparation>((resolve, reject) => {
        const id = ++nextId;
        const current = { id, timer: null as unknown, sent: 0, abort: new AbortController(), lease: undefined as ComputeLease | undefined, inputBytes: request.positions.byteLength + request.indices.byteLength, resolve, reject };
        pending = current;
        const dispatch = (lease?: ComputeLease): void => {
          if (pending !== current) { lease?.release("stale"); return; }
          current.lease = lease; current.sent = options.now();
          current.timer = options.timers.set(() => retire("worker-timeout", "failed"), options.timeoutMs ?? 15_000);
          try { worker!.postMessage({ type: "build", id, request }, [request.positions.buffer as ArrayBuffer, request.indices.buffer as ArrayBuffer]); }
          catch (error) { retire(`worker-post-failed: ${error instanceof Error ? error.message : String(error)}`, "failed"); }
        };
        if (worker!.compute) void worker!.compute.acquire({ signal: current.abort.signal }).then(dispatch, () => { if (pending === current) retire("compute-admission-ended", "disposed"); });
        else dispatch();
      });
    },
    status: () => ({ ...status, lastJob: status.lastJob && { ...status.lastJob } }),
    dispose: () => retire("disposed", "disposed"),
  };
}
