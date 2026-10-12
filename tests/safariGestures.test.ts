// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createInertialCameraController } from "../src/input/inertialCameraController.js";
import { DEFAULT_INPUT_RATES, DEFAULT_INPUT_SETTINGS } from "../src/input/inputSettings.js";
import { attachSafariGestures } from "../src/browser/safariGestures.js";
import type { AnchorAcquisition, AnchorFamily, AnchorOperation, AnchorRequest, NavigationAnchor } from "../src/input/navigationAnchors.js";

/** A Safari GestureEvent; `client` is where Safari says it is, which a synthetic one may leave out. */
function gesture(type: string, rotation: number, scale: number, client?: { clientX: number; clientY: number }): Event {
  return Object.assign(new Event(type, { cancelable: true }), { rotation, scale }, client);
}

describe("attachSafariGestures", () => {
  it("turns a rotate by input.trackpad.rotateRate, and zooms a pinch by input.trackpad.gestureZoomExponent", () => {
    const canvas = document.createElement("canvas");
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    let settings = { ...DEFAULT_INPUT_SETTINGS, rates: { ...DEFAULT_INPUT_RATES } };
    const detach = attachSafariGestures(canvas, camera, { getSettings: () => settings });

    canvas.dispatchEvent(gesture("gesturestart", 0, 1));
    canvas.dispatchEvent(gesture("gesturechange", 10, 1));
    // The shared base these rates had before: a tenth of a degree per degree.
    expect(camera.orbitBy).toHaveBeenLastCalledWith(0, expect.closeTo(-1, 12));
    settings = { ...settings, rates: { ...settings.rates, trackpadRotateRate: 0.5 } };
    canvas.dispatchEvent(gesture("gesturechange", 20, 1));
    expect(camera.orbitBy).toHaveBeenLastCalledWith(0, expect.closeTo(-5, 12));

    canvas.dispatchEvent(gesture("gesturechange", 20, 1.2));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.closeTo(0.9 ** 0.1, 12));
    settings = { ...settings, rates: { ...settings.rates, trackpadGestureZoomExponent: 1 } };
    canvas.dispatchEvent(gesture("gesturechange", 20, 1.44));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.closeTo(0.9, 12));

    detach();
  });
});

function anchorOf(session: number, family: AnchorFamily, operation: AnchorOperation): NavigationAnchor {
  return { session, owner: "globe", family, operation, requested: "pointer", source: "surface", point: { x: session, y: 0, z: 0 }, surfaceRevision: null, fallback: null };
}

/** A camera whose every acquisition is a new session, so each gesture's pick can be told apart. */
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
    panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(), acquireAnchors, acquisition,
    holdAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(), releaseAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(),
  };
}

function pointer(type: string, x: number, y: number, pointerType = "mouse"): PointerEvent {
  return new PointerEvent(type, { pointerId: 1, pointerType, isPrimary: true, clientX: x, clientY: y, bubbles: true });
}

