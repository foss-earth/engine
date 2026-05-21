// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachTouchController } from "./touchController";

function createPointerEvent(
  type: string,
  init: { pointerId: number; pointerType: string; clientX: number; clientY: number; button?: number; timeStamp?: number },
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
  it("uses inverted deltas for one-finger mobile pan", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 30 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 32, clientY: 48 }));

    expect(camera.panBy).toHaveBeenCalledWith(expect.closeTo(-1.2, 5), expect.closeTo(-1.8, 5), 800);

    cleanup();
  });

  it("does not zoom during a two-finger vertical swipe with slight finger-spacing drift", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 10, timeStamp: 20 }));

    expect(camera.orbitBy).not.toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 112, timeStamp: 35 }));

    expect(camera.orbitBy).toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("cancels stale inertia when a new touch gesture starts", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
      cancel: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 }));

    expect(camera.cancel).toHaveBeenCalledTimes(1);

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

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: -10, timeStamp: 20 }));

    expect(camera.zoomBy).not.toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 110, timeStamp: 35 }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("does not let one early touch movement steal a two-finger orbit", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 25, timeStamp: 20 }));

    expect(camera.zoomBy).not.toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 125, timeStamp: 35 }));

    expect(camera.orbitBy).toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("zooms during an asymmetric one-finger pivot pinch", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 130, timeStamp: 150 }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("does not lock into orbit from landing drift before a pinch", () => {
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera);

    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100, timeStamp: 0 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 3, timeStamp: 20 }));
    canvas.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 130, timeStamp: 35 }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    cleanup();
  });
});