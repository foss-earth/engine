// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachTouchController } from "./touchController";

function createPointerEvent(
  type: string,
  init: { pointerId: number; pointerType: string; clientX: number; clientY: number; button?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { value, enumerable: true });
  }
  return event;
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientHeight", { value: 800 });
  canvas.setPointerCapture = vi.fn();
  canvas.releasePointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  document.body.append(canvas);
  return canvas;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("attachTouchController", () => {
  it("does not zoom during a two-finger vertical swipe with slight finger-spacing drift", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 10 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 112 }));

    expect(camera.orbitBy).toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("zooms during a committed pinch without orbiting", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: -10 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 110 }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    cleanup();
  });
});