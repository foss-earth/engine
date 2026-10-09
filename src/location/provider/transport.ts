import type { SearchTuning } from "./searchDefaults.js";

export interface LocationLookupTimers { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void }
export interface LocationLookupTransportPorts {
  fetch(url: string, options: { signal: AbortSignal }): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
  createAbortController(): AbortController;
  combineSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose(): void };
  timeoutError(): unknown;
  nowMs(): number;
  timers: LocationLookupTimers;
  tuning(): SearchTuning;
}

/** One supplied transport and request timers. No fetch, realm, polling or
 * default settings registry is constructed here. */
export function createLocationLookupTransport(ports: LocationLookupTransportPorts) {
  return { nowMs: () => ports.nowMs(), timers: ports.timers,
    wait(delayMs: number, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        let finished = false, arming = true, elapsedDuringSetup = false, timerOwned = false;
        let timer: unknown;
        const finish = (failure?: { error: unknown }): void => {
          if (finished) return;finished = true;
          const failures: unknown[] = failure ? [failure.error] : [];
          try { signal.removeEventListener("abort", cancel); } catch (error) { failures.push(error); }
          if (timerOwned) try { ports.timers.clearTimeout(timer); } catch (error) { failures.push(error); }
          if (failures.length > 1) reject(new AggregateError(failures,"Location lookup wait and cleanup failed."));
          else if (failures.length) reject(failures[0]);else resolve();
        };
        const cancel = (): void => finish({ error: signal.reason });
        try {
          timer = ports.timers.setTimeout(() => { if (arming) elapsedDuringSetup = true;else finish(); }, delayMs);timerOwned = true;arming = false;
          if (elapsedDuringSetup) { finish();return; }
          signal.addEventListener("abort",cancel,{ once: true });if (signal.aborted) cancel();
        } catch (error) { finish({ error }); }
      });
    },
    async json(url: string, signal: AbortSignal, label: "Location" | "Airport"): Promise<unknown> {
      signal.throwIfAborted();
      const timeout = ports.createAbortController();
      let timer: unknown, timerOwned = false;
      let combined: ReturnType<LocationLookupTransportPorts["combineSignals"]> | undefined;
      const failures: unknown[] = [];let value: unknown;
      try {
        timer = ports.timers.setTimeout(() => timeout.abort(ports.timeoutError()), ports.tuning().timeoutMs);timerOwned = true;
        combined = ports.combineSignals([signal, timeout.signal]);
        combined.signal.throwIfAborted();
        const response = await ports.fetch(url, { signal: combined.signal });
        if (!response.ok) throw new Error(`${label} lookup failed (${response.status}). Try again.`);
        value = await response.json();
        combined.signal.throwIfAborted();
      } catch (error) { failures.push(error); }
      finally {
        if (timerOwned) try { ports.timers.clearTimeout(timer); } catch (error) { failures.push(error); }
        if (combined) try { combined.dispose(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Location lookup transport and cleanup failed.");
      return value;
    },
  };
}
export type LocationLookupTransport = ReturnType<typeof createLocationLookupTransport>;
