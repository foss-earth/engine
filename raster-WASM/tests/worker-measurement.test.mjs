import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMeasurement } from "../scripts/worker-measurement.mjs";

class FakeWorker extends EventEmitter {
  constructor(backend) { super(); this.backend = backend; this.references = 1; this.terminated = false; queueMicrotask(() => this.emit("message", { ready: true, actualBackend: backend })); }
  ref() { this.references++; } unref() { this.references--; }
  terminate() { this.terminated = true; return Promise.resolve(0); }
  postMessage(message) { queueMicrotask(() => this.emit("message", { id: message.id, heights: new Float32Array(message.size * message.size).fill(1), kernelAndCopyMs: 1, actualBackend: this.backend })); }
}
test("worker measurements use the actual returned output and do not accept backend fallback", async () => {
  let worker;
  const measure = await createMeasurement("single", { createWorker: () => worker = new FakeWorker("single") });
  const result = await measure();
  assert.equal(result.disturbances.actualBackend, "single"); assert.equal(result.digest.length, 64);
  worker.backend = "typescript";
  await assert.rejects(measure(), /backend/);
  await measure.dispose(); assert.equal(worker.terminated, true);
});
test("startup and lost jobs fail within a bound and retire the owned worker", async () => {
  let worker;
  await assert.rejects(createMeasurement("single", { timeoutMs: 5, createWorker: () => { worker = new FakeWorker("typescript"); return worker; } }), /startup/);
  assert.equal(worker.terminated, true);
  const measure = await createMeasurement("typescript", { timeoutMs: 5, createWorker: () => worker = new FakeWorker("typescript") });
  worker.postMessage = () => {};
  await assert.rejects(measure(), /failed/); assert.equal(worker.terminated, true);
});
