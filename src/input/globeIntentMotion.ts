import { orbitWith, zoomWith, type CameraInputTarget } from "./inertialCameraController.js";
import type { GlobeNavigationIntentFrame } from "./globeNavigationTypes.js";
import type { AnchorAcquisition } from "./navigationAnchors.js";
export interface GlobeIntentRates { panPxPerSecond: number; headingDegPerSecond: number; pitchDegPerSecond: number; zoomLogPerSecond: number }
/** Unmeasured committed source rates, preserved as visible parameter starting values. */
export const DEFAULT_GLOBE_INTENT_RATES: Readonly<GlobeIntentRates> = Object.freeze({ panPxPerSecond: 900, headingDegPerSecond: 75, pitchDegPerSecond: 65, zoomLogPerSecond: 1.5 });
export interface GlobeIntentMotionPorts<TCanvas = unknown> {
  /** True while a feature/navigation owner steers this camera; the existing gesture handover owns it. */
  blocked(): boolean;
  target(): CameraInputTarget<TCanvas> | null;
  canvasHeightPx(): number;
  rates(): GlobeIntentRates;
}
const clampValue = (value: number): number => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
/**
 * Source finite/clamped dt and intent mapping, using the host's existing inertia/render authority.
 * Zoom acts about the key, controller and button choice (`input.nonPointer.zoomAnchor`), and rotation
 * about the compass target, resolved without the pointer when a run of such input starts and kept until it stops: a frame
 * without zoom or rotation, such as the one a controller sends when its sticks come back to rest,
 * ends it. Any glide after that keeps the same anchors.
 */
export function createGlobeIntentMotion<TCanvas>(ports: GlobeIntentMotionPorts<TCanvas>) {
  let episode: { target: CameraInputTarget<TCanvas>; anchors: AnchorAcquisition | null } | null = null;
  const end = (): void => {
    if (episode?.anchors) episode.target.releaseAnchors?.(episode.anchors);
    episode = null;
  };
  const anchors = (target: CameraInputTarget<TCanvas>): AnchorAcquisition | null => {
    if (episode && episode.target !== target) end();
    episode ??= { target, anchors: target.acquireAnchors?.({ family: "nonPointer", operations: ["zoom", "orbit"], client: null, hold: true }) ?? null };
    return episode.anchors;
  };
  return (frame: GlobeNavigationIntentFrame): void => {
    const target = ports.target(); if (ports.blocked() || !target) { end(); return; }
    const turning = frame.intents.some(intent => clampValue(intent.value) !== 0
      && (intent.actionId === "globe.orbitHeading" || intent.actionId === "globe.orbitPitch" || intent.actionId === "globe.zoom"));
    if (!turning) end();
    const dt = Number.isFinite(frame.dt) ? Math.max(0, Math.min(0.1, frame.dt)) : 0; if (dt === 0) return;
    const height = Math.max(1, ports.canvasHeightPx() || 1), rates = ports.rates();
    for (const intent of frame.intents) {
      const value = clampValue(intent.value);
      // The original gamepad adapter already omitted resting sticks; keep idle callers from waking the renderer.
      if (value === 0) continue;
      switch (intent.actionId) {
        case "globe.panX": target.panBy(value * rates.panPxPerSecond * dt, 0, height); break;
        case "globe.panY": target.panBy(0, -value * rates.panPxPerSecond * dt, height); break;
        case "globe.orbitHeading": orbitWith(target, 0, value * rates.headingDegPerSecond * dt, anchors(target)?.orbit); break;
        case "globe.orbitPitch": orbitWith(target, value * rates.pitchDegPerSecond * dt, 0, anchors(target)?.orbit); break;
        case "globe.zoom": zoomWith(target, Math.exp(-value * rates.zoomLogPerSecond * dt), anchors(target)?.zoom); break;
      }
    }
  };
}
