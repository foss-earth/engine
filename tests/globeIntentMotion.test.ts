import { describe, expect, it, vi } from "vitest";
import { createGlobeIntentMotion, DEFAULT_GLOBE_INTENT_RATES } from "../src/input/globeIntentMotion.js";
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
