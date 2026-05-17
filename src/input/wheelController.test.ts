// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachWheelController } from "./wheelController";

function createWheelEvent(
  init: { deltaX?: number; deltaY?: number; deltaMode?: number; ctrlKey?: boolean; shiftKey?: boolean },
): Event {
  const event = new Event("wheel", { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ deltaX: 0, deltaY: 0, deltaMode: 0, ...init })) {
    Object.defineProperty(event, key, { value, enumerable: true });
  }
  return event;
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientHeight", { value: 800 });
  document.body.append(canvas);
  return canvas;
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachWheelController", () => {
  it("pans the first fine pixel wheel event after an idle pause", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaY: 12 }));

    expect(camera.panBy).toHaveBeenCalledWith(0, 12, 800);
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("keeps a trackpad pan burst locked even if a later event carries ctrlKey", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaX: 2, deltaY: 14 }));
    now += 16;
    canvas.dispatchEvent(createWheelEvent({ deltaX: 1, deltaY: 10, ctrlKey: true }));

    expect(camera.panBy).toHaveBeenCalledTimes(2);
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("zooms a standalone trackpad pinch wheel gesture", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaY: -8, ctrlKey: true }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.panBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("zooms a coarse mouse wheel event", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaY: 100 }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.panBy).not.toHaveBeenCalled();

    cleanup();
  });
});