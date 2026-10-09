import type { RenderScheduler } from "@foss-earth/renderer";
import { createInertialCameraController, type InertialCameraController } from "../input/inertialCameraController.js";
import type { CameraController } from "./cameraState.js";
export interface GlobeInertiaPorts {
  nowMs(): number;
  /** One live camera.inertiaDecay; no additional handover or gesture decay. */
  decayPerFrame(): number;
  renderer: Pick<RenderScheduler, "requestRender">;
}
/** Source request-on-input wrapper; target and renderer are supplied, no animation loop is created. */
export function createGlobeInertia(controller: CameraController, ports: GlobeInertiaPorts): InertialCameraController<HTMLCanvasElement> {
  const base = createInertialCameraController<HTMLCanvasElement>(controller, ports);
  return {
    panBy(dx, dy, height) { base.panBy(dx, dy, height); ports.renderer.requestRender(); },
    orbitBy(pitch, heading) { base.orbitBy(pitch, heading); ports.renderer.requestRender(); },
    zoomBy(factor) { base.zoomBy(factor); ports.renderer.requestRender(); },
    beginAnchorPan(pick) { base.cancel(); return controller.beginAnchorPan(pick); },
    panAnchorTo(pick, sensitivity) { const moved = controller.panAnchorTo(pick, sensitivity); if (moved) ports.renderer.requestRender(); return moved; },
    getAnchorPanScreenError: pick => controller.getAnchorPanScreenError(pick),
    endAnchorPan: () => controller.endAnchorPan(),
    update: base.update,
    cancelInertial: base.cancel,
    cancel() { base.cancel(); controller.endAnchorPan(); },
    isActive: base.isActive,
  };
}
