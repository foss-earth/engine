import { Vector3, type Camera, type Scene } from "@babylonjs/core";
import {
  WGS84_A,
  WGS84_B,
  type EcefCoord,
} from "../camera/cameraMath.js";
import { cameraViewportFromTop } from "./worldViewport.js";

export interface ScreenPickInput {
  clientX: number;
  clientY: number;
  canvas: HTMLCanvasElement;
}

export interface ScreenAnchorError {
  anchorClientX: number;
  anchorClientY: number;
  dx: number;
  dy: number;
  lengthPx: number;
}

/** Ray–WGS84 ellipsoid intersection; returns the nearest hit in front of the ray. */
export function intersectRayWgs84Ellipsoid(origin: Vector3, direction: Vector3): Vector3 | null {
  const invA = 1 / WGS84_A;
  const invB = 1 / WGS84_B;
  const ox = origin.x * invA;
  const oy = origin.y * invA;
  const oz = origin.z * invB;
  const dx = direction.x * invA;
  const dy = direction.y * invA;
  const dz = direction.z * invB;

  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || a <= 0) {
    return null;
  }

  const sqrt = Math.sqrt(discriminant);
  let t = (-b - sqrt) / (2 * a);
  if (t < 0) {
    t = (-b + sqrt) / (2 * a);
  }
  if (t < 0) {
    return null;
  }

  return origin.add(direction.scale(t));
}

/**
 * Viewport size for screen↔world conversions.
 * Use CSS canvas dimensions (matches PropertyEarthMap tooltip projection).
 */
export function getCanvasViewportDimensions(
  canvas: HTMLCanvasElement,
  scene: Scene,
): { width: number; height: number } {
  const engine = scene.getEngine();
  return {
    width: canvas.clientWidth || engine.getRenderWidth(),
    height: canvas.clientHeight || engine.getRenderHeight(),
  };
}

/** Map a client pointer position into Babylon viewport coordinates. */
export function clientToViewportCoords(
  canvas: HTMLCanvasElement,
  scene: Scene,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const { width, height } = getCanvasViewportDimensions(canvas, scene);
  return {
    x: ((clientX - rect.left) / Math.max(rect.width, 1)) * width,
    y: ((clientY - rect.top) / Math.max(rect.height, 1)) * height,
  };
}

// Babylon's matrices are row-major and multiply row vectors (v' = v·M). Its
// own Project and Unproject go through float32 scratch matrices, which at
// ECEF scale put a point half a pixel off; these stay in float64, on the
// camera's own high-precision view and projection.

function invert4(m: ArrayLike<number>): number[] | null {
  const [m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23, m30, m31, m32, m33] = Array.from(m);
  const b00 = m00 * m11 - m01 * m10, b01 = m00 * m12 - m02 * m10, b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11, b04 = m01 * m13 - m03 * m11, b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30, b07 = m20 * m32 - m22 * m30, b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31, b10 = m21 * m33 - m23 * m31, b11 = m22 * m33 - m23 * m32;
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const k = 1 / determinant;
  return [
    (m11 * b11 - m12 * b10 + m13 * b09) * k, (m02 * b10 - m01 * b11 - m03 * b09) * k,
    (m31 * b05 - m32 * b04 + m33 * b03) * k, (m22 * b04 - m21 * b05 - m23 * b03) * k,
    (m12 * b08 - m10 * b11 - m13 * b07) * k, (m00 * b11 - m02 * b08 + m03 * b07) * k,
    (m32 * b02 - m30 * b05 - m33 * b01) * k, (m20 * b05 - m22 * b02 + m23 * b01) * k,
    (m10 * b10 - m11 * b08 + m13 * b06) * k, (m01 * b08 - m00 * b10 - m03 * b06) * k,
    (m30 * b04 - m31 * b02 + m33 * b00) * k, (m21 * b02 - m20 * b04 - m23 * b00) * k,
    (m11 * b07 - m10 * b09 - m12 * b06) * k, (m00 * b09 - m01 * b07 + m02 * b06) * k,
    (m31 * b01 - m30 * b03 - m32 * b00) * k, (m20 * b03 - m21 * b01 + m22 * b00) * k,
  ];
}

function transform4(m: ArrayLike<number>, x: number, y: number, z: number, w = 1): [number, number, number, number] {
  return [
    x * m[0] + y * m[4] + z * m[8] + w * m[12],
    x * m[1] + y * m[5] + z * m[9] + w * m[13],
    x * m[2] + y * m[6] + z * m[10] + w * m[14],
    x * m[3] + y * m[7] + z * m[11] + w * m[15],
  ];
}

/**
 * How the canvas's drawing maps to the page: the camera's viewport (the
 * world's part of the canvas) in CSS pixels of the canvas's layout box, from
 * its top-left corner, and where that box is drawn, which CSS transforms
 * may scale. The device pixel ratio and render resolution drop out: a point's
 * share of the viewport is the same in every unit.
 */
function canvasMapping(canvas: HTMLCanvasElement, scene: Scene, camera: Camera) {
  const { width, height } = getCanvasViewportDimensions(canvas, scene);
  const rect = canvas.getBoundingClientRect();
  // From the top, as client points are: Babylon's viewport is measured from the bottom.
  const viewport = cameraViewportFromTop(camera, width, height);
  return {
    viewport,
    left: rect.left, top: rect.top,
    scaleX: rect.width > 0 && width > 0 ? rect.width / width : 1,
    scaleY: rect.height > 0 && height > 0 ? rect.height / height : 1,
  };
}

