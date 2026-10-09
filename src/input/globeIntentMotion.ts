import type { CameraInputTarget } from "./inertialCameraController.js";
import type { GlobeNavigationIntentFrame } from "./globeNavigationTypes.js";
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
/** Source finite/clamped dt and intent mapping, using the host's existing inertia/render authority. */
export function createGlobeIntentMotion<TCanvas>(ports: GlobeIntentMotionPorts<TCanvas>) {
  return (frame: GlobeNavigationIntentFrame): void => {
    const target = ports.target(); if (ports.blocked() || !target) return;
    const dt = Number.isFinite(frame.dt) ? Math.max(0, Math.min(0.1, frame.dt)) : 0; if (dt === 0) return;
    const height = Math.max(1, ports.canvasHeightPx() || 1), rates = ports.rates();
    for (const intent of frame.intents) {
      const value = Number.isFinite(intent.value) ? Math.max(-1, Math.min(1, intent.value)) : 0;
      // The original gamepad adapter already omitted resting sticks; keep idle callers from waking the renderer.
      if (value === 0) continue;
      switch (intent.actionId) {
        case "globe.panX": target.panBy(value * rates.panPxPerSecond * dt, 0, height); break;
        case "globe.panY": target.panBy(0, -value * rates.panPxPerSecond * dt, height); break;
        case "globe.orbitHeading": target.orbitBy(0, value * rates.headingDegPerSecond * dt); break;
        case "globe.orbitPitch": target.orbitBy(value * rates.pitchDegPerSecond * dt, 0); break;
        case "globe.zoom": target.zoomBy(Math.exp(-value * rates.zoomLogPerSecond * dt)); break;
      }
    }
  };
}
