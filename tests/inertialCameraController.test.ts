import { describe, expect, it, vi } from "vitest";
import type { CameraController } from "../src/babylon/cameraState.js";
import { createGlobeInertia } from "../src/babylon/globeInertia.js";
import {
  createInertialCameraController,
  MAX_ZOOM_LOG_DELTA_PER_FRAME,
  type CameraInputTarget,
  type GlideAnchors,
  type InertialCameraController,
} from "../src/input/inertialCameraController.js";
import type { AnchorAcquisition, AnchorOperation, AnchorRequest, GlideMotion, NavigationAnchor } from "../src/input/navigationAnchors.js";

describe("createInertialCameraController", () => {
  it("applies queued pan, orbit, and zoom on update", () => {
    const target = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const controller = createInertialCameraController(target, { nowMs: () => 0 });

    controller.panBy(12, -6, 800);
    controller.orbitBy(2, -3);
    controller.zoomBy(0.92);
    controller.update(1000);

    expect(target.panBy).toHaveBeenCalledWith(12, -6, 800);
    expect(target.orbitBy).toHaveBeenCalledWith(2, -3);
    expect(target.zoomBy).toHaveBeenCalledWith(expect.closeTo(0.92, 6));
  });

  it("decays motion after each update", () => {
    const target = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const controller = createInertialCameraController(target, { nowMs: () => 0 });

    controller.panBy(10, 0, 800);
    controller.update(1000);
    controller.update(1000 + 1000 / 60);

    expect(target.panBy).toHaveBeenNthCalledWith(1, 10, 0, 800);
    expect(target.panBy).toHaveBeenNthCalledWith(2, expect.closeTo(8.2, 1), 0, 800);
  });

  it("glides by camera.inertiaDecay, read at each update", () => {
    const target = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    let decay = 0.5;
    const controller = createInertialCameraController(target, { nowMs: () => 0, decayPerFrame: () => decay });

    controller.panBy(10, 0, 800);
    controller.update(1000);
    controller.update(1000 + 1000 / 60);
    expect(target.panBy).toHaveBeenNthCalledWith(2, expect.closeTo(5, 6), 0, 800);

    // 0 stops after the motion already under way.
    decay = 0;
    controller.update(1000 + 2000 / 60);
    controller.update(1000 + 3000 / 60);
    expect(target.panBy).toHaveBeenCalledTimes(3);
    expect(target.panBy).toHaveBeenNthCalledWith(3, expect.closeTo(2.5, 6), 0, 800);
    expect(controller.isActive()).toBe(false);
  });

  it("cancels queued motion", () => {
    const target = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const controller = createInertialCameraController(target, { nowMs: () => 0 });

    controller.panBy(10, 0, 800);
    controller.orbitBy(5, 5);
    controller.zoomBy(1.08);
    controller.cancel();
    controller.update(1000);

    expect(target.panBy).not.toHaveBeenCalled();
    expect(target.orbitBy).not.toHaveBeenCalled();
    expect(target.zoomBy).not.toHaveBeenCalled();
  });

  it("reports isActive() while velocity exceeds stop thresholds", () => {
    const target = {
      panBy: vi.fn(),
      orbitBy: vi.fn(),
      zoomBy: vi.fn(),
    };
    const controller = createInertialCameraController(target, { nowMs: () => 0 });
    expect(controller.isActive()).toBe(false);

    controller.panBy(10, 0, 800);
    expect(controller.isActive()).toBe(true);

    controller.cancel();
    expect(controller.isActive()).toBe(false);
  });
});

type Point = { x: number; y: number; z: number };

function anchorOf(session: number, operation: AnchorOperation, point: Point | null): NavigationAnchor {
  return {
    session, owner: "globe", family: "mouse", operation, requested: point ? "pointer" : "target",
    source: point ? "surface" : "target", point, surfaceRevision: null, fallback: null,
  };
}

/** The same rates about other anchors: what a camera says of a channel with no motion to carry over. */
function relabelled(motion: GlideMotion, anchors: GlideAnchors): GlideMotion {
  return { ...motion, orbit: { ...motion.orbit, anchor: anchors.orbit }, zoom: { ...motion.zoom, anchor: anchors.zoom } };
}

/**
 * A camera that moves about anchors and logs the order of its steps. Its
 * rebase keeps the rates; a test says what one rebase gives with `mockReturnValueOnce`.
 */
