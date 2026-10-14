import { Viewport, type Camera, type Scene } from "@babylonjs/core";
import { commitWorldViewport, requestedWorldViewport, type WorldViewportRect } from "../browser/worldViewport.js";

/** A camera's viewport in a `width` × `height` box, from the top-left corner. Babylon measures its viewport from the bottom. */
export function cameraViewportFromTop(camera: Pick<Camera, "viewport">, width: number, height: number): WorldViewportRect {
  const viewport = camera.viewport;
  return {
    x: viewport.x * width,
    y: (1 - viewport.y - viewport.height) * height,
    width: viewport.width * width,
    height: viewport.height * height,
  };
}

/**
 * The render pixels a CSS rectangle covers, from the top-left corner. Each
 * edge rounds on its own, as surface rectangles do, so the world meets a
 * neighboring surface without a gap; the world keeps at least one pixel.
 */
export function worldRenderRect(css: WorldViewportRect, cssWidth: number, cssHeight: number, renderWidth: number, renderHeight: number): WorldViewportRect {
  const scaleX = renderWidth / cssWidth, scaleY = renderHeight / cssHeight;
  const clamp = (value: number, limit: number): number => Math.min(Math.max(value, 0), limit);
  const x0 = clamp(Math.round(css.x * scaleX), renderWidth - 1), y0 = clamp(Math.round(css.y * scaleY), renderHeight - 1);
  const x1 = clamp(Math.round((css.x + css.width) * scaleX), renderWidth), y1 = clamp(Math.round((css.y + css.height) * scaleY), renderHeight);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

// Babylon floors (WebGPU) or truncates (WebGL) the pixel viewport it makes
// from these fractions; a thousandth of a pixel keeps whole edges whole.
const NUDGE_PX = 1e-3;

/** Points the active camera's viewport at the world's part of the canvas, and records what it draws. */
export function applyWorldViewport(scene: Scene, canvas: HTMLCanvasElement): void {
  const camera = scene.activeCamera;
  if (!camera) return;
  const engine = scene.getEngine();
  const renderWidth = engine.getRenderWidth(), renderHeight = engine.getRenderHeight();
  const cssWidth = canvas.clientWidth, cssHeight = canvas.clientHeight;
  let next = { x: 0, y: 0, width: 1, height: 1 };
  if (renderWidth > 0 && renderHeight > 0 && cssWidth > 0 && cssHeight > 0) {
    const pixels = worldRenderRect(requestedWorldViewport(canvas), cssWidth, cssHeight, renderWidth, renderHeight);
    if (pixels.x !== 0 || pixels.y !== 0 || pixels.width !== renderWidth || pixels.height !== renderHeight) {
      next = {
        x: (pixels.x + NUDGE_PX) / renderWidth,
        y: (renderHeight - pixels.y - pixels.height + NUDGE_PX) / renderHeight,
        width: (pixels.width + NUDGE_PX) / renderWidth,
        height: (pixels.height + NUDGE_PX) / renderHeight,
      };
    }
    commitWorldViewport(canvas, {
      x: pixels.x * cssWidth / renderWidth,
      y: pixels.y * cssHeight / renderHeight,
      width: pixels.width * cssWidth / renderWidth,
      height: pixels.height * cssHeight / renderHeight,
    });
  } else {
    commitWorldViewport(canvas, null);
  }
  const current = camera.viewport;
  if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) {
    camera.viewport = new Viewport(next.x, next.y, next.width, next.height);
  }
}

/**
 * Applies the world viewport before each render, to whichever camera is
 * active then. The host frame also applies it before preparing the frame,
 * so everything prepared from the camera sees this frame's viewport.
 */
export function attachWorldViewport(scene: Scene, canvas: HTMLCanvasElement): { apply(): void; dispose(): void } {
  const apply = (): void => applyWorldViewport(scene, canvas);
  const observer = scene.onBeforeRenderObservable.add(apply, undefined, true);
  return {
    apply,
    dispose() {
      scene.onBeforeRenderObservable.remove(observer);
      commitWorldViewport(canvas, null);
    },
  };
}
