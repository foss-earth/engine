import { describe, expect, it, vi } from "vitest";
import { createCurrentDisplayedSurface, type CurrentSurfaceOwnerState, type CurrentSurfaceReadiness } from "../src/surface/currentReadiness.js";
import type { SurfaceHit } from "../src/surface/contracts.js";

const locality = { samples: [{ latDeg: 44.973, lonDeg: -93.235 }, { latDeg: 44.974, lonDeg: -93.235 }] };
function fixture() {
  let owner: CurrentSurfaceOwnerState = { revision: 1, sourceGeneration: 1, selectedSource: "raster:fixture",
    displayedSources: ["raster"], loading: false, paused: false, simulationRunning: null, suspended: false, error: null };
  let holes = new Set<number>();
  let height = 100, quality = 12;
  const sample = vi.fn((lat: number): SurfaceHit | null => holes.has(lat) ? null : {
    revision: owner.revision, meshId: "displayed-triangle", heightMeters: height, quality,
    point: { x: 6378237, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, distanceMeters: 19900,
  });
  const query = { sample, raycast: () => null, revision: () => owner.revision };
  const surface = createCurrentDisplayedSurface(query, () => owner);
  return { surface, query, sample, setOwner(next: Partial<CurrentSurfaceOwnerState>) { owner = { ...owner, ...next }; },
    replace(nextHeight: number, nextQuality: number) { height = nextHeight; quality = nextQuality; owner = { ...owner, revision: owner.revision + 1 }; },
    setHoles(next: number[]) { holes = new Set(next); owner = { ...owner, revision: owner.revision + 1 }; } };
}

describe("current local displayed surface evidence", () => {
  it("requires every requested point, rather than a visible mesh elsewhere or an idle network", () => {
    const f = fixture(); f.setHoles([locality.samples[1].latDeg]);
    const observation = f.surface.observe(locality), snapshot = observation.read();
    expect(snapshot.state).toBe("unavailable"); expect(snapshot.readySamples).toBe(1); expect(snapshot.loading).toBe(false);
    expect(snapshot.samples[1]).toMatchObject({ status: "missing", reason: "no-displayed-hit" });
    f.setHoles([]); f.surface.refresh(); expect(observation.read().state).toBe("ready"); f.surface.dispose();
  });
  it("keeps displayed geometry usable while loading and suspended, with its explicit unknown physical datum", () => {
    const f = fixture(); f.setOwner({ loading: true, suspended: true });
    const snapshot = f.surface.observe(locality).read();
    expect(snapshot.state).toBe("ready"); expect(snapshot).toMatchObject({ loading: true, suspended: true });
    expect(snapshot.samples[0]).toMatchObject({ height: { meters: 100, datum: "wgs84-ellipsoid-coordinate", physicalDatum: "unknown" } });
    f.surface.dispose();
  });
  it("does no repeated query or callback work for unchanged settled frames", () => {
    const f = fixture(), observation = f.surface.observe(locality), listener = vi.fn(); observation.subscribe(listener);
    const snapshot = observation.read(); f.sample.mockClear(); listener.mockClear();
    for (let frame = 0; frame < 20; frame += 1) { f.surface.refresh(); expect(observation.read()).toBe(snapshot); }
    expect(f.sample).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); f.surface.dispose();
  });
  it("versions actual geometry replacement and rejects an old hit snapshot", () => {
    const f = fixture(), observation = f.surface.observe(locality), before = observation.read();
    f.replace(250, 15); f.surface.refresh(); const after = observation.read();
    expect(after.revision).toBeGreaterThan(before.revision); expect(observation.isCurrent(before)).toBe(false);
    expect(observation.isCurrent(after)).toBe(true); expect(after.samples[0]).toMatchObject({ hit: { heightMeters: 250, quality: 15, revision: after.revision } });
    f.surface.dispose();
  });
  it("versions source selection independently of unchanged terrain geometry", () => {
    const f = fixture(), observation = f.surface.observe(locality), before = observation.read();
    f.setOwner({ sourceGeneration: 2, selectedSource: "raster:second-imagery" }); f.surface.refresh();
    const after = observation.read(); expect(after.revision).toBe(before.revision); expect(after.samples).toEqual(before.samples);
    expect(observation.isCurrent(before)).toBe(false); expect(after.sourceGeneration).toBe(2); f.surface.dispose();
  });
  it("publishes raster/Google transitions with retained outgoing triangles and later local holes", () => {
    const f = fixture(), observation = f.surface.observe(locality), events: CurrentSurfaceReadiness[] = [];
    observation.subscribe(snapshot => events.push(snapshot));
    f.setOwner({ sourceGeneration: 2, selectedSource: "google", displayedSources: ["raster"], loading: true }); f.surface.refresh();
    expect(events.at(-1)).toMatchObject({ state: "ready", selectedSource: "google", displayedSources: ["raster"] });
    f.setOwner({ displayedSources: ["google"] }); f.setHoles([locality.samples[0].latDeg]); f.surface.refresh();
    expect(events.at(-1)).toMatchObject({ state: "loading", readySamples: 1, displayedSources: ["google"] }); f.surface.dispose();
  });
  it("publishes loading/failure and pause changes without a frame or timer", () => {
    const f = fixture(); f.setHoles(locality.samples.map(point => point.latDeg));
    const observation = f.surface.observe(locality), listener = vi.fn(); observation.subscribe(listener); listener.mockClear();
    f.setOwner({ loading: true, suspended: true }); f.surface.refresh(); expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "loading", suspended: true }));
    f.setOwner({ loading: false, error: "Synthetic elevation failure" }); f.surface.refresh();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", error: "Synthetic elevation failure" })); f.surface.dispose();
  });
  it("rejects a mixed-revision batch if the owner changes during a query", () => {
    const f = fixture(); const normal = f.sample.getMockImplementation()!;
    f.sample.mockImplementationOnce(lat => { const hit = normal(lat); f.setOwner({ revision: 2 }); return hit; });
    const observation = f.surface.observe(locality), first = observation.read();
    // read refreshes the superseded batch; inspect the causal published first
    // batch by causing the change in an already subscribed observation instead.
    expect(first.state).toBe("ready");
    const listener = vi.fn(); observation.subscribe(listener); listener.mockClear();
    f.setOwner({ revision: 3 }); f.sample.mockImplementationOnce(lat => { const hit = normal(lat); f.setOwner({ revision: 4 }); return hit; });
    f.surface.refresh(); expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ readySamples: 0,
      samples: [expect.objectContaining({ reason: "stale-revision" }), expect.objectContaining({ reason: "stale-revision" })] }));
    expect(observation.isCurrent(first)).toBe(false); expect(observation.read().state).toBe("ready"); f.surface.dispose();
  });
  it("rejects nonfinite hits and a query exception rather than claiming ground readiness", () => {
    const f = fixture(); f.sample.mockImplementation(() => ({ revision: 1, meshId: "bad", heightMeters: NaN,
      quality: 1, point: { x: 1, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, distanceMeters: 1 }));
    const observation = f.surface.observe(locality); expect(observation.read().readySamples).toBe(0);
    f.setOwner({ revision: 2 }); f.sample.mockImplementation(() => { throw new Error("Synthetic query failure"); }); f.surface.refresh();
    expect(observation.read().state).toBe("failed"); f.surface.dispose();
  });
  it("copies locality, bounds work and changes currentness when the local demand moves", () => {
    const f = fixture(), input = { samples: [{ latDeg: 0, lonDeg: 179.999 }] }, observation = f.surface.observe(input), before = observation.read();
    input.samples[0].latDeg = 100; expect(before.locality.samples[0].latDeg).toBe(0);
    expect(() => observation.updateLocality(input)).toThrow(RangeError); expect(observation.isCurrent(before)).toBe(true);
    observation.updateLocality({ samples: [{ latDeg: 89.999, lonDeg: -179.999 }] }); expect(observation.isCurrent(before)).toBe(false);
    expect(() => f.surface.observe({ samples: [] })).toThrow(RangeError);
    expect(() => f.surface.observe({ samples: Array.from({ length: 26 }, () => ({ latDeg: 0, lonDeg: 0 })) })).toThrow(RangeError); f.surface.dispose();
  });
  it.each(["quality", "geometric-error"])("rejects nonfinite %s evidence", field => {
    const f = fixture(), normal = f.sample.getMockImplementation()!;
    f.sample.mockImplementation(lat => ({ ...normal(lat)!, ...(field === "quality" ? { quality: NaN } : { geometricErrorMeters: Infinity }) }));
    const observation = f.surface.observe(locality); expect(observation.read()).toMatchObject({ state: "unavailable", readySamples: 0 }); f.surface.dispose();
  });
  it("keeps each published callback batch immutable under reentrant status changes", () => {
    const f = fixture(), observation = f.surface.observe(locality), received: CurrentSurfaceReadiness[] = [];
    observation.subscribe(snapshot => { if (snapshot.loading && !snapshot.paused) { f.setOwner({ paused: true }); f.surface.refresh(); } });
    observation.subscribe(snapshot => received.push(snapshot)); received.length = 0;
    f.setOwner({ loading: true }); f.surface.refresh();
    expect(received.map(snapshot => snapshot.paused)).toEqual([false, true]);
    expect(received[1].sequence).toBeGreaterThan(received[0].sequence);
    expect(observation.read().paused).toBe(true); f.surface.dispose();
  });
  it("unsubscribes idempotently, publishes disposal once and releases every observation", () => {
    const f = fixture(), observation = f.surface.observe(locality), removed = vi.fn(), terminal = vi.fn();
    const stop = observation.subscribe(removed); stop(); stop(); observation.subscribe(terminal);
    const before = observation.read(); removed.mockClear(); terminal.mockClear(); f.surface.dispose(); f.surface.dispose();
    expect(removed).not.toHaveBeenCalled(); expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ state: "unavailable", disposed: true, readySamples: 0 }));
    expect(observation.isCurrent(before)).toBe(false); expect(() => f.surface.observe(locality)).toThrow("disposed");
    const calls = f.sample.mock.calls.length; f.surface.refresh(); observation.dispose(); expect(f.sample).toHaveBeenCalledTimes(calls);
  });
});
