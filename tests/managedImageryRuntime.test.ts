import { GeospatialCamera, NullEngine, Scene, StandardMaterial, type UniformBuffer } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { HostCameraController } from "../fixtures/composition/runtimeHost.js";
import { ownedAtlasHost, flushOwnedAtlas, OWNED_ATLAS_GPU_BUDGET } from "../fixtures/composition/ownedAtlasHost.js";
import { createImageryRuntime } from "../src/babylon/imagery/createImageryRuntime.js";
import { ImageryAtlasMaterialPlugin } from "../src/babylon/imagery/imageryMaterialPlugin.js";

function harness() {
  const host = ownedAtlasHost(), engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 }), scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("owned-table", scene, { planetRadius: 6378137 });
  new HostCameraController(camera, () => 0).applyViewState({ latDeg: 36.1, lonDeg: -112.14, zoomMeters: 30_000, pitchDeg: 0, headingDeg: 0 });
  let frame = true, now = 0, nativeIndex = 0;
  const timers: { at: number; callback(): void }[] = [];
  const source = { id: "old", version: "1", label: "Old", provider: "Fixture", attribution: "Fixture", protocol: "xyz" as const, kind: "cartographic" as const, urlTemplate: "https://fixture.invalid/old/{z}/{x}/{y}", maxZoom: 14 };
  const runtime = createImageryRuntime({ scene, source, loader: { load: async (_url, expected) => host.image(expected.width, expected.height) },
    device: host.device, managedAtlas: host.resources, createAbortController: () => new AbortController(), capabilities: { backend: "webgpu", maxTextureSize: 8192, explicitGradients: true },
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 8, getRevision: () => 0 },
    limits: { gpuBytes: OWNED_ATLAS_GPU_BUDGET, stagingBytes: 16 * 2 ** 20, concurrentRequests: 2, queuedRequests: 128, uploadBytesPerUpdate: 8 * 2 ** 20, cpuMsPerUpdate: 2, missingRetryMs: 1000, retryDelayMs: { min: 2000, max: 30000 } },
    tuning: { reselectWhileMovingMs: 0, anisotropy: 4, fallbackGap: 4, fallbackStep: 3, tablePatches: 1, maxNodes: 12_000, hysteresis: { refineAbove: 1.2, coarsenBelow: 0.8, coarsenAfterMs: 500, pinMs: 1000 } },
    requestRender: () => { frame = true; }, now: () => now, log: { warn() {} },
    after(callback, delay) { const timer = { at: now + delay, callback }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index,1); }; },
  });
  const material = new StandardMaterial("patch", scene); runtime.attachPatch("patch", { z: 2, x: 0, y: 1 }, material); runtime.setPatchVisible("patch", true);
  const binding = () => {
    const plugin = material.pluginManager!.getPlugin("ImageryAtlas") as ImageryAtlasMaterialPlugin, values: Record<string, number[]> = {}, textures: Record<string, unknown> = {};
    plugin.bindForSubMesh({ updateFloat4(name: string, ...value: number[]) { values[name] = value; }, setTexture(name: string, texture: unknown) { textures[name] = texture; } } as unknown as UniformBuffer); return { ...values, textures };
  };
  const pump = async (holdTables = false) => {
    for (let turn = 0; turn < 120; turn++) {
      if (frame) { frame = false; runtime.update(); await flushOwnedAtlas(); }
      while (nativeIndex < host.native.length) {
        const next = host.native[nativeIndex]; if (holdTables && next.table) return next;
        nativeIndex += 1; next.resolve(); await flushOwnedAtlas();
      }
      if (!frame) return null;
    }
    throw new Error("Managed host frame failed to settle.");
  };
  return { host, runtime, binding, pump, source, gpuBudget: OWNED_ATLAS_GPU_BUDGET, switchSource() { runtime.setSource({ ...source, id: "new", label: "New", urlTemplate: "https://fixture.invalid/new/{z}/{x}/{y}" }); },
    completeTable() { host.native[nativeIndex++].resolve(); }, failTable(error: unknown) { host.native[nativeIndex++].reject(error); },
    advance(ms: number) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.splice(timers.indexOf(timer),1); timer.callback(); } },
    dispose() { runtime.dispose(); host.dispose(); scene.dispose(); engine.dispose(); } };
}

