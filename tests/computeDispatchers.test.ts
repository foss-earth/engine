import { describe, expect, it, vi } from "vitest";
import { createComputeAdmission } from "../src/browser/computeAdmission.js";
import { createGroundBvhPreparer } from "../src/browser/groundBvhPreparer.js";
import type { GroundBvhWorkerPort, GroundBvhWorkerReply } from "../src/browser/groundBvhProtocol.js";
import { createTerrainHeightBatches } from "../src/browser/terrainHeightBatches.js";
import type { HeightBatchWorkerPort } from "../src/browser/terrainHeightBatchProtocol.js";

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("dedicated compute dispatchers", () => {
  it("ground waits without an execution timer, then releases a reply and cancels disposal waiters", async () => {
    const a = createComputeAdmission({ limit: 1, now: () => 0 }), busy = await a.port("terrain").acquire();
    let message!: (event: { data?: unknown }) => void;
    const w: GroundBvhWorkerPort = { compute: a.port("ground"), postMessage: vi.fn(), terminate: vi.fn(), addEventListener(type, listener) { if (type === "message") message = listener; } };
    const timers = new Set<unknown>();
    const ground = createGroundBvhPreparer({ kernel: "typescript", createWorker: () => w, now: () => 0,
      timers: { set(callback) { timers.add(callback); return callback; }, clear(timer) { timers.delete(timer); } } });
    const request = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), generation: 1 };
    const pending = ground.prepare(request); await tick(); expect(timers.size).toBe(0); expect(w.postMessage).not.toHaveBeenCalled();
    busy.release(); await tick(); expect(timers.size).toBe(1);
    const reply: GroundBvhWorkerReply = { type: "built", id: 1, result: { generation: 1, snapshot: new Float64Array(1), actual: "typescript", parity: "not-run", fallbackReason: null, workMs: 1 } };
    message({ data: reply }); await pending; expect(a.snapshot().active).toBe(0); expect(timers.size).toBe(0);
    const block = await a.port("sky").acquire(), queued = ground.prepare(request); ground.dispose();
    await expect(queued).rejects.toThrow("disposed"); await tick(); expect(a.snapshot().queued).toBe(0); block.release();
  });
  it("height caches keep exact page answers during pressure and cancel queued admission on disposal", async () => {
    const a = createComputeAdmission({ limit: 1, now: () => 0 }), busy = await a.port("sky").acquire();
    const w: HeightBatchWorkerPort = { compute: a.port("height-cache", -1), onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() };
    const scheduled: Array<() => void> = [], after = vi.fn(() => () => {});
    const heights = createTerrainHeightBatches({ kernel: "typescript", createWorker: () => w, now: () => 0, schedule: callback => scheduled.push(callback), after });
    const grid = { z: 0, x: 0, y: 0, size: 2, heights: new Float32Array([10, 10, 10, 10]) };
    expect(heights.sample(grid, new Float64Array([.5, .5]))).toEqual(new Float64Array([10])); scheduled.shift()!(); await tick();
    expect(w.postMessage).not.toHaveBeenCalled(); expect(after).not.toHaveBeenCalled(); expect(a.snapshot().queued).toBe(1);
    heights.dispose(); await tick(); expect(a.snapshot().queued).toBe(0); busy.release(); expect(a.snapshot().active).toBe(0);
  });
});
