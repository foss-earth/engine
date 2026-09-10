import { Matrix, Ray, Vector3, type AbstractMesh, type Scene, type TransformNode } from "@babylonjs/core";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef, type EcefCoord } from "../camera/cameraMath";

export interface SurfaceHit {
  point: EcefCoord;
  normal: EcefCoord;
  distanceMeters: number;
  /** WGS84 ellipsoid-coordinate height of the displayed geometry. */
  heightMeters: number;
  meshId: string;
  /** Changes when displayed raster geometry changes, not when an aircraft moves. */
  revision: number;
  quality: number;
  /** Geometric error advertised by the Google 3D tile owning this triangle. */
  geometricErrorMeters?: number;
}

const AXES = ["x", "y", "z"] as const;

/** Babylon's mesh broadphase intentionally treats rays as infinite. Reject a
 * mesh before its matrix inversion / triangle scan when the finite segment
 * cannot reach its world bounds. Keep Babylon's exact nearest-triangle pick.
 */
function intersectsSegmentBounds(ray: Ray, minimum: Vector3, maximum: Vector3): boolean {
  let near = 0, far = ray.length;
  for (const axis of AXES) {
    // Triangle picking tolerates slightly negative barycentric coordinates.
    // Include that same fringe, plus 1 mm for transform roundoff at contacts.
    const padding = 0.001 + 2 * ray.epsilon * (maximum[axis] - minimum[axis]);
    const low = minimum[axis] - padding, high = maximum[axis] + padding;
    const origin = ray.origin[axis], direction = ray.direction[axis];
    if (!Number.isFinite(low) || !Number.isFinite(high)) return true;
    if (direction === 0) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const a = (low - origin) / direction, b = (high - origin) / direction;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return false;
  }
  return true;
}

/** Query only currently visible map triangles. Input/output are always ECEF,
 * even when a consumer moves the map under a floating origin. No cached heights. */
export function createSurfaceQuery(scene: Scene, getWorldRoot: () => TransformNode | null,
  isSurface: (mesh: AbstractMesh) => boolean, getRevision: () => number = () => 0,
  sampleOverride?: (latDeg: number, lonDeg: number) => SurfaceHit | null | undefined) {
  function raycast(origin: EcefCoord, direction: EcefCoord, lengthMeters: number): SurfaceHit | null {
    if (![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, lengthMeters].every(Number.isFinite)
      || lengthMeters <= 0) return null;
    const dir = new Vector3(direction.x, direction.y, direction.z);
    if (dir.lengthSquared() === 0) return null;
    const transform = getWorldRoot()?.computeWorldMatrix(true) ?? Matrix.Identity();
    const inverse = Matrix.Invert(transform);
    const ecefRay = new Ray(new Vector3(origin.x, origin.y, origin.z), dir.normalize(), lengthMeters);
    const ray = Ray.Transform(ecefRay, transform);
    const pick = scene.pickWithRay(ray, mesh => {
      if (!mesh.isEnabled() || !mesh.isVisible || !isSurface(mesh)) return false;
      // Let Babylon select the picking camera for billboard/infinite-distance
      // meshes; their bounds can depend on a different camera from rendering.
      if (mesh.isWorldMatrixCameraDependent()) return true;
      // Update bounds after floating-origin / tile movement before filtering.
      mesh.computeWorldMatrix();
      const bounds = mesh.getBoundingInfo().boundingBox;
      return intersectsSegmentBounds(ray, bounds.minimumWorld, bounds.maximumWorld);
    }, false);
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
    return raycast(geodeticToEcef(lat, lon, 20000),
      { x: -Math.cos(lat) * Math.cos(lon), y: -Math.cos(lat) * Math.sin(lon), z: -Math.sin(lat) }, 40000);
  }
  return { raycast, sample };
}
export type SurfaceQuery = ReturnType<typeof createSurfaceQuery>;
