// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachLookInput, createLookModel, type LookSettings } from "../scenes/panoramaInput";
import { createInputController } from "./createInputController";

const LOOK: LookSettings = {
  dragSensitivity: 0.15, swipeSensitivity: 0.15, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 0,
  fovRangeDeg: { min: 35, max: 90 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: false,
};

function setup() {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientHeight", { value: 800 });
  // jsdom has no pointer capture.
  Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
  document.body.append(canvas);
  const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(), cancel: vi.fn(), cancelInertial: vi.fn(), endAnchorPan: vi.fn() };
  const controller = createInputController(canvas, camera);
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

  it("lets a panorama drag look as the pointer moves, and stop when the button is released", () => {
    const { canvas, controller } = setup();
    controller.setSuspended(true);
    const model = createLookModel({ headingDeg: 180, pitchDeg: 0, verticalFovDeg: 60 }, () => LOOK, () => {});
    const input = attachLookInput({ canvas, model, onExit: vi.fn(), onUserInput: vi.fn(), requestFrame: vi.fn() });
    canvas.dispatchEvent(mouse("pointerdown", 100, 1));
    canvas.dispatchEvent(mouse("pointermove", 120, 1));
    expect(model.get().headingDeg).toBeCloseTo(177);
    canvas.dispatchEvent(mouse("pointermove", 160, 1));
    expect(model.get().headingDeg).toBeCloseTo(171);
    canvas.dispatchEvent(mouse("pointerup", 160, 0));
    // Hovering after the release looks nowhere.
    canvas.dispatchEvent(mouse("pointermove", 400, 0));
    expect(model.get().headingDeg).toBeCloseTo(171);
    input.detach();
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

  it("does not let a panorama look with a swipe under way when looking begins, such as the globe's momentum", () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { canvas, controller } = setup();
    const swipe = () => canvas.dispatchEvent(new WheelEvent("wheel", { deltaX: 12.5, deltaY: 3.5, bubbles: true, cancelable: true }));
    swipe();
    controller.setSuspended(true);
    const model = createLookModel({ headingDeg: 180, pitchDeg: 0, verticalFovDeg: 60 }, () => LOOK, () => {});
    const input = attachLookInput({ canvas, model, onExit: vi.fn(), onUserInput: vi.fn(), requestFrame: vi.fn(), inputMode: () => "trackpad", precedingWheelMs: clock });
    for (let i = 0; i < 5; i++) { clock += 16; swipe(); }
    expect(model.get().headingDeg).toBe(180);
    clock += 400;
    swipe();
    expect(model.get().headingDeg).not.toBe(180);
    input.detach();
    vi.restoreAllMocks();
  });

  it("reports the input mode a lease's input reads wheels with", () => {
    const { controller } = setup();
    controller.setMode("mouse");
    expect(controller.getMode()).toBe("mouse");
  });
});
