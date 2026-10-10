// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { VertexBuffer } from "@babylonjs/core";
import type { CurrentSurfaceReadiness } from "../src/index.js";
import { createLocalSurfaceHost } from "../fixtures/surface-readiness/mapHost.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";

const center = { samples: [{ latDeg: 0, lonDeg: 0 }] };

describe("public GlobeRuntime current displayed surface wiring", () => {
  it("does not make a distant hole ready when Google has visible geometry and streaming is idle", () => {
    const host = createLocalSurfaceHost(document);
    try {
      host.tiles().addGround(100); host.frame();
      const observation = host.runtime.displayedSurface.observe({ samples: [center.samples[0], { latDeg: 1, lonDeg: 0 }] });
      expect(host.runtime.isStreamingTiles()).toBe(false); expect(observation.read()).toMatchObject({ state: "unavailable", readySamples: 1, totalSamples: 2 });
      expect(host.runtime.surface.revision?.()).toBe(observation.read().revision);
      const first = observation.read().samples[0]; expect(first.status).toBe("hit");
      if (first.status === "hit") expect(first.hit.revision).toBe(observation.read().revision);
    } finally { host.disposeHost(); }
  });
  it("publishes actual geometry removal/replacement while external simulation is paused", () => {
    const host = createLocalSurfaceHost(document);
    try {
      const outgoing = host.tiles().addGround(100); host.frame();
      const observation = host.runtime.displayedSurface.observe(center), events: CurrentSurfaceReadiness[] = [];
      observation.subscribe(snapshot => events.push(snapshot)); const before = observation.read();
      host.tiles().removeGround(outgoing); expect(events.at(-1)).toMatchObject({ state: "unavailable", readySamples: 0 });
      expect(observation.isCurrent(before)).toBe(false);
      host.tiles().addGround(250); expect(events.at(-1)?.state).toBe("ready");
      const after = observation.read(); expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.samples[0]).toMatchObject({ height: { meters: expect.closeTo(250, 3), physicalDatum: "unknown" } });
      expect(host.runtime.shouldKeepRendering()).toBe(false);
    } finally { host.disposeHost(); }
  });
  it("retains outgoing Google hits during raster startup and versions source and adopted owner separately", async () => {
    const host = createLocalSurfaceHost(document);
    try {
      host.tiles().addGround(100); host.frame();
      const observation = host.runtime.displayedSurface.observe(center), before = observation.read();
      // Fixed legal level isolates source generation from ordinary terrain LOD settlement.
      const raster = { ...RASTER_BASE_MAP_SOURCES[0], minZoom: 2, maxZoom: 2 };
      host.runtime.setMapSource(raster);
      const pending = observation.read(); expect(pending.state).toBe("ready"); expect(pending.displayedSources).toContain("google");
      expect(pending.sourceGeneration).toBeGreaterThan(before.sourceGeneration); expect(observation.isCurrent(before)).toBe(false);
      host.images.splice(0).forEach(done => done()); await Promise.resolve(); await Promise.resolve(); host.frame(2);
      const adopted = observation.read(); expect(adopted.displayedSources).toEqual(["raster"]);
      expect(adopted.samples[0]).toMatchObject({ status: "hit", hit: { revision: adopted.revision } });
      const revision = adopted.revision, mesh = host.scene.meshes.find(candidate => candidate.isEnabled() && candidate.metadata?.mapSurface)!;
      const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind)!], normals = [...mesh.getVerticesData(VertexBuffer.NormalKind)!];
      const terrainZoom = mesh.metadata.terrainZoom;
      // Same stable ID, new provider version: public source forwarding must
      // invalidate observation currentness without rebuilding terrain.
      host.runtime.setMapSource({ ...raster, version: "2" });
      host.images.splice(0).forEach(done => done()); host.frame(3);
      const imageryOnly = observation.read(); expect(imageryOnly.revision).toBe(revision); expect(imageryOnly.sourceGeneration).toBeGreaterThan(adopted.sourceGeneration);
      expect([...mesh.getVerticesData(VertexBuffer.PositionKind)!]).toEqual(positions); expect([...mesh.getVerticesData(VertexBuffer.NormalKind)!]).toEqual(normals);
      expect(mesh.metadata.terrainZoom).toBe(terrainZoom); expect(host.elevation).toHaveLength(0);
      host.runtime.setMapSource("google"); const incoming = host.tiles();
      expect(observation.read().displayedSources).toContain("raster"); incoming.addGround(300); host.frame(4);
      expect(observation.read().displayedSources).toEqual(["google"]); expect(observation.read().state).toBe("ready");
    } finally { host.disposeHost(); }
  });
  it("publishes public render-pause and supplied simulation-running changes without hiding usable geometry", () => {
    const host = createLocalSurfaceHost(document);
    try {
      host.tiles().addGround(100); host.frame();
      const observation = host.runtime.displayedSurface.observe(center), listener = vi.fn(); observation.subscribe(listener); listener.mockClear();
      host.runtime.setPaused(true); expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", paused: true, simulationRunning: false }));
      host.runtime.setExternalRunning(true); expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", paused: true, simulationRunning: true }));
      host.runtime.setPaused(false); expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", paused: false }));
      host.runtime.setExternalRunning(false);
    } finally { host.disposeHost(); }
  });
  it("publishes post-promise queue retirement while paused using one cancellable host-clock read", () => {
    const host = createLocalSurfaceHost(document);
    try {
      host.tiles().addGround(100); host.frame();
      const observation = host.runtime.displayedSurface.observe(center), listener = vi.fn(); observation.subscribe(listener); listener.mockClear();
      // load-content can precede PriorityQueue.finally retirement. No frame
      // runs between this synthetic actual queue transition and the clock read.
      host.tiles().parseQueue.currJobs = 1; host.tiles().emit("load-content");
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", loading: true }));
      host.tiles().parseQueue.currJobs = 0;
      const newTimers = [...host.timers.entries()]; expect(newTimers).toHaveLength(1);
      host.flushTimers(); expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready", loading: false }));
      expect(host.timers.size).toBe(0); expect(host.runtime.shouldKeepRendering()).toBe(false);
      host.tiles().emit("load-content"); host.tiles().emit("load-model", { scene: host.tiles().group, tile: { geometricError: 10 } });
      expect(host.timers.size).toBe(1); host.runtime.destroy(); expect(host.timers.size).toBe(0);
    } finally { host.disposeHost(); }
  });
  it("delivers asynchronous failure and terminal disposal, then detaches every owner listener", () => {
    const host = createLocalSurfaceHost(document);
    try {
      host.tiles().addGround(100); host.frame();
      const observation = host.runtime.displayedSurface.observe({ samples: [{ latDeg: 1, lonDeg: 0 }] }), listener = vi.fn(); observation.subscribe(listener); listener.mockClear();
      host.tiles().emit("load-error", { error: new Error("Synthetic failure"), url: "https://fixture.invalid/failed.glb" });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", readySamples: 0 }));
      const retained = observation.read(), tiles = host.tiles(); host.runtime.destroy();
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "unavailable", disposed: true }));
      expect(observation.isCurrent(retained)).toBe(false); expect(tiles.listenerCount()).toBe(0);
      listener.mockClear(); tiles.emit("tiles-load-end"); expect(listener).not.toHaveBeenCalled();
    } finally { host.disposeHost(); }
  });
  it("redacts request credentials, query keys and fragments from exported failed-source errors", () => {
    const host = createLocalSurfaceHost(document);
    try {
      const observation = host.runtime.displayedSurface.observe(center), listener = vi.fn(); observation.subscribe(listener);
      host.runtime.setMapSource({ ...RASTER_BASE_MAP_SOURCES[0],
        urlTemplate: "https://fixture-user:fixture-password@fixture.invalid/signed-private/{z}/{x}/{y}?key=fixture-key#fixture-fragment" });
      host.imageFailures.splice(0).forEach(fail => fail(new Error("Synthetic failure at https://another-user:another-password@fixture.invalid/error?token=error-token#error-fragment")));
      const failure = observation.read(); expect(failure.state).toBe("failed");
      expect(failure.error).toBe("Synthetic failure at [provider URL] ([provider URL])");
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ error: failure.error }));
      for (const privateText of ["fixture-user", "fixture-password", "signed-private", "fixture-key", "fixture-fragment", "another-user", "another-password", "error-token", "error-fragment"]) {
        expect(JSON.stringify(failure)).not.toContain(privateText);
      }
    } finally { host.disposeHost(); }
  });
  it("retires synchronous supplied settlement handles and permits the next loading notification", () => {
    const host = createLocalSurfaceHost(document, true);
    try {
      host.tiles().addGround(100); host.frame();
      const observation = host.runtime.displayedSurface.observe(center), listener = vi.fn(); observation.subscribe(listener); listener.mockClear();
      const cancels = host.settlementCancels();
      host.tiles().parseQueue.currJobs = 1; host.tiles().emit("load-content");
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ loading: true }));
      host.tiles().parseQueue.currJobs = 0; host.tiles().emit("load-content");
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false }));
      expect(host.settlementCancels()).toBe(cancels + 2); expect(host.timers.size).toBe(0);
    } finally { host.disposeHost(); }
  });
  it("does not arm settlement when a current-evidence listener destroys the owner during refresh", () => {
    const host = createLocalSurfaceHost(document);
    try {
      host.tiles().addGround(100); host.frame(); const tiles = host.tiles();
      const observation = host.runtime.displayedSurface.observe(center);
      observation.subscribe(snapshot => { if (snapshot.loading && !snapshot.disposed) host.runtime.destroy(); });
      tiles.parseQueue.currJobs = 1; tiles.emit("load-content");
      expect(observation.read().disposed).toBe(true); expect(host.timers.size).toBe(0); expect(tiles.listenerCount()).toBe(0);
    } finally { host.disposeHost(); }
  });
});
