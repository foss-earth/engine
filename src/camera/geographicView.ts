/** Geographic view/presentation conversion; the host supplies the capture ENU frame. */
import type { NavigationPresentation } from "../navigation/navigationLease.js";
import { add, cross, dot, enuDirection, enuHeadingPitch, normalize, scale, type EnuFrame, type Vec3 } from "./geographicFrames.js";
import { DEG_TO_RAD, RAD_TO_DEG } from "./cameraMath.js";

export interface GeoView {
  headingDeg: number;
  pitchDeg: number;
  /** Rotation of the view's up away from level, clockwise as seen looking forward. */
  rollDeg: number;
  verticalFovDeg: number;
}

const toEcef = (frame: EnuFrame, enu: Vec3): Vec3 => add(add(scale(frame.east, enu[0]), scale(frame.north, enu[1])), scale(frame.up, enu[2]));
const toEnu = (frame: EnuFrame, ecef: Vec3): Vec3 => [dot(ecef, frame.east), dot(ecef, frame.north), dot(ecef, frame.up)];

/** Level up for a look direction: the direction 90° above it in the same vertical plane. */
function levelBasis(headingDeg: number, pitchDeg: number): { forward: Vec3; up: Vec3; right: Vec3 } {
  const forward = enuDirection(headingDeg, pitchDeg);
  const up = enuDirection(headingDeg, pitchDeg + 90);
  return { forward, up, right: normalize(cross(forward, up)) };
}

export function presentationFromView(frame: EnuFrame, position: Vec3, view: GeoView): NavigationPresentation {
  const level = levelBasis(view.headingDeg, view.pitchDeg);
  const roll = view.rollDeg * DEG_TO_RAD;
  const upEnu = add(scale(level.up, Math.cos(roll)), scale(level.right, Math.sin(roll)));
  const v = (value: Vec3) => ({ x: value[0], y: value[1], z: value[2] });
  return {
    position: v(position),
    forward: v(normalize(toEcef(frame, level.forward))),
    up: v(normalize(toEcef(frame, upEnu))),
    verticalFovRad: view.verticalFovDeg * DEG_TO_RAD,
  };
}

/** The geographic view of a presentation; at a vertical look the heading falls back to `fallbackHeadingDeg`. */
export function viewFromPresentation(frame: EnuFrame, presentation: NavigationPresentation, fallbackHeadingDeg = 0): GeoView {
  const forward = toEnu(frame, [presentation.forward.x, presentation.forward.y, presentation.forward.z]);
  const up = toEnu(frame, [presentation.up.x, presentation.up.y, presentation.up.z]);
  const { headingDeg, pitchDeg } = enuHeadingPitch(normalize(forward), fallbackHeadingDeg);
  const level = levelBasis(headingDeg, pitchDeg);
  const rollDeg = Math.atan2(dot(up, level.right), dot(up, level.up)) * RAD_TO_DEG;
  return { headingDeg, pitchDeg, rollDeg, verticalFovDeg: presentation.verticalFovRad * RAD_TO_DEG };
}

