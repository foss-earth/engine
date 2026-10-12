// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachWheelController } from "../src/browser/wheelController.js";
import { DEFAULT_INPUT_SETTINGS, type InputModePreference } from "../src/input/inputSettings.js";
import type { AnchorAcquisition, AnchorChoice, AnchorFamily, AnchorOperation, AnchorRequest, NavigationAnchor } from "../src/input/navigationAnchors.js";
import { WHEEL_GESTURE_IDLE_MS } from "../src/input/wheelGesture.js";

function createWheelEvent(
  init: { deltaX?: number; deltaY?: number; deltaMode?: number; ctrlKey?: boolean; shiftKey?: boolean; clientX?: number; clientY?: number },
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
  it("pans the first fractional fine pixel wheel event after an idle pause", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaY: 12.25 }));

    expect(camera.panBy).toHaveBeenCalledWith(0, 1.225, 800);
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("zooms vertical-only integer pixel wheel events instead of panning lat/lon", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaY: 40 }));

    expect(camera.zoomBy).toHaveBeenCalledWith(expect.closeTo(Math.pow(1.08, 0.03), 6));
    expect(camera.panBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("ignores horizontal-only integer pixel wheel events instead of panning lat/lon", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaX: 40, deltaY: 0 }));

    expect(camera.panBy).not.toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("keeps fractional horizontal trackpad wheel events as pan", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaX: 12.25, deltaY: 0 }));

    expect(camera.panBy).toHaveBeenCalledWith(1.225, 0, 800);
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
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false });

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
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false });

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
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false });

    canvas.dispatchEvent(createWheelEvent({ deltaY: 100 }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.panBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("zooms a notch by input.wheel.zoomRate, and orbits by input.wheel.orbitRate", async () => {
    const { DEFAULT_INPUT_RATES, DEFAULT_INPUT_SETTINGS } = await import("../src/input/inputSettings.js");
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const canvas = createCanvas();
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    let settings = { ...DEFAULT_INPUT_SETTINGS, mode: "mouse" as const, globeAnchorRotation: true, rates: { ...DEFAULT_INPUT_RATES } };
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false, getSettings: () => settings });

    // Out by the default share: what 1.08 to the power 0.03 always did.
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100 }));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.closeTo(1.08 ** 0.03, 12));
    settings = { ...settings, rates: { ...settings.rates, wheelZoomPerNotch: 0.1 } };
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100 }));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.closeTo(1.1, 12));

    // A new gesture after a pause.
    now += 1_000;
    settings = { ...settings, rates: { ...settings.rates, wheelOrbitDegPerPx: 0.1 } };
    canvas.dispatchEvent(createWheelEvent({ deltaX: 10, deltaY: 20, shiftKey: true }));
    expect(camera.orbitBy).toHaveBeenLastCalledWith(expect.closeTo(2, 9), expect.closeTo(-1, 9));

    cleanup();
  });

  it("pans a two-finger swipe by input.trackpad.panRate", async () => {
    const { DEFAULT_INPUT_RATES, DEFAULT_INPUT_SETTINGS } = await import("../src/input/inputSettings.js");
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    const settings = { ...DEFAULT_INPUT_SETTINGS, rates: { ...DEFAULT_INPUT_RATES, trackpadPanRate: 0.3 } };
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false, getSettings: () => settings });

    canvas.dispatchEvent(createWheelEvent({ deltaY: 12.25 }));
    expect(camera.panBy).toHaveBeenCalledWith(0, expect.closeTo(3.675, 9), 800);

    cleanup();
  });

  it("zooms (not orbits) when shift is held in trackpad mode", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const getSettings = () => ({
      mode: "trackpad" as const, globeAnchorRotation: true,
      sensitivity: { mouse: { pan: 1, orbit: 1, zoom: 1 }, trackpad: { pan: 1, orbit: 1, zoom: 1 }, touch: { pan: 1, orbit: 1, zoom: 1 } },
    });
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false, getSettings });

    canvas.dispatchEvent(createWheelEvent({ deltaY: -20, shiftKey: true }));

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("orbits when shift is held in non-trackpad (mouse) mode", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const getSettings = () => ({
      mode: "mouse" as const, globeAnchorRotation: true,
      sensitivity: { mouse: { pan: 1, orbit: 1, zoom: 1 }, trackpad: { pan: 1, orbit: 1, zoom: 1 }, touch: { pan: 1, orbit: 1, zoom: 1 } },
    });
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => performance.now(), isSafariWithGestures: false, getSettings });

    canvas.dispatchEvent(createWheelEvent({ deltaY: -20, shiftKey: true }));

    expect(camera.orbitBy).toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("inverts POI-orbit pitch so swipe-up tilts the view upward", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const canvas = createCanvas();
    const camera = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const cleanup = attachWheelController(canvas, camera, {
      nowMs: () => performance.now(),
      isSafariWithGestures: false,
      isOrbitMode: () => true,
    });

    canvas.dispatchEvent(createWheelEvent({ deltaY: -10.5 }));

    expect(camera.orbitBy).toHaveBeenCalledTimes(1);
    const [pitch, heading] = camera.orbitBy.mock.calls[0] as [number, number];
    expect(pitch).toBeCloseTo(0.1575, 5);
    expect(heading).toBeCloseTo(0, 5);
    expect(camera.panBy).not.toHaveBeenCalled();

    cleanup();
  });
});
function anchorOf(session: number, family: AnchorFamily, operation: AnchorOperation, requested: AnchorChoice): NavigationAnchor {
  return { session, owner: "globe", family, operation, requested, source: "surface", point: { x: session, y: 0, z: 0 }, surfaceRevision: null, fallback: null };
}

