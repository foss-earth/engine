import { createNavigationOwner, createInertialCameraController, createDisplayedSurfaceAccess,
  geodeticToEcef, orbitAngles, type NavigationAbortSignal, type NavigationHost,
  type NavigationSnapshot, type GlobeViewState, type GlobeLayer, DEFAULT_POI_SPRITE_SIZE_PARAMS, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS, createHemisphereCulling, poiRefinementLod } from "@foss-earth/engine";

/** ES2022-only public declaration fixture: no DOM, React or Babylon types. */
class Signal implements NavigationAbortSignal {
  aborted = false;
  reason: unknown;
  private listeners = new Set<() => void>();
  addEventListener(_type: "abort", listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: "abort", listener: () => void): void { this.listeners.delete(listener); }
  abort(reason: unknown): void { this.aborted = true; this.reason = reason; for (const listener of this.listeners) listener(); }
}
const view: GlobeViewState = { latDeg: 44, lonDeg: -93, headingDeg: 0, pitchDeg: 30, zoomMeters: 200 };
const overview: NavigationSnapshot = { version: 1, view,
  camera: { center: geodeticToEcef(44 * Math.PI / 180, -93 * Math.PI / 180, 200), yaw: 0, pitch: 1, radius: 200, fov: 0.8 } };
let renderRequests = 0;
let holds = 0;
const host: NavigationHost<string, Signal> = {
  focusReturn: () => "host-focus-token",
  createAbortController: () => { const signal = new Signal(); return { signal, abort: reason => signal.abort(reason) }; },
  abortReason: reason => ({ name: "AbortError", message: `Navigation ended: ${reason}.` }),
  unavailable: () => null, snapshot: () => overview,
  suspend() {}, resume() {}, present() {}, requestRender: () => { renderRequests++; },
  beginContinuous: () => { holds++; }, endContinuous: () => { holds--; },
};
const owner = createNavigationOwner(host);
const acquired = owner.acquire({ owner: "fixture", inputContext: "placed-camera", terrain: "paused" });
if (!acquired.ok) throw new Error(acquired.message);
const focus: string | null = acquired.lease.focusReturn;
const stop = acquired.lease.holdRendering();
stop(); stop(); acquired.lease.release("exit");
if (holds !== 0 || !acquired.lease.signal.aborted || focus !== "host-focus-token" || renderRequests !== 2) throw new Error("Unbalanced host navigation ports");
createInertialCameraController({ panBy() {}, orbitBy() {}, zoomBy() {} }, { nowMs: () => 1000, decayPerFrame: () => 0.82 }).update();
createDisplayedSurfaceAccess({ sample: () => null, raycast: () => null }, { readiness: () => ({ state: "loading", revision: 0 }) }).sample(44, -93);
orbitAngles([6378137, 0, 0], [-1, 0, 0], 0);

const layer: GlobeLayer = { id: "host-layer", setup: () => ({}), destroy() {} };
layer.setup({ scene: {}, engine: {} });
if (DEFAULT_POI_SPRITE_SIZE_PARAMS.minSize !== 200 || DEFAULT_ORBIT_COMPASS_SCALE_PARAMS.radiusScale !== .035 || poiRefinementLod(5000) !== 17) throw new Error("Changed pure visualization defaults");
createHemisphereCulling(() => null).update();
