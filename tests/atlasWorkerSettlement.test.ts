import { expect, it } from "vitest";
import { atlasWorkerHost, deferredWorker, flushWorker } from "../fixtures/composition/atlasWorkerHost.js";
for (const offThread of [true, false]) it(`waits real ${offThread ? "worker" : "fallback"} decoder input after cancellation`, async () => {
  const h = atlasWorkerHost(offThread), gate = deferredWorker<void>(); h.nativeWait(gate.promise);
  const loaded = h.load().catch((error: unknown) => error); await flushWorker(); h.loader.dispose(); h.bridge.dispose();
  let done = false; const drain = h.bridge.whenSettled().then(() => { done = true; });
  await flushWorker(); expect(done).toBe(false); expect(h.nativeCloses).not.toHaveBeenCalled();
  gate.resolve(); await loaded; await drain; expect(h.nativeCloses).toHaveBeenCalledOnce(); expect(h.broker.pools.live()).toEqual([]); h.dispose();
});
