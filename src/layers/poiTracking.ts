import { PointerEventTypes } from "@babylonjs/core";
import type { AbstractMesh, GeospatialCamera, Scene, Vector3 } from "@babylonjs/core";
import { DEFAULT_INPUT_RATES } from "../input/inputRates";
import type { PoiDescriptor } from "./types";

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
}

/**
 * Creates a POI tracking controller that:
 *  - Watches left mouse clicks (pointerdown → pointerup moving less than the drag threshold).
 *  - On click: picks the scene at the click position.
 *    - If the hit mesh is a registered POI → enter tracking mode.
 *    - Otherwise (empty space or non-POI) → exit tracking if active.
 *  - Each frame: updates the GeospatialCamera's orbit center to the tracked
 *    POI's current ECEF position so the camera "follows" the POI.
 *
 * Touch events are intentionally excluded — those are handled by touchController.
 */
export function createPoiTracking(
  scene: Scene,
  getCamera: () => GeospatialCamera | null,
  options: PoiTrackingOptions = {},
): PoiTrackingHandle {
  const dragThresholdPx = options.dragThresholdPx ?? (() => DEFAULT_INPUT_RATES.mouseDragThresholdPx);
  const meshToPoiMap = new Map<AbstractMesh, PoiDescriptor>();
  let currentPoi: PoiDescriptor | null = null;
  let suspended = false;
  let pointerDownX = 0;
  let pointerDownY = 0;

  // ── Core tracking actions ─────────────────────────────────────────────────

  function enterTracking(poi: PoiDescriptor): void {
    if (currentPoi === poi) return;
    currentPoi?.onTrackingExit?.();
    currentPoi = poi;
    poi.onTrackingEnter?.();
    // Snap orbit center immediately on entry
    const camera = getCamera();
    const pos = poi.getPosition();
    if (camera && pos) {
      camera.center = pos;
    }
    console.info(`[poi-tracking] entered tracking poi=${poi.mesh.name}`);
  }

  function exitTracking(): void {
    if (!currentPoi) return;
    const name = currentPoi.mesh.name;
    currentPoi.onTrackingExit?.();
    currentPoi = null;
    console.info(`[poi-tracking] exited tracking poi=${name}`);
  }

  function isTracking(): boolean {
    return currentPoi !== null;
  }

  function getOrbitTarget(): Vector3 | null {
    return currentPoi?.getPosition() ?? null;
  }

  // ── Before-render: keep orbit center locked to the tracked POI ────────────

  const renderObserver = scene.onBeforeRenderObservable.add(() => {
    if (!currentPoi || suspended) return;
    const camera = getCamera();
    const pos = currentPoi.getPosition();
    if (camera && pos) {
      camera.center = pos;
    }
  });

  // ── Pointer observer: click-to-select / click-to-deselect ────────────────

  const pointerObserver = scene.onPointerObservable.add((info) => {
    const event = info.event as PointerEvent;
    // Only react to primary mouse button — touch is handled by touchController
    if (event.pointerType !== "mouse" || suspended) return;

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
    scene.onBeforeRenderObservable.remove(renderObserver);
    scene.onPointerObservable.remove(pointerObserver);
    meshToPoiMap.clear();
    currentPoi = null;
  }

  function setSuspended(next: boolean): void {
    suspended = next;
  }

  return { setPois, enterTracking, exitTracking, isTracking, getOrbitTarget, setSuspended, destroy };
}
