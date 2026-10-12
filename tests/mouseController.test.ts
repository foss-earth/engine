// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { attachMouseController, type PointSelection } from "../src/browser/mouseController.js";
import type { AnchorAcquisition, AnchorFamily, AnchorOperation, AnchorRequest, NavigationAnchor } from "../src/input/navigationAnchors.js";

function anchorOf(session: number, family: AnchorFamily, operation: AnchorOperation): NavigationAnchor {
  return { session, owner: "globe", family, operation, requested: "pointer", source: "surface", point: { x: session, y: 0, z: 0 }, surfaceRevision: null, fallback: null };
}

/** A camera whose every acquisition is a new session, so each pick can be told apart. */
function anchoredCamera() {
  let session = 0;
  const acquireAnchors = vi.fn((request: AnchorRequest<HTMLCanvasElement>): AnchorAcquisition => {
    session += 1;
    const acquired: { zoom?: NavigationAnchor; orbit?: NavigationAnchor } = {};
    for (const operation of request.operations) acquired[operation] = anchorOf(session, request.family, operation);
    return acquired;
  });
  return {
    panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn(), cancel: vi.fn(), cancelInertial: vi.fn(),
    acquireAnchors, holdAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(), releaseAnchors: vi.fn<(acquisition: AnchorAcquisition) => void>(),
  };
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientHeight", { value: 800 });
  // jsdom has no pointer capture.
  Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
  document.body.append(canvas);
  return canvas;
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true, ...init });
}

function at(event: Event, timeStamp: number): Event {
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
}

function selection(hits: boolean[] = [true]): PointSelection & { pickAt: Mock<PointSelection["pickAt"]> } {
  let armed = true;
  const pickAt = vi.fn<PointSelection["pickAt"]>(() => {
    const hit = hits.shift() ?? true;
    if (hit) armed = false;
    return hit;
  });
  return { armed: () => armed, pickAt };
}

afterEach(() => { document.body.replaceChildren(); });

