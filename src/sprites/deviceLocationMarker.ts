import { Matrix, Vector3, type Scene, type Sprite, type SpriteManager, type TransformNode } from "@babylonjs/core";
import type { CanvasTextureDevicePorts } from "@foss-earth/renderer/babylon";
import type { EcefCoord } from "../camera/cameraMath.js";
import {
  accuracySpriteSize, DEVICE_LOCATION_ACCURACY_LIFT_M, DEVICE_LOCATION_ACCURACY_OPACITY, DEVICE_LOCATION_BLUE,
  DEVICE_LOCATION_DOT_LIFT_M, DEVICE_LOCATION_DOT_PX, DEVICE_LOCATION_DOT_STROKE, screenConstantSpriteSize,
  type DeviceLocationFix,
} from "../location/deviceLocation.js";
import { smoothSurfaceEcef } from "../terrain/smoothElevation.js";
import { makeCircularMarkerAtlas } from "./atlas.js";
import { createPointSprite, createPointSpriteManager, disposeSpriteManagers } from "./spriteManager.js";
import { DEFAULT_DOT_TEXTURE_SIZE } from "./types.js";

/**
 * After the world. A phone's depth buffer cannot tell a marker a few metres
 * above the ground from the ground itself, so this group clears depth and the
 * circles stay visible. Nothing else renders here.
 */
const MARKER_RENDERING_GROUP = 3;
const SOLID_CELL = 1;
const OCCLUDED_CELL = 2;
/** Short of the point, as the navigation anchors do, so the surface under the dot is not itself a hit. */
const OCCLUSION_REACH = 0.995;

export interface DeviceLocationSurfaceHit {
  point: EcefCoord;
  normal: EcefCoord;
}

export interface DeviceLocationMarkerOptions {
  scene: Scene;
  device: CanvasTextureDevicePorts;
  requestRender(): void;
  /** Scene transform of a simulation's floating origin. Absent on the globe, where ECEF is already scene space. */
  getWorldRoot?(): TransformNode | null;
  /** Displayed ground, in ECEF. The smooth surface is used until this hits. */
  sampleSurface?(latDeg: number, lonDeg: number): DeviceLocationSurfaceHit | null;
  surfaceRevision?(): number;
  /** Displayed ground between an ECEF eye and a point. A hit means the dot is behind the map. */
  raycastSurface?(origin: EcefCoord, direction: EcefCoord, lengthMeters: number): unknown;
}

export interface DeviceLocationMarker {
  /** `null` hides the dot and the accuracy disc. */
  show(fix: DeviceLocationFix | null): void;
  destroy(): void;
}

export interface DeviceLocationScene {
  scene: Scene;
  requestRender(): void;
  getWorldRoot(): TransformNode | null;
  surface: {
    sample(latDeg: number, lonDeg: number): DeviceLocationSurfaceHit | null;
    revision?(): number;
    raycast?(origin: EcefCoord, direction: EcefCoord, lengthMeters: number): unknown;
  };
}

/** The globe runtime's scene, render request and ground query, with a host-owned canvas device. */
export function createSceneDeviceLocationMarker(runtime: DeviceLocationScene, device: CanvasTextureDevicePorts): DeviceLocationMarker {
  return createDeviceLocationMarker({
    scene: runtime.scene,
    device,
    requestRender: () => runtime.requestRender(),
    getWorldRoot: () => runtime.getWorldRoot(),
    sampleSurface: (latDeg, lonDeg) => runtime.surface.sample(latDeg, lonDeg),
    surfaceRevision: () => runtime.surface.revision?.() ?? 0,
    raycastSurface: runtime.surface.raycast
      ? (origin, direction, length) => runtime.surface.raycast?.(origin, direction, length)
      : undefined,
  });
}

function finite(value: EcefCoord | undefined): value is EcefCoord {
  return !!value && [value.x, value.y, value.z].every(Number.isFinite);
}

