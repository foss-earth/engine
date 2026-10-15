// @vitest-environment jsdom

import { describe, it, expect, vi, type Mock } from "vitest";
import { attachTouchController } from "../src/browser/touchController.js";
import { DEFAULT_INPUT_RATES, DEFAULT_INPUT_SETTINGS } from "../src/input/inputSettings.js";
import type { AnchorAcquisition, AnchorFamily, AnchorOperation, AnchorRequest, NavigationAnchor } from "../src/input/navigationAnchors.js";

interface TouchLike {
  identifier: number;
  clientX: number;
  clientY: number;
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientHeight", { value: 800, configurable: true });
  return canvas;
}

function dispatchTouch(
  canvas: HTMLCanvasElement,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: TouchLike[],
  changedTouches: TouchLike[],
  timestamp = 0,
): void {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "targetTouches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changedTouches });
  Object.defineProperty(event, "timeStamp", { value: timestamp });
  canvas.dispatchEvent(event);
}

function makeCamera(): {
  panBy: Mock<(...args: unknown[]) => void>;
  orbitBy: Mock<(...args: unknown[]) => void>;
  zoomBy: Mock<(...args: unknown[]) => void>;
  cancel: Mock<(...args: unknown[]) => void>;
} {
  return {
    panBy: vi.fn(),
    orbitBy: vi.fn(),
    zoomBy: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("attachTouchController (TouchEvent / continuous transform)", () => {
  it("uses inverted deltas for one-finger pan", () => {
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    const t0 = [{ identifier: 1, clientX: 20, clientY: 30 }];
    dispatchTouch(canvas, "touchstart", t0, t0, 0);
    const t1 = [{ identifier: 1, clientX: 32, clientY: 48 }];
    dispatchTouch(canvas, "touchmove", t1, t1, 16);

    expect(camera.panBy).toHaveBeenCalledTimes(1);
    expect(camera.panBy).toHaveBeenCalledWith(expect.closeTo(-5.76, 5), expect.closeTo(-8.64, 5), 800);

    cleanup();
  });

  it("cancels stale inertia when a new touch gesture starts", () => {
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    const t0 = [{ identifier: 1, clientX: 0, clientY: 0 }];
    dispatchTouch(canvas, "touchstart", t0, t0, 0);

    expect(camera.cancel).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("zooms but does not orbit during a pure pinch (centroid stationary)", () => {
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    // Fingers symmetric around (50, 50), 100px apart vertically.
    const start = [
      { identifier: 1, clientX: 50, clientY: 0 },
      { identifier: 2, clientX: 50, clientY: 100 },
    ];
    dispatchTouch(canvas, "touchstart", [start[0]], [start[0]], 0);
    dispatchTouch(canvas, "touchstart", start, [start[1]], 0);

    // Spread fingers symmetrically — centroid unchanged, distance grows by 30px (30%).
    const spread = [
      { identifier: 1, clientX: 50, clientY: -15 },
      { identifier: 2, clientX: 50, clientY: 115 },
    ];
    dispatchTouch(canvas, "touchmove", spread, spread, 16);

    expect(camera.zoomBy).toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("orbits but does not zoom during a parallel two-finger swipe", () => {
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    const start = [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 100, clientY: 300 },
    ];
    dispatchTouch(canvas, "touchstart", [start[0]], [start[0]], 0);
    dispatchTouch(canvas, "touchstart", start, [start[1]], 0);

    // Both fingers slide right by 30px — distance unchanged, centroid moves 30px.
    const swiped = [
      { identifier: 1, clientX: 130, clientY: 200 },
      { identifier: 2, clientX: 130, clientY: 300 },
    ];
    dispatchTouch(canvas, "touchmove", swiped, swiped, 16);

    expect(camera.orbitBy).toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("orbits and zooms simultaneously during a combined gesture", () => {
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    const start = [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 100, clientY: 300 },
    ];
    dispatchTouch(canvas, "touchstart", [start[0]], [start[0]], 0);
    dispatchTouch(canvas, "touchstart", start, [start[1]], 0);

    // Both fingers shift right AND spread apart.
    const combined = [
      { identifier: 1, clientX: 130, clientY: 180 },
      { identifier: 2, clientX: 130, clientY: 320 },
    ];
    dispatchTouch(canvas, "touchmove", combined, combined, 16);

    expect(camera.orbitBy).toHaveBeenCalled();
    expect(camera.zoomBy).toHaveBeenCalled();

    cleanup();
  });

  it("ignores micro-jitter below activation thresholds", () => {
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    const start = [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 100, clientY: 400 },
    ];
    dispatchTouch(canvas, "touchstart", [start[0]], [start[0]], 0);
    dispatchTouch(canvas, "touchstart", start, [start[1]], 0);

    // Sub-pixel-scale wobble: centroid moves < 1px, distance changes by < 1px (~0.5% of 200).
    const jitter = [
      { identifier: 1, clientX: 100, clientY: 200.5 },
      { identifier: 2, clientX: 100, clientY: 400.5 },
    ];
    dispatchTouch(canvas, "touchmove", jitter, jitter, 16);

    expect(camera.orbitBy).not.toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();

    cleanup();
  });

  it("orbits on Android Firefox style frames where only one finger moves per event", () => {
    // On Android Firefox the touchmove TouchList still contains both fingers
    // each frame (even though only one finger's position has changed since
    // the previous frame).  A parallel swipe with a 'lagging' finger looks
    // like the centroid moving by half-finger-1-delta and the distance
    // changing by half-finger-1-delta.  Over enough frames this still adds
    // up to a swipe, and orbit should engage well before zoom does.
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    const f2 = { identifier: 2, clientX: 100, clientY: 400 };
    const startTouches = [{ identifier: 1, clientX: 100, clientY: 200 }, f2];
    dispatchTouch(canvas, "touchstart", [startTouches[0]], [startTouches[0]], 0);
    dispatchTouch(canvas, "touchstart", startTouches, [f2], 0);

    // Finger 1 slides right; finger 2's reported position never changes.
    for (let i = 1; i <= 6; i++) {
      const f1 = { identifier: 1, clientX: 100 + i * 8, clientY: 200 };
      dispatchTouch(canvas, "touchmove", [f1, f2], [f1], i * 16);
    }

    expect(camera.orbitBy).toHaveBeenCalled();

    cleanup();
  });

  it("resets baselines when a finger lifts so the remaining pan does not jump", () => {
    const canvas = createCanvas();
    const camera = makeCamera();
    const cleanup = attachTouchController(canvas, camera);

    const start = [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 100, clientY: 300 },
    ];
    dispatchTouch(canvas, "touchstart", [start[0]], [start[0]], 0);
    dispatchTouch(canvas, "touchstart", start, [start[1]], 0);

    // Two-finger swipe.
    const moved = [
      { identifier: 1, clientX: 130, clientY: 200 },
      { identifier: 2, clientX: 130, clientY: 300 },
    ];
    dispatchTouch(canvas, "touchmove", moved, moved, 16);

    camera.panBy.mockClear();
    camera.orbitBy.mockClear();

    // Finger 2 lifts.  Remaining finger is at (130,200) — must be re-baselined,
    // i.e. the next pan should be relative to (130,200), not the original (100,200).
    dispatchTouch(canvas, "touchend", [moved[0]], [moved[1]], 30);
    const after = [{ identifier: 1, clientX: 135, clientY: 205 }];
    dispatchTouch(canvas, "touchmove", after, after, 40);

    expect(camera.panBy).toHaveBeenCalledTimes(1);
    const [dx, dy] = camera.panBy.mock.calls[0];
    // Expected: -(135-130)*0.48*1 = -2.4,  -(205-200)*0.48*1 = -2.4
    expect(dx).toBeCloseTo(-2.4, 5);
    expect(dy).toBeCloseTo(-2.4, 5);

    cleanup();
  });
});

function anchorOf(session: number, family: AnchorFamily, operation: AnchorOperation): NavigationAnchor {
  return { session, owner: "globe", family, operation, requested: "gesture", source: "surface", point: { x: session, y: 0, z: 0 }, surfaceRevision: null, fallback: null };
}

/** A camera whose every acquisition is a new session, so each pair's pick can be told apart. */
function anchoredCamera() {
  let session = 0;
  const acquireAnchors = vi.fn((request: AnchorRequest<HTMLCanvasElement>): AnchorAcquisition => {
    session += 1;
    const acquired: { zoom?: NavigationAnchor; orbit?: NavigationAnchor } = {};
    for (const operation of request.operations) acquired[operation] = anchorOf(session, request.family, operation);
    return acquired;
  });
  const acquisition = (call: number) => acquireAnchors.mock.results[call].value as AnchorAcquisition;
  return {
    ...makeCamera(), acquireAnchors, acquisition,
    holdAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(), releaseAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(),
  };
}

describe("attachTouchController: a pair's zoom anchor and orbit pivot", () => {
  const f1 = { identifier: 1, clientX: 100, clientY: 200 };
  const f2 = { identifier: 2, clientX: 100, clientY: 300 };

  function landPair(canvas: HTMLCanvasElement): void {
    dispatchTouch(canvas, "touchstart", [f1], [f1], 0);
    dispatchTouch(canvas, "touchstart", [f1, f2], [f2], 0);
  }

  it("picks once under the pair's first midpoint, as a candidate, holds once it moves, keeps it as the midpoint moves, and lets go when it lifts", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const cleanup = attachTouchController(canvas, camera);

    landPair(canvas);
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "touch", operations: ["zoom", "orbit"], client: { x: 100, y: 250 }, canvas, candidate: true });
    const acquired = camera.acquisition(0);
    expect(camera.holdAnchors).not.toHaveBeenCalled();

    // A pinch: the pair zooms about its pick.
    const spread = [{ identifier: 1, clientX: 100, clientY: 180 }, { identifier: 2, clientX: 100, clientY: 320 }];
    dispatchTouch(canvas, "touchmove", spread, spread, 16);
    expect(camera.holdAnchors).toHaveBeenCalledTimes(1);
    expect(camera.holdAnchors).toHaveBeenCalledWith(acquired);
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), acquired.zoom);

    // The midpoint moves: the view turns about the same pick, picked nowhere new.
    for (let i = 1; i <= 3; i++) {
      const swiped = spread.map(t => ({ ...t, clientX: t.clientX + 30 * i, clientY: t.clientY + 10 * i }));
      dispatchTouch(canvas, "touchmove", swiped, swiped, 16 + 16 * i);
    }
    expect(camera.orbitBy).toHaveBeenCalled();
    for (const [, , pivot] of camera.orbitBy.mock.calls) expect(pivot).toBe(acquired.orbit);
    for (const [, anchor] of camera.zoomBy.mock.calls) expect(anchor).toBe(acquired.zoom);
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.holdAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).not.toHaveBeenCalled();

    // One finger lifts: the pair has ended, and what is left pans.
    const last = [{ identifier: 1, clientX: 190, clientY: 210 }];
    dispatchTouch(canvas, "touchend", last, [{ identifier: 2, clientX: 190, clientY: 350 }], 80);
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(acquired);
    dispatchTouch(canvas, "touchend", [], last, 90);
    cleanup();
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
  });

  it("lets go of a pair that lifts without moving, never having held it", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const cleanup = attachTouchController(canvas, camera);

    landPair(canvas);
    const jitter = [{ ...f1, clientY: 200.5 }, { ...f2, clientY: 300.5 }];
    dispatchTouch(canvas, "touchmove", jitter, jitter, 16);
    dispatchTouch(canvas, "touchend", [], jitter, 30);
    expect(camera.holdAnchors).not.toHaveBeenCalled();
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(camera.acquisition(0));
    cleanup();
  });

  it("keeps the pair's pick when a third finger lands", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const cleanup = attachTouchController(canvas, camera);

    landPair(canvas);
    const f3 = { identifier: 3, clientX: 400, clientY: 400 };
    dispatchTouch(canvas, "touchstart", [f1, f2, f3], [f3], 10);
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).not.toHaveBeenCalled();
    cleanup();
    expect(camera.releaseAnchors).toHaveBeenCalledWith(camera.acquisition(0));
  });

  it("picks afresh for a changed pair, letting go of the last pair's first", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const cleanup = attachTouchController(canvas, camera);

    landPair(canvas);
    dispatchTouch(canvas, "touchend", [f1], [f2], 10);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(camera.acquisition(0));
    const f3 = { identifier: 3, clientX: 300, clientY: 200 };
    dispatchTouch(canvas, "touchstart", [f1, f3], [f3], 20);
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(2);
    expect(camera.acquireAnchors).toHaveBeenLastCalledWith(expect.objectContaining({ family: "touch", client: { x: 200, y: 200 }, candidate: true }));

    // A pair that changes without a touchend in between, too.
    const f4 = { identifier: 4, clientX: 300, clientY: 400 };
    dispatchTouch(canvas, "touchmove", [f1, f4], [f4], 30);
    expect(camera.releaseAnchors).toHaveBeenLastCalledWith(camera.acquisition(1));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(3);
    expect(camera.acquireAnchors).toHaveBeenLastCalledWith(expect.objectContaining({ client: { x: 200, y: 300 } }));
    cleanup();
    expect(camera.releaseAnchors).toHaveBeenLastCalledWith(camera.acquisition(2));
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(3);
  });

  it("goes on with a pair handed back, from where its fingers are, without a touchstart", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const cleanup = attachTouchController(canvas, camera, { heldTouches: [f1, f2] });

    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "touch", operations: ["zoom", "orbit"], client: { x: 100, y: 250 }, canvas, candidate: true });
    const acquired = camera.acquisition(0);
    const spread = [{ ...f1, clientY: 180 }, { ...f2, clientY: 320 }];
    dispatchTouch(canvas, "touchmove", spread, spread, 16);
    // From the handed-back positions: 100 px apart, now 140.
    expect(camera.zoomBy).toHaveBeenCalledTimes(1);
    expect(camera.zoomBy).toHaveBeenCalledWith(expect.closeTo((100 / 140) ** DEFAULT_INPUT_RATES.touchZoomExponent, 9), acquired.zoom);
    expect(camera.holdAnchors).toHaveBeenCalledWith(acquired);
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.cancel).not.toHaveBeenCalled();
    dispatchTouch(canvas, "touchend", [], spread, 30);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(acquired);
    cleanup();
  });

  it("does not stop the glide for a handed-back contact's touchstart, but does for a fresh finger", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const cleanup = attachTouchController(canvas, camera, { heldTouches: [f1, f2] });

    dispatchTouch(canvas, "touchstart", [f1, f2], [f1, f2], 0);
    expect(camera.cancel).not.toHaveBeenCalled();
    // The same pair: its pick stands.
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).not.toHaveBeenCalled();

    const f3 = { identifier: 3, clientX: 400, clientY: 400 };
    dispatchTouch(canvas, "touchstart", [f1, f2, f3], [f3], 10);
    expect(camera.cancel).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("goes on panning with one finger handed back", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const cleanup = attachTouchController(canvas, camera, { heldTouches: [f1] });

    dispatchTouch(canvas, "touchmove", [{ ...f1, clientX: 110 }], [{ ...f1, clientX: 110 }], 16);
    expect(camera.panBy).toHaveBeenCalledWith(expect.closeTo(-4.8, 9), expect.closeTo(0, 9), 800);
    expect(camera.acquireAnchors).not.toHaveBeenCalled();
    expect(camera.cancel).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("attachTouchController: a finger's grab of the ground", () => {
  const f1 = { identifier: 1, clientX: 100, clientY: 200 };
  const f2 = { identifier: 2, clientX: 100, clientY: 300 };

  function grabbingCamera() {
    return {
      ...makeCamera(),
      beginAnchorPan: vi.fn(() => true),
      panAnchorTo: vi.fn<(pick: unknown, sensitivity?: number) => boolean>(() => true),
      endAnchorPan: vi.fn(),
    };
  }
  const options = { getSettings: () => ({ ...DEFAULT_INPUT_SETTINGS, globeAnchorRotation: true }) };

  it("grabs under the finger, follows it, and lets go when it lifts", () => {
    const canvas = createCanvas();
    const camera = grabbingCamera();
    const cleanup = attachTouchController(canvas, camera, options);

    dispatchTouch(canvas, "touchstart", [f1], [f1], 0);
    expect(camera.beginAnchorPan).toHaveBeenCalledTimes(1);
    expect(camera.beginAnchorPan).toHaveBeenCalledWith(expect.objectContaining({ clientX: 100, clientY: 200 }));
    dispatchTouch(canvas, "touchmove", [{ ...f1, clientX: 130 }], [{ ...f1, clientX: 130 }], 16);
    expect(camera.panAnchorTo.mock.lastCall?.[0]).toEqual(expect.objectContaining({ clientX: 130, clientY: 200 }));
    expect(camera.panBy).not.toHaveBeenCalled();
    dispatchTouch(canvas, "touchend", [], [{ ...f1, clientX: 130 }], 32);
    expect(camera.endAnchorPan).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("lets a pinch or a turn coast when one finger lifts, and grabs only once that finger drags", () => {
    const canvas = createCanvas();
    const camera = {
      ...grabbingCamera(),
      releaseMomentum: vi.fn(),
      armReleaseMomentum: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera, options);
    const start = [
      { identifier: 1, clientX: 50, clientY: 0 },
      { identifier: 2, clientX: 50, clientY: 100 },
    ];
    const spread = [
      { identifier: 1, clientX: 50, clientY: -15 },
      { identifier: 2, clientX: 50, clientY: 115 },
    ];
    dispatchTouch(canvas, "touchstart", start, start, 0);
    dispatchTouch(canvas, "touchmove", spread, spread, 16);
    const cancels = camera.cancel.mock.calls.length;

    dispatchTouch(canvas, "touchend", [spread[0]], [spread[1]], 32);
    expect(camera.releaseMomentum).toHaveBeenCalledWith("zoom");
    expect(camera.releaseMomentum).toHaveBeenCalledWith("orbit");
    expect(camera.beginAnchorPan).not.toHaveBeenCalled();
    expect(camera.cancel).toHaveBeenCalledTimes(cancels);

    dispatchTouch(canvas, "touchmove", [{ ...spread[0], clientY: -14 }], [{ ...spread[0], clientY: -14 }], 40);
    expect(camera.beginAnchorPan).not.toHaveBeenCalled();
    expect(camera.cancel).toHaveBeenCalledTimes(cancels);

    dispatchTouch(canvas, "touchmove", [{ ...spread[0], clientY: -6 }], [{ ...spread[0], clientY: -6 }], 56);
    expect(camera.cancel).toHaveBeenCalledTimes(cancels + 1);
    expect(camera.beginAnchorPan).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("lets a pinch coast when both fingers lift together", () => {
    const canvas = createCanvas();
    const camera = {
      ...grabbingCamera(),
      releaseMomentum: vi.fn(),
    };
    const cleanup = attachTouchController(canvas, camera, options);
    const start = [
      { identifier: 1, clientX: 50, clientY: 0 },
      { identifier: 2, clientX: 50, clientY: 100 },
    ];
    const spread = [
      { identifier: 1, clientX: 50, clientY: -15 },
      { identifier: 2, clientX: 50, clientY: 115 },
    ];
    dispatchTouch(canvas, "touchstart", start, start, 0);
    dispatchTouch(canvas, "touchmove", spread, spread, 16);
    dispatchTouch(canvas, "touchend", [], spread, 32);
    expect(camera.releaseMomentum).toHaveBeenCalledWith("zoom");
    expect(camera.releaseMomentum).toHaveBeenCalledWith("orbit");
    expect(camera.beginAnchorPan).not.toHaveBeenCalled();
    cleanup();
  });

  it("lets go of the ground when a second finger lands, and grabs afresh under the finger left", () => {
    const canvas = createCanvas();
    const camera = grabbingCamera();
    const cleanup = attachTouchController(canvas, camera, options);

    dispatchTouch(canvas, "touchstart", [f1], [f1], 0);
    dispatchTouch(canvas, "touchstart", [f1, f2], [f2], 10);
    // A pair zooms and turns: the one finger's grab is over.
    expect(camera.endAnchorPan).toHaveBeenCalledTimes(1);

    dispatchTouch(canvas, "touchend", [f2], [f1], 20);
    expect(camera.endAnchorPan).toHaveBeenCalledTimes(1);
    // The finger left takes its own grab, which this one does not end.
    expect(camera.beginAnchorPan).toHaveBeenCalledTimes(2);
    expect(camera.beginAnchorPan).toHaveBeenLastCalledWith(expect.objectContaining({ clientX: 100, clientY: 300 }));
    dispatchTouch(canvas, "touchend", [], [f2], 30);
    expect(camera.endAnchorPan).toHaveBeenCalledTimes(2);
    cleanup();
  });
});
