import {
  Axis,
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type { LinesMesh, Scene } from "@babylonjs/core";

import { compassLabelMeters, compassLineFade, compassRadiusMeters, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS, DEFAULT_COMPASS_LABEL_TEXTURE_SIZE, type OrbitCompassScaleParams } from "./defaults.js";
import { horizonCompassPlacements } from "./horizonPlacement.js";
import type { CanvasTextureDevicePorts } from "@foss-earth/renderer/babylon";
export { compassLabelMeters, compassLineFade, compassRadiusMeters, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS, DEFAULT_COMPASS_LABEL_TEXTURE_SIZE, orbitCompassScaleFromSettings, COMPASS_SCALE_SETTING_IDS, type OrbitCompassScaleParams } from "./defaults.js";
export { horizonCompassPlacements, HORIZON_COMPASS_ANGULAR_SIZE, HORIZON_COMPASS_LIFT } from "./horizonPlacement.js";

export type CompassMode = "horizon" | "legacy";

export interface OrbitCompassPorts { device: CanvasTextureDevicePorts; labelTextureSize?: number; requestRender?(): void }

const LABEL_RADIUS_SCALE = 1.28;
const SURFACE_LIFT_SCALE = 0.08;
const MIN_SURFACE_LIFT_METERS = 150;
const MAX_SURFACE_LIFT_METERS = 16_000;
const ANCHOR_EPSILON_METERS = 1;
const RADIUS_EPSILON_METERS = 500;
const COMPASS_OPACITY = 0.5;
const WHITE_LINE_ALPHA_FACTOR = 0.25;
const RED_LINE_ALPHA_FACTOR = 1;
const HORIZON_LABEL_ALPHA = 1;

export interface OrbitCompassHandle {
  update(anchor: Vector3 | null, zoomDistance: number, cameraPosition?: { x: number; y: number; z: number } | null): void;
  /** Horizon letters are the default. Legacy is the ground compass. */
  setMode(mode: CompassMode): void;
  setScaleParams(params: OrbitCompassScaleParams): void;
  isMesh(mesh: Mesh | null | undefined): boolean;
  destroy(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeScaleParams(params: OrbitCompassScaleParams): OrbitCompassScaleParams {
  const radiusScale = Math.max(0.000001, params.radiusScale);
  const minRadius = Math.max(1, params.minRadius);
  const maxRadius = Math.max(minRadius, params.maxRadius);
  const labelSizeScale = Math.max(0.000001, params.labelSizeScale);
  const minDistance = params.minDistance === undefined ? undefined : Math.max(1, params.minDistance);
  const maxDistance = minDistance === undefined || params.maxDistance === undefined ? undefined : Math.max(minDistance, params.maxDistance);
  return { radiusScale, minRadius, maxRadius, labelSizeScale, ...(minDistance !== undefined && maxDistance !== undefined ? { minDistance, maxDistance } : {}) };
}

function createLine(name: string, color: Color3, scene: Scene, width = 1): LinesMesh {
  const line = MeshBuilder.CreateLines(
    name,
    { points: [Vector3.Zero(), Vector3.Zero()], updatable: true },
    scene,
  );
  line.color = color;
  line.alpha = (color === Color3.White() ? WHITE_LINE_ALPHA_FACTOR : RED_LINE_ALPHA_FACTOR) * COMPASS_OPACITY;
  line.enableEdgesRendering();
  line.edgesWidth = width;
  line.isPickable = false;
  line.setEnabled(false);
  return line;
}

function createLabel(text: string, color: string, scene: Scene, ports: OrbitCompassPorts): Mesh {
  const size = ports.labelTextureSize ?? DEFAULT_COMPASS_LABEL_TEXTURE_SIZE;
  const texture = ports.device.createTexture({ name: `orbit-compass-label-${text}-texture`, width: size, height: size, mipmaps: true });
  let material: StandardMaterial | null = null;
  try {
  texture.hasAlpha = true;
  const font = `bold ${size * 72 / 128}px system-ui`;
  const ctx = texture.getContext() as unknown as {
    clearRect(x: number, y: number, w: number, h: number): void;
    font: string;
    textAlign: string;
    textBaseline: string;
    lineJoin: string;
    lineWidth: number;
    strokeStyle: string;
    fillStyle: string;
    strokeText(text: string, x: number, y: number): void;
    fillText(text: string, x: number, y: number): void;
  };
  ctx.clearRect(0, 0, size, size);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(4, size * 0.055);
  ctx.strokeStyle = "rgba(8, 12, 20, 0.92)";
  ctx.strokeText(text, size / 2, size / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, size / 2, size / 2);
  ports.device.updateTexture(texture, true);

  material = new StandardMaterial(`orbit-compass-label-${text}-material`, scene);
  material.fogEnabled = false;
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.emissiveColor = Color3.White();
  material.disableLighting = true;
  material.useAlphaFromDiffuseTexture = true;
  material.alpha = COMPASS_OPACITY;
  material.backFaceCulling = false;

  const label = MeshBuilder.CreatePlane(`orbit-compass-label-${text}`, { size: 1 }, scene);
  label.material = material;
  label.billboardMode = Mesh.BILLBOARDMODE_ALL;
  label.isPickable = false;
  label.setEnabled(false);
  return label;
  } catch (error) { material?.dispose(); texture.dispose(); throw error; }
}

function getAnchorBasis(anchor: Vector3): { east: Vector3; north: Vector3; up: Vector3 } {
  const up = anchor.normalizeToNew();
  const poleSafeAxis = Math.abs(Vector3.Dot(up, Axis.Z)) > 0.98 ? Axis.Y : Axis.Z;
  const east = Vector3.Cross(poleSafeAxis, up).normalize();
  const north = Vector3.Cross(up, east).normalize();
  return { east, north, up };
}

function offsetPoint(
  base: Vector3,
  east: Vector3,
  north: Vector3,
  up: Vector3,
  eastMeters: number,
  northMeters: number,
  upMeters = 0,
): Vector3 {
  return base
    .add(east.scale(eastMeters))
    .add(north.scale(northMeters))
    .add(up.scale(upMeters));
}

function setLine(line: LinesMesh, start: Vector3, end: Vector3, scene: Scene): void {
  MeshBuilder.CreateLines(line.name, { points: [start, end], instance: line }, scene);
}

export function createOrbitCompass(scene: Scene, ports: OrbitCompassPorts): OrbitCompassHandle {
  const meshes: Mesh[] = []; let disposed = false, visible = false, lastFade = -1;
  function own<T extends Mesh>(create: () => T): T { try { const mesh = create(); meshes.push(mesh); return mesh; } catch (error) { for (const mesh of meshes) mesh.dispose(false, true); throw error; } }
  const eastWestAxis = own(() => createLine("orbit-compass-east-west-axis", Color3.White(), scene));
  const northSouthAxis = own(() => createLine("orbit-compass-north-south-axis", Color3.White(), scene));
  const northNeedle = own(() => createLine("orbit-compass-north-needle", Color3.FromHexString("#ef4444"), scene, 3));
  const northLabel = own(() => createLabel("N", "#ef4444", scene, ports));
  const eastLabel = own(() => createLabel("E", "#ffffff", scene, ports));
  const southLabel = own(() => createLabel("S", "#ffffff", scene, ports));
  const westLabel = own(() => createLabel("W", "#ffffff", scene, ports));
  const meshSet = new Set<Mesh>(meshes);
  const cardinalLabels = [northLabel, eastLabel, southLabel, westLabel];
  const labelsById = { N: northLabel, E: eastLabel, S: southLabel, W: westLabel };
  const axisLines = [eastWestAxis, northSouthAxis, northNeedle];
  let scaleParams = DEFAULT_ORBIT_COMPASS_SCALE_PARAMS;
  let mode: CompassMode = "horizon";
  let lastAnchor: Vector3 | null = null;
  let lastRadiusMeters = -1;
  let lastLabelMeters = -1;
  const lastHorizon = cardinalLabels.map(() => ({ x: Number.NaN, y: Number.NaN, z: Number.NaN, size: Number.NaN }));
  // Where the legacy geometry was last built. Unlike lastAnchor, it follows moves within the epsilon.
  let drawnAnchor: Vector3 | null = null;

  function hide(): void {
    for (const mesh of meshes) mesh.setEnabled(false);
    lastLabelMeters = -1;
    drawnAnchor = null;
    for (const slot of lastHorizon) { slot.x = Number.NaN; slot.y = Number.NaN; slot.z = Number.NaN; slot.size = Number.NaN; }
  }

  function setLabelAlpha(alpha: number): void {
    for (const label of cardinalLabels) {
      const material = label.material as StandardMaterial | null;
      if (material && material.alpha !== alpha) material.alpha = alpha;
    }
  }

  function setEnabledIfNeeded(mesh: Mesh, enabled: boolean): void {
    if (mesh.isEnabled() !== enabled) mesh.setEnabled(enabled);
  }

  function rebuildGeometry(anchor: Vector3, radiusMeters: number): void {
    const { east, north, up } = getAnchorBasis(anchor);
    const surfaceLift = clamp(radiusMeters * SURFACE_LIFT_SCALE, MIN_SURFACE_LIFT_METERS, MAX_SURFACE_LIFT_METERS);
    const labelRadius = radiusMeters * LABEL_RADIUS_SCALE;
    const labelLift = surfaceLift * 0.4;
    const center = offsetPoint(anchor, east, north, up, 0, 0, surfaceLift);

    setLine(
      eastWestAxis,
      offsetPoint(center, east, north, up, -radiusMeters, 0),
      offsetPoint(center, east, north, up, radiusMeters, 0),
      scene,
    );
    setLine(
      northSouthAxis,
      offsetPoint(center, east, north, up, 0, -radiusMeters),
      center,
      scene,
    );
    setLine(
      northNeedle,
      center,
      offsetPoint(center, east, north, up, 0, radiusMeters * 0.95),
      scene,
    );

    northLabel.position.copyFrom(offsetPoint(center, east, north, up, 0, labelRadius, labelLift));
    eastLabel.position.copyFrom(offsetPoint(center, east, north, up, labelRadius, 0, labelLift));
    southLabel.position.copyFrom(offsetPoint(center, east, north, up, 0, -labelRadius, labelLift));
    westLabel.position.copyFrom(offsetPoint(center, east, north, up, -labelRadius, 0, labelLift));
  }

  function applyLegacyLabelScale(zoomDistance: number): boolean {
    const labelScale = compassLabelMeters(zoomDistance, scaleParams);
    const tolerance = Math.max(1, Math.abs(lastLabelMeters) * 0.0025);
    if (Math.abs(labelScale - lastLabelMeters) <= tolerance) return false;
    lastLabelMeters = labelScale;
    for (const label of cardinalLabels) label.scaling.setAll(labelScale);
    return true;
  }

  function updateLegacy(anchor: Vector3 | null, zoomDistance: number): void {
    if (!anchor) {
      lastAnchor = null;
      drawnAnchor = null;
      lastRadiusMeters = -1;
      hide();
      if (visible) ports.requestRender?.();
      visible = false;
      lastFade = -1;
      return;
    }

    const radiusMeters = compassRadiusMeters(zoomDistance, scaleParams).radius;
    const anchorChanged = !lastAnchor || Vector3.Distance(anchor, lastAnchor) > ANCHOR_EPSILON_METERS;
    const radiusChanged = Math.abs(radiusMeters - lastRadiusMeters) > RADIUS_EPSILON_METERS;
    if (anchorChanged || radiusChanged) {
      lastAnchor = anchor.clone();
      lastRadiusMeters = radiusMeters;
    }
    // A move within the epsilon is drawn in this frame and asks for no other, so the compass rests on its anchor.
    if (anchorChanged || radiusChanged || !drawnAnchor || !anchor.equals(drawnAnchor)) {
      rebuildGeometry(anchor, radiusMeters);
      drawnAnchor = anchor.clone();
    }
    const labelChanged = applyLegacyLabelScale(zoomDistance);
    setLabelAlpha(COMPASS_OPACITY);

    const fadeFactor = compassLineFade(zoomDistance, scaleParams);
    const linesVisible = fadeFactor > 0.001;
    eastWestAxis.alpha = WHITE_LINE_ALPHA_FACTOR * COMPASS_OPACITY * fadeFactor;
    northSouthAxis.alpha = WHITE_LINE_ALPHA_FACTOR * COMPASS_OPACITY * fadeFactor;
    northNeedle.alpha = RED_LINE_ALPHA_FACTOR * COMPASS_OPACITY * fadeFactor;

    const changed = anchorChanged || radiusChanged || labelChanged || !visible || lastFade !== fadeFactor;
    visible = true;
    lastFade = fadeFactor;
    for (const line of axisLines) setEnabledIfNeeded(line, linesVisible);
    for (const label of cardinalLabels) setEnabledIfNeeded(label, true);
    if (changed) ports.requestRender?.();
  }

  function updateHorizon(cameraPosition: { x: number; y: number; z: number } | null): void {
    const camera = cameraPosition && [cameraPosition.x, cameraPosition.y, cameraPosition.z].every(Number.isFinite)
      ? cameraPosition
      : null;
    const placements = camera ? horizonCompassPlacements(camera) : null;
    if (!placements) {
      hide();
      if (visible) ports.requestRender?.();
      visible = false;
      lastFade = -1;
      return;
    }

    let moved = !visible;
    placements.forEach((placement, index) => {
      const slot = lastHorizon[index];
      const sizeTolerance = Math.max(1, Math.abs(slot.size) * 0.0025);
      const slotMoved = !Number.isFinite(slot.x) || !Number.isFinite(slot.size)
        || Math.abs(placement.position.x - slot.x) > 1
        || Math.abs(placement.position.y - slot.y) > 1
        || Math.abs(placement.position.z - slot.z) > 1
        || Math.abs(placement.sizeMeters - slot.size) > sizeTolerance;
      if (!slotMoved) return;
      moved = true;
      const label = labelsById[placement.id];
      label.position.set(placement.position.x, placement.position.y, placement.position.z);
      label.scaling.setAll(placement.sizeMeters);
      slot.x = placement.position.x;
      slot.y = placement.position.y;
      slot.z = placement.position.z;
      slot.size = placement.sizeMeters;
    });
    setLabelAlpha(HORIZON_LABEL_ALPHA);
    for (const line of axisLines) setEnabledIfNeeded(line, false);
    for (const label of cardinalLabels) setEnabledIfNeeded(label, true);
    visible = true;
    lastFade = -1;
    if (moved) ports.requestRender?.();
  }

  return {
    update(anchor: Vector3 | null, zoomDistance: number, cameraPosition?: { x: number; y: number; z: number } | null): void {
      if (disposed) return;
      if (mode === "horizon") updateHorizon(cameraPosition ?? null);
      else updateLegacy(anchor, zoomDistance);
    },

    setMode(next: CompassMode): void {
      if (disposed || mode === next) return;
      mode = next;
      lastAnchor = null;
      drawnAnchor = null;
      lastRadiusMeters = -1;
      lastLabelMeters = -1;
      lastFade = -1;
      for (const slot of lastHorizon) { slot.x = Number.NaN; slot.y = Number.NaN; slot.z = Number.NaN; slot.size = Number.NaN; }
      if (visible) ports.requestRender?.();
    },

    setScaleParams(params: OrbitCompassScaleParams): void {
      if (disposed) return;
      const next = normalizeScaleParams(params);
      if (Object.keys(next).every(key => next[key as keyof OrbitCompassScaleParams] === scaleParams[key as keyof OrbitCompassScaleParams])) return;
      scaleParams = next; lastRadiusMeters = -1; lastLabelMeters = -1; if (visible) ports.requestRender?.();
    },

    isMesh(mesh: Mesh | null | undefined): boolean {
      return mesh !== null && mesh !== undefined && meshSet.has(mesh);
    },

    destroy(): void {
      if (disposed) return; disposed = true;
      for (const mesh of meshes) {
        mesh.dispose(false, true);
      }
      if (visible) ports.requestRender?.(); visible = false;
    },
  };
}
