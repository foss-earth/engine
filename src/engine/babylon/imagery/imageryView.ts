import { Matrix, Vector3, type Scene, type TransformNode } from "@babylonjs/core";
import { multiplyMatrices, type ImageryView } from "../../../terrain/imagery/imageryGeometry";

const worldToEcef = new Matrix();
const eye = new Vector3();

/**
 * The active camera as an imagery view: ECEF straight to clip space, through
 * the world root's transform when a floating origin moves the world. The
 * render size is the actual buffer after hardware scaling, not CSS size times
 * an assumed device pixel ratio.
 */
export function readImageryView(scene: Scene, worldRoot: TransformNode | null): ImageryView | null {
  const camera = scene.activeCamera;
  const engine = scene.getEngine();
  if (!camera) return null;
  const renderWidth = engine.getRenderWidth();
  const renderHeight = engine.getRenderHeight();
  if (renderWidth <= 0 || renderHeight <= 0) return null;
  const projection = camera.getProjectionMatrix().m;
  const viewProjection = multiplyMatrices(camera.getViewMatrix().m, projection);
  const world = worldRoot ? worldRoot.computeWorldMatrix(true) : null;
  const ecefToClip = world ? multiplyMatrices(world.m, viewProjection) : viewProjection;
  eye.copyFrom(camera.globalPosition);
  if (world) {
    world.invertToRef(worldToEcef);
    Vector3.TransformCoordinatesToRef(eye, worldToEcef, eye);
  }
  const canvas = engine.getRenderingCanvas();
  const logicalWidth = canvas?.clientWidth || renderWidth;
  const logicalHeight = canvas?.clientHeight || renderHeight;
  const halfZ = engine.isNDCHalfZRange;
  const reverse = engine.useReverseDepthBuffer;
  // Inside the near plane: z >= -w (WebGL), z >= 0 (WebGPU), z <= w (reversed depth).
  const nearPlane = reverse ? { z: -1, w: 1 } : halfZ ? { z: 1, w: 0 } : { z: 1, w: 1 };
  return {
    ecefToClip,
    pixelAngle: 2 / (Math.abs(projection[5]) * renderHeight),
    nearPlane,
    camera: { x: eye.x, y: eye.y, z: eye.z },
    renderWidth,
    renderHeight,
    logicalWidth,
    logicalHeight,
  };
}

/** True when two views differ enough to select imagery again. */
export function imageryViewChanged(a: ImageryView | null, b: ImageryView | null): boolean {
  if (!a || !b) return a !== b;
  if (a.renderWidth !== b.renderWidth || a.renderHeight !== b.renderHeight) return true;
  if (a.logicalWidth !== b.logicalWidth || a.logicalHeight !== b.logicalHeight) return true;
  for (let index = 0; index < 16; index++) {
    const x = a.ecefToClip[index], y = b.ecefToClip[index];
    if (Math.abs(x - y) > 1e-7 * Math.max(1, Math.abs(x), Math.abs(y))) return true;
  }
  return false;
}
