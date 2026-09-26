// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_INPUT_RATES, DEFAULT_INPUT_SETTINGS } from "./inputSettings";
import { attachSafariGestures } from "./safariGestures";

function gesture(type: string, rotation: number, scale: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), { rotation, scale });
}

describe("attachSafariGestures", () => {
  it("turns a rotate by input.trackpad.rotateRate, and zooms a pinch by input.trackpad.gestureZoomExponent", () => {
    const canvas = document.createElement("canvas");
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    let settings = { ...DEFAULT_INPUT_SETTINGS, rates: { ...DEFAULT_INPUT_RATES } };
    const detach = attachSafariGestures(canvas, camera, { getSettings: () => settings });

    canvas.dispatchEvent(gesture("gesturestart", 0, 1));
    canvas.dispatchEvent(gesture("gesturechange", 10, 1));
    // The shared base these rates had before: a tenth of a degree per degree.
    expect(camera.orbitBy).toHaveBeenLastCalledWith(0, expect.closeTo(-1, 12));
    settings = { ...settings, rates: { ...settings.rates, trackpadRotateRate: 0.5 } };
    canvas.dispatchEvent(gesture("gesturechange", 20, 1));
    expect(camera.orbitBy).toHaveBeenLastCalledWith(0, expect.closeTo(-5, 12));

    canvas.dispatchEvent(gesture("gesturechange", 20, 1.2));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.closeTo(0.9 ** 0.1, 12));
    settings = { ...settings, rates: { ...settings.rates, trackpadGestureZoomExponent: 1 } };
    canvas.dispatchEvent(gesture("gesturechange", 20, 1.44));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.closeTo(0.9, 12));

    detach();
  });
});