function anchoredTarget() {
  const steps: string[] = [];
  return {
    steps,
    panBy: vi.fn<CameraInputTarget["panBy"]>(() => { steps.push("pan"); }),
    orbitBy: vi.fn<CameraInputTarget["orbitBy"]>(() => { steps.push("orbit"); }),
    zoomBy: vi.fn<CameraInputTarget["zoomBy"]>(() => { steps.push("zoom"); }),
    orbitZoomBy: vi.fn<NonNullable<CameraInputTarget["orbitZoomBy"]>>(() => { steps.push("orbitZoom"); }),
    rebaseMotion: vi.fn<NonNullable<CameraInputTarget["rebaseMotion"]>>(relabelled),
  };
}

/** Updates a frame at a time on a 60 Hz clock; glides here keep half their speed each frame. */
function glideOf<T extends CameraInputTarget>(target: T) {
  const controller = createInertialCameraController(target, { nowMs: () => 0, decayPerFrame: () => 0.5 });
  let now = 1000;
  const step = () => { controller.update(now); now += 1000 / 60; };
  return { controller, step };
}

const P1 = { x: 1, y: 2, z: 3 };
const P2 = { x: 4, y: 5, z: 6 };
const P3 = { x: 7, y: 8, z: 9 };

describe("createInertialCameraController: anchored glide", () => {
  it("glides orbit and zoom on about the anchors they were set moving with, and lets go of each as it settles", () => {
    const target = anchoredTarget();
    const { controller, step } = glideOf(target);
    const pivot = anchorOf(1, "orbit", P1);
    const zoomAt = anchorOf(2, "zoom", P2);

    controller.orbitBy(0.01, 0, pivot);
    controller.zoomBy(0.9, zoomAt);
    expect(controller.anchors()).toEqual({ orbit: pivot, zoom: zoomAt });

    // Direct input has ended: the tail goes on about the same points.
    step();
    step();
    expect(target.orbitBy).toHaveBeenNthCalledWith(1, 0.01, 0, pivot);
    expect(target.orbitBy).toHaveBeenNthCalledWith(2, 0.005, 0, pivot);
    expect(target.zoomBy).toHaveBeenNthCalledWith(2, expect.closeTo(Math.sqrt(0.9), 12), zoomAt);
    expect(controller.anchors()).toEqual({ orbit: pivot, zoom: zoomAt });

    // The orbit settles first and lets go of its pivot; the zoom keeps its anchor.
    step();
    expect(target.orbitBy).toHaveBeenCalledTimes(3);
    expect(controller.anchors()).toEqual({ orbit: null, zoom: zoomAt });
    expect(controller.motion().orbit.anchor).toBeNull();

    while (controller.isActive()) step();
    for (const [, anchor] of target.zoomBy.mock.calls) expect(anchor).toBe(zoomAt);
    expect(controller.anchors()).toEqual({ orbit: null, zoom: null });
    expect(controller.motion().zoom.anchor).toBeNull();
    expect(target.orbitZoomBy).not.toHaveBeenCalled();

    // Settled: the next input naming none moves about the orbit target, with nothing to carry over.
    target.rebaseMotion.mockClear();
    controller.orbitBy(1, 0);
    step();
    expect(target.orbitBy.mock.lastCall).toEqual([expect.closeTo(1, 4), 0]);
    expect(target.rebaseMotion).not.toHaveBeenCalled();
  });

  it("steps pan, then orbit and zoom as one step about a picked point they share", () => {
    const target = anchoredTarget();
    const { controller, step } = glideOf(target);
    const pivot = anchorOf(1, "orbit", P1);
    const zoomAt = anchorOf(1, "zoom", { ...P1 });

    controller.zoomBy(0.9, zoomAt);
    controller.orbitBy(1, 2, pivot);
    controller.panBy(5, 0, 800);
    step();

    expect(target.steps).toEqual(["pan", "orbitZoom"]);
    expect(target.orbitZoomBy).toHaveBeenCalledWith(1, 2, expect.closeTo(0.9, 12), pivot);
    expect(target.orbitBy).not.toHaveBeenCalled();
    expect(target.zoomBy).not.toHaveBeenCalled();
  });

  it("steps orbit then zoom apart about different points, about the compass target, and for a target with no combined step", () => {
    const cases: [NavigationAnchor, NavigationAnchor, boolean][] = [
      [anchorOf(1, "orbit", P1), anchorOf(1, "zoom", P2), true],
      // Both the compass target: the target's own orbit and zoom.
      [anchorOf(1, "orbit", null), anchorOf(1, "zoom", null), true],
      [anchorOf(1, "orbit", P1), anchorOf(1, "zoom", P1), false],
    ];
    for (const [pivot, zoomAt, combines] of cases) {
      const { orbitZoomBy, ...rest } = anchoredTarget();
      const target = combines ? { ...rest, orbitZoomBy } : rest;
      const { controller, step } = glideOf(target);

      controller.panBy(5, 0, 800);
      controller.orbitBy(1, 2, pivot);
      controller.zoomBy(0.9, zoomAt);
      step();

      expect(rest.steps).toEqual(["pan", "orbit", "zoom"]);
      expect(rest.orbitBy).toHaveBeenCalledWith(1, 2, pivot);
      expect(rest.zoomBy).toHaveBeenCalledWith(expect.closeTo(0.9, 12), zoomAt);
      expect(orbitZoomBy).not.toHaveBeenCalled();
    }
  });

  it("calls a target with no anchor as before anchors", () => {
    const target = anchoredTarget();
    const { controller, step } = glideOf(target);

    controller.orbitBy(1, 2);
    controller.zoomBy(0.9, null);
    step();

    expect(target.orbitBy.mock.lastCall).toEqual([1, 2]);
    expect(target.zoomBy.mock.lastCall).toEqual([expect.closeTo(0.9, 12)]);
    expect(controller.anchors()).toEqual({ orbit: null, zoom: null });
  });

  it("stops only a channel whose step the target could not take, and lets go of its anchor", () => {
    const target = anchoredTarget();
    target.orbitBy.mockReturnValue({ moved: false, constrained: "tilt-limit" });
    // Held short by a limit, but moved: its glide goes on.
    target.zoomBy.mockReturnValue({ moved: true, constrained: "distance-limit" });
    const { controller, step } = glideOf(target);
    const zoomAt = anchorOf(1, "zoom", P2);

    controller.orbitBy(2, 0, anchorOf(1, "orbit", P1));
    controller.zoomBy(0.9, zoomAt);
    step();
    expect(controller.anchors()).toEqual({ orbit: null, zoom: zoomAt });
    expect(controller.motion().orbit).toEqual({ pitch: 0, heading: 0, anchor: null });

    step();
    expect(target.orbitBy).toHaveBeenCalledTimes(1);
    expect(target.zoomBy).toHaveBeenCalledTimes(2);
  });

  it("stops orbit and zoom together when their one combined step cannot be taken", () => {
    const target = anchoredTarget();
    target.orbitZoomBy.mockReturnValue({ moved: false, constrained: "not-ahead" });
    const { controller, step } = glideOf(target);

    controller.panBy(5, 0, 800);
    controller.orbitBy(2, 0, anchorOf(1, "orbit", P1));
    controller.zoomBy(0.9, anchorOf(1, "zoom", P1));
    step();

    expect(controller.anchors()).toEqual({ orbit: null, zoom: null });
    // Pan is no part of that step.
    expect(controller.motion().pan.x).toBe(2.5);
    step();
    expect(target.orbitZoomBy).toHaveBeenCalledTimes(1);
    expect(target.panBy).toHaveBeenCalledTimes(2);
  });

  it("stops every channel and lets go of its anchors on cancel", () => {
    const target = anchoredTarget();
    const { controller, step } = glideOf(target);

    controller.panBy(5, 0, 800);
    controller.orbitBy(2, 0, anchorOf(1, "orbit", P1));
    controller.zoomBy(0.9, anchorOf(1, "zoom", P2));
    controller.cancel();
    target.rebaseMotion.mockClear();
    expect(controller.anchors()).toEqual({ orbit: null, zoom: null });
    expect(controller.motion()).toEqual({
      pan: { x: 0, y: 0, canvasHeight: 800 }, orbit: { pitch: 0, heading: 0, anchor: null }, zoom: { log: 0, anchor: null },
    });

    // The next gesture starts on its own anchor: nothing is left to carry over.
    const next = anchorOf(2, "orbit", P3);
    controller.orbitBy(1, 0, next);
    step();
    expect(target.rebaseMotion).not.toHaveBeenCalled();
    expect(target.orbitBy).toHaveBeenCalledTimes(1);
    expect(target.orbitBy).toHaveBeenCalledWith(1, 0, next);
  });

  it("passes a gesture's acquire, hold and release through to its target, and offers none a target lacks", () => {
    const plain = createInertialCameraController({ panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() }, { nowMs: () => 0 });
    expect(plain.acquireAnchors).toBeUndefined();
    expect(plain.holdAnchors).toBeUndefined();
    expect(plain.releaseAnchors).toBeUndefined();

    const pivot = anchorOf(1, "orbit", P1);
    const acquired: AnchorAcquisition = { orbit: pivot, zoom: anchorOf(1, "zoom", P1) };
    const target = {
      ...anchoredTarget(),
      acquireAnchors: vi.fn<(request: AnchorRequest) => AnchorAcquisition>(() => acquired),
      holdAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(),
      releaseAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(),
    };
    const { controller, step } = glideOf(target);
    const request: AnchorRequest = { family: "trackpad", operations: ["zoom", "orbit"], client: { x: 0, y: 0 }, hold: true };

    expect(controller.acquireAnchors?.(request)).toBe(acquired);
    expect(target.acquireAnchors).toHaveBeenCalledWith(request);
    controller.holdAnchors?.(acquired);
    expect(target.holdAnchors).toHaveBeenCalledWith(acquired);

    // Letting go ends the gesture, not what it set moving.
    controller.orbitBy(2, 0, pivot);
    controller.releaseAnchors?.(acquired);
    expect(target.releaseAnchors).toHaveBeenCalledWith(acquired);
    step();
    step();
    expect(target.orbitBy).toHaveBeenLastCalledWith(1, 0, pivot);
    expect(controller.anchors().orbit).toBe(pivot);
  });
});

