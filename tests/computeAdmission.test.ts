import { describe, expect, it } from "vitest";
import { createComputeAdmission } from "../src/browser/computeAdmission.js";
import { createWorkerPool, type PoolWorkerPort } from "../src/browser/workerPool.js";

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("shared fixed compute admission", () => {
  it("queues capacity pressure, wakes on release and measures wait separately from admitted spans", async () => {
    let now = 0;
    const a = createComputeAdmission({ limit: 1, now: () => now, observe: true });
    const first = await a.port("terrain").acquire();
    now = 5; const queued = a.port("sky").acquire(); now = 35;
    expect(a.snapshot()).toMatchObject({ active: 1, queued: 1 });
    first.release(); const second = await queued; now = 42; second.release();
    expect(a.snapshot().components).toMatchObject([
      { component: "terrain", useful: 1, executionMs: 35, admissionWaitMs: 0 },
      { component: "sky", useful: 1, executionMs: 7, admissionWaitMs: 30, maxWaitMs: 30 },
    ]);
    second.release("retired"); expect(a.snapshot().active).toBe(0);
  });
  it("cancels queued demand and does not release a granted team on caller abort", async () => {
    const a = createComputeAdmission({ limit: 2, now: () => 0 }), port = a.port("sky");
    const liveAbort = new AbortController(), live = await port.acquire({ lanes: 2, signal: liveAbort.signal });
    const abort = new AbortController(), pending = port.acquire({ signal: abort.signal });
    abort.abort(new Error("obsolete")); await expect(pending).rejects.toThrow("obsolete");
    liveAbort.abort(); expect(a.snapshot()).toMatchObject({ active: 2, queued: 0 });
    live.release("stale"); expect(a.snapshot().components[0].stale).toBe(1);
  });
  it("shrinks by draining, grants a whole smaller supported team and recovers to full allowed width", async () => {
    const a = createComputeAdmission({ limit: 12, now: () => 0 }), p = a.port("sky");
    const old = await p.acquire({ lanes: 8 }); a.setLimit(1);
    const next = p.acquire({ lanes: 8 }); await tick(); expect(a.snapshot().queued).toBe(1);
    old.release(); const small = await next; expect(small.lanes).toBe(1); small.release();
    a.setLimit(12); const full = await p.acquire({ lanes: 12 }); expect(full.lanes).toBe(12); full.release();
  });
  it("does not starve an older whole team with younger single-lane work", async () => {
    const a = createComputeAdmission({ limit: 4, now: () => 0 }), p = a.port("team");
    const first = await p.acquire({ lanes: 2 }), team = p.acquire({ lanes: 4 }), single = a.port("terrain").acquire();
    await tick(); expect(a.snapshot()).toMatchObject({ active: 2, queued: 2 });
    first.release(); const full = await team; expect(full.lanes).toBe(4); expect(a.snapshot().queued).toBe(1);
    full.release(); (await single).release();
  });
  it("ages optional work at real completion events without an aging timer", async () => {
    let now = 0;
    const a = createComputeAdmission({ limit: 1, now: () => now, agingMs: 10 });
    const busy = await a.port("sky").acquire(), optional = a.port("cache", -1).acquire();
    now = 30; const urgent = a.port("terrain", 1).acquire(); busy.release();
    (await optional).release(); (await urgent).release();
    expect(a.snapshot()).toMatchObject({ active: 0, queued: 0, observing: false });
  });
  it("settles queued demand on disposal while owned live leases retire independently", async () => {
    const a = createComputeAdmission({ limit: 1, now: () => 0 }), p = a.port("ground");
    const live = await p.acquire(), queued = p.acquire(); a.dispose();
    await expect(queued).rejects.toThrow("disposed"); await expect(p.acquire()).rejects.toThrow("disposed");
    expect(a.snapshot().active).toBe(1); live.release("retired"); expect(a.snapshot().active).toBe(0);
  });
  it("rejects invalid widths and bounds labels without any topology dependency", async () => {
    for (const limit of [0, -1, NaN, Infinity, 1.5]) expect(() => createComputeAdmission({ limit, now: () => 0 })).toThrow();
    const a = createComputeAdmission({ limit: 32, now: () => 0 });
    await expect(a.port("unknown topology").acquire({ lanes: 0 })).rejects.toThrow();
    const full = await a.port("homogeneous CPU").acquire({ lanes: 32 }); expect(full.lanes).toBe(32); full.release();
  });
});

