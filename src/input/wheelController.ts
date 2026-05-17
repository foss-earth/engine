import type { CameraController } from "../camera/cameraState";

/**
 * Attach a trackpad-aware wheel event handler to the canvas.
 *
 * Behavior matrix (matches foss-earth / Cesium parity):
 *   - Trackpad two-finger swipe (no modifier)  → pan lat/lon
 *   - Shift + wheel / swipe                     → orbit heading/pitch
 *   - Ctrl + wheel (non-Safari, i.e. pinch)     → zoom
 *   - Mouse wheel (no modifier)                 → zoom
 *
 * Runs in capture phase with stopImmediatePropagation so Babylon's
 * built-in camera wheel handler never fires.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachWheelController(
  canvas: HTMLCanvasElement,
  camera: CameraController,
  options: { isSafariWithGestures: boolean },
): () => void {
  const { isSafariWithGestures } = options;
  let lastWheelTime = 0;
  let isTrackpad = false;

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Prevent Babylon's own wheel/zoom handler from firing on the same event.
    e.stopImmediatePropagation();

    const now = performance.now();
    const dt = now - lastWheelTime;
    lastWheelTime = now;

    // Heuristic: trackpad events arrive rapidly with small deltaY.
    if (dt < 50 && Math.abs(e.deltaY) < 60) isTrackpad = true;
    else if (dt > 300) isTrackpad = false;

    // ── Ctrl+wheel = macOS trackpad pinch-to-zoom (non-Safari browsers) ──
    if (e.ctrlKey) {
      if (!isSafariWithGestures) {
        // deltaY<0 = pinch open (zoom in) → factor < 1; deltaY>0 = pinch close → factor > 1
        const factor = 1 + e.deltaY * 0.01;
        camera.zoomBy(factor);
      }
      // On Safari, gesturechange handles pinch — skip here.
      return;
    }

    // ── Shift+wheel = orbit (heading + pitch) ────────────────────────────
    if (e.shiftKey) {
      const pitchDeltaDeg = -e.deltaY * 0.15;
      const headingDeltaDeg = e.deltaX * 0.15;
      camera.orbitBy(pitchDeltaDeg, headingDeltaDeg);
      return;
    }

    // ── Trackpad two-finger swipe = pan ──────────────────────────────────
    if (isTrackpad) {
      camera.panBy(e.deltaX, e.deltaY, canvas.clientHeight);
      return;
    }

    // ── Mouse wheel = coarser zoom ───────────────────────────────────────
    // Scroll down (deltaY>0) = zoom out; scroll up (deltaY<0) = zoom in.
    const factor = e.deltaY > 0 ? 1.08 : 0.92;
    camera.zoomBy(factor);
  }

  canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });

  return () => {
    canvas.removeEventListener("wheel", onWheel, { capture: true });
  };
}
