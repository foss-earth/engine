import { Ray, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
import { smoothSurfaceEcef } from "../terrain/smoothElevation.js";

import { DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_UP_M, DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_DOWN_M } from "./core.js";
export * from "./core.js";

export function smoothPointPosition(latDeg: number, lonDeg: number, offsetMeters: number): Vector3 {
  const pos = smoothSurfaceEcef(latDeg, lonDeg, offsetMeters);
  return new Vector3(pos.x, pos.y, pos.z);
}

export function isEligiblePoiHeightMesh(mesh: AbstractMesh): boolean {
  if (!mesh.isEnabled() || !mesh.isVisible || !mesh.isPickable) return false;
  if (mesh.name.startsWith("orbit-compass") || mesh.name === "fallback-globe") return false;
  return true;
}

/**
 * Ray-casts straight down through the terrain meshes at the given lat/lng to
 * find a refined surface position. Returns null if no mesh was hit.
 */
export function samplePoiMeshPosition(
  scene: Scene,
  latDeg: number,
  lonDeg: number,
  offsetMeters: number,
  probeUpMeters: number = DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_UP_M,
  probeDownMeters: number = DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_DOWN_M,
): Vector3 | null {
  const base = smoothPointPosition(latDeg, lonDeg, 0);
  const up = base.normalizeToNew();
  const origin = base.add(up.scale(probeUpMeters));
  const ray = new Ray(origin, up.scale(-1), probeUpMeters + probeDownMeters);
  const pick = scene.pickWithRay(ray, isEligiblePoiHeightMesh, false);
  if (!pick?.hit || !pick.pickedPoint) return null;
  return pick.pickedPoint.add(up.scale(offsetMeters));
}
