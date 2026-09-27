/**
 * Views in a panorama's geographic frame: heading clockwise from north,
 * pitch above the horizon and roll about the view direction, at a capture's
 * east-north-up frame, converted to and from the ECEF forward/up pair a
 * navigation presentation takes. Also the scene overview as the globe
 * camera's exact snapshot.
 */
import type { NavigationPresentation, NavigationSnapshot } from "../engine/babylon/navigationLease";
import type { OverviewRecord } from "./format";
import {
  add,
  cross,
  DEG_TO_RAD,
  dot,
  enuDirection,
  enuFrame,
  enuHeadingPitch,
  geodeticPoint,
  normalize,
  RAD_TO_DEG,
  scale,
  type EnuFrame,
  type Vec3,
} from "./panoramaMath";

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

/** Shortest signed difference b − a in degrees, in (−180, 180]. */
export function angleDifferenceDeg(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** A view part way from one to another, heading along the shorter way. */
export function interpolateView(from: GeoView, to: GeoView, t: number): GeoView {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return {
    headingDeg: (((from.headingDeg + angleDifferenceDeg(from.headingDeg, to.headingDeg) * t) % 360) + 360) % 360,
    pitchDeg: lerp(from.pitchDeg, to.pitchDeg),
    rollDeg: lerp(from.rollDeg, to.rollDeg),
    verticalFovDeg: lerp(from.verticalFovDeg, to.verticalFovDeg),
  };
}

/**
 * The overview as a globe camera snapshot. The camera orbits the target at
 * the given distance, its forward direction at `headingDeg` and `pitchDeg`
 * (negative looks down); `groundHeightMeters` is the target's height, the
 * displayed ground's when the record leaves it null.
 */
export function snapshotFromOverview(overview: OverviewRecord, groundHeightMeters: number): NavigationSnapshot {
  const height = overview.target.height ? overview.target.height.meters : groundHeightMeters;
  const center = geodeticPoint(overview.target.longitudeDeg, overview.target.latitudeDeg, height);
  // The globe's pitch is 0 at the horizon and 90 looking down; Babylon's camera pitch is π/2 at the horizon.
  const surfacePitchDeg = -overview.pitchDeg;
  return {
    version: 1,
    view: {
      latDeg: overview.target.latitudeDeg,
      lonDeg: overview.target.longitudeDeg,
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

export { enuFrame };
