/**
 * A pool of dedicated workers for independent CPU tasks, sized by the host
 * (normally from the device's hardware threads, 1–16).
 *
 * Workers pull from one priority queue: a worker takes the next task only
 * when it finishes its last one, so faster cores take more of the work and
 * slower (efficiency) cores take less, without the page knowing which is
 * which. Workers start when work queues and stop after they idle.
 */
import type { ComputeLease, ComputeWorker } from "./computeAdmission.js";

export interface PoolWorkerPort<TRequest, TReply> extends ComputeWorker {
  onmessage: ((event: MessageEvent<TReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: TRequest, transfer: Transferable[]): void;
  terminate(): void;
}
export interface WorkerPoolTimers { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface WorkerPoolOptions<TRequest, TReply> {
  /** Null or a throw: this host has no usable worker, and the pool reports itself unavailable. */
  createWorker(): PoolWorkerPort<TRequest, TReply> | null;
  /** The most workers alive at once, read whenever work is dispatched. 0 or less: none. */
  size(): number;
  timers: WorkerPoolTimers;
  nowMs(): number;
  /** A worker with nothing to do for this long stops. */
  idleMs: number;
  /** Lost workers after which the pool stops starting new ones. */
  maxLosses?: number;
  /** A reply that arrives for a cancelled task: release what it holds. */
  discard?(reply: TReply): void;
  /** A replied failure is completion, but not useful content progress. */
  isSuccess?(reply: TReply): boolean;
  onError?(error: unknown): void;
}
export interface WorkerPoolTask<TRequest> {
  message(id: number): TRequest;
  transfer?: Transferable[];
  /** Higher runs first; equal priorities run in the order they were queued. */
  priority?: number;
  signal?: AbortSignal;
  /** Publication epoch, checked again at reply for useful/stale accounting. */
  isCurrent?(): boolean;
}
export interface WorkerPoolStats {
  workers: number; busy: number; queued: number; completed: number; losses: number; available: boolean;
  /** Each live worker's finished tasks and mean task time, ms, from dispatch to reply. */
  perWorker: { tasks: number; meanMs: number }[];
  scheduling?: { useful: number; stale: number; failed: number; retired: number; oldestQueueMs: number; queueToDispatchMs: number; executionMs: number };
}
export interface WorkerPool<TRequest, TReply> {
  /** False once workers cannot be created or kept: callers use their own thread. */
  available(): boolean;
  /** Resolves with the worker's reply. Rejects with WorkerPoolUnavailableError when no worker can take it. */
  run(task: WorkerPoolTask<TRequest>): Promise<TReply>;
  stats(): WorkerPoolStats;
  /** Stops every worker. Queued and running tasks reject. */
  dispose(): void;
}
/** No worker can run this task: the work has not started, so the caller may do it itself. */
export class WorkerPoolUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "WorkerPoolUnavailableError"; }
}

type Entry<TRequest, TReply> = {
  task: WorkerPoolTask<TRequest>; priority: number; resolve(reply: TReply): void; reject(error: unknown): void;
  onAbort?: () => void; settled: boolean; queued: number;
};
type Slot<TRequest, TReply> = {
  port: PoolWorkerPort<TRequest, TReply>; running: { id: number; entry: Entry<TRequest, TReply>; started: number; lease?: ComputeLease } | null;
  waiting: { entry: Entry<TRequest, TReply>; abort: AbortController } | null;
  idle: unknown; tasks: number; totalMs: number;
};

