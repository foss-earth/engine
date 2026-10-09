import type { NavigationSnapshot } from "../navigation/navigationLease.js";
import { geodeticPoint } from "./geographicFrames.js";
import { DEG_TO_RAD } from "./cameraMath.js";

export interface OrbitViewOptions {
  longitudeDeg: number; latitudeDeg: number;
  /** Resolved WGS84 ellipsoid-coordinate target height; host owns source datum resolution. */
  heightMeters: number;
  distanceMeters: number; headingDeg: number;
  /** Geographic pitch above the horizon (negative looks down). */
  pitchDeg: number;
  verticalFovDeg: number;
}
/** Source globe snapshot math, independent of any scene envelope or height-provider policy. */
export function createOrbitViewSnapshot(overview: OrbitViewOptions): NavigationSnapshot {
  const center = geodeticPoint(overview.longitudeDeg, overview.latitudeDeg, overview.heightMeters);
  // The globe's pitch is 0 at the horizon and 90 looking down; Babylon's camera pitch is π/2 at the horizon.
  const surfacePitchDeg = -overview.pitchDeg;
  return {
    version: 1,
    view: {
      latDeg: overview.latitudeDeg,
      lonDeg: overview.longitudeDeg,
      headingDeg: overview.headingDeg,
      pitchDeg: surfacePitchDeg,
      zoomMeters: overview.distanceMeters,
    },
    camera: {
      center: { x: center[0], y: center[1], z: center[2] },
      yaw: overview.headingDeg * DEG_TO_RAD,
      pitch: (Math.PI / 2) * (1 - surfacePitchDeg / 90),
      radius: overview.distanceMeters,
      fov: overview.verticalFovDeg * DEG_TO_RAD,
    },
  };
}

