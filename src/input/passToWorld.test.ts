// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageUsesWheel, passUnusedInputToWorld } from "./passToWorld";

/** A box whose content is taller than it is, scrolling up and down only. */
function scroller(parent: HTMLElement): HTMLElement {
  const element = document.createElement("div");
  element.style.overflowY = "auto";
  element.style.overflowX = "hidden";
  Object.defineProperty(element, "scrollHeight", { value: 900 });
  Object.defineProperty(element, "clientHeight", { value: 300 });
  Object.defineProperty(element, "scrollWidth", { value: 320 });
  Object.defineProperty(element, "clientWidth", { value: 320 });
  parent.append(element);
  return element;
}

const swipe = (deltaX: number, deltaY: number, init: WheelEventInit = {}) =>
  new WheelEvent("wheel", { deltaX, deltaY, clientX: 140, clientY: 90, bubbles: true, cancelable: true, ...init });

describe("passUnusedInputToWorld", () => {
  let now = 1000;
  let canvas: HTMLCanvasElement;
  let received: WheelEvent[];
  let stop: () => void;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    canvas = document.createElement("canvas");
    document.body.append(canvas);
    received = [];
    canvas.addEventListener("wheel", event => { event.preventDefault(); received.push(event); });
    stop = passUnusedInputToWorld(canvas, { safariGestures: true });
  });

  afterEach(() => {
    stop();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  /**
   * On 2026-10-07 a sideways two-finger swipe over the Debug tab, meant for
   * the camera, went Back a page: the panel scrolls only up and down, so
   * nothing used the swipe and the browser took it.
   */
  it("hands a swipe over a panel that cannot scroll that way to the canvas, and keeps it from the browser", () => {
    const panel = scroller(document.body);
    const label = document.createElement("span");
    panel.append(label);
    const event = swipe(-40, 2);
    label.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ deltaX: -40, deltaY: 2, clientX: 140, clientY: 90 });
    expect(received[0].target).toBe(canvas);
  });

  it("leaves a swipe along a panel's scroll to the panel, for the whole gesture", () => {
    const panel = scroller(document.body);
    const first = swipe(1, 30);
    panel.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
    // The swipe turns sideways partway; it still scrolls.
    now += 16;
    const turned = swipe(25, 3);
    panel.dispatchEvent(turned);
    expect(turned.defaultPrevented).toBe(false);
    expect(received).toHaveLength(0);
    // After a pause a sideways swipe is a new gesture, and the world's.
    now += 400;
    panel.dispatchEvent(swipe(25, 3));
    expect(received).toHaveLength(1);
  });

  it("hands over swipes on anything that does not scroll: the HUD, an instrument", () => {
    const instrument = document.createElement("div");
    document.body.append(instrument);
    instrument.dispatchEvent(swipe(0, 30));
    expect(received).toHaveLength(1);
  });

  it("keeps a camera swipe that drifts over a panel going to the camera", () => {
    const panel = scroller(document.body);
    canvas.dispatchEvent(swipe(0, 30));
    expect(received).toHaveLength(1);
    now += 16;
    const drifted = swipe(0, 30);
    panel.dispatchEvent(drifted);
    expect(drifted.defaultPrevented).toBe(true);
    expect(received).toHaveLength(2);
  });

  it("hands over a pinch, which scrolls nothing", () => {
    const panel = scroller(document.body);
    panel.dispatchEvent(swipe(0, 4, { ctrlKey: true }));
    expect(received).toHaveLength(1);
    expect(received[0].ctrlKey).toBe(true);
  });

  it("leaves an event a control used where it is", () => {
    const control = document.createElement("div");
    control.addEventListener("wheel", event => event.preventDefault());
    document.body.append(control);
    control.dispatchEvent(swipe(-40, 0));
    expect(received).toHaveLength(0);
  });

  it("hands a Safari pinch over a panel to the canvas with its scale and rotation", () => {
    const panel = scroller(document.body);
    const gestures: Event[] = [];
    canvas.addEventListener("gesturechange", event => gestures.push(event));
    const pinch = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.assign(pinch, { scale: 1.25, rotation: -4 });
    panel.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ scale: 1.25, rotation: -4 });
  });

  it("stops handing anything over when stopped", () => {
    stop();
    document.body.dispatchEvent(swipe(-40, 0));
    expect(received).toHaveLength(0);
    stop = () => {};
  });
});

describe("pageUsesWheel", () => {
  afterEach(() => document.body.replaceChildren());

  it("is the page's where a scroller is along the swipe's main axis, or a number field has focus", () => {
    const panel = scroller(document.body);
    expect(pageUsesWheel(panel, { deltaX: 1, deltaY: 30, ctrlKey: false })).toBe(true);
    expect(pageUsesWheel(panel, { deltaX: 30, deltaY: 1, ctrlKey: false })).toBe(false);
    expect(pageUsesWheel(document.body, { deltaX: 0, deltaY: 30, ctrlKey: false })).toBe(false);
    const field = document.createElement("input");
    field.type = "number";
    document.body.append(field);
    expect(pageUsesWheel(field, { deltaX: 0, deltaY: 30, ctrlKey: false })).toBe(false);
    field.focus();
    expect(pageUsesWheel(field, { deltaX: 0, deltaY: 30, ctrlKey: false })).toBe(true);
  });
});