export function createWorkerPool<TRequest, TReply extends { id: number }>(options: WorkerPoolOptions<TRequest, TReply>): WorkerPool<TRequest, TReply> {
  const queue: Entry<TRequest, TReply>[] = [];
  const slots: Slot<TRequest, TReply>[] = [];
  const maxLosses = options.maxLosses ?? 2;
  let nextId = 1, completed = 0, losses = 0, unavailable = false, disposed = false;
  let useful = 0, stale = 0, failed = 0, retired = 0, queueToDispatchMs = 0, executionMs = 0;
  const report = (error: unknown): void => { try { options.onError?.(error); } catch { /* The host's error port was tried. */ } };
  const limit = (): number => { const size = options.size(); return Number.isFinite(size) ? Math.max(0, Math.min(16, Math.floor(size))) : 0; };
  const settle = (entry: Entry<TRequest, TReply>): boolean => {
    if (entry.settled) return false;
    entry.settled = true;
    if (entry.onAbort) entry.task.signal?.removeEventListener("abort", entry.onAbort);
    return true;
  };
  const failQueued = (error: () => unknown): void => { for (const entry of queue.splice(0)) if (settle(entry)) entry.reject(error()); };
  const stop = (slot: Slot<TRequest, TReply>): void => {
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    if (slot.idle !== null) { options.timers.clearTimeout(slot.idle); slot.idle = null; }
    slot.waiting?.abort.abort(new Error("Worker retired before dispatch.")); slot.waiting = null;
    slot.port.onmessage = null; slot.port.onerror = null;
    if (slot.port.onmessageerror !== undefined) slot.port.onmessageerror = null;
    try { slot.port.terminate(); } catch (error) { report(error); }
  };
  const lose = (slot: Slot<TRequest, TReply>, error: unknown): void => {
    if (!slots.includes(slot)) return;
    losses++; report(error);
    const running = slot.running; slot.running = null;
    stop(slot);
    if (running) { retired++; running.lease?.release("retired"); }
    if (losses >= maxLosses) unavailable = true;
    // The task never produced a result: the caller may run it on its own thread.
    if (running && settle(running.entry)) running.entry.reject(new WorkerPoolUnavailableError("The worker running this task stopped.", { cause: error }));
    if (unavailable && !slots.length) failQueued(() => new WorkerPoolUnavailableError("Workers keep stopping."));
    pump();
  };
  const spawn = (): Slot<TRequest, TReply> | null => {
    let port: PoolWorkerPort<TRequest, TReply> | null = null;
    try { port = options.createWorker(); } catch (error) { report(error); }
    if (!port) { unavailable = true; return null; }
    const slot: Slot<TRequest, TReply> = { port, running: null, waiting: null, idle: null, tasks: 0, totalMs: 0 };
    port.onmessage = event => {
      const reply = event.data, running = slot.running;
      if (!running || reply?.id !== running.id) { lose(slot, new Error("A worker replied to a task it was not given.")); return; }
      slot.running = null; slot.tasks++; const elapsed = options.nowMs() - running.started;
      slot.totalMs += elapsed; executionMs += elapsed; completed++;
      let obsolete = running.entry.settled;
      try { obsolete ||= running.entry.task.isCurrent?.() === false; } catch (error) { report(error); obsolete = true; }
      let success = false;
      try { success = options.isSuccess?.(reply) !== false; } catch (error) { report(error); }
      if (obsolete) stale++; else if (success) useful++; else failed++;
      running.lease?.release(obsolete ? "stale" : success ? "useful" : "failed");
      if (settle(running.entry)) running.entry.resolve(reply);
      else if (options.discard) try { options.discard(reply); } catch (error) { report(error); }
      pump();
    };
    port.onerror = event => {
      const message = (event as { message?: unknown } | null)?.message;
      lose(slot, new Error(typeof message === "string" && message ? `A pool worker stopped: ${message}` : "A pool worker stopped."));
    };
    if ("onmessageerror" in port) port.onmessageerror = () => lose(slot, new Error("A pool worker reply could not be read."));
    slots.push(slot);
    return slot;
  };
  const retireLater = (slot: Slot<TRequest, TReply>): void => {
    if (slot.idle !== null) return;
    slot.idle = options.timers.setTimeout(() => { slot.idle = null; if (!slot.running && !slot.waiting) stop(slot); }, options.idleMs);
  };
  const dispatch = (slot: Slot<TRequest, TReply>, entry: Entry<TRequest, TReply>, lease?: ComputeLease): void => {
    if (disposed || entry.settled || !slots.includes(slot)) { lease?.release("stale"); return; }
    const id = nextId++;
    let message: TRequest;
    try { message = entry.task.message(id); } catch (error) { lease?.release("stale"); if (settle(entry)) entry.reject(error); return; }
    queueToDispatchMs += Math.max(0, options.nowMs() - entry.queued);
    slot.running = { id, entry, started: options.nowMs(), lease };
    try { slot.port.postMessage(message, entry.task.transfer ?? []); }
    catch (error) { lose(slot, error); }
  };
  const pump = (): void => {
    if (disposed) return;
    while (queue.length) {
      let slot = slots.find(candidate => !candidate.running && !candidate.waiting) ?? null;
      if (!slot) {
        if (unavailable || slots.length >= limit()) break;
        slot = spawn();
        if (!slot) break;
      }
      const entry = queue.shift()!;
      if (entry.settled) continue;
      if (slot.idle !== null) { options.timers.clearTimeout(slot.idle); slot.idle = null; }
      if (slot.port.compute) {
        const selected = slot, abort = new AbortController();
        selected.waiting = { entry, abort };
        void selected.port.compute!.acquire({ signal: abort.signal, priority: entry.priority }).then(lease => {
          if (selected.waiting?.entry === entry) selected.waiting = null;
          dispatch(selected, entry, lease); pump();
        }, error => {
          if (selected.waiting?.entry === entry) selected.waiting = null;
          if (settle(entry)) entry.reject(error);
          pump();
        });
      } else dispatch(slot, entry);
    }
    if (unavailable && !slots.length) failQueued(() => new WorkerPoolUnavailableError("No worker is available."));
    // Above the size (it may have shrunk) idle workers stop now; otherwise after idling.
    let excess = slots.length - limit();
    for (const slot of [...slots]) {
      if (slot.running || slot.waiting) continue;
      if (excess > 0) { excess--; stop(slot); } else if (!queue.length) retireLater(slot);
    }
  };
  return {
    available: () => !disposed && !unavailable && limit() > 0,
    run(task) {
      return new Promise<TReply>((resolve, reject) => {
        if (disposed) { reject(new WorkerPoolUnavailableError("The worker pool is disposed.")); return; }
        if (unavailable || limit() === 0) { reject(new WorkerPoolUnavailableError("No worker is available.")); return; }
        task.signal?.throwIfAborted();
        const entry: Entry<TRequest, TReply> = { task, priority: task.priority ?? 0, resolve, reject, settled: false, queued: options.nowMs() };
        if (task.signal) {
          const signal = task.signal;
          entry.onAbort = () => {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            const waiting = slots.find(slot => slot.waiting?.entry === entry)?.waiting;
            waiting?.abort.abort(signal.reason);
            // A running task keeps its worker until its reply arrives, then the reply is discarded.
            if (settle(entry)) reject(signal.reason);
          };
          signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        let at = queue.length;
        while (at > 0 && queue[at - 1].priority < entry.priority) at--;
        queue.splice(at, 0, entry);
        pump();
      });
    },
    stats: () => ({ workers: slots.length, busy: slots.filter(slot => slot.running).length, queued: queue.length + slots.filter(slot => slot.waiting).length, completed, losses,
      available: !disposed && !unavailable && limit() > 0,
      scheduling: { useful, stale, failed, retired, queueToDispatchMs, executionMs, oldestQueueMs: Math.max(queue.reduce((oldest, entry) => Math.max(oldest, options.nowMs() - entry.queued), 0), slots.reduce((oldest, slot) => slot.waiting ? Math.max(oldest, options.nowMs() - slot.waiting.entry.queued) : oldest, 0)) },
      perWorker: slots.map(slot => ({ tasks: slot.tasks, meanMs: slot.tasks ? slot.totalMs / slot.tasks : 0 })) }),
    dispose() {
      if (disposed) return;
      disposed = true;
      failQueued(() => new WorkerPoolUnavailableError("The worker pool is disposed."));
      for (const slot of [...slots]) {
        const running = slot.running; slot.running = null;
        const waiting = slot.waiting?.entry;
        stop(slot);
        if (running) { retired++; running.lease?.release("retired"); }
        if (waiting && settle(waiting)) waiting.reject(new WorkerPoolUnavailableError("The worker pool is disposed."));
        if (running && settle(running.entry)) running.entry.reject(new WorkerPoolUnavailableError("The worker pool is disposed."));
      }
    },
  };
}
