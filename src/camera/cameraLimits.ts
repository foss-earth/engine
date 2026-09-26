// A leaf module: the settings catalogue reads these defaults, so it imports nothing.

/**
 * Minimum pitch: 1° prevents a perfectly horizontal view that can flip the
 * camera. The default of `camera.pitchLimits`, which is also the bound.
 */
export const MIN_PITCH_DEG = 1;
/** Maximum pitch: 89° prevents a perfectly vertical view that loses heading reference. */
export const MAX_PITCH_DEG = 89;
/** Minimum orbit radius (metres) — prevents clipping into tile geometry. The default of `camera.zoomLimits`. */
export const MIN_ZOOM_METERS = 25;
/**
 * Maximum orbit radius (metres): four Earth radii, where Babylon's globe
 * camera stops by default, and so where the camera stopped before
 * `camera.zoomLimits`.
 */
export const MAX_ZOOM_METERS = 4 * 6_378_137;

/** How far the camera may tilt and how near and far it may orbit: `camera.pitchLimits` and `camera.zoomLimits`. */
export interface CameraLimits {
  pitchDeg: { min: number; max: number };
  zoomMeters: { min: number; max: number };
}

export const DEFAULT_CAMERA_LIMITS: CameraLimits = Object.freeze({
  pitchDeg: Object.freeze({ min: MIN_PITCH_DEG, max: MAX_PITCH_DEG }),
  zoomMeters: Object.freeze({ min: MIN_ZOOM_METERS, max: MAX_ZOOM_METERS }),
});
