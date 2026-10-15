import type { NumberRange, SettingsRegistry } from "@foss-earth/ui/settings";
import { DEFAULT_CAMERA_LIMITS, DEFAULT_EYE_CONTACT, type CameraLimits, type EyeContact, type GroundFollow } from "../camera/cameraLimits.js";
import { DEG_TO_RAD } from "../camera/cameraMath.js";
import type { GlobeIntentRates } from "../input/globeIntentMotion.js";
import { DEFAULT_INPUT_RATES, type InputRates } from "../input/inputRates.js";
import { INPUT_RATE_IDS } from "./catalogue/controls.js";
const numberRange = (value: unknown): value is NumberRange => !!value && typeof value === "object"
  && typeof (value as NumberRange).min === "number" && typeof (value as NumberRange).max === "number";
/** Pure reads from the one host registry; no default registry or device observation. */
export function createCameraSettings(settings: Pick<SettingsRegistry, "get">) {
  return {
    fieldOfViewRad: () => settings.get<number>("camera.fieldOfView") * DEG_TO_RAD,
    limits(): CameraLimits {
      const pitch = settings.get("camera.pitchLimits"), zoom = settings.get("camera.zoomLimits");
      return { pitchDeg: numberRange(pitch) ? pitch : DEFAULT_CAMERA_LIMITS.pitchDeg,
        zoomMeters: numberRange(zoom) ? zoom : DEFAULT_CAMERA_LIMITS.zoomMeters };
    },
    groundFollow(): GroundFollow { return { speedMetersPerSecond: settings.get<number>("camera.surfaceFollowSpeed"),
      zoomStepMeters: settings.get<number>("camera.orbitTargetZoomStep"), retryMs: settings.get<number>("camera.surfaceRetry") }; },
    eyeContact(): EyeContact {
      const keep = settings.get("camera.inertiaDecay");
      const acceleration = settings.get("camera.eyeContactAcceleration");
      const clearance = settings.get("camera.eyeClearance");
      return {
        enabled: settings.get("camera.eyeContact") === true,
        maxAccelerationMetersPerSecondSquared: typeof acceleration === "number" && Number.isFinite(acceleration)
          ? acceleration : DEFAULT_EYE_CONTACT.maxAccelerationMetersPerSecondSquared,
        clearanceMeters: typeof clearance === "number" && Number.isFinite(clearance) ? clearance : DEFAULT_EYE_CONTACT.clearanceMeters,
        glideKeepPerFrame: typeof keep === "number" && Number.isFinite(keep) ? keep : DEFAULT_EYE_CONTACT.glideKeepPerFrame,
      };
    },
    intentRates(): GlobeIntentRates { return { panPxPerSecond: settings.get<number>("input.gamepad.panRate"),
      headingDegPerSecond: settings.get<number>("input.gamepad.headingRate"), pitchDegPerSecond: settings.get<number>("input.gamepad.pitchRate"),
      zoomLogPerSecond: settings.get<number>("input.gamepad.zoomRate") }; },
    inputRates(): InputRates {
      const rates = { ...DEFAULT_INPUT_RATES };
      for (const [field, id] of Object.entries(INPUT_RATE_IDS) as Array<[keyof InputRates, string]>) {
        const value = settings.get(id); if (typeof value === "number") rates[field] = value;
      }
      return rates;
    },
  };
}
