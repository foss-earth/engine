import { expect, it, vi } from "vitest";
import { createNativeMapSettlement, NativeMapStartupError } from "../src/babylon/nativeMapSettlement.js";
it("tracks inner native parser completion independently of a cancelled outer queue result", async () => {
  let resolve!: () => void; const actual = new Promise<void>(done => { resolve = done; });
  const owner = createNativeMapSettlement(), parse = vi.fn(() => actual), inner = owner.run(parse);
  owner.track(Promise.reject(new Error("queue removed"))).catch(() => {}); owner.close();
  let finished = false; const drain = owner.whenSettled().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); expect(parse).toHaveBeenCalledOnce();
  await expect(owner.run(parse)).rejects.toThrow("retired"); expect(parse).toHaveBeenCalledOnce();
  resolve(); await inner; await drain; expect(finished).toBe(true);
});
it("retains cleanup failures without stopping the other actual native jobs", async () => {
  let resolve!: () => void; const owner = createNativeMapSettlement(); owner.track(new Promise<void>(done => { resolve = done; }));
  owner.recordCleanupFailure(new Error("cleanup")); owner.close();
  const failure = expect(owner.whenSettled()).rejects.toThrow("cleanup"); resolve(); await failure;
});
it("retains startup diagnostics and cleanup causes while exposing the actual drain", async () => {
  const startup = new Error("Sky host failed"), cleanup = new Error("Partial mesh cleanup failed");
  let finish!: () => void, settled = false;
  const actual = new Promise<void>(resolve => { finish = resolve; });
  const failure = new NativeMapStartupError([new AggregateError([startup, cleanup], "Owner setup failed")], "Globe setup and cleanup failed.", () => actual);
  expect(failure.message).toContain(startup.message); expect(failure.errors).toEqual([startup, cleanup]);
  const drain = failure.whenSettled().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  finish(); await drain; expect(settled).toBe(true);
});
