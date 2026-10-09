import type { RenderScheduler } from "@foss-earth/renderer";

export type BorrowedGlobeScheduler = Pick<RenderScheduler, "requestRender" | "beginContinuous" | "endContinuous" | "setPaused" | "isActive" | "onActiveChange">;
/** Own feature holds/cleanup only; never stop or dispose borrowed authorities. */
export function createBorrowedRuntimeAuthority(host: BorrowedGlobeScheduler) {
  let disposed = false, holds = 0;
  const stops: Array<() => void> = [];
  const scheduler: BorrowedGlobeScheduler = {
    requestRender() { if (!disposed) host.requestRender(); },
    beginContinuous() { if (!disposed) { holds += 1; host.beginContinuous(); } },
    endContinuous() { if (holds > 0) { holds -= 1; host.endContinuous(); } },
    setPaused(paused) { if (!disposed) host.setPaused(paused); },
    isActive: () => !disposed && host.isActive(),
    onActiveChange(listener) { if (disposed) return () => undefined; const stop = host.onActiveChange(listener); let live = true; const once = () => { if (!live) return; live = false; stop(); }; stops.push(once); return once; },
  };
  return {
    scheduler,
    own(stop: () => void): () => void { let live = true; const once = () => { if (!live) return; live = false; stop(); }; if (disposed) once(); else stops.push(once); return once; },
    dispose() {
      if (disposed) return; disposed = true;
      const failures: unknown[] = [];
      for (const stop of stops.splice(0).reverse()) try { stop(); } catch (error) { failures.push(error); }
      while (holds > 0) { holds -= 1; try { host.endContinuous(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, "Globe feature cleanup failed.");
    },
  };
}
