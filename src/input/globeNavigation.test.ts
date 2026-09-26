// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BindingRuntime, validateProfileImport } from "@felipegalind0/gamepad-tools/core";
import { createBrowserInputSource } from "@felipegalind0/gamepad-tools/browser";
import {
  GLOBE_GAMEPAD_ACTIONS,
  createGlobeGamepadAdapter,
  createStandardGlobeProfile,
  withStickDeadzone,
  type GlobeNavigationIntentFrame,
} from "./globeNavigation";

const DEADZONE = 0.15;
const cleanups: (() => void)[] = [];
let pad: Gamepad;

beforeEach(() => {
  pad = {
    id: "Standard controller", index: 0, connected: true, mapping: "standard", timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })),
  } as unknown as Gamepad;
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true, value: vi.fn(() => [pad]),
  });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

function axis(index: number, value: number): void {
  (pad.axes as number[])[index] = value;
}

function button(index: number, value: number): void {
  Object.assign(pad.buttons[index], { value, pressed: value > 0.5 });
}

function outsideDeadzone(value: number): number {
  return Math.sign(value) * (Math.abs(value) - DEADZONE) / (1 - DEADZONE);
}

function harness() {
  const applyGlobeNavigationIntents = vi.fn<(frame: GlobeNavigationIntentFrame) => void>();
  const onResetNorth = vi.fn();
  const source = createBrowserInputSource({ target: window });
  const runtime = new BindingRuntime({
    profile: createStandardGlobeProfile(),
    adapter: createGlobeGamepadAdapter({ applyGlobeNavigationIntents }, { onResetNorth }),
  });
  const detach = source.subscribe((frame) => runtime.dispatch(frame));
  cleanups.push(() => { detach(); runtime.dispose(); source.dispose(); });
  const step = () => {
    applyGlobeNavigationIntents.mockClear();
    source.tick();
    const intents = applyGlobeNavigationIntents.mock.calls.flatMap(([frame]) => frame.intents);
    return (actionId: string) => intents.find((intent) => intent.actionId === actionId)?.value;
  };
  return { runtime, step, applyGlobeNavigationIntents, onResetNorth };
}

describe("standard globe controller profile", () => {
  it("binds every globe action and survives export and import for this host", () => {
    const profile = createStandardGlobeProfile();
    expect(new Set(profile.bindings.map((binding) => binding.actionId)))
      .toEqual(new Set(GLOBE_GAMEPAD_ACTIONS.map((action) => action.id)));
    // The binding editor recognises a built-in profile by its ID.
    expect(createStandardGlobeProfile().profileId).toBe(profile.profileId);

    const imported = validateProfileImport(JSON.parse(JSON.stringify({ profile })));
    expect(imported.valid).toBe(true);
    expect(imported.profile).toMatchObject({ hostNamespace: "foss-earth", profileId: profile.profileId });
    expect(imported.profile?.bindings).toHaveLength(profile.bindings.length);
  });

  it("pans with the left stick, moving forward when pushed up", () => {
    const { step } = harness();
    axis(0, 0.6);
    axis(1, -0.6);
    const value = step();
    expect(value("globe.panX")).toBeCloseTo(outsideDeadzone(0.6));
    expect(value("globe.panY")).toBeCloseTo(outsideDeadzone(0.6));
    expect(value("globe.orbitHeading")).toBeUndefined();
  });

  it("orbits with the right stick in the same directions as a right drag", () => {
    const { step } = harness();
    axis(2, 0.5);
    axis(3, 0.5);
    const value = step();
    expect(value("globe.orbitHeading")).toBeCloseTo(outsideDeadzone(0.5));
    expect(value("globe.orbitPitch")).toBeCloseTo(outsideDeadzone(0.5));
    expect(value("globe.panX")).toBeUndefined();
  });

  it("zooms in with the right trigger and out with the left", () => {
    const { step } = harness();
    button(7, 0.4);
    expect(step()("globe.zoom")).toBeCloseTo(0.4);
    button(6, 1);
    expect(step()("globe.zoom")).toBeCloseTo(-0.6);
    button(6, 0);
    button(7, 0);
    expect(step()("globe.zoom")).toBeUndefined();
  });

  it("resets north-up once per press of the top face button", () => {
    const { step, onResetNorth } = harness();
    button(3, 1);
    step();
    step();
    expect(onResetNorth).toHaveBeenCalledTimes(1);
    button(3, 0);
    step();
    button(3, 1);
    step();
    expect(onResetNorth).toHaveBeenCalledTimes(2);
  });

  it("sends nothing for a resting controller, so the renderer can stay idle", () => {
    const { step, applyGlobeNavigationIntents } = harness();
    axis(0, 0.1);
    axis(3, -0.14);
    step();
    expect(applyGlobeNavigationIntents).not.toHaveBeenCalled();
  });

  it("takes input.gamepad.deadzone for every stick bound to a rate, and nothing else", () => {
    const { step, runtime, applyGlobeNavigationIntents } = harness();
    const before = runtime.getProfile();
    runtime.setProfile(withStickDeadzone(before, 0.3));
    axis(0, 0.2);
    step();
    // Inside the wider deadzone, a stick that moved the view before rests.
    expect(applyGlobeNavigationIntents).not.toHaveBeenCalled();
    const after = runtime.getProfile();
    const deadzones = (profile: typeof before) => profile.bindings.map(binding => [binding.id, binding.transform.deadzone]);
    expect(deadzones(after)).toEqual(deadzones(before).map(([id, deadzone]) => [id, String(id).match(/pan|orbit/) ? 0.3 : deadzone]));
    // Nothing to change: the same profile comes back.
    expect(withStickDeadzone(after, 0.3)).toBe(after);
    expect(deadzones(createStandardGlobeProfile(0, 0.3))).toEqual(deadzones(after));
  });

  it("keeps the camera still while a binding is being captured", () => {
    const { step, runtime, applyGlobeNavigationIntents, onResetNorth } = harness();
    runtime.setBindingCapture(true);
    axis(0, 1);
    axis(2, 1);
    button(7, 1);
    button(3, 1);
    step();
    expect(applyGlobeNavigationIntents).not.toHaveBeenCalled();
    expect(onResetNorth).not.toHaveBeenCalled();
  });
});