/**
 * The ray through a client (CSS) point, from the eye, in float64: the exact
 * inverse of `projectEcefToClient`, through the camera's own view,
 * projection and viewport and the canvas's CSS scaling. Null when the
 * camera's matrices cannot be inverted.
 */
export function clientRay(
  scene: Scene,
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { origin: Vector3; direction: Vector3 } | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const mapping = canvasMapping(canvas, scene, camera);
  const { viewport } = mapping;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
  const x = (clientX - mapping.left) / mapping.scaleX;
  const y = (clientY - mapping.top) / mapping.scaleY;
  const ndcX = ((x - viewport.x) / viewport.width) * 2 - 1;
  const ndcY = 1 - ((y - viewport.y) / viewport.height) * 2;
  // Into view space through the projection alone, then out through the view: the large
  // ECEF translation never mixes with the projection's terms.
  const unproject = invert4(camera.getProjectionMatrix().m);
  const unview = invert4(camera.getViewMatrix().m);
  if (!unproject || !unview) return null;
  // In view space the eye is the origin, so one point on the ray gives its direction.
  // Depth runs -1 to 1 on WebGL and 0 to 1 on WebGPU, whose reversed infinite
  // projection puts 0 at infinity: 0.5 is a finite point in each. Ahead of the eye,
  // its w is positive.
  const at = transform4(unproject, ndcX, ndcY, 0.5);
  if (!(at[3] !== 0)) return null;
  const w = Math.abs(at[3]);
  const eye = transform4(unview, 0, 0, 0);
  const toward = transform4(unview, at[0] / w, at[1] / w, at[2] / w, 0);
  const origin = new Vector3(eye[0], eye[1], eye[2]);
  const direction = new Vector3(toward[0], toward[1], toward[2]);
  const length = direction.length();
  if (!(length > 0) || ![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(Number.isFinite)) return null;
  direction.scaleInPlace(1 / length);
  return { origin, direction };
}

/** Cast a screen-space pick ray and return the WGS84 ellipsoid hit, if any. */
export function pickEllipsoidFromScreen(
  scene: Scene,
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): Vector3 | null {
  const ray = clientRay(scene, camera, canvas, clientX, clientY);
  return ray ? intersectRayWgs84Ellipsoid(ray.origin, ray.direction) : null;
}

/**
 * Project a world/ECEF point to client (CSS) coordinates, in float64, through
 * the camera's viewport and the canvas's CSS scaling. Null behind the camera.
 */
export function projectEcefToClient(
  worldPoint: Vector3,
  scene: Scene,
  camera: Camera,
  canvas: HTMLCanvasElement,
): { x: number; y: number } | null {
  const mapping = canvasMapping(canvas, scene, camera);
  const view = transform4(camera.getViewMatrix().m, worldPoint.x, worldPoint.y, worldPoint.z);
  const clip = transform4(camera.getProjectionMatrix().m, view[0], view[1], view[2], view[3]);
  if (!(clip[3] > 0)) return null;
  const ndcX = clip[0] / clip[3], ndcY = clip[1] / clip[3];
  const { viewport } = mapping;
  const x = viewport.x + ((ndcX + 1) / 2) * viewport.width;
  const y = viewport.y + ((1 - ndcY) / 2) * viewport.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: mapping.left + x * mapping.scaleX, y: mapping.top + y * mapping.scaleY };
}

/**
 * Screen-space segment from the projected grab point to the cursor.
 * `fallbackAnchorClient` is used when projection fails (e.g. before the next render).
 */
export function computeScreenAnchorError(
  anchor: Vector3,
  cursorClientX: number,
  cursorClientY: number,
  scene: Scene,
  camera: Camera,
  canvas: HTMLCanvasElement,
  fallbackAnchorClient?: { x: number; y: number },
): ScreenAnchorError | null {
  const projected = projectEcefToClient(anchor, scene, camera, canvas);
  const anchorClientX = projected?.x ?? fallbackAnchorClient?.x;
  const anchorClientY = projected?.y ?? fallbackAnchorClient?.y;
  if (anchorClientX === undefined || anchorClientY === undefined) {
    return null;
  }

  const dx = cursorClientX - anchorClientX;
  const dy = cursorClientY - anchorClientY;
  return {
    anchorClientX,
    anchorClientY,
    dx,
    dy,
    lengthPx: Math.hypot(dx, dy),
  };
}

export function ecefToVector3(coord: EcefCoord): Vector3 {
  return new Vector3(coord.x, coord.y, coord.z);
}

export function vector3ToEcef(vector: Vector3): EcefCoord {
  return { x: vector.x, y: vector.y, z: vector.z };
}

/** Shortest rotation carrying one surface direction onto another. */
export function rotationFromTo(from: Vector3, to: Vector3): { axis: Vector3; angleRad: number } | null {
  const fromUnit = from.normalize();
  const toUnit = to.normalize();
  const dot = Vector3.Dot(fromUnit, toUnit);
  if (dot > 0.999999 || dot < -0.999999) {
    return null;
  }

  const axis = Vector3.Cross(fromUnit, toUnit);
  const axisLen = axis.length();
  if (axisLen < 1e-12) {
    return null;
  }
  axis.scaleInPlace(1 / axisLen);
  return { axis, angleRad: Math.acos(Math.max(-1, Math.min(1, dot))) };
}