function liftEcef(point: EcefCoord, normal: EcefCoord, meters: number): EcefCoord {
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (!(length > 0)) return point;
  return {
    x: point.x + normal.x / length * meters,
    y: point.y + normal.y / length * meters,
    z: point.z + normal.z / length * meters,
  };
}

function toScene(ecef: EcefCoord, root: TransformNode | null): Vector3 {
  const point = new Vector3(ecef.x, ecef.y, ecef.z);
  return root ? Vector3.TransformCoordinates(point, root.computeWorldMatrix(true)) : point;
}

function sceneToEcef(point: Vector3, root: TransformNode | null): EcefCoord {
  const ecef = root ? Vector3.TransformCoordinates(point, Matrix.Invert(root.computeWorldMatrix(true))) : point;
  return { x: ecef.x, y: ecef.y, z: ecef.z };
}

function readSurface(sample: DeviceLocationMarkerOptions["sampleSurface"], fix: DeviceLocationFix): DeviceLocationSurfaceHit | null {
  if (!sample) return null;
  try {
    const hit = sample(fix.latDeg, fix.lonDeg);
    if (!hit || !finite(hit.point) || !finite(hit.normal) || !(Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z) > 0)) return null;
    return hit;
  } catch {
    return null;
  }
}

/**
 * Two camera-facing circle sprites at the device fix: a blue dot that stays a
 * constant size on screen, and a larger translucent disc whose diameter is the
 * reported accuracy. Ground between the camera and the dot paints an X on the
 * dot's blue fill, the same pattern the navigation anchors use.
 */
