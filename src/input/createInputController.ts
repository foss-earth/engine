import type { CameraInputTarget } from "./inertialCameraController";
import { attachWheelController } from "./wheelController";
import { attachSafariGestures, isSafariGestureSupported } from "./safariGestures";
import { attachTouchController } from "./touchController";

export interface InputController {
  destroy(): void;
}

/**
 * Create and attach all input controllers to the canvas.
 *
 * Wires:
 *  - Trackpad-aware wheel handler (pan / orbit / zoom)
 *  - Safari GestureEvent handler (rotation + pinch on macOS Safari)
 *  - Two-finger touch handler (orbit + pinch on touch devices)
 *
 * Also registers document-level wheel/gesture prevention to stop the
 * browser from scrolling or zooming the page during globe interaction.
 *
 * @returns An `InputController` whose `destroy()` removes every listener.
 */
export function createInputController(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget,
): InputController {
  const hasSafariGestures = isSafariGestureSupported();

  // ── Document-level prevention ────────────────────────────────────
  // Prevent the page from scrolling or zooming while the user interacts
  // with the globe canvas.
  const docWheelHandler = (e: Event): void => { e.preventDefault(); };
  document.addEventListener("wheel", docWheelHandler, { passive: false });

  const docGestureCleanup: Array<() => void> = [];
  if (hasSafariGestures) {
    for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
      const handler = (e: Event): void => { e.preventDefault(); };
      document.addEventListener(type, handler, { passive: false } as AddEventListenerOptions);
      docGestureCleanup.push(() => document.removeEventListener(type, handler));
    }
  }

  // ── Canvas-level handlers ────────────────────────────────────────
  const detachWheel = attachWheelController(canvas, camera, { isSafariWithGestures: hasSafariGestures });
  const detachSafari = hasSafariGestures ? attachSafariGestures(canvas, camera) : (): void => undefined;
  const detachTouch = attachTouchController(canvas, camera);

  return {
    destroy(): void {
      detachWheel();
      detachSafari();
      detachTouch();
      document.removeEventListener("wheel", docWheelHandler);
      for (const cleanup of docGestureCleanup) cleanup();
    },
  };
}
