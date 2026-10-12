// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BindingRuntime, type ActionIntent, type ActionIntentFrame } from "@felipegalind0/gamepad-tools/core";
import { createBrowserInputSource } from "@felipegalind0/gamepad-tools/browser";
import { createGlobeGamepadAdapter, createStandardGlobeProfile } from "../src/gamepad/index.js";
import type { GlobeNavigationIntentFrame } from "../src/input/globeNavigationTypes.js";

const rate = (actionId: string, value: number): ActionIntent =>
  ({ kind: "rate", actionId, value, dt: 0.016, source: { inputKind: "gamepad", selector: { kind: "gamepad-axis", gamepadSlot: 0, axisIndex: 2 }, bindingId: actionId } });
let frameId = 0;
const frame = (intents: readonly ActionIntent[], dt = 0.016, context = "globe"): ActionIntentFrame =>
  ({ frameId: ++frameId, timestamp: frameId * 16, dt, context, intents, conflicts: [] });

function adapter(context = () => "globe") {
  const applyGlobeNavigationIntents = vi.fn<(frame: GlobeNavigationIntentFrame) => void>();
  const applyNavigationIntents = vi.fn<(frame: ActionIntentFrame) => void>();
  const host = createGlobeGamepadAdapter({ applyGlobeNavigationIntents, applyNavigationIntents }, { getContext: context });
  return { host, applyGlobeNavigationIntents, applyNavigationIntents };
}

describe("a controller coming back to rest", () => {
  it("sends one empty frame when the sticks come back to the dead zone, and none after", () => {
    const f = adapter();
    f.host.applyIntents(frame([rate("globe.zoom", 0.5), rate("globe.panX", 0)]));
    f.host.applyIntents(frame([rate("globe.zoom", 0), rate("globe.panX", 0)], 0.02));
    f.host.applyIntents(frame([rate("globe.zoom", 0)]));
    f.host.applyIntents(frame([]));
    expect(f.applyGlobeNavigationIntents.mock.calls).toEqual([
      [{ dt: 0.016, intents: [{ actionId: "globe.zoom", value: 0.5 }] }],
      [{ dt: 0.02, intents: [] }],
    ]);
  });

  it("sends nothing while idle, nor for intents it does not move the globe with", () => {
    const f = adapter();
    f.host.applyIntents(frame([]));
    f.host.applyIntents(frame([rate("globe.zoom", 0), rate("globe.panY", NaN), rate("panorama.lookX", 0.7)]));
    f.host.applyIntents(frame([{ kind: "command", actionId: "globe.resetNorth", edge: "press", source: { inputKind: "gamepad", selector: { kind: "gamepad-button", gamepadSlot: 0, buttonIndex: 3 }, bindingId: "n" } }]));
    expect(f.applyGlobeNavigationIntents).not.toHaveBeenCalled();
  });

  it("ends each run of input on its own", () => {
    const f = adapter();
    for (const value of [0.4, 0, 0, -0.4, 0]) f.host.applyIntents(frame([rate("globe.orbitHeading", value)]));
    expect(f.applyGlobeNavigationIntents.mock.calls.map(([sent]) => sent.intents.length)).toEqual([1, 0, 1, 0]);
  });

  it("sends the empty frame when binding capture takes the controller mid-run, and none while it holds it", () => {
    const f = adapter();
    f.host.applyIntents(frame([rate("globe.panX", 1)]));
    f.host.setBindingCapture(true);
    f.host.applyIntents(frame([rate("globe.panX", 1)], 0.03));
    f.host.applyIntents(frame([rate("globe.panX", 1)]));
    expect(f.applyGlobeNavigationIntents.mock.calls.slice(1)).toEqual([[{ dt: 0.03, intents: [] }]]);
    f.host.setBindingCapture(false);
    f.host.applyIntents(frame([rate("globe.panX", 1)]));
    expect(f.applyGlobeNavigationIntents).toHaveBeenCalledTimes(3);
  });

  it("sends the empty frame when another context takes navigation mid-run, and gives that context its own intents", () => {
    let context = "globe";
    const f = adapter(() => context);
    f.host.applyIntents(frame([rate("globe.zoom", 1)]));
    context = "panorama";
    f.host.applyIntents(frame([rate("globe.zoom", 1), rate("panorama.lookX", 0.5)], 0.025, "panorama"));
    f.host.applyIntents(frame([rate("globe.zoom", 1)], 0.016, "panorama"));
    expect(f.applyGlobeNavigationIntents.mock.calls.slice(1)).toEqual([[{ dt: 0.025, intents: [] }]]);
    expect(f.applyNavigationIntents).toHaveBeenCalledOnce();
    expect(f.applyNavigationIntents.mock.calls[0][0].intents.map(intent => intent.actionId)).toEqual(["panorama.lookX"]);
  });

  it("sends nothing on capture or another context when the globe was not moving", () => {
    let context = "panorama";
    const f = adapter(() => context);
    f.host.applyIntents(frame([rate("globe.zoom", 1)], 0.016, "panorama"));
    context = "globe"; f.host.setBindingCapture(true);
    f.host.applyIntents(frame([rate("globe.zoom", 1)]));
    expect(f.applyGlobeNavigationIntents).not.toHaveBeenCalled();
  });
});

describe("a standard controller's sticks coming back to rest", () => {
  const DEADZONE = 0.15;
  let pad: Gamepad;
  const cleanups: (() => void)[] = [];
  beforeEach(() => {
    pad = { id: "Standard controller", index: 0, connected: true, mapping: "standard", timestamp: 0, axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })) } as unknown as Gamepad;
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: vi.fn(() => [pad]) });
  });
  afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); });

  it("sends one empty frame once the stick is inside the dead zone, and none while it stays there", () => {
    const applyGlobeNavigationIntents = vi.fn<(frame: GlobeNavigationIntentFrame) => void>();
    const source = createBrowserInputSource({ target: window });
    const runtime = new BindingRuntime({ profile: createStandardGlobeProfile(0, DEADZONE), adapter: createGlobeGamepadAdapter({ applyGlobeNavigationIntents }) });
    const detach = source.subscribe(next => runtime.dispatch(next));
    cleanups.push(() => { detach(); runtime.dispose(); source.dispose(); });
    const axis = (index: number, value: number) => { (pad.axes as number[])[index] = value; };
    for (let i = 0; i < 3; i++) source.tick();
    expect(applyGlobeNavigationIntents).not.toHaveBeenCalled();
    axis(2, 0.8);
    source.tick(); source.tick();
    const moving = applyGlobeNavigationIntents.mock.calls.length;
    expect(moving).toBeGreaterThan(0);
    expect(applyGlobeNavigationIntents.mock.calls.every(([sent]) => sent.intents.some(intent => intent.actionId === "globe.orbitHeading"))).toBe(true);
    axis(2, 0.1);
    for (let i = 0; i < 4; i++) source.tick();
    const after = applyGlobeNavigationIntents.mock.calls.slice(moving).map(([sent]) => sent);
    expect(after).toHaveLength(1);
    expect(after[0].intents).toEqual([]);
    expect(Number.isFinite(after[0].dt)).toBe(true);
  });
});