describe("createInertialCameraController: a new gesture's anchors during a glide", () => {
  it("writes the glide under way about the new anchor before adding the new input", () => {
    const oldPivot = anchorOf(1, "orbit", P1);
    const oldZoom = anchorOf(1, "zoom", P1);
    const newPivot = anchorOf(2, "orbit", P2);
    const target = anchoredTarget();
    const { controller, step } = glideOf(target);

    controller.orbitBy(2, 4, oldPivot);
    controller.zoomBy(Math.exp(-0.05), oldZoom);
    step();
    const under = controller.motion();
    expect(under.orbit).toEqual({ pitch: 1, heading: 2, anchor: oldPivot });

    target.rebaseMotion.mockClear().mockReturnValueOnce({
      pan: { x: 3, y: -2, canvasHeight: 600 }, orbit: { pitch: 0.5, heading: 1, anchor: newPivot }, zoom: { log: -0.02, anchor: oldZoom },
    });
    controller.orbitBy(0.25, 0, newPivot);
    expect(target.rebaseMotion).toHaveBeenCalledTimes(1);
    expect(target.rebaseMotion).toHaveBeenCalledWith(under, { orbit: newPivot, zoom: oldZoom });
    // The new input adds to the motion as rewritten, not to the old pivot's rates.
    expect(controller.motion()).toEqual({
      pan: { x: 3, y: -2, canvasHeight: 600 }, orbit: { pitch: 0.75, heading: 1, anchor: newPivot }, zoom: { log: -0.02, anchor: oldZoom },
    });

    // The pivot and zoom anchor now differ: two steps, each about its own.
    step();
    expect(target.steps.slice(-3)).toEqual(["pan", "orbit", "zoom"]);
    expect(target.panBy).toHaveBeenLastCalledWith(3, -2, 600);
    expect(target.orbitBy).toHaveBeenLastCalledWith(0.75, 1, newPivot);
    expect(target.zoomBy).toHaveBeenLastCalledWith(expect.closeTo(Math.exp(-0.02), 12), oldZoom);
  });

  it("reanchors a zoom glide where a wheel has moved, keeping the orbit's pivot", () => {
    const pivot = anchorOf(1, "orbit", P1);
    const oldZoom = anchorOf(2, "zoom", P2);
    const newZoom = anchorOf(3, "zoom", P3);
    const target = anchoredTarget();
    const { controller } = glideOf(target);

    controller.orbitBy(0.5, 0, pivot);
    controller.zoomBy(0.9, oldZoom);
    target.rebaseMotion.mockClear().mockReturnValueOnce({
      pan: { x: 1, y: 0, canvasHeight: 800 }, orbit: { pitch: 0.4, heading: 0, anchor: pivot }, zoom: { log: -0.03, anchor: newZoom },
    });
    controller.zoomBy(0.95, newZoom);

    expect(target.rebaseMotion).toHaveBeenCalledTimes(1);
    expect(target.rebaseMotion).toHaveBeenCalledWith(expect.objectContaining({ zoom: { log: Math.log(0.9), anchor: oldZoom } }), { orbit: pivot, zoom: newZoom });
    expect(controller.motion().zoom).toEqual({ log: expect.closeTo(-0.03 + Math.log(0.95), 12), anchor: newZoom });
    expect(controller.motion().orbit).toEqual({ pitch: 0.4, heading: 0, anchor: pivot });
    expect(controller.anchors()).toEqual({ orbit: pivot, zoom: newZoom });
  });

  it("adds to the glide without rewriting it when the same point is picked again", () => {
    const target = anchoredTarget();
    const { controller } = glideOf(target);
    const first = anchorOf(1, "orbit", P1);
    const again = anchorOf(2, "orbit", { ...P1 });

    controller.orbitBy(2, 0, first);
    controller.orbitBy(1, 0, again);

    expect(target.rebaseMotion).not.toHaveBeenCalled();
    expect(controller.motion().orbit).toEqual({ pitch: 3, heading: 0, anchor: again });
  });

  it("stops only the channel whose anchor changed when its motion cannot be written about the new one", () => {
    const target = anchoredTarget();
    const { controller } = glideOf(target);
    const zoomAt = anchorOf(1, "zoom", P2);
    const newPivot = anchorOf(2, "orbit", P3);

    controller.panBy(5, 0, 800);
    controller.orbitBy(2, 0, anchorOf(1, "orbit", P1));
    controller.zoomBy(0.9, zoomAt);
    target.rebaseMotion.mockClear().mockReturnValue(null);
    controller.orbitBy(0.5, 0, newPivot);

    expect(target.rebaseMotion).toHaveBeenCalledTimes(1);
    expect(controller.motion()).toEqual({
      pan: { x: 5, y: 0, canvasHeight: 800 }, orbit: { pitch: 0.5, heading: 0, anchor: newPivot }, zoom: { log: Math.log(0.9), anchor: zoomAt },
    });

    const newZoom = anchorOf(3, "zoom", P1);
    controller.zoomBy(0.95, newZoom);
    expect(target.rebaseMotion).toHaveBeenCalledTimes(2);
    expect(controller.motion()).toEqual({
      pan: { x: 5, y: 0, canvasHeight: 800 }, orbit: { pitch: 0.5, heading: 0, anchor: newPivot }, zoom: { log: Math.log(0.95), anchor: newZoom },
    });
  });

  it("carries the rates over as they are for a target that moves only about its orbit target", () => {
    const target: CameraInputTarget = { ...anchoredTarget(), rebaseMotion: undefined };
    const { controller } = glideOf(target);
    const pivot = anchorOf(2, "orbit", P2);

    controller.orbitBy(2, 0, anchorOf(1, "orbit", P1));
    controller.orbitBy(1, 0, pivot);

    expect(controller.motion().orbit).toEqual({ pitch: 3, heading: 0, anchor: pivot });
  });

  it("leaves the glide and its anchor alone for a zoom it cannot take", () => {
    const target = anchoredTarget();
    const { controller } = glideOf(target);
    const zoomAt = anchorOf(1, "zoom", P1);

    controller.zoomBy(0.9, zoomAt);
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) controller.zoomBy(factor, anchorOf(2, "zoom", P2));

    expect(target.rebaseMotion).not.toHaveBeenCalled();
    expect(controller.motion().zoom).toEqual({ log: Math.log(0.9), anchor: zoomAt });
  });
});