/** A camera whose every acquisition is a new session, resolved as `requested`. */
function anchoredCamera(requested: AnchorChoice = "pointer") {
  let session = 0;
  const acquireAnchors = vi.fn((request: AnchorRequest<HTMLCanvasElement>): AnchorAcquisition => {
    session += 1;
    const acquired: { zoom?: NavigationAnchor; orbit?: NavigationAnchor } = {};
    for (const operation of request.operations) acquired[operation] = anchorOf(session, request.family, operation, request.prefer?.[operation] ?? requested);
    return acquired;
  });
  return {
    panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(),
    acquireAnchors, holdAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(), releaseAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(),
  };
}

describe("attachWheelController: zoom anchors and orbit pivots", () => {
  function setup(options: { mode?: InputModePreference; isSafariWithGestures?: boolean; isOrbitMode?: () => boolean; precedingWheelMs?: number; requested?: AnchorChoice } = {}) {
    let now = 1_000;
    const canvas = createCanvas();
    const camera = anchoredCamera(options.requested);
    const settings = { ...DEFAULT_INPUT_SETTINGS, mode: options.mode ?? "auto" };
    const cleanup = attachWheelController(canvas, camera, {
      nowMs: () => now, isSafariWithGestures: options.isSafariWithGestures ?? false, isOrbitMode: options.isOrbitMode,
      getSettings: () => settings, precedingWheelMs: options.precedingWheelMs,
    });
    const zoomAnchor = (call: number) => (camera.acquireAnchors.mock.results[call].value as AnchorAcquisition).zoom;
    const orbitAnchor = (call: number) => (camera.acquireAnchors.mock.results[call].value as AnchorAcquisition).orbit;
    return { canvas, camera, cleanup, zoomAnchor, orbitAnchor, advance: (ms: number) => { now += ms; } };
  }

  it("zooms a mouse wheel about the point its first event picks, as a mouse's, and keeps it while the pointer stays", () => {
    const { canvas, camera, cleanup, zoomAnchor, advance } = setup();

    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "mouse", operations: ["zoom"], client: { x: 200, y: 150 }, canvas });
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), zoomAnchor(0));

    for (let i = 0; i < 3; i++) {
      advance(100);
      canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    }
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.zoomBy).toHaveBeenCalledTimes(4);
    for (const [, anchor] of camera.zoomBy.mock.calls) expect(anchor).toBe(zoomAnchor(0));
    // A wheel's events do not hold their anchors: nothing to hold or let go.
    expect(camera.holdAnchors).not.toHaveBeenCalled();
    expect(camera.releaseAnchors).not.toHaveBeenCalled();
    cleanup();
  });

  it("picks again where the pointer has moved, keeping the choice the gesture began with", () => {
    const { canvas, camera, cleanup, zoomAnchor, advance } = setup();

    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    advance(50);
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 260, clientY: 150 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(2);
    expect(camera.acquireAnchors).toHaveBeenLastCalledWith({ family: "mouse", operations: ["zoom"], client: { x: 260, y: 150 }, canvas, prefer: { zoom: "pointer" } });
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), zoomAnchor(1));
    expect(zoomAnchor(1)).not.toBe(zoomAnchor(0));

    // And keeps the new pick while the pointer stays there.
    advance(50);
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 260, clientY: 150 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(2);
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), zoomAnchor(1));
    cleanup();
  });

  it("counts a pointer at zero as a pointer", () => {
    const { canvas, camera, cleanup } = setup();
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 0, clientY: 0 }));
    expect(camera.acquireAnchors).toHaveBeenCalledWith(expect.objectContaining({ client: { x: 0, y: 0 } }));
    cleanup();
  });

  it("keeps a compass-target zoom where it is when the pointer moves", () => {
    const { canvas, camera, cleanup, zoomAnchor, advance } = setup({ requested: "target" });

    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    advance(50);
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 400, clientY: 300 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), zoomAnchor(0));
    cleanup();
  });

  it(`picks afresh for a gesture after ${WHEEL_GESTURE_IDLE_MS} ms without a wheel event, at the same place too`, () => {
    const { canvas, camera, cleanup, zoomAnchor, advance } = setup();

    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    advance(WHEEL_GESTURE_IDLE_MS);
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);

    advance(WHEEL_GESTURE_IDLE_MS + 1);
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(2);
    // A new gesture has no choice to keep: it reads the current one.
    expect(camera.acquireAnchors).toHaveBeenLastCalledWith({ family: "mouse", operations: ["zoom"], client: { x: 200, y: 150 }, canvas });
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), zoomAnchor(1));
    cleanup();
  });

  it("zooms a Ctrl+wheel pinch as a trackpad's, in mouse mode too", () => {
    for (const mode of ["auto", "mouse"] as const) {
      const { canvas, camera, cleanup, zoomAnchor } = setup({ mode });
      canvas.dispatchEvent(createWheelEvent({ deltaY: -8.5, ctrlKey: true, clientX: 30, clientY: 40 }));
      expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "trackpad", operations: ["zoom"], client: { x: 30, y: 40 }, canvas });
      expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), zoomAnchor(0));
      cleanup();
    }
  });

  it("zooms, as a trackpad's, with Shift+wheel in trackpad mode", () => {
    const { canvas, camera, cleanup, zoomAnchor } = setup({ mode: "trackpad" });
    canvas.dispatchEvent(createWheelEvent({ deltaY: -20, shiftKey: true, clientX: 30, clientY: 40 }));
    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "trackpad", operations: ["zoom"], client: { x: 30, y: 40 }, canvas });
    expect(camera.zoomBy).toHaveBeenCalledWith(expect.any(Number), zoomAnchor(0));
    expect(camera.orbitBy).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not zoom or pick for Safari's Ctrl+wheel copy of a pinch its gesture events already zoom", () => {
    const { canvas, camera, cleanup } = setup({ isSafariWithGestures: true });
    canvas.dispatchEvent(createWheelEvent({ deltaY: -1.5, ctrlKey: true, clientX: 30, clientY: 40 }));
    expect(camera.zoomBy).not.toHaveBeenCalled();
    expect(camera.acquireAnchors).not.toHaveBeenCalledWith(expect.objectContaining({ operations: ["zoom"] }));
    cleanup();
  });

  it("orbits a wheel about one pivot for the whole gesture, a mouse's in mouse mode and a trackpad's otherwise", () => {
    for (const [mode, family] of [["mouse", "mouse"], ["auto", "trackpad"]] as const) {
      const { canvas, camera, cleanup, orbitAnchor, advance } = setup({ mode });
      canvas.dispatchEvent(createWheelEvent({ deltaX: 3, deltaY: -20, shiftKey: true, clientX: 30, clientY: 40 }));
      advance(40);
      canvas.dispatchEvent(createWheelEvent({ deltaX: 3, deltaY: -20, shiftKey: true, clientX: 90, clientY: 120 }));
      expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
      expect(camera.acquireAnchors).toHaveBeenCalledWith({ family, operations: ["orbit"], client: { x: 30, y: 40 }, canvas });
      expect(camera.orbitBy).toHaveBeenCalledTimes(2);
      for (const [, , anchor] of camera.orbitBy.mock.calls) expect(anchor).toBe(orbitAnchor(0));

      // The next gesture picks its own.
      advance(WHEEL_GESTURE_IDLE_MS + 1);
      canvas.dispatchEvent(createWheelEvent({ deltaX: 3, deltaY: -20, shiftKey: true, clientX: 90, clientY: 120 }));
      expect(camera.acquireAnchors).toHaveBeenCalledTimes(2);
      expect(camera.orbitBy).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), orbitAnchor(1));
      expect(camera.releaseAnchors).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("orbits a trackpad swipe in POI orbit mode about a trackpad pivot picked once", () => {
    const { canvas, camera, cleanup, orbitAnchor, advance } = setup({ mode: "trackpad", isOrbitMode: () => true });
    canvas.dispatchEvent(createWheelEvent({ deltaX: 1.5, deltaY: 4.25, clientX: 10, clientY: 20 }));
    advance(16);
    canvas.dispatchEvent(createWheelEvent({ deltaX: 1.5, deltaY: 4.25, clientX: 12, clientY: 24 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "trackpad", operations: ["orbit"], client: { x: 10, y: 20 }, canvas });
    expect(camera.orbitBy).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), orbitAnchor(0));
    cleanup();
  });

  it("picks nothing for a pan swipe", () => {
    const { canvas, camera, cleanup } = setup();
    canvas.dispatchEvent(createWheelEvent({ deltaX: 1.5, deltaY: 4.25, clientX: 10, clientY: 20 }));
    expect(camera.panBy).toHaveBeenCalled();
    expect(camera.acquireAnchors).not.toHaveBeenCalled();
    cleanup();
  });

  it("picks nothing for the rest of a gesture another owner's reader began, then picks for the next", () => {
    const { canvas, camera, cleanup, zoomAnchor, advance } = setup({ precedingWheelMs: 1_000 - 50 });
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    expect(camera.zoomBy).not.toHaveBeenCalled();
    expect(camera.acquireAnchors).not.toHaveBeenCalled();

    advance(WHEEL_GESTURE_IDLE_MS + 1);
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.zoomBy).toHaveBeenCalledWith(expect.any(Number), zoomAnchor(0));
    cleanup();
  });

  it("zooms about the orbit target, as before anchors, with a camera that picks nothing", () => {
    const canvas = createCanvas();
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    const cleanup = attachWheelController(canvas, camera, { nowMs: () => 1_000, isSafariWithGestures: false });
    canvas.dispatchEvent(createWheelEvent({ deltaY: 100, clientX: 200, clientY: 150 }));
    expect(camera.zoomBy.mock.calls[0]).toHaveLength(1);
    cleanup();
  });
});
