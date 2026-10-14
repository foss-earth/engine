import { describe, expect, it, vi } from "vitest";
import { createWorkerPool, WorkerPoolUnavailableError, type PoolWorkerPort, type WorkerPoolOptions } from "../src/browser/workerPool.js";

type Request = { id: number; value: number };
type Reply = { id: number; value: number };
class FakeWorker implements PoolWorkerPort<Request, Reply> {
  onmessage: PoolWorkerPort<Request, Reply>["onmessage"] = null;
  onerror: PoolWorkerPort<Request, Reply>["onerror"] = null;
  onmessageerror: PoolWorkerPort<Request, Reply>["onmessageerror"] = null;
  received: Request[] = []; transfers: Transferable[][] = []; terminated = false; postFailure: unknown = null;
  postMessage(message: Request, transfer: Transferable[]) { if (this.postFailure) throw this.postFailure; this.received.push(message); this.transfers.push(transfer); }
  terminate() { this.terminated = true; }
  last() { return this.received[this.received.length - 1]; }
  reply(value = this.last().value * 2, id = this.last().id) { this.onmessage?.({ data: { id, value } } as MessageEvent<Reply>); }
  crash(message = "boom") { this.onerror?.({ message } as ErrorEvent); }
}
function fixture(overrides: Partial<WorkerPoolOptions<Request, Reply>> = {}) {
  const workers: FakeWorker[] = [], timers = new Set<{ callback: () => void; ms: number }>();
  let size = 2, now = 0;
  const onError = vi.fn(), discard = vi.fn();
  const pool = createWorkerPool<Request, Reply>({
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    size: () => size, nowMs: () => now, idleMs: 1000, onError, discard,
    timers: { setTimeout: (callback, ms) => { const handle = { callback, ms }; timers.add(handle); return handle; },
      clearTimeout: handle => { timers.delete(handle as { callback: () => void; ms: number }); } },
    ...overrides,
  });
  const run = (value: number, options: { priority?: number; signal?: AbortSignal } = {}) => pool.run({ message: id => ({ id, value }), ...options });
  const fireTimers = () => { for (const timer of [...timers]) { timers.delete(timer); timer.callback(); } };
  return { pool, workers, timers, onError, discard, run, fireTimers,
    setSize(next: number) { size = next; }, advance(ms: number) { now += ms; } };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("worker pool", () => {
  it("starts workers up to its size as work queues, and the first worker to finish takes the next task", async () => {
    const f = fixture(), results = [f.run(1), f.run(2), f.run(3)];
    expect(f.workers).toHaveLength(2);
    expect(f.pool.stats()).toMatchObject({ workers: 2, busy: 2, queued: 1 });
    f.workers[1].reply();
    expect(f.workers[1].received.map(request => request.value)).toEqual([2, 3]);
    f.workers[1].reply(); f.workers[0].reply();
    expect((await Promise.all(results)).map(reply => reply.value)).toEqual([2, 4, 6]);
    expect(f.pool.stats()).toMatchObject({ workers: 2, busy: 0, queued: 0, completed: 3, losses: 0, available: true });
  });
  it("runs higher priorities first and equal priorities in the order they were queued", async () => {
    const f = fixture(); f.setSize(1);
    const first = f.run(0), rest = [f.run(1), f.run(2), f.run(3, { priority: 1 }), f.run(4, { priority: 1 }), f.run(5, { priority: -1 })];
    for (let index = 0; index < 6; index++) f.workers[0].reply();
    await Promise.all([first, ...rest]);
    expect(f.workers[0].received.map(request => request.value)).toEqual([0, 3, 4, 1, 2, 5]);
  });
  it("passes transferables with the message and gives each task its own id", async () => {
    const f = fixture(), buffer = new ArrayBuffer(8);
    const result = f.pool.run({ message: id => ({ id, value: 7 }), transfer: [buffer] });
    expect(f.workers[0].transfers[0]).toEqual([buffer]);
    f.workers[0].reply(); expect(await result).toEqual({ id: f.workers[0].received[0].id, value: 14 });
    const next = f.run(8); expect(f.workers[0].received[1].id).not.toBe(f.workers[0].received[0].id); f.workers[0].reply(); await next;
  });
  it("drops an aborted queued task without sending it and discards the late reply of an aborted running task", async () => {
    const f = fixture(); f.setSize(1);
    const runningAbort = new AbortController(), queuedAbort = new AbortController();
    const running = f.run(1, { signal: runningAbort.signal }), queued = f.run(2, { signal: queuedAbort.signal }), after = f.run(3);
    queuedAbort.abort(new Error("queued gone")); runningAbort.abort(new Error("running gone"));
    await expect(queued).rejects.toThrow("queued gone"); await expect(running).rejects.toThrow("running gone");
    // The worker stays busy until its reply arrives, then takes the next live task.
    expect(f.pool.stats()).toMatchObject({ busy: 1, queued: 1 });
    f.workers[0].reply();
    expect(f.discard).toHaveBeenCalledWith({ id: f.workers[0].received[0].id, value: 2 });
    expect(f.workers[0].received.map(request => request.value)).toEqual([1, 3]);
    f.workers[0].reply(); expect((await after).value).toBe(6);
    await expect(f.run(4, { signal: AbortSignal.abort(new Error("already")) })).rejects.toThrow("already");
  });
  it("rejects a task whose worker stops with WorkerPoolUnavailableError, so its caller can do it itself", async () => {
    const f = fixture(); f.setSize(1);
    const lost = f.run(1), next = f.run(2);
    f.workers[0].crash("script failed");
    const error = await lost.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WorkerPoolUnavailableError);
    expect((error as Error).cause).toEqual(new Error("A pool worker stopped: script failed"));
    expect(f.onError).toHaveBeenCalledOnce(); expect(f.workers[0].terminated).toBe(true);
    // One loss: the queued task goes to a new worker.
    expect(f.workers).toHaveLength(2); expect(f.workers[1].last().value).toBe(2);
    f.workers[1].reply(); expect((await next).value).toBe(4);
    expect(f.pool.stats()).toMatchObject({ losses: 1, available: true });
  });
  it("stops starting workers after the second loss and rejects what is queued", async () => {
    const f = fixture(); f.setSize(1);
    const first = f.run(1), second = f.run(2), third = f.run(3);
    f.workers[0].crash(); f.workers[1].crash();
    for (const result of [first, second, third]) await expect(result).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(f.pool.available()).toBe(false); expect(f.workers).toHaveLength(2);
    await expect(f.run(4)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
  });
  it("loses a worker that answers a task it was not given, or whose reply cannot be read", async () => {
    const f = fixture(); f.setSize(1);
    const wrong = f.run(1); f.workers[0].reply(2, 999);
    await expect(wrong).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    const unreadable = f.run(2); f.workers[1].onmessageerror?.({} as MessageEvent);
    await expect(unreadable).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(f.pool.available()).toBe(false);
  });
  it("is unavailable when the host has no worker, a factory throws, or the size is 0", async () => {
    const none = fixture({ createWorker: () => null });
    expect(none.pool.available()).toBe(true);
    await expect(none.run(1)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(none.pool.available()).toBe(false);
    const failure = new Error("CSP"), throwing = fixture({ createWorker: () => { throw failure; } });
    await expect(throwing.run(1)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(throwing.onError).toHaveBeenCalledWith(failure);
    const empty = fixture(); empty.setSize(0);
    expect(empty.pool.available()).toBe(false);
    await expect(empty.run(1)).rejects.toBeInstanceOf(WorkerPoolUnavailableError); expect(empty.workers).toHaveLength(0);
  });
  it("rejects only the task whose message cannot be built", async () => {
    const f = fixture(); f.setSize(1);
    const failure = new Error("bad input");
    const broken = f.pool.run({ message: () => { throw failure; } }), fine = f.run(2);
    await expect(broken).rejects.toBe(failure);
    f.workers[0].reply(); expect((await fine).value).toBe(4);
    expect(f.pool.stats().losses).toBe(0);
  });
  it("loses a worker whose postMessage throws, and its task falls back", async () => {
    const f = fixture({ createWorker: () => { const worker = new FakeWorker(); worker.postFailure = new Error("DataCloneError"); return worker; } });
    await expect(f.run(1)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(f.pool.stats().losses).toBe(1);
  });
  it("stops a worker after it idles, and starts one again for new work", async () => {
    const f = fixture();
    const result = f.run(1); f.workers[0].reply(); await result;
    expect([...f.timers].map(timer => timer.ms)).toEqual([1000]);
    f.fireTimers();
    expect(f.workers[0].terminated).toBe(true); expect(f.pool.stats().workers).toBe(0);
    const again = f.run(2); expect(f.workers).toHaveLength(2); f.workers[1].reply(); expect((await again).value).toBe(4);
  });
  it("keeps a busy worker's idle timer from stopping it", async () => {
    const f = fixture(); f.setSize(1);
    const first = f.run(1); f.workers[0].reply(); await first;
    const second = f.run(2); expect(f.timers.size).toBe(0);
    f.fireTimers(); expect(f.workers[0].terminated).toBe(false);
    f.workers[0].reply(); await second;
  });
  it("stops idle workers above a smaller size and never starts more than 16", async () => {
    const f = fixture(); f.setSize(3);
    const results = [f.run(1), f.run(2), f.run(3)];
    f.setSize(1);
    f.workers[0].reply(); f.workers[1].reply();
    expect(f.workers.map(worker => worker.terminated)).toEqual([true, true, false]);
    f.workers[2].reply(); await Promise.all(results);
    const big = fixture(); big.setSize(64);
    const many = Array.from({ length: 20 }, (_, index) => big.run(index));
    expect(big.workers).toHaveLength(16); expect(big.pool.stats().queued).toBe(4);
    big.pool.dispose(); await Promise.allSettled(many);
  });
  it("reports finished tasks and mean task time for each live worker", async () => {
    const f = fixture(); f.setSize(1);
    const a = f.run(1); f.advance(10); f.workers[0].reply(); await a;
    const b = f.run(2); f.advance(30); f.workers[0].reply(); await b;
    expect(f.pool.stats().perWorker).toEqual([{ tasks: 2, meanMs: 20 }]);
  });
  it("on dispose rejects queued and running tasks, terminates every worker and ignores late replies", async () => {
    const f = fixture(); f.setSize(1);
    const running = f.run(1), queued = f.run(2), worker = f.workers[0], handler = worker.onmessage;
    f.pool.dispose();
    await expect(running).rejects.toBeInstanceOf(WorkerPoolUnavailableError); await expect(queued).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(worker.terminated).toBe(true); expect(worker.onmessage).toBeNull();
    handler?.({ data: { id: worker.received[0].id, value: 1 } } as MessageEvent<Reply>);
    expect(f.discard).not.toHaveBeenCalled();
    await expect(f.run(3)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    await flush(); expect(f.pool.available()).toBe(false);
  });
});
