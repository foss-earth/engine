import { Matrix, Ray, Vector3, type AbstractMesh, type Scene, type TransformNode } from "@babylonjs/core";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef, type EcefCoord } from "../camera/cameraMath.js";

import type { SurfaceHit, SurfaceQuery } from "../surface/contracts.js";
import type { GroundAcceleration } from "./groundAcceleration.js";

/** The segment's parameter range still inside every slab tested so far. */
const segment = { near: 0, far: 0 };
const MISS = 0, REACH = 1, NEXT = 2;

/** One axis's slab: the segment misses it, may reach the bounds whatever the other axes say, or goes on to the next axis. */
function slab(minimum: number, maximum: number, origin: number, direction: number, epsilon: number): number {
  // Triangle picking tolerates slightly negative barycentric coordinates.
  // Include that same fringe, plus 1 mm for transform roundoff at contacts.
  const padding = 0.001 + 2 * epsilon * (maximum - minimum);
  const low = minimum - padding, high = maximum + padding;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return REACH;
  if (direction === 0) return origin < low || origin > high ? MISS : NEXT;
  const a = (low - origin) / direction, b = (high - origin) / direction;
  segment.near = Math.max(segment.near, Math.min(a, b));
  segment.far = Math.min(segment.far, Math.max(a, b));
  return segment.near > segment.far ? MISS : NEXT;
}

/** Babylon's mesh broadphase intentionally treats rays as infinite. Reject a
 * mesh before its matrix inversion / triangle scan when the finite segment
 * cannot reach its world bounds. Keep Babylon's exact nearest-triangle pick.
 * The axes go x, y, z, each component read by name: a computed key reaches
 * Vector3's accessors only through the slow generic path.
 */
export function intersectsSegmentBounds(ray: Ray, minimum: Vector3, maximum: Vector3): boolean {
  segment.near = 0; segment.far = ray.length;
  const origin = ray.origin, direction = ray.direction;
  let step = slab(minimum.x, maximum.x, origin.x, direction.x, ray.epsilon);
  if (step !== NEXT) return step === REACH;
  step = slab(minimum.y, maximum.y, origin.y, direction.y, ray.epsilon);
  if (step !== NEXT) return step === REACH;
  step = slab(minimum.z, maximum.z, origin.z, direction.z, ray.epsilon);
  return step !== MISS;
}

/** Query only currently visible map triangles. Input/output are always ECEF,
 * even when a consumer moves the map under a floating origin. No cached heights. */
export function createSurfaceQuery(scene: Scene, getWorldRoot: () => TransformNode | null,
  isSurface: (mesh: AbstractMesh) => boolean, getRevision: () => number = () => 0,
  sampleOverride?: (latDeg: number, lonDeg: number) => SurfaceHit | null | undefined, acceleration?: GroundAcceleration | null): Required<SurfaceQuery> {
  /** The first surface along a ray; with `finerThanMeters`, the first Google surface of a smaller geometric error. */
  function cast(origin: EcefCoord, direction: EcefCoord, lengthMeters: number, finerThanMeters = Infinity): SurfaceHit | null {
    if (![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, lengthMeters].every(Number.isFinite)
      || lengthMeters <= 0) return null;
    const dir = new Vector3(direction.x, direction.y, direction.z);
    if (dir.lengthSquared() === 0) return null;
    const transform = getWorldRoot()?.computeWorldMatrix(true) ?? Matrix.Identity();
    const inverse = Matrix.Invert(transform);
    const ecefRay = new Ray(new Vector3(origin.x, origin.y, origin.z), dir.normalize(), lengthMeters);
    const ray = Ray.Transform(ecefRay, transform);
    const predicate = (mesh: AbstractMesh): boolean => {
      if (finerThanMeters !== Infinity && !(mesh.metadata?.googleGeometricErrorMeters < finerThanMeters)) return false;
      if (!mesh.isEnabled() || !mesh.isVisible || !isSurface(mesh)) return false;
      // Let Babylon select the picking camera for billboard/infinite-distance
      // meshes; their bounds can depend on a different camera from rendering.
      if (mesh.isWorldMatrixCameraDependent()) return true;
      // Update bounds after floating-origin / tile movement before filtering.
      mesh.computeWorldMatrix();
      const bounds = mesh.getBoundingInfo().boundingBox;
      return intersectsSegmentBounds(ray, bounds.minimumWorld, bounds.maximumWorld);
    };
    const pick = acceleration ? acceleration.pick(scene, ray, predicate) : scene.pickWithRay(ray, predicate, false);
    if (!pick?.hit || !pick.pickedPoint || !pick.pickedMesh) return null;
    const point = Vector3.TransformCoordinates(pick.pickedPoint, inverse);
    const normal = Vector3.TransformNormal(pick.getNormal(true, false) ?? Vector3.Up(), inverse).normalize();
    const heightMeters = ecefToGeodetic(point.x, point.y, point.z).altMeters;
    if (![point.x, point.y, point.z, normal.x, normal.y, normal.z, heightMeters].every(Number.isFinite)) return null;
    return { point: { x: point.x, y: point.y, z: point.z }, normal: { x: normal.x, y: normal.y, z: normal.z },
      distanceMeters: Vector3.Distance(point, ecefRay.origin),
      heightMeters, meshId: pick.pickedMesh.id, revision: getRevision(), quality: pick.pickedMesh.metadata?.terrainZoom ?? -1,
      geometricErrorMeters: pick.pickedMesh.metadata?.googleGeometricErrorMeters };
  }
  function sample(latDeg: number, lonDeg: number): SurfaceHit | null {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90) return null;
    // undefined selects the general path; null is an authoritative raster miss.
    const overridden = sampleOverride?.(latDeg, lonDeg);
    if (overridden !== undefined) return overridden;
    const lat = latDeg * DEG_TO_RAD, lon = lonDeg * DEG_TO_RAD;
    const origin = geodeticToEcef(lat, lon, 20000);
    const down = { x: -Math.cos(lat) * Math.cos(lon), y: -Math.cos(lat) * Math.sin(lon), z: -Math.sin(lat) };
    let hit = cast(origin, down, 40000);
    // While finer Google tiles load, coarser ones stay drawn in their place, and
    // Google's tile bounds overlap: a tile thousands of kilometres across can be
    // drawn kilometres above the finer ground under it. A coarser surface within
    // its geometric error above a finer one gives way to it. Farther above, it is
    // a feature of its own, such as a bridge, and stays the ground.
    for (let error = hit?.geometricErrorMeters; hit && error !== undefined; error = hit.geometricErrorMeters) {
      const finer = cast(origin, down, 40000, error);
      if (!finer || hit.heightMeters - finer.heightMeters > error) break;
      hit = finer;
    }
    return hit;
  }
  function raycast(origin: EcefCoord, direction: EcefCoord, lengthMeters: number): SurfaceHit | null {
    return cast(origin, direction, lengthMeters);
  }
  /** Changes when the displayed geometry does; a caller re-samples only then. */
  const revision = (): number => getRevision();
  return { raycast, sample, revision };
}
