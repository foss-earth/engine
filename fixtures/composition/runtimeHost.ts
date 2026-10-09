/** Source-only host fixtures. No production singleton, scheduler or device is created by engine. */
import { type Scene } from "@babylonjs/core";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { createTextureDevicePorts } from "@foss-earth/renderer/babylon";
import { RENDERER_PARAMETERS } from "@foss-earth/renderer/settings";
import { CameraController as EngineCameraController } from "../../src/babylon/cameraState.js";
import type { ImageryAtlasDevicePorts } from "../../src/babylon/imagery/imageryAtlas.js";
import {
  CONTROLS_PARAMETERS, MAP_SOURCE_PARAMETERS, MAP_DETAIL_PARAMETERS, MAP_LOADING_PARAMETERS,
  MAP_SELECTION_PARAMETERS, MAP_TERRAIN_SELECTION_PARAMETERS, MAP_AUTO_PARAMETERS, GLOBE_RUNTIME_PARAMETERS,
} from "../../src/settings/index.js";

export function createEngineSettings() {
  const settings = createSettingsRegistry({ storage: null });
  settings.register([
    ...CONTROLS_PARAMETERS, ...MAP_SOURCE_PARAMETERS, ...MAP_DETAIL_PARAMETERS, ...MAP_LOADING_PARAMETERS,
    ...MAP_SELECTION_PARAMETERS, ...MAP_TERRAIN_SELECTION_PARAMETERS, ...MAP_AUTO_PARAMETERS, ...RENDERER_PARAMETERS, ...GLOBE_RUNTIME_PARAMETERS,
  ]);
  return settings;
}
/** Test composition binds an already supplied scene to the generic device ports. */
export function testAtlasDevice(scene: Scene): ImageryAtlasDevicePorts {
  // NullEngine is a test double with simulated texture limits for untimed logical fixtures.
  scene.getEngine().getCaps().maxTextureSize = 8192;
  return createTextureDevicePorts({ scene, transfer: (_bytes, _label, submit) => submit() }) satisfies ImageryAtlasDevicePorts;
}
export const testAfter = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};
/** Default test clock is explicit; scenarios with simulated time supply their same clock. */
export class HostCameraController extends EngineCameraController {
  constructor(camera: ConstructorParameters<typeof EngineCameraController>[0], nowMs: () => number = () => performance.now()) {
    super(camera, { nowMs, hasPickablePointAt: () => false });
  }
}