describe("createInertialCameraController: rebaseTo", () => {
  it("carries a glide onto other anchors, as when following a point begins, within the glide's limits", () => {
    const target = anchoredTarget();
    const { controller, step } = glideOf(target);

    controller.orbitBy(2, 4, anchorOf(1, "orbit", P1));
    controller.zoomBy(0.9, anchorOf(1, "zoom", P2));
    const under = controller.motion();
    target.rebaseMotion.mockClear().mockReturnValueOnce({
      pan: { x: 500, y: -500, canvasHeight: 0 }, orbit: { pitch: 30, heading: -30, anchor: null }, zoom: { log: 1, anchor: null },
    });
    controller.rebaseTo({ orbit: null, zoom: null });

    expect(target.rebaseMotion).toHaveBeenCalledTimes(1);
    expect(target.rebaseMotion).toHaveBeenCalledWith(under, { orbit: null, zoom: null });
    expect(controller.motion()).toEqual({
      pan: { x: 80, y: -80, canvasHeight: 1 }, orbit: { pitch: 12, heading: -12, anchor: null }, zoom: { log: MAX_ZOOM_LOG_DELTA_PER_FRAME, anchor: null },
    });
    expect(controller.anchors()).toEqual({ orbit: null, zoom: null });

    // About the orbit target: the target's own orbit and zoom, as before anchors.
    step();
    expect(target.panBy).toHaveBeenLastCalledWith(80, -80, 1);
    expect(target.orbitBy.mock.lastCall).toEqual([12, -12]);
    expect(target.zoomBy.mock.lastCall).toEqual([expect.closeTo(Math.exp(MAX_ZOOM_LOG_DELTA_PER_FRAME), 12)]);
  });

  it("asks nothing of the target when nothing moves or the points are the same, and shows no anchor at rest", () => {
    const target = anchoredTarget();
    const { controller } = glideOf(target);
    const pivot = anchorOf(1, "orbit", P1);

    controller.rebaseTo({ orbit: pivot, zoom: null });
    expect(controller.anchors()).toEqual({ orbit: null, zoom: null });

    controller.orbitBy(2, 0, pivot);
    const again = anchorOf(2, "orbit", { ...P1 });
    controller.rebaseTo({ orbit: again, zoom: null });
    expect(target.rebaseMotion).not.toHaveBeenCalled();
    expect(controller.motion().orbit).toEqual({ pitch: 2, heading: 0, anchor: again });
  });
});

