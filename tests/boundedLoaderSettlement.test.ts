import { expect, it } from "vitest";
import { atlasWorkerHost, flushWorker } from "../fixtures/composition/atlasWorkerHost.js";
import { deferredWorker } from "../fixtures/composition/atlasWorkerHost.js";
it("keeps prepared pages charged through terminal settlement while a native consumer retains them", async () => {
  const h = atlasWorkerHost(), image = await h.load(), release = image.retain(); image.close(); h.loader.dispose();
  let done = false; const drain = h.loader.whenSettled().then(() => { done = true; }); await flushWorker();
  expect(done).toBe(false); expect(h.broker.pools.stats().decoded.reserved).toBeGreaterThan(0);
  release(); await drain; expect(h.broker.pools.live()).toEqual([]); h.dispose();
});
it("does not turn a completed readback into proof that delayed canvas storage retired", async () => {
  const h = atlasWorkerHost(false), retired = deferredWorker<void>();
  h.surfaceFailure(undefined, retired.promise);
  const image = await h.load(); image.close(); h.loader.dispose();
  let done = false; const drain = h.loader.whenSettled().then(() => { done = true; });
  await flushWorker(); expect(done).toBe(false); expect(h.broker.pools.stats().decoded.reserved).toBeGreaterThan(0);
  retired.resolve(); await drain; expect(h.broker.pools.live()).toEqual([]); h.dispose();
});
