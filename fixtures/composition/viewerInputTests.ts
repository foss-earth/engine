// Prepared mixed engine/viewer suite. Host test composition must register it with actual public360 adapters.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInputController } from "../../src/browser/createInputController.js";
interface LookState { headingDeg: number; pitchDeg: number; verticalFovDeg: number }
interface LookSettings {
  dragSensitivity: number; swipeSensitivity: number; lookRate: number; zoomPerNotch: number; zoomRate: number;
  pinchGain: number; inertiaHalfLifeMs: number; fovRangeDeg: { min: number; max: number };
  pitchRangeDeg: { min: number; max: number }; reducedMotion: boolean;
}
export interface ViewerInputCompositionPorts {
  createLookModel(initial: LookState, settings: () => LookSettings, onChange: (state: LookState) => void): { get(): LookState };
  attachLookInput(options: { canvas: HTMLCanvasElement; model: { get(): LookState }; onExit(): void; onUserInput(): void; requestFrame(): void;
    inputMode?: () => "trackpad"; precedingWheelMs?: number }): { detach(): void };
}
export function registerViewerInputCompositionTests(viewer: ViewerInputCompositionPorts): void {
  const { createLookModel, attachLookInput } = viewer;
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
  const controller = createInputController(canvas, camera, { realm: { document, window, userAgent: navigator.userAgent, hasGestureEvent: "GestureEvent" in window, nowMs: () => performance.now() }, loadGlobeAnchorRotationPreference: () => true, saveGlobeAnchorRotationPreference() {} });
  return { canvas, camera, controller };
}

const mouse = (type: string, x: number, buttons: number) =>
  new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons, clientX: x, clientY: 400, bubbles: true, cancelable: true });

afterEach(() => { document.body.replaceChildren(); });

describe("engine with host viewer input", () => {
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
});
}