describe("attachSafariGestures: zoom anchor and orbit pivot", () => {
  it("picks both where the gesture starts, held, turns and zooms about them, and lets go when it ends", () => {
    const canvas = document.createElement("canvas");
    const camera = anchoredCamera();
    const detach = attachSafariGestures(canvas, camera);

    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 120, clientY: 80 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    // Native gestures read the trackpad's choices, and hold what they pick until they end: there is no candidate stage.
    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "trackpad", operations: ["zoom", "orbit"], client: { x: 120, y: 80 }, canvas, hold: true });
    const acquired = camera.acquisition(0);

    // Scale and rotation together: each once, each about its own anchor.
    canvas.dispatchEvent(gesture("gesturechange", 10, 1.2, { clientX: 300, clientY: 200 }));
    expect(camera.orbitBy).toHaveBeenCalledTimes(1);
    expect(camera.orbitBy).toHaveBeenLastCalledWith(0, expect.any(Number), acquired.orbit);
    expect(camera.zoomBy).toHaveBeenCalledTimes(1);
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), acquired.zoom);
    canvas.dispatchEvent(gesture("gesturechange", 20, 1.5));
    for (const [, , pivot] of camera.orbitBy.mock.calls) expect(pivot).toBe(acquired.orbit);
    for (const [, anchor] of camera.zoomBy.mock.calls) expect(anchor).toBe(acquired.zoom);
    // Moving fingers pick nowhere new.
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.holdAnchors).not.toHaveBeenCalled();
    expect(camera.releaseAnchors).not.toHaveBeenCalled();

    canvas.dispatchEvent(gesture("gestureend", 20, 1.5));
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(acquired);

    // A stray change after the end moves about the orbit target, not the anchor let go of.
    canvas.dispatchEvent(gesture("gesturechange", 30, 1.5));
    expect(camera.orbitBy.mock.lastCall).toEqual([0, expect.any(Number)]);
    detach();
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
  });

  it("picks afresh for each gesture, and lets go of one whose end never came before picking the next", () => {
    const canvas = document.createElement("canvas");
    const camera = anchoredCamera();
    const detach = attachSafariGestures(canvas, camera);

    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(gesture("gestureend", 0, 1, { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 200, clientY: 220 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(2);
    expect(camera.acquireAnchors.mock.calls[1][0].client).toEqual({ x: 200, y: 220 });
    canvas.dispatchEvent(gesture("gesturechange", 0, 1.2));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), camera.acquisition(1).zoom);

    // No gestureend: the next start lets go of the one before, then picks.
    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 50, clientY: 60 }));
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(2);
    expect(camera.releaseAnchors).toHaveBeenLastCalledWith(camera.acquisition(1));
    expect(camera.releaseAnchors.mock.invocationCallOrder[1]).toBeLessThan(camera.acquireAnchors.mock.invocationCallOrder[2]);
    canvas.dispatchEvent(gesture("gesturechange", 0, 1.2));
    expect(camera.zoomBy).toHaveBeenLastCalledWith(expect.any(Number), camera.acquisition(2).zoom);
    detach();
  });

  it("lets go of a gesture under way when detached, and of nothing more", () => {
    const canvas = document.createElement("canvas");
    const camera = anchoredCamera();
    const detach = attachSafariGestures(canvas, camera);

    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 10, clientY: 10 }));
    detach();
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(camera.acquisition(0));

    // Detached: nothing listens.
    canvas.dispatchEvent(gesture("gestureend", 0, 1));
    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 20, clientY: 20 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
  });

  it("takes a zero coordinate as given, and without a usable one the mouse's last place over the canvas", () => {
    const canvas = document.createElement("canvas");
    const camera = anchoredCamera();
    const detach = attachSafariGestures(canvas, camera);
    const startAt = (client?: { clientX: number; clientY: number }) => {
      canvas.dispatchEvent(gesture("gesturestart", 0, 1, client));
      return camera.acquireAnchors.mock.lastCall?.[0].client;
    };

    // No position anywhere: said, not guessed.
    expect(startAt()).toBeNull();
    expect(startAt({ clientX: 0, clientY: 0 })).toEqual({ x: 0, y: 0 });

    canvas.dispatchEvent(pointer("pointermove", 140, 90));
    expect(startAt()).toEqual({ x: 140, y: 90 });
    expect(startAt({ clientX: Number.NaN, clientY: 5 })).toEqual({ x: 140, y: 90 });
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    expect(startAt()).toEqual({ x: 0, y: 0 });
    // A pen or finger is not where a trackpad gesture is.
    canvas.dispatchEvent(pointer("pointermove", 300, 300, "touch"));
    canvas.dispatchEvent(pointer("pointermove", 310, 310, "pen"));
    expect(startAt()).toEqual({ x: 0, y: 0 });
    // The gesture's own position wins.
    expect(startAt({ clientX: 7, clientY: 8 })).toEqual({ x: 7, y: 8 });
    detach();
  });

  it("uses no pointer seen by an earlier attachment", () => {
    const canvas = document.createElement("canvas");
    const camera = anchoredCamera();
    const first = attachSafariGestures(canvas, camera);
    canvas.dispatchEvent(pointer("pointermove", 140, 90));
    first();
    canvas.dispatchEvent(pointer("pointermove", 150, 95));

    const detach = attachSafariGestures(canvas, camera);
    canvas.dispatchEvent(gesture("gesturestart", 0, 1));
    expect(camera.acquireAnchors).toHaveBeenLastCalledWith(expect.objectContaining({ client: null }));
    detach();
  });

  it("turns and zooms about the orbit target, as before anchors, with a camera that picks nothing", () => {
    const canvas = document.createElement("canvas");
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    const detach = attachSafariGestures(canvas, camera);

    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(gesture("gesturechange", 10, 1.2));
    canvas.dispatchEvent(gesture("gestureend", 10, 1.2));

    expect(camera.orbitBy.mock.lastCall).toEqual([0, expect.any(Number)]);
    expect(camera.zoomBy.mock.lastCall).toEqual([expect.any(Number)]);
    detach();
  });

  it("glides on about the gesture's shared point after it ends, in one step for the turn and the zoom", () => {
    const canvas = document.createElement("canvas");
    const shared = { x: 1, y: 2, z: 3 };
    const acquired: AnchorAcquisition = {
      zoom: { ...anchorOf(1, "trackpad", "zoom"), point: shared },
      orbit: { ...anchorOf(1, "trackpad", "orbit"), point: { ...shared } },
    };
    const target = {
      panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(), orbitZoomBy: vi.fn(),
      acquireAnchors: vi.fn<(request: AnchorRequest<HTMLCanvasElement>) => AnchorAcquisition>(() => acquired),
      releaseAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(),
    };
    const glide = createInertialCameraController(target, { nowMs: () => 0, decayPerFrame: () => 0.5 });
    const detach = attachSafariGestures(canvas, glide);

    canvas.dispatchEvent(gesture("gesturestart", 0, 1, { clientX: 120, clientY: 80 }));
    canvas.dispatchEvent(gesture("gesturechange", 10, 1.2));
    canvas.dispatchEvent(gesture("gestureend", 10, 1.2));
    expect(target.releaseAnchors).toHaveBeenCalledWith(acquired);
    expect(glide.anchors()).toEqual({ orbit: acquired.orbit, zoom: acquired.zoom });

    glide.update(1000);
    glide.update(1000 + 1000 / 60);
    expect(target.orbitZoomBy).toHaveBeenCalledTimes(2);
    expect(target.orbitZoomBy).toHaveBeenLastCalledWith(0, expect.any(Number), expect.any(Number), acquired.orbit);
    expect(target.orbitBy).not.toHaveBeenCalled();
    expect(target.zoomBy).not.toHaveBeenCalled();
    detach();
  });
});
