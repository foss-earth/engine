// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInputController } from "../src/browser/createInputController.js";


function setup() {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientHeight", { value: 800 });
  // jsdom has no pointer capture.
  Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
  document.body.append(canvas);
  const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(), cancel: vi.fn(), cancelInertial: vi.fn(), endAnchorPan: vi.fn() };
  const controller = createInputController(canvas, camera, { realm: { document, window, userAgent: navigator.userAgent, hasGestureEvent: "GestureEvent" in window, nowMs: () => performance.now() }, loadGlobeAnchorRotationPreference: () => true, saveGlobeAnchorRotationPreference() {} });
  return { canvas, camera, controller };
}

const mouse = (type: string, x: number, buttons: number) =>
  new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons, clientX: x, clientY: 400, bubbles: true, cancelable: true });

afterEach(() => { document.body.replaceChildren(); });

describe("the globe's input controller", () => {
  it("consumes a mouse drag and a wheel while it owns input", () => {
    const { canvas, camera } = setup();
    const later = vi.fn();
    canvas.addEventListener("pointermove", later);
    canvas.addEventListener("wheel", later);
    canvas.dispatchEvent(mouse("pointerdown", 100, 1));
    canvas.dispatchEvent(mouse("pointermove", 160, 1));
    canvas.dispatchEvent(mouse("pointerup", 160, 0));
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    expect(camera.panBy).toHaveBeenCalled();
    expect(camera.zoomBy).toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it("while suspended, leaves every event to a lease's input, and consumes them again once resumed", () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { canvas, camera, controller } = setup();
    controller.setSuspended(true);
    const later = vi.fn();
    canvas.addEventListener("pointermove", later);
    canvas.addEventListener("pointerup", later);
    canvas.addEventListener("wheel", later);
    canvas.dispatchEvent(mouse("pointerdown", 100, 1));
    canvas.dispatchEvent(mouse("pointermove", 160, 1));
    canvas.dispatchEvent(mouse("pointerup", 160, 0));
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    expect(later).toHaveBeenCalledTimes(3);
    expect(camera.panBy).not.toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    controller.setSuspended(false);
    later.mockClear();
    clock += 1_000;
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    expect(camera.zoomBy).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("ignores a wheel gesture under way when it resumes, as a swipe's momentum is, until the gesture pauses", () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { canvas, camera, controller } = setup();
    controller.setSuspended(true);
    const swipe = () => canvas.dispatchEvent(new WheelEvent("wheel", { deltaX: 12.5, deltaY: 3.5, bubbles: true, cancelable: true }));
    swipe();
    controller.setSuspended(false);
    for (let i = 0; i < 10; i++) { clock += 16; swipe(); }
    expect(camera.panBy).not.toHaveBeenCalled();
    clock += 400;
    swipe();
    expect(camera.panBy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });



  it("carries on a wheel gesture begun since a lease's owner began its motion, and ignores one from before", () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { canvas, camera, controller } = setup();
    const swipe = () => canvas.dispatchEvent(new WheelEvent("wheel", { deltaX: 12.5, deltaY: 3.5, bubbles: true, cancelable: true }));
    controller.setSuspended(true);
    // A swipe's momentum from before the owner's flight began at 1010.
    swipe();
    clock += 16;
    swipe();
    controller.setSuspended(false, { keepWheelSince: 1_010 });
    clock += 16;
    swipe();
    expect(camera.panBy).not.toHaveBeenCalled();
    // A swipe begun during it, which took the camera over, pans at once.
    controller.setSuspended(true);
    clock += 400;
    const flightBegan = clock - 100;
    swipe();
    controller.setSuspended(false, { keepWheelSince: flightBegan });
    clock += 16;
    swipe();
    expect(camera.panBy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("carries on a mouse press held through the handback as a drag from where the pointer is", () => {
    const { canvas, camera, controller } = setup();
    controller.setSuspended(true);
    controller.setSuspended(false, { press: { pointerId: 1, button: 0, clientX: 100, clientY: 400 } });
    canvas.dispatchEvent(mouse("pointermove", 160, 1));
    expect(camera.panBy).toHaveBeenCalled();
    canvas.dispatchEvent(mouse("pointerup", 160, 0));
  });



  it("reports the input mode a lease's input reads wheels with", () => {
    const { controller } = setup();
    controller.setMode("mouse");
    expect(controller.getMode()).toBe("mouse");
  });
});

describe("Pick point", () => {
  function armedSetup(armed = true) {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientHeight", { value: 800 });
    Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
    document.body.append(canvas);
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(), cancel: vi.fn(), cancelInertial: vi.fn(), endAnchorPan: vi.fn() };
    const selection = { armed: vi.fn(() => armed), pickAt: vi.fn<(client: { readonly x: number; readonly y: number }) => boolean>(() => true), cancel: vi.fn() };
    const controller = createInputController(canvas, camera, { realm: { document, window, userAgent: navigator.userAgent, hasGestureEvent: "GestureEvent" in window, nowMs: () => performance.now() },
      loadGlobeAnchorRotationPreference: () => false, saveGlobeAnchorRotationPreference() {}, pointSelection: selection });
    return { canvas, camera, selection, controller };
  }
  const press = (type: string, x: number, buttons: number) =>
    new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: x, clientY: 400, bubbles: true, cancelable: true });
  const escape = (key = "Escape") => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });

  it("cancels with Escape while armed, taking the key", () => {
    const { selection, controller } = armedSetup();
    const key = escape();
    document.dispatchEvent(key);
    expect(selection.cancel).toHaveBeenCalledOnce();
    expect(key.defaultPrevented).toBe(true);
    controller.destroy();
  });

  it("leaves Escape alone when not armed", () => {
    const { selection, controller } = armedSetup(false);
    const key = escape();
    document.dispatchEvent(key);
    expect(selection.cancel).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);
    controller.destroy();
  });

  it("leaves an Escape something else took first, such as a menu", () => {
    const { selection, controller } = armedSetup();
    const menu = document.createElement("button");
    document.body.append(menu);
    menu.addEventListener("keydown", e => e.preventDefault());
    menu.dispatchEvent(escape());
    expect(selection.cancel).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("ignores other keys", () => {
    const { selection, controller } = armedSetup();
    for (const key of ["Enter", " ", "Esc", "q"]) document.dispatchEvent(escape(key));
    expect(selection.cancel).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("stops listening for Escape once destroyed", () => {
    const { selection, controller } = armedSetup();
    controller.destroy();
    const key = escape();
    document.dispatchEvent(key);
    expect(selection.cancel).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);
  });

  it("picks the point a primary click lands on, without panning or letting the scene see the press", () => {
    const { canvas, camera, selection, controller } = armedSetup();
    const later = vi.fn();
    canvas.addEventListener("pointerdown", later);
    canvas.addEventListener("pointerup", later);
    canvas.dispatchEvent(press("pointerdown", 100, 1));
    canvas.dispatchEvent(press("pointermove", 102, 1));
    canvas.dispatchEvent(press("pointerup", 102, 0));
    expect(selection.pickAt).toHaveBeenCalledExactlyOnceWith({ x: 102, y: 400 });
    expect(camera.panBy).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("pans a drag past the threshold and stays armed, picking nothing", () => {
    const { canvas, camera, selection, controller } = armedSetup();
    canvas.dispatchEvent(press("pointerdown", 100, 1));
    canvas.dispatchEvent(press("pointermove", 160, 1));
    canvas.dispatchEvent(press("pointerup", 160, 0));
    expect(camera.panBy).toHaveBeenCalled();
    expect(selection.pickAt).not.toHaveBeenCalled();
    expect(selection.cancel).not.toHaveBeenCalled();
    // Still armed: the next click picks.
    canvas.dispatchEvent(press("pointerdown", 200, 1));
    canvas.dispatchEvent(press("pointerup", 200, 0));
    expect(selection.pickAt).toHaveBeenCalledExactlyOnceWith({ x: 200, y: 400 });
    controller.destroy();
  });

  it("leaves a click to the scene when not armed", () => {
    const { canvas, selection, controller } = armedSetup(false);
    const later = vi.fn();
    canvas.addEventListener("pointerdown", later);
    canvas.dispatchEvent(press("pointerdown", 100, 1));
    canvas.dispatchEvent(press("pointerup", 100, 0));
    expect(later).toHaveBeenCalledOnce();
    expect(selection.pickAt).not.toHaveBeenCalled();
    controller.destroy();
  });
});
