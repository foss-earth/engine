/**
 * Synthetic cameras for imagery tests and fixtures: an ECEF look-at view with
 * a right-handed perspective or orthographic projection, in Babylon's
 * row-vector matrix layout and WebGL depth range.
 */

import { DEG_TO_RAD, geodeticToEcef } from "../../camera/cameraMath";
import { multiplyMatrices as multiply, type ImageryView, type Vec3 } from "./imageryGeometry";

export interface TestViewOptions {
  latDeg: number;
  lonDeg: number;
  altitudeMeters: number;
  /** 0 looks straight down; 90 looks at the horizon. */
  pitchDeg?: number;
  headingDeg?: number;
  fovYDeg?: number;
  renderWidth?: number;
  renderHeight?: number;
  /** CSS pixels; defaults to the render size (DPR 1). */
  logicalWidth?: number;
  logicalHeight?: number;
  near?: number;
  far?: number;
  /** Half-height of an orthographic view in metres. */
  orthographicHalfHeight?: number;
  /** A rigid world transform applied to everything, e.g. a floating origin. */
  worldTransform?: { rotationZDeg: number; translation: Vec3 };
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a.x, a.y, a.z));

function rigid(rotationZDeg: number, translation: Vec3): number[] {
  const c = Math.cos(rotationZDeg * DEG_TO_RAD), s = Math.sin(rotationZDeg * DEG_TO_RAD);
  // Row-vector: [x y z 1] * M rotates about Z, then translates.
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, translation.x, translation.y, translation.z, 1];
}

function applyRigid(m: number[], p: Vec3): Vec3 {
  return {
    x: p.x * m[0] + p.y * m[4] + p.z * m[8] + m[12],
    y: p.x * m[1] + p.y * m[5] + p.z * m[9] + m[13],
    z: p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14],
  };
}

export function createTestView(options: TestViewOptions): ImageryView {
  const lat = options.latDeg * DEG_TO_RAD, lon = options.lonDeg * DEG_TO_RAD;
  const eyeEcef = geodeticToEcef(lat, lon, options.altitudeMeters);
  const up = { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
  const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
  const north = cross(up, east);
  const pitch = (options.pitchDeg ?? 0) * DEG_TO_RAD;
  const heading = (options.headingDeg ?? 0) * DEG_TO_RAD;
  const horizontal = add(scale(north, Math.cos(heading)), scale(east, Math.sin(heading)));
  let direction = normalize(add(scale(up, -Math.cos(pitch)), scale(horizontal, Math.sin(pitch))));
  let upHint = Math.abs(pitch) < 1e-6 ? horizontal : up;
  let eye: Vec3 = eyeEcef;

  const world = options.worldTransform ? rigid(options.worldTransform.rotationZDeg, options.worldTransform.translation) : null;
  if (world) {
    // The camera lives in the transformed world, like a floating-origin scene.
    eye = applyRigid(world, eyeEcef);
    const linear = [...world.slice(0, 12), 0, 0, 0, 1];
    direction = normalize(applyRigid(linear, direction));
    upHint = normalize(applyRigid(linear, upHint));
  }

  // Right-handed look-at: the camera looks down its -Z axis.
  const zAxis = scale(direction, -1);
  const xAxis = normalize(cross(upHint, zAxis));
  const yAxis = cross(zAxis, xAxis);
  const viewMatrix = [
    xAxis.x, yAxis.x, zAxis.x, 0,
    xAxis.y, yAxis.y, zAxis.y, 0,
    xAxis.z, yAxis.z, zAxis.z, 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1,
  ];
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const aspect = renderWidth / renderHeight;
  const near = options.near ?? 1;
  const far = options.far ?? 5e7;
  let projection: number[];
  if (options.orthographicHalfHeight) {
    const top = options.orthographicHalfHeight, right = top * aspect;
    projection = [
      1 / right, 0, 0, 0,
      0, 1 / top, 0, 0,
      0, 0, -2 / (far - near), 0,
      0, 0, -(far + near) / (far - near), 1,
    ];
  } else {
    const f = 1 / Math.tan(((options.fovYDeg ?? 60) * DEG_TO_RAD) / 2);
    projection = [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ];
  }
  let ecefToClip = multiply(viewMatrix, projection);
  if (world) ecefToClip = multiply(world, ecefToClip);
  return {
    ecefToClip,
    nearPlane: { z: 1, w: 1 },
    camera: eyeEcef,
    renderWidth,
    renderHeight,
    logicalWidth: options.logicalWidth ?? renderWidth,
    logicalHeight: options.logicalHeight ?? renderHeight,
  };
}