describe("createGlobeInertia: anchors", () => {
  function globe() {
    const camera = { ...anchoredTarget(), endAnchorPan: vi.fn() };
    let current = true;
    const anchors = {
      acquire: vi.fn<(request: AnchorRequest<HTMLCanvasElement>) => AnchorAcquisition>(() => ({})),
      hold: vi.fn<(acquisition: AnchorAcquisition) => void>(),
      release: vi.fn<(acquisition: AnchorAcquisition) => void>(),
      isCurrent: vi.fn<(anchor: NavigationAnchor) => boolean>(() => current),
    };
    const requestRender = vi.fn();
    const inertia: InertialCameraController<HTMLCanvasElement> = createGlobeInertia(camera as unknown as CameraController, {
      nowMs: () => 0, decayPerFrame: () => 0.5, renderer: { requestRender }, anchors,
    });
    return { camera, anchors, inertia, requestRender, retire: () => { current = false; } };
  }

  it("moves about the orbit target for an anchor retired before its step, as when navigation was leased", () => {
    const { camera, inertia, retire } = globe();
    const pivot = anchorOf(1, "orbit", P1);

    inertia.orbitBy(2, 0, pivot);
    inertia.update(1000);
    expect(camera.orbitBy).toHaveBeenLastCalledWith(2, 0, pivot);

    retire();
    inertia.cancel();
    inertia.orbitBy(1, 0, pivot);
    inertia.zoomBy(0.9, anchorOf(1, "zoom", P2));
    inertia.update(2000);
    expect(camera.orbitBy.mock.lastCall).toEqual([1, 0]);
    expect(camera.zoomBy.mock.lastCall).toEqual([expect.closeTo(0.9, 12)]);
    expect(inertia.anchors()).toEqual({ orbit: null, zoom: null });
  });

  it("acquires, holds and releases through the anchor service, and wakes the renderer for a rebase", () => {
    const { anchors, inertia, requestRender } = globe();
    const request: AnchorRequest<HTMLCanvasElement> = { family: "mouse", operations: ["orbit"], client: { x: 1, y: 2 }, candidate: true };

    const acquired = inertia.acquireAnchors?.(request);
    expect(anchors.acquire).toHaveBeenCalledWith(request);
    inertia.holdAnchors?.(acquired!);
    expect(anchors.hold).toHaveBeenCalledWith(acquired);
    inertia.releaseAnchors?.(acquired!);
    expect(anchors.release).toHaveBeenCalledWith(acquired);

    requestRender.mockClear();
    inertia.rebaseTo({ orbit: null, zoom: null });
    expect(requestRender).toHaveBeenCalledOnce();
  });
});
