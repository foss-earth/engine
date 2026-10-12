import { PointerEventTypes, Vector3 } from "@babylonjs/core";
import type { AbstractMesh, GeospatialCamera, Scene } from "@babylonjs/core";
import { DEFAULT_INPUT_RATES } from "../input/inputRates.js";
import type { PoiDescriptor } from "./types.js";

export interface PoiTrackingHandle {
  /**
   * Replace the full active POI set.
   * Call this after every `addLayer` / `removeLayer` so the picking map stays
   * in sync with the registered layers.
   */
  setPois(pois: PoiDescriptor[]): void;
  /** Programmatically enter tracking for a specific POI. */
  enterTracking(poi: PoiDescriptor): void;
  /**
   * Exit tracking mode and return to free orbit.
   * Safe to call when no POI is tracked.
   */
  exitTracking(): void;
  /** True while a POI is being actively tracked. */
  isTracking(): boolean;
  /**
   * Returns the ECEF orbit target of the currently tracked POI, or null.
   * Intended for Phase 6 compass anchor integration.
   */
  getOrbitTarget(): Vector3 | null;
  /**
   * While suspended, clicks select nothing and the camera does not follow:
   * a navigation lease owns the camera. The tracked point is kept, so the
   * camera follows it again once resumed.
   */
  setSuspended(suspended: boolean): void;
  /** Remove all scene observers. Call before `scene.dispose()`. */
  destroy(): void;
}

export interface PoiTrackingOptions {
  /**
   * How far a press may move and still be a click, px: `input.mouse.dragThreshold`,
   * so a press the map took as a drag never also selects a point.
   */
  dragThresholdPx?: () => number;
  /**
   * How much of the way from the view's centre to a newly tracked point is
   * left after each 60 Hz frame, 0 to 1, such as `camera.inertiaDecay`:
   * tracking eases the centre onto the point instead of jumping to it.
   */
  entryKeepPerFrame?: () => number;
  requestRender?(): void;
  log?(message: string): void;
}

/**
 * Creates a POI tracking controller that:
 *  - Watches left mouse clicks (pointerdown → pointerup moving less than the drag threshold).
 *  - On click: picks the scene at the click position.
 *    - If the hit mesh is a registered POI → enter tracking mode.
 *    - Otherwise (empty space or non-POI) → exit tracking if active.
 *  - Each frame: updates the GeospatialCamera's orbit center to the tracked
 *    POI's current ECEF position so the camera "follows" the POI. On entry
 *    the centre eases onto the POI over a few frames rather than jumping.
 *
 * Touch events are intentionally excluded — those are handled by touchController.
 */
const FRAME_MS = 1000 / 60;
/** How much of the way to a newly tracked point is left after each 60 Hz frame, by default. */
const DEFAULT_ENTRY_KEEP_PER_FRAME = 0.85;
/** Nearer than this, metres, the centre is on the tracked point. */
const ENTRY_SETTLED_METERS = 0.01;

