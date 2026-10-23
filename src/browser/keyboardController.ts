import { orbitWith, zoomWith, DEFAULT_INERTIA_DECAY_PER_FRAME, type CameraInputTarget } from "../input/inertialCameraController.js";
import type { AnchorAcquisition, GlideMotion } from "../input/navigationAnchors.js";
import { DEFAULT_INPUT_RATES, type InputRates } from "../input/inputRates.js";
import { createNavigationSpeedAxis } from "../input/navigationSpeedCurve.js";
import { worldViewportHeight } from "./worldViewport.js";

const KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyF", "KeyR", "KeyT", "KeyG", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight"]);

/** Held keys feed the same inertial pan and compass orbit as trackpad input. */
export function attachKeyboardController(canvas: HTMLCanvasElement, camera: CameraInputTarget<HTMLCanvasElement>, window: Window, getRates: () => InputRates = () => DEFAULT_INPUT_RATES): () => void {
  const document = canvas.ownerDocument;
  const held = new Set<string>();
  let frame: number | null = null;
  let previous: number | null = null;
  let anchors: AnchorAcquisition | null = null;
  const axes = Array.from({ length: 5 }, () => createNavigationSpeedAxis());
  let forceActive = false;
  const lastVelocity = new Float64Array(5);
  const targets = new Float64Array(5), speeds = new Float64Array(5);
  const curve = { accelerationMs: 0, accelerationPower: 1, slowdownMs: 0, slowdownPower: 1 };
  const force = { pan: { x: 0, y: 0, canvasHeight: 1 }, orbit: { pitch: 0, heading: 0, anchor: null as GlideMotion["orbit"]["anchor"] }, zoom: { log: 0, anchor: null as GlideMotion["zoom"]["anchor"] } };
  const axis = (positive: string, negative: string): number => Number(held.has(positive)) - Number(held.has(negative));
  const editing = (target: EventTarget | null): boolean => {
    const element = target as Element | null;
    return !!element?.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]');
  };
  function releaseOrbit(): void {
    if (anchors) camera.releaseAnchors?.(anchors);
    anchors = null;
  }
  function clear(): void {
    for (const axis of axes) axis.reset();
    if (forceActive) camera.clearNavigationForce?.();
    forceActive = false;
    lastVelocity.fill(0);
    held.clear();
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = previous = null;
    releaseOrbit();
  }
  function tick(time: number): void {
    frame = null;
    const rates = getRates();
    const seconds = previous === null ? 1 / 60 : Math.min((time - previous) / 1000, 0.05);
    previous = time;
    const x = axis("KeyD", "KeyA"), y = axis("KeyS", "KeyW");
    const length = Math.max(1, Math.hypot(x, y));
    targets[0] = x / length; targets[1] = y / length;
    targets[2] = axis("KeyE", "KeyQ"); targets[3] = axis("KeyR", "KeyF");
    const control = held.has("ControlLeft") || held.has("ControlRight");
    const shift = held.has("ShiftLeft") || held.has("ShiftRight");
    targets[4] = Math.max(-1, Math.min(1, Number(control) - Number(shift) + (rates.keyboardTGZoomEnabled ? axis("KeyG", "KeyT") : 0)));
    curve.accelerationMs = rates.keyboardAccelerationMs; curve.accelerationPower = rates.keyboardAccelerationPower;
    curve.slowdownMs = rates.keyboardSlowdownMs; curve.slowdownPower = rates.keyboardSlowdownPower;
    let moving = false;
    for (let i = 0; i < axes.length; i++) { speeds[i] = axes[i].step(targets[i], seconds * 1000, curve); moving ||= speeds[i] !== 0; }
    const panX = speeds[0], panY = speeds[1], heading = speeds[2], pitch = speeds[3], zoom = speeds[4];
    if (heading || pitch || zoom) {
      if (!anchors) {
        anchors = camera.acquireAnchors?.({ family: "nonPointer", operations: ["orbit", "zoom"], client: null, canvas }) ?? null;
        if (anchors) camera.holdAnchors?.(anchors);
      }
    } else releaseOrbit();
    // Preserve the prior steady speed (an impulse fed through the standard 0.82 glide),
    // but apply this envelope once, rather than running it through another slowdown.
    const gain = 1 / (1 - DEFAULT_INERTIA_DECAY_PER_FRAME);
    const height = worldViewportHeight(canvas);
    const vx = panX * height * rates.keyboardPanSensitivity * gain / 60;
    const vy = panY * height * rates.keyboardPanSensitivity * gain / 60;
    const vh = heading * 45 * rates.keyboardHeadingSensitivity * gain / 60;
    const vp = pitch * 45 * rates.keyboardPitchSensitivity * gain / 60;
    const vz = zoom * rates.keyboardZoomSensitivity * gain / 60;
    if (camera.applyNavigationForce && seconds > 0) {
      // F = delta velocity / dt with unit mass. Reuse scratch storage; the integrator copies values.
      force.pan.x = (vx - lastVelocity[0]) / seconds; force.pan.y = (vy - lastVelocity[1]) / seconds; force.pan.canvasHeight = height;
      force.orbit.heading = (vh - lastVelocity[2]) / seconds; force.orbit.pitch = (vp - lastVelocity[3]) / seconds; force.orbit.anchor = anchors?.orbit ?? null;
      force.zoom.log = (vz - lastVelocity[4]) / seconds; force.zoom.anchor = anchors?.zoom ?? null;
      camera.applyNavigationForce(force, seconds);
      lastVelocity[0] = vx; lastVelocity[1] = vy; lastVelocity[2] = vh; lastVelocity[3] = vp; lastVelocity[4] = vz;
      forceActive = true;
    } else {
      if (panX || panY) camera.panBy(vx * seconds * 60, vy * seconds * 60, height);
      if (heading || pitch) orbitWith(camera, vp * seconds * 60, vh * seconds * 60, anchors?.orbit);
      if (zoom) zoomWith(camera, Math.exp(vz * seconds * 60), anchors?.zoom);
    }
    if (held.size || moving) frame = window.requestAnimationFrame(tick);
    else clear();
  }
  function down(event: KeyboardEvent): void {
    const zoomModifier = event.code === "ControlLeft" || event.code === "ControlRight" || event.code === "ShiftLeft" || event.code === "ShiftRight";
    if (event.metaKey || event.altKey || (event.ctrlKey && !zoomModifier)) return;
    if ((event.code === "KeyT" || event.code === "KeyG") && !getRates().keyboardTGZoomEnabled) return;
    if (!KEYS.has(event.code) || event.defaultPrevented || editing(event.target) || editing(document.activeElement)) return;
    event.preventDefault();
    held.add(event.code);
    if (frame === null) frame = window.requestAnimationFrame(tick);
  }
  function up(event: KeyboardEvent): void {
    held.delete(event.code);
    // macOS may omit letter keyups while Cmd is held. Let the normal slowdown finish them.
    if (event.key === "Meta" || event.code === "MetaLeft" || event.code === "MetaRight") held.clear();
  }
  function focus(event: FocusEvent): void { if (editing(event.target)) clear(); }
  function visibility(): void { if (document.hidden) clear(); }
  document.addEventListener("focusin", focus);
  document.addEventListener("keydown", down);
  document.addEventListener("keyup", up);
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    clear();
    document.removeEventListener("focusin", focus);
    document.removeEventListener("keydown", down);
    document.removeEventListener("keyup", up);
    window.removeEventListener("blur", clear);
    document.removeEventListener("visibilitychange", visibility);
  };
}
