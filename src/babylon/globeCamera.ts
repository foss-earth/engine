import { GeospatialCamera, Vector3, type Scene } from "@babylonjs/core";
import { DEFAULT_GLOBE_CAMERA } from "../camera/cameraDefaults.js";
import { DEG_TO_RAD, geodeticToEcef } from "../camera/cameraMath.js";
export interface GlobeCameraInitialView {
  latitudeDeg: number; longitudeDeg: number; radiusMeters: number; yawRad: number; pitchRad: number;
}
/** Camera only: the caller owns scene.activeCamera and the already supplied backend. */
export function createGeospatialGlobeCamera(scene: Scene, initial: GlobeCameraInitialView = DEFAULT_GLOBE_CAMERA): GeospatialCamera {
  const camera = new GeospatialCamera("geo-camera", scene, { planetRadius: 6378137 });
  try {
  // The person's gestures must go through the shared inertial controller exactly once.
  camera.inputs.removeByType("GeospatialCameraPointersInput");
  camera.inputs.removeByType("GeospatialCameraMouseWheelInput");
  camera.attachControl(true);
  const centre = geodeticToEcef(initial.latitudeDeg * DEG_TO_RAD, initial.longitudeDeg * DEG_TO_RAD, 0);
  camera.center = new Vector3(centre.x, centre.y, centre.z);
  camera.radius = initial.radiusMeters;
  camera.yaw = initial.yawRad;
  camera.pitch = initial.pitchRad;
  camera.checkCollisions = true;
  return camera;
  } catch (error) { camera.dispose(); throw error; }
}
