import { Matrix, Vector3, type Camera, type Scene } from "@babylonjs/core";
import {
  WGS84_A,
  WGS84_B,
  type EcefCoord,
} from "./cameraMath";

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

function buildPickRay(
  scene: Scene,
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { origin: Vector3; direction: Vector3 } {
  const { width, height } = getCanvasViewportDimensions(canvas, scene);
  const { x, y } = clientToViewportCoords(canvas, scene, clientX, clientY);
  const world = Matrix.Identity();
  const view = camera.getViewMatrix();
  const projection = camera.getProjectionMatrix();
  const near = Vector3.Unproject(new Vector3(x, y, 0), width, height, world, view, projection);
  const far = Vector3.Unproject(new Vector3(x, y, 1), width, height, world, view, projection);
  const direction = far.subtract(near);
  const len = direction.length();
  if (len < 1e-12) {
    return { origin: near, direction: new Vector3(0, 0, 1) };
  }
  direction.scaleInPlace(1 / len);
  return { origin: near, direction };
}

/** Cast a screen-space pick ray and return the WGS84 ellipsoid hit, if any. */
export function pickEllipsoidFromScreen(
  scene: Scene,
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): Vector3 | null {
  const { origin, direction } = buildPickRay(scene, camera, canvas, clientX, clientY);
  return intersectRayWgs84Ellipsoid(origin, direction);
}

/** Project a world/ECEF point to client (CSS) coordinates. */
export function projectEcefToClient(
  worldPoint: Vector3,
  scene: Scene,
  camera: Camera,
  canvas: HTMLCanvasElement,
): { x: number; y: number } | null {
  const { width, height } = getCanvasViewportDimensions(canvas, scene);
  const viewport = camera.viewport.toGlobal(width, height);
  const projected = Vector3.Project(
    worldPoint,
    Matrix.Identity(),
    camera.getTransformationMatrix(),
    viewport,
  );
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z <= 0) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.left + projected.x,
    y: rect.top + projected.y,
  };
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

/** How aggressively each pointer move closes the anchor→cursor screen gap. */
export const ANCHOR_PAN_CHASE = {
  /** Stop correcting once the gap is below this (px). */
  donePx: 0.5,
  /** Minimum fraction of screen error applied per move (smooth tail). */
  minFactor: 0.72,
  /** Maximum fraction — large gaps close in one step. */
  maxFactor: 1,
  /** Error length (px) at which chase reaches maxFactor. */
  fullChasePx: 48,
} as const;
