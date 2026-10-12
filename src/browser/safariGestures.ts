import { orbitWith, zoomWith, type CameraInputTarget } from "../input/inertialCameraController.js";
import { DEFAULT_INPUT_RATES, type InputSettings } from "../input/inputSettings.js";
import type { AnchorAcquisition } from "../input/navigationAnchors.js";

export interface SafariGesturePorts { userAgent: string; hasGestureEvent: boolean }

/**
 * Detect whether the current browser supports macOS Safari GestureEvents.
 * These are non-standard events fired by Safari on macOS for trackpad
 * rotation (two-finger twist) and pinch zoom.
 *
 * Conditions:
 *  - `GestureEvent` class exists in the window
 *  - Running in Safari (not Chrome/Firefox/Edge/Opera masquerading as Safari)
 *  - Not on Apple mobile (iOS fires touch events, not gesture events)
 */
export function isSafariGestureSupported(ports: SafariGesturePorts): boolean {
  const ua = ports.userAgent;
  const isAppleMobile = /iPhone|iPad|iPod/i.test(ua);
  return (
    ports.hasGestureEvent &&
    /Safari/i.test(ua) &&
    !isAppleMobile &&
    !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPR|Android/i.test(ua)
  );
}

/**
 * Attach Safari-specific macOS GestureEvent handlers to the canvas.
 *
 * - `gesturechange` rotation delta  → orbit by heading
 * - `gesturechange` scale delta     → zoom
 *
 * The scale-to-zoom formula mirrors the foss-earth reference:
 *   factor = 1.5 − scaleDelta × 0.5
 *   scaleDelta > 1 (pinch open)  → factor < 1 = zoom in
 *   scaleDelta < 1 (pinch close) → factor > 1 = zoom out
 *
 * A gesture is a trackpad's (`input.trackpad.*`): it zooms and turns about
 * the anchors picked where it starts, at the event's position or, without
 * one, where the pointer last was over the canvas.
 *
 * @returns Cleanup function that removes all registered listeners.
 */
export function attachSafariGestures(
  canvas: HTMLCanvasElement,
  camera: CameraInputTarget<HTMLCanvasElement>,
  options: { getSettings?: () => InputSettings } = {},
): () => void {
  let lastRotation = 0;
  let lastScale = 1;
  let anchors: AnchorAcquisition | null = null;
  // Where the pointer last was over the canvas while this handler was attached: no other owner's.
  let pointer: { x: number; y: number } | null = null;
  // Rotate and pinch rates at sensitivity 1: `input.trackpad.*`.
  const rates = () => options.getSettings?.().rates ?? DEFAULT_INPUT_RATES;

  function releaseAnchors(): void {
    if (anchors) camera.releaseAnchors?.(anchors);
    anchors = null;
  }

  function onPointer(e: PointerEvent): void {
    if (e.pointerType === "mouse" && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) pointer = { x: e.clientX, y: e.clientY };
  }

  function onGestureStart(e: Event): void {
    e.preventDefault();
    const ge = e as unknown as { rotation: number; scale: number; clientX?: number; clientY?: number };
    lastRotation = ge.rotation;
    lastScale = ge.scale;
    releaseAnchors();
    const at = typeof ge.clientX === "number" && typeof ge.clientY === "number" && Number.isFinite(ge.clientX) && Number.isFinite(ge.clientY)
      ? { x: ge.clientX, y: ge.clientY }
      : pointer;
    anchors = camera.acquireAnchors?.({ family: "trackpad", operations: ["zoom", "orbit"], client: at, canvas, hold: true }) ?? null;
  }

  function onGestureChange(e: Event): void {
    e.preventDefault();
    const ge = e as unknown as { rotation: number; scale: number };

    // Rotation is in degrees, CCW positive on Safari.
    // Negate so clockwise drag increases heading (eastward = positive heading).
    const rotDelta = ge.rotation - lastRotation;
    lastRotation = ge.rotation;
    if (Math.abs(rotDelta) > 0.1) {
      const sensitivity = options.getSettings?.().sensitivity.trackpad.orbit ?? 1;
      orbitWith(camera, 0, -rotDelta * sensitivity * rates().trackpadRotateRate, anchors?.orbit);
    }

    const scaleDelta = ge.scale / lastScale;
    lastScale = ge.scale;
    // Apply zoom only when there is a meaningful scale change.
    const factor = 1.5 - scaleDelta * 0.5;
    if (Math.abs(factor - 1) > 0.001) {
      const sensitivity = options.getSettings?.().sensitivity.trackpad.zoom ?? 1;
      zoomWith(camera, Math.pow(factor, sensitivity * rates().trackpadGestureZoomExponent), anchors?.zoom);
    }
  }

  function onGestureEnd(e: Event): void {
    e.preventDefault();
    releaseAnchors();
  }

  const opts = { passive: false } as AddEventListenerOptions;
  const watch = { capture: true, passive: true } as AddEventListenerOptions;
  canvas.addEventListener("gesturestart", onGestureStart, opts);
  canvas.addEventListener("gesturechange", onGestureChange, opts);
  canvas.addEventListener("gestureend", onGestureEnd, opts);
  canvas.addEventListener("pointermove", onPointer, watch);
  canvas.addEventListener("pointerdown", onPointer, watch);

  return () => {
    releaseAnchors();
    canvas.removeEventListener("gesturestart", onGestureStart, opts as EventListenerOptions);
    canvas.removeEventListener("gesturechange", onGestureChange, opts as EventListenerOptions);
    canvas.removeEventListener("gestureend", onGestureEnd, opts as EventListenerOptions);
    canvas.removeEventListener("pointermove", onPointer, watch as EventListenerOptions);
    canvas.removeEventListener("pointerdown", onPointer, watch as EventListenerOptions);
  };
}