describe("worker dispatch owns admission", () => {
  function fixture(limit = 2) {
    let now = 0;
    const admission = createComputeAdmission({ limit, now: () => now, observe: true });
    type Message = { id: number };
    const workers: Array<PoolWorkerPort<Message, Message> & { messages: Message[]; terminated: boolean }> = [];
    const timers = new Set<unknown>();
    const pool = createWorkerPool<Message, Message>({
      createWorker() { const w = { compute: admission.port("terrain"), onmessage: null, onerror: null, messages: [] as Message[], terminated: false,
        postMessage(message: Message) { this.messages.push(message); }, terminate() { this.terminated = true; } }; workers.push(w); return w; },
      size: () => 4, nowMs: () => now, idleMs: 1000,
      timers: { setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout(handle) { timers.delete(handle); } },
    });
    const run = (signal?: AbortSignal) => pool.run({ message: id => ({ id }), signal });
    const reply = (index: number) => { const w = workers[index]; w.onmessage?.({ data: w.messages.at(-1)! } as MessageEvent<Message>); };
    return { admission, workers, pool, run, reply, timers, advance(ms: number) { now += ms; } };
  }
  it("limits existing workers precisely, retains cancelled compute and reuses workers after drain", async () => {
    const f = fixture(), abort = new AbortController();
    const one = f.run(abort.signal), two = f.run(), three = f.run(); await tick();
    expect(f.workers.filter(w => w.messages.length)).toHaveLength(2);
    abort.abort(new Error("view replaced")); await expect(one).rejects.toThrow("view replaced");
    expect(f.admission.snapshot().active).toBe(2);
    f.admission.setLimit(1); f.advance(10); f.reply(0); await tick();
    expect(f.workers[2].messages).toHaveLength(0);
    f.reply(1); await two; await tick(); expect(f.workers[2].messages).toHaveLength(1);
    f.reply(2); await three;
    expect(f.pool.stats().scheduling).toMatchObject({ useful: 2, stale: 1 });
    f.admission.setLimit(4); const more = [f.run(), f.run(), f.run(), f.run()]; await tick();
    expect(f.pool.stats().busy).toBe(4);
    for (let i = 0; i < 4; i++) f.reply(i); await Promise.all(more); f.pool.dispose();
    expect(f.admission.snapshot()).toMatchObject({ active: 0, queued: 0 }); expect(f.timers.size).toBe(0);
  });
  it("removes a cancelled admission waiter without unavailability and retires all owned work on disposal", async () => {
    const f = fixture(1), abort = new AbortController(), first = f.run(), queued = f.run(abort.signal);
    await tick(); abort.abort(new Error("cancelled")); await expect(queued).rejects.toThrow("cancelled");
    expect(f.pool.available()).toBe(true); expect(f.admission.snapshot().queued).toBe(0);
    f.pool.dispose(); await expect(first).rejects.toThrow("disposed"); await tick();
    expect(f.admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
    expect(f.workers.every(w => w.terminated)).toBe(true);
  });
  it("retires a lost worker's grant and wakes another existing worker without leaking a lane", async () => {
    const f = fixture(1), lost = f.run(), next = f.run(); await tick();
    f.workers[0].onerror?.({ message: "worker lost" } as ErrorEvent);
    await expect(lost).rejects.toThrow("stopped"); await tick();
    expect(f.workers[0].terminated).toBe(true); expect(f.workers[1].messages).toHaveLength(1);
    expect(f.admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    f.reply(1); await next; f.pool.dispose();
    expect(f.admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
    expect(f.admission.snapshot().components[0]).toMatchObject({ retired: 1, useful: 1 });
  });
});
