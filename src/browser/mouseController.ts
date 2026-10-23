import { orbitWith, type CameraInputTarget } from "../input/inertialCameraController.js";
import type { AnchorAcquisition } from "../input/navigationAnchors.js";
import type { AnchorPanDebugOverlay } from "./anchorPanDebugOverlay.js";
import { DEFAULT_INPUT_RATES, type InputSettings } from "../input/inputSettings.js";
import { worldViewportHeight } from "./worldViewport.js";

/** A mouse press already held when the handler attaches, and where the pointer is. */
export interface HeldPress {
  pointerId: number;
  button: number;
  metaKey?: boolean;
  clientX: number;
  clientY: number;
}

/**
 * Pick point, as the pointer sees it: while it is armed, a primary click or
 * tap on the globe picks a point, and nothing else sees that press.
 */
export interface PointSelection {
  armed(): boolean;
  /** Picks the point under a client position. False when no surface is there: it stays armed. */
  pickAt(client: { readonly x: number; readonly y: number }): boolean;
}

/** How long after a consumed click its double click is still the selection's, ms. */
const SELECTION_DOUBLE_CLICK_MS = 800;

/**
 * Attach a mouse-button drag handler to the canvas.
 *
 * - Left-button drag  → pan
 * - Right-button or Cmd-left drag → orbit (heading + pitch)
 *
 * On pointerdown the event is NOT consumed so that Babylon's picking
 * system can still detect clicks on scene objects.  Once the pointer
 * travels more than `input.mouse.dragThreshold` the interaction is committed
 * as a drag: subsequent pointermove / pointerup events are captured and
 * stopImmediatePropagation is called so Babylon's own camera input does
 * not also fire.
 *
 * The context-menu is suppressed to prevent the right-click menu from
 * interrupting orbit. A `heldPress`, such as one that took the camera over
 * from a lease's owner, goes on as if pressed where the pointer is now.
 *
 * An orbit drag turns about the compass target, resolved where the button
 * went down and used once the press becomes a drag. While Pick point is
 * armed (`pointSelection`), a primary press of
 * any pointer is kept from everything else from pointer-down on: released
 * as a click or tap, it picks the point and its clicks go nowhere; dragged,
 * it goes on navigating, and Pick point stays armed.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachMouseController(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget<HTMLCanvasElement>,
  options: { isOrbitMode?: () => boolean; getSettings?: () => InputSettings; heldPress?: HeldPress | null; attachAnchorPanDebugOverlay?: (canvas: HTMLCanvasElement) => AnchorPanDebugOverlay; pointSelection?: PointSelection | null } = {},
): () => void {
  // Below the drag threshold a press is a click, and events pass through to
  // Babylon so picking and sphere-click handlers still fire.
  const rates = () => options.getSettings?.().rates ?? DEFAULT_INPUT_RATES;
  let activeButton: 0 | 2 | null = null;
  let commandOrbit = false;
  let isDragging = false;
  let anchorPanActive = false;
  let startX = 0;
  let startY = 0;
  let prevX = 0;
  let prevY = 0;
  let anchorDownClientX = 0;
  let anchorDownClientY = 0;
  let pressPointerId: number | null = null;
  // Where an orbit drag from this press turns: picked at the press, held once it is a drag.
  let orbitAnchors: AnchorAcquisition | null = null;
  let orbitAnchorsHeld = false;
  // A press Pick point keeps from everything else, and whether it is still a click.
  let selectionPress: { pointerId: number; x: number; y: number; click: boolean } | null = null;
  // The clicks a consumed selection press makes.
  let selectionClickPending = false;
  let selectionDoubleClickUntil = Number.NEGATIVE_INFINITY;
  const anchorPanDebugOverlay: AnchorPanDebugOverlay = options.attachAnchorPanDebugOverlay?.(canvas) ?? { update() {}, hide() {}, destroy() {} };

  function stopInertial(): void {
    if (camera.cancelInertial) {
      camera.cancelInertial();
    } else {
      camera.cancel?.();
    }
  }

  function shouldUseAnchorPan(button: number): boolean {
    return button === 0
      && !(options.isOrbitMode?.() ?? false)
      && (options.getSettings?.().globeAnchorRotation ?? false);
  }

  function updateAnchorPanDebug(clientX: number, clientY: number): void {
    if (!anchorPanActive) {
      anchorPanDebugOverlay.hide();
      return;
    }
    const error = camera.getAnchorPanScreenError?.({
      clientX,
      clientY,
      canvas,
    });
    const anchorX = error?.anchorClientX ?? anchorDownClientX;
    const anchorY = error?.anchorClientY ?? anchorDownClientY;
    anchorPanDebugOverlay.update(anchorX, anchorY, clientX, clientY);
  }

  function releaseOrbitAnchors(): void {
    if (orbitAnchors) camera.releaseAnchors?.(orbitAnchors);
    orbitAnchors = null;
    orbitAnchorsHeld = false;
  }

  /** A press that becomes a drag, or a second contact, is no click: it navigates, and Pick point stays armed. */
  function updateSelectionPress(e: PointerEvent): void {
    if (!selectionPress) return;
    if (e.pointerId !== selectionPress.pointerId) {
      if (e.type === "pointerdown") selectionPress.click = false;
      return;
    }
    if (Math.hypot(e.clientX - selectionPress.x, e.clientY - selectionPress.y) >= rates().mouseDragThresholdPx) selectionPress.click = false;
  }

  /** The release of a press Pick point kept: a click picks the point, and its clicks are the selection's too. */
  function endSelectionPress(e: PointerEvent): void {
    if (!selectionPress || e.pointerId !== selectionPress.pointerId) return;
    const press = selectionPress;
    selectionPress = null;
    e.stopImmediatePropagation();
    updateSelectionPress(e);
    if (e.type === "pointerup" && press.click && options.pointSelection?.armed()) {
      options.pointSelection.pickAt({ x: e.clientX, y: e.clientY });
    }
    selectionClickPending = true;
    selectionDoubleClickUntil = e.timeStamp + SELECTION_DOUBLE_CLICK_MS;
  }

  function onPointerDown(e: PointerEvent): void {
    // The click a consumed press would make comes before any later press.
    selectionClickPending = false;
    if (selectionPress) updateSelectionPress(e);
    else if (options.pointSelection?.armed() && e.isPrimary && (e.pointerType !== "mouse" || e.button === 0)) {
      // From pointer-down on, nothing else sees a press that may pick a point:
      // no point of interest, scene or double click acts on it.
      selectionPress = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, click: true };
      e.stopImmediatePropagation();
      // A tap's mouse events, which a browser makes up after it, are kept too.
      if (e.pointerType !== "mouse") e.preventDefault();
    }
    if (e.pointerType !== "mouse") return;
    // Do NOT stop propagation here — let Babylon's picking system see the event.
    beginPress(e);
  }

  function beginPress(e: HeldPress): void {
    if (e.button !== 0 && e.button !== 2) return;
    releaseOrbitAnchors();
    commandOrbit = e.button === 0 && !!e.metaKey;
    activeButton = commandOrbit ? 2 : e.button as 0 | 2;
    pressPointerId = e.pointerId;
    isDragging = false;
    anchorPanActive = false;
    startX = prevX = e.clientX;
    startY = prevY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a held press's pointer may be gone */ }
    // An orbit drag's anchor is resolved now, as the camera is.
    if (activeButton === 2 || (options.isOrbitMode?.() ?? false)) {
      orbitAnchors = camera.acquireAnchors?.({ family: "mouse", operations: ["orbit"], client: { x: e.clientX, y: e.clientY }, canvas, candidate: true }) ?? null;
    }

    if (shouldUseAnchorPan(activeButton) && camera.beginAnchorPan) {
      anchorPanActive = camera.beginAnchorPan({
        clientX: e.clientX,
        clientY: e.clientY,
        canvas,
      });
      if (anchorPanActive) {
        anchorDownClientX = e.clientX;
        anchorDownClientY = e.clientY;
        updateAnchorPanDebug(e.clientX, e.clientY);
      }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    updateSelectionPress(e);
    if (e.pointerType !== "mouse" || activeButton === null) return;

    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    const distFromStart = Math.hypot(e.clientX - startX, e.clientY - startY);

    if (anchorPanActive && activeButton === 0 && !(options.isOrbitMode?.() ?? false)) {
      if (distFromStart >= rates().mouseDragThresholdPx) {
        if (!isDragging) {
          isDragging = true;
          stopInertial();
        }
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      if (dx !== 0 || dy !== 0) {
        const sensitivity = options.getSettings?.().sensitivity.mouse.pan ?? 1;
        camera.panAnchorTo?.({
          clientX: e.clientX,
          clientY: e.clientY,
          canvas,
        }, sensitivity);
      }
      updateAnchorPanDebug(e.clientX, e.clientY);
      prevX = e.clientX;
      prevY = e.clientY;
      return;
    }

    if (!isDragging) {
      const dist = distFromStart;
      if (dist < rates().mouseDragThresholdPx) return;
      isDragging = true;
      stopInertial();
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    prevX = e.clientX;
    prevY = e.clientY;

    if (activeButton === 0 && !(options.isOrbitMode?.() ?? false)) {
      const sensitivity = options.getSettings?.().sensitivity.mouse.pan ?? 1;
      const rate = rates().mousePanRate * sensitivity;
      camera.panBy(-dx * rate, -dy * rate, worldViewportHeight(canvas));
      // A click-drag is not a swipe: the trackpad will not keep sending it.
      camera.armReleaseMomentum?.("pan");
    } else {
      // The press is a drag now: its anchor is in use.
      if (orbitAnchors && !orbitAnchorsHeld) {
        orbitAnchorsHeld = true;
        camera.holdAnchors?.(orbitAnchors);
      }
      const sensitivity = (options.getSettings?.().sensitivity.mouse.orbit ?? 1) * (commandOrbit ? rates().commandOrbitSensitivity : 1);
      const pitchSign = options.isOrbitMode?.() ? -1 : 1;
      orbitWith(
        camera,
        pitchSign * dy * rates().mouseOrbitDegPerPx * sensitivity,
        dx * rates().mouseOrbitDegPerPx * sensitivity,
        orbitAnchors?.orbit,
      );
      // A button drag is not a swipe: the trackpad will not keep sending it.
      camera.armReleaseMomentum?.("orbit");
    }
  }

  function onPointerUp(e: PointerEvent): void {
    endSelectionPress(e);
    if (e.pointerType !== "mouse" || activeButton === null) return;
    if (isDragging) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    endPress();
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  }

  /** Direct input ends; motion it set going glides on about its pivot. */
  function endPress(): void {
    if (anchorPanActive) {
      camera.endAnchorPan?.();
      anchorPanActive = false;
      anchorPanDebugOverlay.hide();
    }
    releaseOrbitAnchors();
    camera.releaseMomentum?.("orbit");
    camera.releaseMomentum?.("pan");
    isDragging = false;
    activeButton = null;
    pressPointerId = null;
  }

  /** Capture lost without a release, as when the canvas leaves the page: the press ends. */
  function onLostPointerCapture(e: PointerEvent): void {
    // A pick press whose capture is lost picks nothing: its release may never come here.
    if (selectionPress?.pointerId === e.pointerId) selectionPress = null;
    if (activeButton === null || e.pointerId !== pressPointerId) return;
    endPress();
  }

  /** A consumed selection's click and double click go nowhere. */
  function onClick(e: MouseEvent): void {
    const target = e.target as Node | null;
    if (target !== canvas && !(target && canvas.contains(target))) return;
    if (e.type === "click" ? !selectionClickPending : e.timeStamp > selectionDoubleClickUntil) return;
    if (e.type === "click") selectionClickPending = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onContextMenu(e: Event): void {
    e.preventDefault();
  }

  const opts = { capture: true, passive: false } as AddEventListenerOptions;
  const doc = canvas.ownerDocument;
  canvas.addEventListener("pointerdown", onPointerDown, opts);
  canvas.addEventListener("pointermove", onPointerMove, opts);
  canvas.addEventListener("pointerup", onPointerUp, opts);
  canvas.addEventListener("pointercancel", onPointerUp, opts as EventListenerOptions);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture, opts as EventListenerOptions);
  canvas.addEventListener("contextmenu", onContextMenu, opts as EventListenerOptions);
  // Before anything on the page can act on them.
  doc.addEventListener("click", onClick, opts);
  doc.addEventListener("dblclick", onClick, opts);
  if (options.heldPress) beginPress(options.heldPress);

  return (): void => {
    anchorPanDebugOverlay.destroy();
    releaseOrbitAnchors();
    canvas.removeEventListener("pointerdown", onPointerDown, opts as EventListenerOptions);
    canvas.removeEventListener("pointermove", onPointerMove, opts as EventListenerOptions);
    canvas.removeEventListener("pointerup", onPointerUp, opts as EventListenerOptions);
    canvas.removeEventListener("pointercancel", onPointerUp, opts as EventListenerOptions);
    canvas.removeEventListener("lostpointercapture", onLostPointerCapture, opts as EventListenerOptions);
    canvas.removeEventListener("contextmenu", onContextMenu, opts as EventListenerOptions);
    doc.removeEventListener("click", onClick, opts as EventListenerOptions);
    doc.removeEventListener("dblclick", onClick, opts as EventListenerOptions);
  };
}
