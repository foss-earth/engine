import type { CameraInputTarget } from "./inertialCameraController";
import { attachAnchorPanDebugOverlay, type AnchorPanDebugOverlay } from "./anchorPanDebugOverlay";
import { MOVEMENT_SENSITIVITY_BASE, type InputSettings } from "./inputSettings";

/** Degrees of orbit change per pixel of mouse drag. */
const MOUSE_ORBIT_DEG_PER_PX = 0.3;
/**
 * Pixels the pointer must travel from its down-position before we
 * commit to a drag and start intercepting events.  Below this threshold
 * the interaction is treated as a click and events pass through to
 * Babylon so picking / sphere-click handlers still fire.
 */
const DRAG_START_THRESHOLD_PX = 4;

/**
 * Attach a mouse-button drag handler to the canvas.
 *
 * - Left-button drag  → pan
 * - Right-button drag → orbit (heading + pitch)
 *
 * On pointerdown the event is NOT consumed so that Babylon's picking
 * system can still detect clicks on scene objects.  Once the pointer
 * travels more than DRAG_START_THRESHOLD_PX the interaction is committed
 * as a drag: subsequent pointermove / pointerup events are captured and
 * stopImmediatePropagation is called so Babylon's own camera input does
 * not also fire.
 *
 * The context-menu is suppressed to prevent the right-click menu from
 * interrupting orbit.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachMouseController(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget,
  options: { isOrbitMode?: () => boolean; getSettings?: () => InputSettings } = {},
): () => void {
  let activeButton: 0 | 2 | null = null;
  let isDragging = false;
  let anchorPanActive = false;
  let startX = 0;
  let startY = 0;
  let prevX = 0;
  let prevY = 0;
  let anchorDownClientX = 0;
  let anchorDownClientY = 0;
  const anchorPanDebugOverlay: AnchorPanDebugOverlay = attachAnchorPanDebugOverlay(canvas);

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

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return;
    if (e.button !== 0 && e.button !== 2) return;
    // Do NOT stop propagation here — let Babylon's picking system see the event.
    activeButton = e.button as 0 | 2;
    isDragging = false;
    anchorPanActive = false;
    startX = prevX = e.clientX;
    startY = prevY = e.clientY;
    canvas.setPointerCapture(e.pointerId);

    if (shouldUseAnchorPan(e.button) && camera.beginAnchorPan) {
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
    if (e.pointerType !== "mouse" || activeButton === null) return;

    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    const distFromStart = Math.hypot(e.clientX - startX, e.clientY - startY);

    if (anchorPanActive && activeButton === 0 && !(options.isOrbitMode?.() ?? false)) {
      if (distFromStart >= DRAG_START_THRESHOLD_PX) {
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
      if (dist < DRAG_START_THRESHOLD_PX) return;
      isDragging = true;
      stopInertial();
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    prevX = e.clientX;
    prevY = e.clientY;

    if (activeButton === 0 && !(options.isOrbitMode?.() ?? false)) {
      const sensitivity = options.getSettings?.().sensitivity.mouse.pan ?? 1;
      camera.panBy(-dx * sensitivity * MOVEMENT_SENSITIVITY_BASE, -dy * sensitivity * MOVEMENT_SENSITIVITY_BASE, canvas.clientHeight);
    } else {
      const sensitivity = options.getSettings?.().sensitivity.mouse.orbit ?? 1;
      camera.orbitBy(dy * MOUSE_ORBIT_DEG_PER_PX * sensitivity * MOVEMENT_SENSITIVITY_BASE, dx * MOUSE_ORBIT_DEG_PER_PX * sensitivity * MOVEMENT_SENSITIVITY_BASE);
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== "mouse" || activeButton === null) return;
    if (isDragging) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (anchorPanActive) {
      camera.endAnchorPan?.();
      anchorPanActive = false;
      anchorPanDebugOverlay.hide();
    }
    isDragging = false;
    activeButton = null;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  }

  function onContextMenu(e: Event): void {
    e.preventDefault();
  }

  const opts = { capture: true, passive: false } as AddEventListenerOptions;
  canvas.addEventListener("pointerdown", onPointerDown, opts);
  canvas.addEventListener("pointermove", onPointerMove, opts);
  canvas.addEventListener("pointerup", onPointerUp, opts);
  canvas.addEventListener("pointercancel", onPointerUp, opts as EventListenerOptions);
  canvas.addEventListener("contextmenu", onContextMenu, opts as EventListenerOptions);

  return (): void => {
    anchorPanDebugOverlay.destroy();
    canvas.removeEventListener("pointerdown", onPointerDown, opts as EventListenerOptions);
    canvas.removeEventListener("pointermove", onPointerMove, opts as EventListenerOptions);
    canvas.removeEventListener("pointerup", onPointerUp, opts as EventListenerOptions);
    canvas.removeEventListener("pointercancel", onPointerUp, opts as EventListenerOptions);
    canvas.removeEventListener("contextmenu", onContextMenu, opts as EventListenerOptions);
  };
}