describe("managed actual runtime table acknowledgement", () => {
  it("keeps outgoing binding and attribution until incoming table success and retirement", async () => {
    const h = harness();
    try { await h.pump(); expect(h.runtime.getDiagnostics().counters.tableWrites).toBeGreaterThan(0); expect(h.runtime.getDisplayedSourceId()).toBe("old"); const before = h.binding(), writes = h.runtime.getDiagnostics().counters.tableWrites;
      h.switchSource(); const pending = await h.pump(true); expect(pending?.table).toBe(true); expect(h.binding()).toEqual(before); expect(h.runtime.getDisplayedSourceId()).toBe("old"); expect(h.runtime.getDiagnostics().counters.tableWrites).toBe(writes);
      h.completeTable(); await flushOwnedAtlas(); await h.pump(); expect(h.runtime.getDisplayedSourceId()).toBe("new"); expect(h.runtime.getDiagnostics().counters.tableWrites).toBeGreaterThan(writes);
      // Coordinates can repeat in a distinct physical source generation. Both
      // adopted native textures must change after acknowledged table success.
      expect(h.binding().textures.imageryPageTable).not.toBe(before.textures.imageryPageTable);
      expect(h.binding().textures.imageryAtlas).not.toBe(before.textures.imageryAtlas);
    } finally { h.dispose(); }
  });
  it("preserves old display and acknowledgement while unknown table completion remains quarantined", async () => {
    const h = harness();
    try { await h.pump(); const before = h.binding(), writes = h.runtime.getDiagnostics().counters.tableWrites; h.switchSource(); expect((await h.pump(true))?.table).toBe(true);
      h.failTable(new Error("unknown table completion")); await flushOwnedAtlas(); await h.pump(); expect(h.binding()).toEqual(before); expect(h.runtime.getDisplayedSourceId()).toBe("old"); expect(h.runtime.getDiagnostics().counters.tableWrites).toBe(writes);
      // Rejection is not proof: quarantined block/copy survives until actual loss.
      expect(h.host.broker.pools.stats().uploadOutstanding.reserved).toBeGreaterThan(0); h.host.tracker.deviceLost(); await flushOwnedAtlas();
      expect(h.runtime.getDisplayedSourceId()).toBe("old");
    } finally { h.dispose(); }
  });
  it("retries a partial native table failure after actual retirement through the existing host deadline", async () => {
    const h = harness();
    try { await h.pump(); const before = h.binding(); h.host.onWrite(() => { if (h.host.writes.at(-1)?.width === 64) throw new Error("partial native table failure"); });
      h.switchSource(); expect((await h.pump(true))?.table).toBe(true); h.completeTable(); await flushOwnedAtlas(); await h.pump();
      expect(h.binding()).toEqual(before); expect(h.runtime.getDisplayedSourceId()).toBe("old"); h.host.onWrite(() => {}); h.advance(2000); await h.pump(); expect(h.runtime.getDisplayedSourceId()).toBe("new");
    } finally { h.dispose(); }
  });
  it("uses two physical table blocks per logical patch inside the same named GPU budget", async () => {
    const h = harness();
    try { await h.pump(); const diagnostics = h.runtime.getDiagnostics(); expect(diagnostics.atlas!.tableBlocks).toBeGreaterThanOrEqual(2); expect(diagnostics.atlas!.estimatedGpuBytes).toBeLessThanOrEqual(h.gpuBudget); expect(diagnostics.binding.blocks).toBeLessThanOrEqual(1); }
    finally { h.dispose(); }
  });
  it("keeps bound slots and material on full upload refusal and resumes after actual capacity availability", async () => {
    const h = harness();
    try { await h.pump(); const before = h.binding(); const cap = h.host.broker.pools.limits().uploadOutstanding, grant = h.host.broker.pools.reserve("uploadOutstanding", cap, "other outstanding owner"); if (!grant.ok) throw new Error(grant.reason);
      h.switchSource(); await h.pump(); expect(h.binding()).toEqual(before); expect(h.runtime.getDisplayedSourceId()).toBe("old"); grant.reservation.release(); await flushOwnedAtlas(); await h.pump(); expect(h.runtime.getDisplayedSourceId()).toBe("new"); }
    finally { h.dispose(); }
  });
});