export function createDeviceLocationMarker(options: DeviceLocationMarkerOptions): DeviceLocationMarker {
  const cellSize = DEFAULT_DOT_TEXTURE_SIZE;
  let disposed = false;
  let fix: DeviceLocationFix | null = null;
  let cache: { key: string; accuracy: EcefCoord; dot: EcefCoord; ground: EcefCoord } | null = null;
  let manager: SpriteManager | null = null;
  let accuracy: Sprite | null = null;
  let dot: Sprite | null = null;

  const observer = options.scene.onBeforeRenderObservable.add(() => { place(); });

  function destroy(): void {
    if (disposed) return;
    disposed = true;
    fix = null;
    cache = null;
    try { options.scene.onBeforeRenderObservable.remove(observer); }
    catch { /* The scene can already be gone. */ }
    const owned = manager;
    manager = null;
    accuracy = null;
    dot = null;
    clearDepthForMarker(false);
    if (owned) disposeSpriteManagers([owned]);
  }

  function clearDepthForMarker(enabled: boolean): void {
    try { options.scene.setRenderingAutoClearDepthStencil(MARKER_RENDERING_GROUP, enabled, true, false); }
    catch { /* The scene can already be gone. */ }
  }

  function ensure(): void {
    if (manager || disposed) return;
    const texture = makeCircularMarkerAtlas(options.device, "device-location", [
      { fill: DEVICE_LOCATION_BLUE, stroke: DEVICE_LOCATION_BLUE, strokeWidth: 0 },
      { fill: DEVICE_LOCATION_BLUE, stroke: DEVICE_LOCATION_DOT_STROKE },
      { fill: DEVICE_LOCATION_BLUE, stroke: DEVICE_LOCATION_DOT_STROKE, obscuredSizePx: DEVICE_LOCATION_DOT_PX },
    ], cellSize);
    try {
      manager = createPointSpriteManager({
        scene: options.scene, name: "device-location", capacity: 2, minCapacity: 2, texture, cellSize,
        renderingGroupId: MARKER_RENDERING_GROUP, isPickable: false,
      });
      manager.disableDepthWrite = true;
      manager.fogEnabled = false;
      accuracy = createPointSprite({
        manager, name: "device-location-accuracy", position: Vector3.Zero(), size: 1,
        cellIndex: 0, opacity: DEVICE_LOCATION_ACCURACY_OPACITY, isPickable: false,
      });
      dot = createPointSprite({
        manager, name: "device-location", position: Vector3.Zero(), size: 1, cellIndex: SOLID_CELL, isPickable: false,
      });
      accuracy.isVisible = false;
      dot.isVisible = false;
    } catch (error) {
      try { if (manager) disposeSpriteManagers([manager]); else texture.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Device location marker cleanup failed."); }
      manager = null;
      accuracy = null;
      dot = null;
      throw error;
    }
  }

  function placement(): { accuracy: EcefCoord; dot: EcefCoord; ground: EcefCoord } | null {
    if (!fix) return null;
    const revision = options.surfaceRevision?.() ?? 0;
    const key = `${fix.latDeg}:${fix.lonDeg}:${fix.accuracyMeters}:${revision}`;
    if (cache?.key === key) return cache;
    const hit = readSurface(options.sampleSurface, fix);
    const point = hit?.point ?? smoothSurfaceEcef(fix.latDeg, fix.lonDeg, 0);
    const normal = hit?.normal ?? point;
    const next = {
      key,
      accuracy: liftEcef(point, normal, DEVICE_LOCATION_ACCURACY_LIFT_M),
      dot: liftEcef(point, normal, DEVICE_LOCATION_DOT_LIFT_M),
      ground: point,
    };
    cache = next;
    return next;
  }

  function place(): void {
    if (disposed || !accuracy || !dot) return;
    const at = placement();
    if (!fix || !at) {
      accuracy.isVisible = false;
      dot.isVisible = false;
      return;
    }
    const root = options.getWorldRoot?.() ?? null;
    accuracy.position.copyFrom(toScene(at.accuracy, root));
    dot.position.copyFrom(toScene(at.dot, root));
    const diameter = accuracySpriteSize(fix.accuracyMeters, cellSize);
    accuracy.size = diameter;
    accuracy.isVisible = diameter > 0;
    const camera = options.scene.activeCamera;
    // The camera's matrix is otherwise from the previous frame; the dot's size has to match where it is now.
    (camera as { computeWorldMatrix?(force: boolean): void } | null)?.computeWorldMatrix?.(true);
    const distance = camera ? Vector3.Distance(camera.globalPosition, dot.position) : 0;
    const fov = camera && "fov" in camera && typeof camera.fov === "number" ? camera.fov : 0;
    const sized = screenConstantSpriteSize(distance, fov, options.scene.getEngine().getRenderHeight(), DEVICE_LOCATION_DOT_PX);
    if (sized > 0) dot.size = sized;
    dot.cellIndex = groundHides(at.ground, root, camera) ? OCCLUDED_CELL : SOLID_CELL;
    dot.isVisible = true;
  }

  function groundHides(ground: EcefCoord, root: TransformNode | null, camera: Scene["activeCamera"]): boolean {
    const raycast = options.raycastSurface;
    if (!raycast || !camera) return false;
    const eye = sceneToEcef(camera.globalPosition, root);
    const dx = ground.x - eye.x, dy = ground.y - eye.y, dz = ground.z - eye.z;
    const distance = Math.hypot(dx, dy, dz);
    const reach = distance * OCCLUSION_REACH - 1;
    if (!(reach > 0) || !(distance > 0)) return false;
    try {
      return raycast(eye, { x: dx / distance, y: dy / distance, z: dz / distance }, reach) != null;
    } catch {
      return false;
    }
  }

  function show(next: DeviceLocationFix | null): void {
    if (disposed) return;
    const had = fix !== null;
    fix = next;
    cache = null;
    if (!next) {
      if (accuracy) accuracy.isVisible = false;
      if (dot) dot.isVisible = false;
      clearDepthForMarker(false);
      if (had) options.requestRender();
      return;
    }
    ensure();
    clearDepthForMarker(true);
    place();
    options.requestRender();
  }

  return { show, destroy };
}
