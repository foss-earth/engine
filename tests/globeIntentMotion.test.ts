import { describe, expect, it, vi } from "vitest";
import { createGlobeIntentMotion, DEFAULT_GLOBE_INTENT_RATES } from "../src/input/globeIntentMotion.js";
import type { CameraInputTarget } from "../src/input/inertialCameraController.js";
import type { GlobeNavigationIntentFrame } from "../src/input/globeNavigationTypes.js";
import type { AnchorAcquisition, AnchorOperation, AnchorRequest, NavigationAnchor } from "../src/input/navigationAnchors.js";
function fixture() {
  const target = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
  let blocked = false; let rates = { ...DEFAULT_GLOBE_INTENT_RATES };
  const apply = createGlobeIntentMotion({ blocked: () => blocked, target: () => target, canvasHeightPx: () => 800, rates: () => rates });
  return { target, apply, block: () => { blocked = true; }, rates: (next: typeof rates) => { rates = next; } };
}
describe("existing globe intent motion authority", () => {
  it("keeps source directions/units and uses the supplied live rate change", () => {
    const f = fixture();
    f.apply({ dt: 0.02, intents: [ { actionId: "globe.panX", value: 1 }, { actionId: "globe.panY", value: 1 },
      { actionId: "globe.orbitHeading", value: 1 }, { actionId: "globe.orbitPitch", value: 1 }, { actionId: "globe.zoom", value: 1 } ] });
    expect(f.target.panBy.mock.calls).toEqual([[18, 0, 800], [0, -18, 800]]);
    expect(f.target.orbitBy.mock.calls).toEqual([[0, 1.5], [1.3, 0]]);
    expect(f.target.zoomBy).toHaveBeenCalledWith(Math.exp(-0.03));
    f.rates({ ...DEFAULT_GLOBE_INTENT_RATES, panPxPerSecond: 450 });
    f.apply({ dt: 0.02, intents: [{ actionId: "globe.panX", value: 1 }] });
    expect(f.target.panBy).toHaveBeenLastCalledWith(9, 0, 800);
  });
  it("does not send an old or idle gesture into a navigation-owned camera", () => {
    const f = fixture();
    f.apply({ dt: NaN, intents: [{ actionId: "globe.panX", value: 1 }] });
    f.apply({ dt: 1, intents: [{ actionId: "globe.panX", value: NaN }, { actionId: "globe.zoom", value: 0 }] });
    f.block(); f.apply({ dt: 0.02, intents: [{ actionId: "globe.panX", value: 1 }] });
    expect(f.target.panBy).not.toHaveBeenCalled(); expect(f.target.zoomBy).not.toHaveBeenCalled();
  });
  it("caps elapsed input time and full-stick value without creating a second loop", () => {
    const f = fixture(); f.apply({ dt: 10, intents: [{ actionId: "globe.orbitHeading", value: 5 }] });
    expect(f.target.orbitBy).toHaveBeenCalledExactlyOnceWith(0, 7.5);
  });
});
describe("anchors for keys, controllers and buttons", () => {
  const anchor = (session: number, operation: AnchorOperation): NavigationAnchor => ({ session, owner: "globe", family: "nonPointer", operation,
    requested: "pinned", source: "pinned", point: { x: 1, y: 2, z: 3 }, surfaceRevision: null, fallback: null });
  const NON_POINTER: AnchorRequest = { family: "nonPointer", operations: ["zoom", "orbit"], client: null, hold: true };
  function anchored(acquisition: (session: number) => AnchorAcquisition = session => ({ zoom: anchor(session, "zoom"), orbit: anchor(session, "orbit") })) {
    let session = 0;
    const target = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(),
      acquireAnchors: vi.fn<(request: AnchorRequest) => AnchorAcquisition>(() => acquisition(++session)), releaseAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>() };
    let blocked = false; let current: CameraInputTarget | null = target;
    const apply = createGlobeIntentMotion({ blocked: () => blocked, target: () => current, canvasHeightPx: () => 800, rates: () => DEFAULT_GLOBE_INTENT_RATES });
    return { target, apply, block: (next: boolean) => { blocked = next; }, use: (next: CameraInputTarget | null) => { current = next; } };
  }
  const turn: GlobeNavigationIntentFrame = { dt: 0.02, intents: [{ actionId: "globe.orbitHeading", value: 1 }, { actionId: "globe.orbitPitch", value: 1 }, { actionId: "globe.zoom", value: 1 }] };
  const zoom: GlobeNavigationIntentFrame = { dt: 0.02, intents: [{ actionId: "globe.zoom", value: 1 }] };

  it("acquires once for a run of zoom and rotation, without a pointer, and moves about what it acquired", () => {
    const f = anchored();
    f.apply(turn); f.apply(turn); f.apply(zoom);
    expect(f.target.acquireAnchors).toHaveBeenCalledExactlyOnceWith(NON_POINTER);
    const acquired = f.target.acquireAnchors.mock.results[0].value as AnchorAcquisition;
    expect(f.target.orbitBy.mock.calls.slice(0, 2)).toEqual([[0, 1.5, acquired.orbit], [1.3, 0, acquired.orbit]]);
    expect(f.target.zoomBy.mock.calls).toEqual([[Math.exp(-0.03), acquired.zoom], [Math.exp(-0.03), acquired.zoom], [Math.exp(-0.03), acquired.zoom]]);
    expect(f.target.releaseAnchors).not.toHaveBeenCalled();
  });

  it("ends the run with a frame of no zoom or rotation, releasing what it acquired, and the next zoom acquires again", () => {
    const f = anchored();
    f.apply(zoom);
    const first = f.target.acquireAnchors.mock.results[0].value as AnchorAcquisition;
    f.apply({ dt: 0.02, intents: [] });
    expect(f.target.releaseAnchors).toHaveBeenCalledExactlyOnceWith(first);
    f.apply({ dt: 0.02, intents: [] });
    expect(f.target.releaseAnchors).toHaveBeenCalledTimes(1);
    f.apply(zoom);
    expect(f.target.acquireAnchors).toHaveBeenCalledTimes(2);
    const second = f.target.acquireAnchors.mock.results[1].value as AnchorAcquisition;
    expect(second).not.toBe(first);
    expect(f.target.zoomBy).toHaveBeenLastCalledWith(Math.exp(-0.03), second.zoom);
  });

  it("ends the run with a pan alone, which pans and acquires nothing", () => {
    const f = anchored();
    f.apply(turn);
    f.apply({ dt: 0.02, intents: [{ actionId: "globe.panX", value: 1 }, { actionId: "globe.zoom", value: 0 }] });
    expect(f.target.releaseAnchors).toHaveBeenCalledExactlyOnceWith(f.target.acquireAnchors.mock.results[0].value);
    expect(f.target.panBy).toHaveBeenCalledExactlyOnceWith(18, 0, 800);
    expect(f.target.acquireAnchors).toHaveBeenCalledTimes(1);
  });

  it("acquires nothing for a pan or an idle frame", () => {
    const f = anchored();
    f.apply({ dt: 0.02, intents: [{ actionId: "globe.panX", value: 1 }, { actionId: "globe.panY", value: -1 }] });
    f.apply({ dt: 0.02, intents: [] });
    expect(f.target.acquireAnchors).not.toHaveBeenCalled();
    expect(f.target.releaseAnchors).not.toHaveBeenCalled();
  });

  it("ends the run when navigation is blocked, and moves nothing while it is", () => {
    const f = anchored();
    f.apply(turn);
    f.target.orbitBy.mockClear(); f.target.zoomBy.mockClear();
    f.block(true); f.apply(turn); f.apply(turn);
    expect(f.target.releaseAnchors).toHaveBeenCalledExactlyOnceWith(f.target.acquireAnchors.mock.results[0].value);
    expect(f.target.orbitBy).not.toHaveBeenCalled(); expect(f.target.zoomBy).not.toHaveBeenCalled();
    expect(f.target.acquireAnchors).toHaveBeenCalledTimes(1);
    f.block(false); f.apply(zoom);
    expect(f.target.acquireAnchors).toHaveBeenCalledTimes(2);
  });

  it("releases on the old target when the target changes, and acquires on the new one", () => {
    const f = anchored();
    f.apply(zoom);
    const next = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(), acquireAnchors: vi.fn(() => ({ zoom: anchor(99, "zoom") })), releaseAnchors: vi.fn() };
    f.use(next); f.apply(zoom);
    expect(f.target.releaseAnchors).toHaveBeenCalledExactlyOnceWith(f.target.acquireAnchors.mock.results[0].value);
    expect(next.acquireAnchors).toHaveBeenCalledExactlyOnceWith(NON_POINTER);
    expect(next.zoomBy).toHaveBeenCalledExactlyOnceWith(Math.exp(-0.03), anchor(99, "zoom"));
    expect(f.target.zoomBy).toHaveBeenCalledTimes(1);
    f.use(null); f.apply(zoom);
    expect(next.releaseAnchors).toHaveBeenCalledOnce();
  });

  it("moves an operation the acquisition has no anchor for about the orbit target, as before anchors", () => {
    const f = anchored(session => ({ orbit: anchor(session, "orbit") }));
    f.apply(turn);
    expect(f.target.zoomBy.mock.calls).toEqual([[Math.exp(-0.03)]]);
    expect(f.target.orbitBy.mock.calls[0]).toHaveLength(3);
  });

  it("keeps the calls from before anchors for a target without them", () => {
    const f = fixture();
    f.apply(turn); f.apply({ dt: 0.02, intents: [] }); f.apply(zoom);
    expect(f.target.orbitBy.mock.calls).toEqual([[0, 1.5], [1.3, 0]]);
    expect(f.target.zoomBy.mock.calls).toEqual([[Math.exp(-0.03)], [Math.exp(-0.03)]]);
  });
});
