/** Host-owned admission for ready worker work, independent of Worker lifetime.
 * A lease covers dispatch through reply or the owner's termination action.
 * Browser termination has no exit acknowledgement; retired is not measured CPU.
 */
export type ComputeOutcome = "useful" | "stale" | "failed" | "retired";
export interface ComputeLease { readonly lanes: number; release(outcome?: ComputeOutcome): void }
export interface ComputeAdmissionPort {
  /** Whole team, coordinator included. May grant a smaller supported team after
   * a limit reduction; the dispatcher must use exactly the returned width. */
  /** Priority's sign supplies one urgency step; arbitrary tile scores cannot
   * defeat bounded aging across components. Local pools keep their full order. */
  acquire(request?: { lanes?: number; signal?: AbortSignal; priority?: number }): Promise<ComputeLease>;
}
export interface ComputeWorker { readonly compute?: ComputeAdmissionPort }
export interface ComputeObservation {
  component: string; queued: number; active: number; useful: number; stale: number; failed: number; retired: number;
  admissionWaitMs: number; executionMs: number; maxWaitMs: number; oldestMs: number;
}
export interface ComputeAdmissionSnapshot {
  limit: number; active: number; queued: number; observing: boolean; disposed: boolean;
  components: ComputeObservation[];
}
export interface ComputeAdmission {
  port(component: string, priority?: number): ComputeAdmissionPort;
  setLimit(lanes: number): void;
  snapshot(): ComputeAdmissionSnapshot;
  dispose(): void;
}
const width = (lanes: number): number => {
  if (!Number.isSafeInteger(lanes) || lanes < 1) throw new RangeError("Compute lanes must be a positive integer.");
  return lanes;
};
/** No timer, worker, polling, I/O or partial team grants. FIFO within urgency;
 * aging is evaluated only on real admission/release/change events. */
export function createComputeAdmission(options: { limit: number; now(): number; observe?: boolean; agingMs?: number }): ComputeAdmission {
  let limit = width(options.limit), active = 0, disposed = false, sequence = 0;
  const observing = options.observe === true, agingMs = options.agingMs ?? 1000;
  if (!(agingMs > 0 && Number.isFinite(agingMs))) throw new RangeError("Invalid compute aging window.");
  type Entry = { lanes: number; signal?: AbortSignal; abort(): void; queued: number; priority: number; order: number;
    stats: ComputeObservation; resolve(lease: ComputeLease): void; reject(error: unknown): void };
  const queue: Entry[] = [], components = new Map<string, ComputeObservation>();
  const pump = (): void => {
    if (disposed) return;
    while (queue.length) {
      const now = options.now();
      queue.sort((a, b) => (b.priority + Math.floor((now - b.queued) / agingMs)) - (a.priority + Math.floor((now - a.queued) / agingMs)) || a.order - b.order);
      const entry = queue[0], lanes = Math.min(entry.lanes, limit);
      // Reserve no partial permits, and do not starve a team with younger jobs.
      if (active + lanes > limit) return;
      queue.shift(); entry.signal?.removeEventListener("abort", entry.abort);
      const stats = entry.stats;
      active += lanes; stats.active += lanes; stats.queued--;
      if (observing) { const wait = Math.max(0, now - entry.queued); stats.admissionWaitMs += wait; stats.maxWaitMs = Math.max(stats.maxWaitMs, wait); }
      let released = false;
      entry.resolve({ lanes, release(outcome = "useful") {
        if (released) return;
        released = true; active -= lanes; stats.active -= lanes; stats[outcome]++;
        if (observing) stats.executionMs += Math.max(0, options.now() - now);
        pump();
      } });
    }
  };
  return {
    port(component, priority = 0) {
      if (!Number.isFinite(priority)) throw new RangeError("Invalid compute urgency.");
      let stats = components.get(component);
      if (!stats) {
        // Host-defined names only: no per-tile labels or unbounded histories.
        if (components.size >= 32) throw new RangeError("Too many compute components.");
        stats = { component, queued: 0, active: 0, useful: 0, stale: 0, failed: 0, retired: 0, admissionWaitMs: 0, executionMs: 0, maxWaitMs: 0, oldestMs: 0 };
        components.set(component, stats);
      }
      const observed = stats;
      return { acquire(request = {}) {
        return new Promise<ComputeLease>((resolve, reject) => {
          if (disposed) { reject(new Error("Compute admission disposed.")); return; }
          request.signal?.throwIfAborted();
          if (!Number.isFinite(request.priority ?? 0)) { reject(new RangeError("Invalid compute urgency.")); return; }
          const entry: Entry = { lanes: width(request.lanes ?? 1), signal: request.signal, queued: options.now(), priority: Math.sign(priority) + Math.sign(request.priority ?? 0), order: sequence++, stats: observed, resolve, reject,
            abort() { const index = queue.indexOf(entry); if (index < 0) return; queue.splice(index, 1); observed.queued--; entry.signal?.removeEventListener("abort", entry.abort); reject(entry.signal?.reason); pump(); } };
          observed.queued++; queue.push(entry); entry.signal?.addEventListener("abort", entry.abort, { once: true }); pump();
        });
      } };
    },
    setLimit(lanes) { limit = width(lanes); pump(); },
    snapshot() {
      const now = observing ? options.now() : 0;
      return { limit, active, queued: queue.length, observing, disposed,
        components: [...components.values()].map(stats => ({ ...stats, oldestMs: observing ? queue.reduce((oldest, entry) => entry.stats === stats ? Math.max(oldest, now - entry.queued) : oldest, 0) : 0 })) };
    },
    dispose() { if (disposed) return; disposed = true; for (const entry of queue.splice(0)) { entry.stats.queued--; entry.signal?.removeEventListener("abort", entry.abort); entry.reject(new Error("Compute admission disposed.")); } },
  };
}
