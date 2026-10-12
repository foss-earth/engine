import type { RenderScheduler } from "@foss-earth/renderer";
import { createInertialCameraController, type InertialCameraController } from "../input/inertialCameraController.js";
import type { NavigationAnchor } from "../input/navigationAnchors.js";
import type { CameraController } from "./cameraState.js";
import type { NavigationAnchorService } from "./navigationAnchorService.js";
export interface GlobeInertiaPorts {
  nowMs(): number;
  /** One live camera.inertiaDecay; no additional handover or gesture decay. */
  decayPerFrame(): number;
  renderer: Pick<RenderScheduler, "requestRender">;
  /** Where gestures zoom and turn about; without it, about the orbit target. */
  anchors?: Pick<NavigationAnchorService, "acquire" | "hold" | "release" | "isCurrent">;
}
/** Source request-on-input wrapper; target and renderer are supplied, no animation loop is created. */
export function createGlobeInertia(controller: CameraController, ports: GlobeInertiaPorts): InertialCameraController<HTMLCanvasElement> {
  const base = createInertialCameraController<HTMLCanvasElement>(controller, ports);
  const anchors = ports.anchors;
  // A gesture's anchor from before its context was cleared (the view replaced, navigation leased) is the orbit target's.
  const current = (anchor?: NavigationAnchor | null): NavigationAnchor | null => (anchor && anchors && !anchors.isCurrent(anchor) ? null : anchor ?? null);
  return {
    panBy(dx, dy, height) { base.panBy(dx, dy, height); ports.renderer.requestRender(); },
    orbitBy(pitch, heading, anchor) { base.orbitBy(pitch, heading, current(anchor)); ports.renderer.requestRender(); },
    zoomBy(factor, anchor) { base.zoomBy(factor, current(anchor)); ports.renderer.requestRender(); },
    ...(anchors ? {
      acquireAnchors: request => anchors.acquire(request),
      holdAnchors: acquisition => anchors.hold(acquisition),
      releaseAnchors: acquisition => anchors.release(acquisition),
    } satisfies Pick<InertialCameraController<HTMLCanvasElement>, "acquireAnchors" | "holdAnchors" | "releaseAnchors"> : {}),
    beginAnchorPan(pick) { base.cancel(); return controller.beginAnchorPan(pick); },
    panAnchorTo(pick, sensitivity) { const moved = controller.panAnchorTo(pick, sensitivity); if (moved) ports.renderer.requestRender(); return moved; },
    getAnchorPanScreenError: pick => controller.getAnchorPanScreenError(pick),
    endAnchorPan: () => controller.endAnchorPan(),
    update: base.update,
    cancelInertial: base.cancel,
    cancel() { base.cancel(); controller.endAnchorPan(); },
    isActive: base.isActive,
    anchors: base.anchors,
    motion: base.motion,
    rebaseTo(next) { base.rebaseTo(next); ports.renderer.requestRender(); },
  };
}