describe("attachMouseController: orbit pivot", () => {
  it("picks the pivot where a right press goes down, as a candidate, and holds it once the press is a drag", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const detach = attachMouseController(canvas, camera);

    canvas.dispatchEvent(pointer("pointerdown", 120, 80, { button: 2 }));
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "mouse", operations: ["orbit"], client: { x: 120, y: 80 }, canvas, candidate: true });
    const acquired = camera.acquireAnchors.mock.results[0].value as AnchorAcquisition;
    expect(camera.holdAnchors).not.toHaveBeenCalled();

    // Under the threshold the press is still a click.
    canvas.dispatchEvent(pointer("pointermove", 122, 80, { button: 2 }));
    expect(camera.holdAnchors).not.toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    canvas.dispatchEvent(pointer("pointermove", 140, 90, { button: 2 }));
    expect(camera.holdAnchors).toHaveBeenCalledTimes(1);
    expect(camera.holdAnchors).toHaveBeenCalledWith(acquired);
    expect(camera.orbitBy).toHaveBeenLastCalledWith(expect.closeTo(0.3, 9), expect.closeTo(0.6, 9), acquired.orbit);

    // Moving the mouse turns about the same pivot: no new pick, no second hold.
    canvas.dispatchEvent(pointer("pointermove", 400, 300, { button: 2 }));
    expect(camera.orbitBy).toHaveBeenCalledTimes(2);
    expect(camera.orbitBy).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), acquired.orbit);
    expect(camera.acquireAnchors).toHaveBeenCalledTimes(1);
    expect(camera.holdAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).not.toHaveBeenCalled();

    canvas.dispatchEvent(pointer("pointerup", 400, 300, { button: 2 }));
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(acquired);
    detach();
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
  });

  it("lets go of a press that never became a drag without holding it", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const detach = attachMouseController(canvas, camera);

    canvas.dispatchEvent(pointer("pointerdown", 50, 50, { button: 2 }));
    canvas.dispatchEvent(pointer("pointermove", 52, 51, { button: 2 }));
    canvas.dispatchEvent(pointer("pointerup", 52, 51, { button: 2 }));

    expect(camera.holdAnchors).not.toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(camera.acquireAnchors.mock.results[0].value);
    detach();
  });

  it("picks a fresh pivot for each press", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const detach = attachMouseController(canvas, camera);

    canvas.dispatchEvent(pointer("pointerdown", 10, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointermove", 30, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointerup", 30, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointerdown", 200, 220, { button: 2 }));
    canvas.dispatchEvent(pointer("pointermove", 220, 220, { button: 2 }));

    expect(camera.acquireAnchors).toHaveBeenCalledTimes(2);
    expect(camera.acquireAnchors.mock.calls[1][0].client).toEqual({ x: 200, y: 220 });
    const second = camera.acquireAnchors.mock.results[1].value as AnchorAcquisition;
    expect(second.orbit?.session).toBe(2);
    expect(camera.orbitBy).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), second.orbit);
    detach();
    expect(camera.releaseAnchors).toHaveBeenLastCalledWith(second);
  });

  it("picks no pivot for a left pan drag, but does for a left drag in orbit mode", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    let orbitMode = false;
    const detach = attachMouseController(canvas, camera, { isOrbitMode: () => orbitMode });

    canvas.dispatchEvent(pointer("pointerdown", 10, 10));
    canvas.dispatchEvent(pointer("pointermove", 30, 10));
    canvas.dispatchEvent(pointer("pointerup", 30, 10));
    expect(camera.panBy).toHaveBeenCalled();
    expect(camera.acquireAnchors).not.toHaveBeenCalled();

    orbitMode = true;
    canvas.dispatchEvent(pointer("pointerdown", 40, 40));
    expect(camera.acquireAnchors).toHaveBeenCalledWith(expect.objectContaining({ family: "mouse", operations: ["orbit"], client: { x: 40, y: 40 }, candidate: true }));
    canvas.dispatchEvent(pointer("pointermove", 60, 40));
    const acquired = camera.acquireAnchors.mock.results[0].value as AnchorAcquisition;
    expect(camera.holdAnchors).toHaveBeenCalledWith(acquired);
    expect(camera.orbitBy).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), acquired.orbit);
    canvas.dispatchEvent(pointer("pointerup", 60, 40));
    expect(camera.releaseAnchors).toHaveBeenCalledWith(acquired);
    detach();
  });

  it("orbits about the orbit target, as before anchors, with a camera that picks nothing", () => {
    const canvas = createCanvas();
    const camera = { panBy: vi.fn(), orbitBy: vi.fn(), zoomBy: vi.fn() };
    const detach = attachMouseController(canvas, camera);

    canvas.dispatchEvent(pointer("pointerdown", 10, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointermove", 30, 10, { button: 2 }));
    expect(camera.orbitBy).toHaveBeenCalledTimes(1);
    expect(camera.orbitBy.mock.calls[0]).toHaveLength(2);
    canvas.dispatchEvent(pointer("pointerup", 30, 10, { button: 2 }));
    detach();
  });

  it("goes on with a held press handed back as a drag from where the pointer is, about a pivot picked there", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const detach = attachMouseController(canvas, camera, { heldPress: { pointerId: 7, button: 2, clientX: 300, clientY: 200 } });

    expect(camera.acquireAnchors).toHaveBeenCalledWith({ family: "mouse", operations: ["orbit"], client: { x: 300, y: 200 }, canvas, candidate: true });
    const acquired = camera.acquireAnchors.mock.results[0].value as AnchorAcquisition;
    // No new pointer-down: the next move continues the press.
    canvas.dispatchEvent(pointer("pointermove", 320, 200, { pointerId: 7, button: 2 }));
    expect(camera.holdAnchors).toHaveBeenCalledWith(acquired);
    expect(camera.orbitBy).toHaveBeenCalledWith(expect.closeTo(0, 9), expect.closeTo(0.6, 9), acquired.orbit);
    canvas.dispatchEvent(pointer("pointerup", 320, 200, { pointerId: 7, button: 2 }));
    expect(camera.releaseAnchors).toHaveBeenCalledWith(acquired);
    detach();
  });

  it("goes on panning with a held primary press handed back", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const detach = attachMouseController(canvas, camera, { heldPress: { pointerId: 3, button: 0, clientX: 100, clientY: 100 } });

    canvas.dispatchEvent(pointer("pointermove", 110, 100, { pointerId: 3 }));
    expect(camera.panBy).toHaveBeenCalledTimes(1);
    expect(camera.acquireAnchors).not.toHaveBeenCalled();
    detach();
  });

  it("ends the press when capture is lost without a release: its pivot is let go, and later moves do nothing", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const detach = attachMouseController(canvas, camera);

    canvas.dispatchEvent(pointer("pointerdown", 10, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointermove", 30, 10, { button: 2 }));
    const acquired = camera.acquireAnchors.mock.results[0].value as AnchorAcquisition;
    // Another pointer's loss is not this press's.
    canvas.dispatchEvent(pointer("lostpointercapture", 30, 10, { pointerId: 2 }));
    expect(camera.releaseAnchors).not.toHaveBeenCalled();

    canvas.dispatchEvent(pointer("lostpointercapture", 30, 10));
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    expect(camera.releaseAnchors).toHaveBeenCalledWith(acquired);
    camera.orbitBy.mockClear();
    canvas.dispatchEvent(pointer("pointermove", 80, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointerup", 80, 10, { button: 2 }));
    expect(camera.orbitBy).not.toHaveBeenCalled();
    expect(camera.releaseAnchors).toHaveBeenCalledTimes(1);
    detach();
  });

  it("lets go of an uncommitted candidate when the press is cancelled", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const detach = attachMouseController(canvas, camera);

    canvas.dispatchEvent(pointer("pointerdown", 10, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointercancel", 10, 10, { button: 2 }));
    expect(camera.holdAnchors).not.toHaveBeenCalled();
    expect(camera.releaseAnchors).toHaveBeenCalledWith(camera.acquireAnchors.mock.results[0].value);
    detach();
  });
});

describe("attachMouseController: Pick point", () => {
  it("picks the point a primary click lands on, and nothing else sees the press, its click or its double click", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });
    const later = vi.fn();
    for (const type of ["pointerdown", "pointerup", "click", "dblclick"]) canvas.addEventListener(type, later);

    canvas.dispatchEvent(at(pointer("pointerdown", 150, 160), 1_000));
    canvas.dispatchEvent(at(pointer("pointermove", 151, 161), 1_010));
    canvas.dispatchEvent(at(pointer("pointerup", 151, 161), 1_050));
    expect(pick.pickAt).toHaveBeenCalledTimes(1);
    expect(pick.pickAt).toHaveBeenCalledWith({ x: 151, y: 161 });

    const click = at(new MouseEvent("click", { bubbles: true, cancelable: true }), 1_060);
    canvas.dispatchEvent(click);
    const dblclick = at(new MouseEvent("dblclick", { bubbles: true, cancelable: true }), 1_200);
    canvas.dispatchEvent(dblclick);
    expect(click.defaultPrevented).toBe(true);
    expect(dblclick.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(camera.panBy).not.toHaveBeenCalled();
    expect(camera.zoomBy).not.toHaveBeenCalled();
    expect(camera.orbitBy).not.toHaveBeenCalled();

    // Disarmed now: the next click is an ordinary one.
    canvas.dispatchEvent(at(pointer("pointerdown", 150, 160), 3_000));
    canvas.dispatchEvent(at(pointer("pointerup", 150, 160), 3_050));
    canvas.dispatchEvent(at(new MouseEvent("click", { bubbles: true, cancelable: true }), 3_060));
    expect(pick.pickAt).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(3);
    detach();
  });

  it("stays armed after a miss, and picks with the next click", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection([false, true]);
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });

    canvas.dispatchEvent(pointer("pointerdown", 10, 20));
    canvas.dispatchEvent(pointer("pointerup", 10, 20));
    expect(pick.pickAt).toHaveBeenLastCalledWith({ x: 10, y: 20 });
    expect(pick.armed()).toBe(true);

    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    canvas.dispatchEvent(pointer("pointerup", 0, 0));
    expect(pick.pickAt).toHaveBeenCalledTimes(2);
    expect(pick.pickAt).toHaveBeenLastCalledWith({ x: 0, y: 0 });
    expect(pick.armed()).toBe(false);
    expect(camera.panBy).not.toHaveBeenCalled();
    detach();
  });

  it("goes on navigating with a press dragged past the threshold, and stays armed", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });

    canvas.dispatchEvent(pointer("pointerdown", 100, 100));
    canvas.dispatchEvent(pointer("pointermove", 130, 100));
    canvas.dispatchEvent(pointer("pointerup", 130, 100));
    expect(camera.panBy).toHaveBeenCalledTimes(1);
    expect(pick.pickAt).not.toHaveBeenCalled();
    expect(pick.armed()).toBe(true);

    // A drag that comes back to where it began is still no click.
    canvas.dispatchEvent(pointer("pointerdown", 100, 100));
    canvas.dispatchEvent(pointer("pointermove", 130, 100));
    canvas.dispatchEvent(pointer("pointermove", 100, 100));
    canvas.dispatchEvent(pointer("pointerup", 100, 100));
    expect(pick.pickAt).not.toHaveBeenCalled();
    detach();
  });

  it("leaves a right press to orbit while armed", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });
    const later = vi.fn();
    canvas.addEventListener("pointerdown", later);

    canvas.dispatchEvent(pointer("pointerdown", 10, 10, { button: 2 }));
    expect(later).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(pointer("pointermove", 30, 10, { button: 2 }));
    canvas.dispatchEvent(pointer("pointerup", 30, 10, { button: 2 }));
    expect(camera.orbitBy).toHaveBeenCalled();
    expect(pick.pickAt).not.toHaveBeenCalled();
    detach();
  });

  it("picks with a tap, and keeps the mouse events a browser makes up after it", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });

    const down = pointer("pointerdown", 40, 50, { pointerType: "touch", pointerId: 9 });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    canvas.dispatchEvent(pointer("pointerup", 40, 50, { pointerType: "touch", pointerId: 9 }));
    expect(pick.pickAt).toHaveBeenCalledWith({ x: 40, y: 50 });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    detach();
  });

  it("picks nothing when a second contact lands during the press", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });

    canvas.dispatchEvent(pointer("pointerdown", 40, 50, { pointerType: "touch", pointerId: 9 }));
    canvas.dispatchEvent(pointer("pointerdown", 140, 50, { pointerType: "touch", pointerId: 10, isPrimary: false }));
    canvas.dispatchEvent(pointer("pointerup", 140, 50, { pointerType: "touch", pointerId: 10, isPrimary: false }));
    canvas.dispatchEvent(pointer("pointerup", 40, 50, { pointerType: "touch", pointerId: 9 }));
    expect(pick.pickAt).not.toHaveBeenCalled();
    expect(pick.armed()).toBe(true);
    detach();
  });

  it("does not pick when the press is cancelled", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });

    canvas.dispatchEvent(pointer("pointerdown", 40, 50));
    canvas.dispatchEvent(pointer("pointercancel", 40, 50));
    expect(pick.pickAt).not.toHaveBeenCalled();
    expect(pick.armed()).toBe(true);
    detach();
  });

  it("does not suppress a double click long after the consumed click", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });
    const later = vi.fn();
    canvas.addEventListener("dblclick", later);

    canvas.dispatchEvent(at(pointer("pointerdown", 10, 10), 1_000));
    canvas.dispatchEvent(at(pointer("pointerup", 10, 10), 1_050));
    canvas.dispatchEvent(at(new MouseEvent("dblclick", { bubbles: true, cancelable: true }), 1_050 + 801));
    expect(later).toHaveBeenCalledTimes(1);
    detach();
  });

  // Spec ("Pointer cancel, lost capture or device loss": clear uncommitted
  // candidates): the next mouse press, same pointerId 1, is not measured from
  // the lost one's position.
  it("forgets a pick press whose capture was lost, so the next click picks", () => {
    const canvas = createCanvas();
    const camera = anchoredCamera();
    const pick = selection();
    const detach = attachMouseController(canvas, camera, { pointSelection: pick });

    canvas.dispatchEvent(pointer("pointerdown", 10, 10));
    canvas.dispatchEvent(pointer("lostpointercapture", 10, 10));
    // The release happened off the canvas; the next press is elsewhere.
    canvas.dispatchEvent(pointer("pointerdown", 300, 300));
    canvas.dispatchEvent(pointer("pointerup", 300, 300));
    expect(pick.pickAt).toHaveBeenCalledWith({ x: 300, y: 300 });
    detach();
  });
});