export function createPoiTracking(
  scene: Scene,
  getCamera: () => GeospatialCamera | null,
  options: PoiTrackingOptions = {},
): PoiTrackingHandle {
  const dragThresholdPx = options.dragThresholdPx ?? (() => DEFAULT_INPUT_RATES.mouseDragThresholdPx);
  const meshToPoiMap = new Map<AbstractMesh, PoiDescriptor>();
  let currentPoi: PoiDescriptor | null = null;
  let suspended = false;
  let disposed = false;
  let pointerDownX = 0;
  let pointerDownY = 0;
  /** Where the centre still is from the tracked point while it eases onto it, ECEF metres, or null once it is there. */
  let entryOffset: { x: number; y: number; z: number } | null = null;

  // ── Core tracking actions ─────────────────────────────────────────────────

  function enterTracking(poi: PoiDescriptor): void {
    if (disposed || suspended) return;
    if (currentPoi === poi) return;
    currentPoi?.onTrackingExit?.();
    currentPoi = poi;
    poi.onTrackingEnter?.();
    // The centre eases onto the point from where it is, frame by frame: the view never jumps.
    const camera = getCamera();
    const pos = poi.getPosition();
    const from = camera?.center;
    entryOffset = from && pos ? { x: from.x - pos.x, y: from.y - pos.y, z: from.z - pos.z } : null;
    if (entryOffset && !(Math.hypot(entryOffset.x, entryOffset.y, entryOffset.z) > ENTRY_SETTLED_METERS)) entryOffset = null;
    options.requestRender?.(); options.log?.(`[poi-tracking] entered tracking poi=${poi.mesh.name}`);
  }

  function exitTracking(): void {
    if (disposed) return;
    if (!currentPoi) return;
    const name = currentPoi.mesh.name;
    currentPoi.onTrackingExit?.();
    currentPoi = null;
    entryOffset = null;
    options.requestRender?.(); options.log?.(`[poi-tracking] exited tracking poi=${name}`);
  }

  function isTracking(): boolean {
    return currentPoi !== null;
  }

  function getOrbitTarget(): Vector3 | null {
    return currentPoi?.getPosition() ?? null;
  }

  // ── Before-render: keep orbit center locked to the tracked POI ────────────

  const renderObserver = scene.onBeforeRenderObservable.add(() => {
    if (!currentPoi || suspended || disposed) return;
    const camera = getCamera();
    const pos = currentPoi.getPosition();
    if (!camera || !pos) return;
    if (entryOffset) {
      const frameMs = scene.getEngine().getDeltaTime?.() ?? FRAME_MS;
      const keep = Math.max(0, Math.min(1, options.entryKeepPerFrame?.() ?? DEFAULT_ENTRY_KEEP_PER_FRAME));
      // The same share each 60 Hz frame whatever the frame rate; a stalled frame counts as at most a few.
      const left = keep ** (Math.min(Math.max(frameMs, 0), 4 * FRAME_MS) / FRAME_MS);
      entryOffset = { x: entryOffset.x * left, y: entryOffset.y * left, z: entryOffset.z * left };
      if (!(Math.hypot(entryOffset.x, entryOffset.y, entryOffset.z) > ENTRY_SETTLED_METERS)) entryOffset = null;
    }
    if (entryOffset) {
      camera.center = pos.add(new Vector3(entryOffset.x, entryOffset.y, entryOffset.z));
      options.requestRender?.();
    } else {
      camera.center = pos;
    }
  });

  // ── Pointer observer: click-to-select / click-to-deselect ────────────────

  const pointerObserver = scene.onPointerObservable.add((info) => {
    const event = info.event as PointerEvent;
    // Only react to primary mouse button — touch is handled by touchController
    if (event.pointerType !== "mouse" || suspended || disposed) return;

    if (info.type === PointerEventTypes.POINTERDOWN) {
      if (event.button !== 0) return;
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
      return;
    }

    if (info.type === PointerEventTypes.POINTERUP) {
      if (event.button !== 0) return;
      const dx = event.clientX - pointerDownX;
      const dy = event.clientY - pointerDownY;
      // Ignore if the pointer moved too far — this was a drag, not a click
      if (Math.hypot(dx, dy) >= dragThresholdPx()) return;

      const canvas = scene.getEngine().getRenderingCanvas();
      const canvasRect = canvas?.getBoundingClientRect();
      const pickX = canvasRect ? event.clientX - canvasRect.left : event.offsetX;
      const pickY = canvasRect ? event.clientY - canvasRect.top : event.offsetY;
      const pickResult = scene.pick(pickX, pickY);
      const pickedMesh = pickResult?.hit ? pickResult.pickedMesh : null;

      if (pickedMesh) {
        const poi = meshToPoiMap.get(pickedMesh);
        if (poi) {
          enterTracking(poi);
          return;
        }
      }

      // Click on empty space or a non-POI mesh — exit tracking if active
      if (currentPoi) {
        exitTracking();
      }
    }
  });

  // ── Public API ────────────────────────────────────────────────────────────

  function setPois(pois: PoiDescriptor[]): void {
    if (disposed) return;
    meshToPoiMap.clear();
    for (const poi of pois) {
      meshToPoiMap.set(poi.mesh, poi);
    }
    // If the tracked POI was removed from the set, exit cleanly
    if (currentPoi && !pois.includes(currentPoi)) {
      exitTracking();
    }
  }

  function destroy(): void {
    if (disposed) return; exitTracking(); disposed = true;
    scene.onBeforeRenderObservable.remove(renderObserver);
    scene.onPointerObservable.remove(pointerObserver);
    meshToPoiMap.clear();
    currentPoi = null;
  }

  function setSuspended(next: boolean): void {
    if (disposed) return;
    suspended = next;
  }

  return { setPois, enterTracking, exitTracking, isTracking, getOrbitTarget, setSuspended, destroy };
}
