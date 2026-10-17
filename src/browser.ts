/** Optional browser realm binding; importing this module starts no input or clock. */
import { createNavigationOwner, type NavigationHost, type NavigationOwner } from "./navigation/navigationLease.js";
import { createInertialCameraController, type CameraInputTarget, type InertialCameraOptions, type InertialCameraController } from "./input/inertialCameraController.js";

export * from "./browser/createInputController.js";
export * from "./browser/wheelController.js";
export * from "./browser/mouseController.js";
export * from "./browser/touchController.js";
export * from "./browser/safariGestures.js";
export * from "./browser/anchorPanDebugOverlay.js";
export * from "./browser/navigationAnchorMarkers.js";
export * from "./browser/worldViewport.js";

export type BrowserNavigationHost = Omit<NavigationHost<Element, AbortSignal>, "focusReturn" | "createAbortController" | "abortReason">;
export interface BrowserNavigationPorts {
  document: Pick<Document, "activeElement">;
  createAbortController(): AbortController;
  abortReason(reason: Parameters<NavigationHost["abortReason"]>[0]): unknown;
}
/** The host supplies its DOM/cancellation realm and the one renderer's frame methods. */
export function createBrowserNavigationOwner(host: BrowserNavigationHost, ports: BrowserNavigationPorts): NavigationOwner<Element, AbortSignal> {
  return createNavigationOwner({ ...host, focusReturn: () => ports.document.activeElement,
    createAbortController: ports.createAbortController, abortReason: ports.abortReason });
}
/** Legacy browser target uses a canvas; time still comes from the supplied host clock. */
export function createBrowserInertialCameraController(target: CameraInputTarget<HTMLCanvasElement>, options: InertialCameraOptions): InertialCameraController<HTMLCanvasElement> {
  return createInertialCameraController(target, options);
}
export * from "./browser/passToWorld.js";
export * from "./browser/geoid.js";
export * from "./browser/mapCache.js";
export * from "./browser/mapDownloadMeter.js";
export * from "./browser/describeGoogleTileFailure.js";
export * from "./browser/boundedAtlasImageryLoader.js";

export * from "./browser/terrainImageDecoder.js";
export * from "./browser/terrainNativeDecoder.js";
export * from "./browser/atlasImageryWorkerBridge.js";
export * from "./browser/atlasImageryWorkerKernel.js";
export * from "./browser/atlasImageryWorkerProtocol.js";
export * from "./browser/workerPool.js";
export * from "./browser/terrainDecodeWorkers.js";
export * from "./browser/terrainDecodeWorkerKernel.js";
export * from "./browser/terrainDecodeWorkerProtocol.js";
export * from "./browser/terrainMeshWorkerProtocol.js";
export * from "./browser/terrainMeshWorkerKernel.js";
export * from "./browser/terrainMeshWorkers.js";
