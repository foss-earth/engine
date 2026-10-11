import { describe, expect, it, vi } from "vitest";
import { createGlobeOverviewBinding, type GlobeOverviewOptions } from "../src/navigation/globeOverview.js";
import { createOrbitViewSnapshot } from "../src/camera/orbitView.js";
const record = { target: { longitudeDeg: 0, latitudeDeg: 0 }, distanceMeters: 100, headingDeg: 0, pitchDeg: -45, verticalFovDeg: 60 };
function fixture() {
  let resolve!: (value: { groundHeightMeters: number; altitudeMeters: number }) => void;
  const terrain = new Promise<{ groundHeightMeters: number; altitudeMeters: number }>(yes => { resolve = yes; });
  let snapshot = createOrbitViewSnapshot({ ...record, longitudeDeg: 0, latitudeDeg: 0, heightMeters: 0 });
  let ground: number | null = null, overview = true;
  const restore = vi.fn((next: typeof snapshot) => { snapshot = next; return true; });
  const prepare = vi.fn(() => terrain);
  const runtime = { surface: { sample: () => ground === null ? null : ({ heightMeters: ground }) }, prepareTerrain: prepare,
    captureNavigationSnapshot: () => snapshot, restoreNavigationSnapshot: restore, requestRender: vi.fn() };
  const binding = createGlobeOverviewBinding({ runtime, isOverview: () => overview,
    minimumPreparationRadiusMeters: () => 300, configuredFovDegrees: () => 50,
    createAbortController: () => new AbortController(), combineSignals: signals => AbortSignal.any([...signals]), abortReason: () => new Error("fresh input") } as GlobeOverviewOptions<AbortSignal>);
  return { binding, prepare, restore, runtime, resolve, ground: (value: number) => { ground = value; },
    busy: () => { overview = false; }, move: () => { snapshot = { ...snapshot, view: { ...snapshot.view, lonDeg: 1 } }; } };
}
describe("generic globe overview", () => {
  it("uses adopted ground without a DEM request and restores only its applied FOV", async () => {
    const f = fixture(); f.ground(7); expect(await f.binding.showOverview(record)).toEqual({ ok: true, state: "applied" });
    expect(f.prepare).not.toHaveBeenCalled(); f.binding.dispose(); await f.binding.whenSettled();
    expect(f.restore.mock.calls.at(-1)![0].camera.fov).toBeCloseTo(50 * Math.PI / 180);
  });
  for (const cancel of ["input", "camera", "panorama", "dispose"] as const) it(`awaits actual preparation after ${cancel} cancellation without applying stale overview`, async () => {
    const f = fixture(), work = f.binding.showOverview(record);
    expect(f.prepare.mock.calls[0]).toBeDefined(); expect(f.binding.isPending()).toBe(true);
    if (cancel === "input") f.binding.cancel(); else if (cancel === "camera") { f.move(); f.binding.observeFrame(); }
    else if (cancel === "panorama") { f.busy(); f.binding.observeFrame(); } else f.binding.dispose();
    let done = false; const drain = f.binding.whenSettled().then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    f.resolve({ groundHeightMeters: 10, altitudeMeters: 10 }); expect(await work).toMatchObject({ ok: false, reason: "cancelled" }); await drain;
    expect(f.restore).not.toHaveBeenCalled(); f.binding.dispose();
  });
  it("supersedes old preparation and refuses overview while another viewer owns the camera", async () => {
    const f = fixture(), first = f.binding.showOverview(record); f.ground(9);
    expect(await f.binding.showOverview({ ...record, headingDeg: 90 })).toMatchObject({ ok: true });
    f.resolve({ groundHeightMeters: 10, altitudeMeters: 10 }); expect(await first).toMatchObject({ reason: "cancelled" });
    f.busy(); expect(await f.binding.showOverview(record)).toMatchObject({ reason: "busy" }); f.binding.dispose();
  });
});
