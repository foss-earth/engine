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
}

/** Query only currently visible map triangles. Input/output are always ECEF,
 * even when a consumer moves the map under a floating origin. No cached heights. */
export function createSurfaceQuery(scene: Scene, getWorldRoot: () => TransformNode | null,
  isSurface: (mesh: AbstractMesh) => boolean, getRevision: () => number = () => 0) {
  function raycast(origin: EcefCoord, direction: EcefCoord, lengthMeters: number): SurfaceHit | null {
    if (![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, lengthMeters].every(Number.isFinite)
      || lengthMeters <= 0) return null;
    const dir = new Vector3(direction.x, direction.y, direction.z);
    if (dir.lengthSquared() === 0) return null;
    const transform = getWorldRoot()?.computeWorldMatrix(true) ?? Matrix.Identity();
    const inverse = Matrix.Invert(transform);
    const ecefRay = new Ray(new Vector3(origin.x, origin.y, origin.z), dir.normalize(), lengthMeters);
    const ray = Ray.Transform(ecefRay, transform);
    const pick = scene.pickWithRay(ray, mesh => mesh.isEnabled() && mesh.isVisible && isSurface(mesh), false);
    if (!pick?.hit || !pick.pickedPoint || !pick.pickedMesh) return null;
    const point = Vector3.TransformCoordinates(pick.pickedPoint, inverse);
    const normal = Vector3.TransformNormal(pick.getNormal(true, false) ?? Vector3.Up(), inverse).normalize();
    const heightMeters = ecefToGeodetic(point.x, point.y, point.z).altMeters;
    if (![point.x, point.y, point.z, normal.x, normal.y, normal.z, heightMeters].every(Number.isFinite)) return null;
    return { point: { x: point.x, y: point.y, z: point.z }, normal: { x: normal.x, y: normal.y, z: normal.z },
      distanceMeters: Vector3.Distance(point, ecefRay.origin),
      heightMeters, meshId: pick.pickedMesh.id, revision: getRevision(), quality: pick.pickedMesh.metadata?.terrainZoom ?? -1 };
  }
  function sample(latDeg: number, lonDeg: number): SurfaceHit | null {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90) return null;
    const lat = latDeg * DEG_TO_RAD, lon = lonDeg * DEG_TO_RAD;
    return raycast(geodeticToEcef(lat, lon, 20000),
      { x: -Math.cos(lat) * Math.cos(lon), y: -Math.cos(lat) * Math.sin(lon), z: -Math.sin(lat) }, 40000);
  }
  return { raycast, sample };
}
export type SurfaceQuery = ReturnType<typeof createSurfaceQuery>;
