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

/**
 * What the globe camera holds to on its own, for an owner handing it back in
 * motion: its limits, and the share of its speed a glide keeps each 60 Hz
 * frame (`camera.inertiaDecay`).
 */
export interface CameraHandling extends CameraLimits {
  glideKeepPerFrame: number;
}

export const DEFAULT_CAMERA_LIMITS: CameraLimits = Object.freeze({
  pitchDeg: Object.freeze({ min: MIN_PITCH_DEG, max: MAX_PITCH_DEG }),
  zoomMeters: Object.freeze({ min: MIN_ZOOM_METERS, max: MAX_ZOOM_METERS }),
});

/**
 * How the orbit target and the compass follow the ground under them:
 * `camera.surfaceFollowSpeed`, `camera.orbitTargetZoomStep` and `camera.surfaceRetry`.
 */
export interface GroundFollow {
  /** The fastest the orbit target and compass rise or fall with the ground, m/s. */
  speedMetersPerSecond: number;
  /** How far zooming in at the closest distance lowers a raised orbit target, per e-fold of zoom, m. */
  zoomStepMeters: number;
  /** How soon a ground height that was not loaded is looked up again, ms. */
  retryMs: number;
}

/** What they were before they became parameters, and the parameters' defaults. */
export const DEFAULT_GROUND_FOLLOW: GroundFollow = Object.freeze({
  speedMetersPerSecond: 160,
  zoomStepMeters: 750,
  retryMs: 1500,
});

/**
 * Safe space: the eye's altitude is a velocity. A sphere around the camera
 * is pushed upward when the ground enters it. `camera.safeSpace`,
 * `camera.safeSpace.acceleration` and `camera.safeSpace.clearance`. Vertical
 * speed left after the push slows by `camera.inertiaDecay`.
 */
export interface EyeContact {
  /** Off: the orbit point follows the ground. On: pan, grab and zoom keep altitude. */
  enabled: boolean;
  /** The fastest the ground may accelerate the eye upward, m/s². */
  maxAccelerationMetersPerSecondSquared: number;
  /** Radius of the sphere around the camera. Ground inside it pushes the camera up, m. */
  clearanceMeters: number;
  /** Share of upward speed kept each 60 Hz frame once the eye is clear of the ground. */
  glideKeepPerFrame: number;
}

/** On: the camera keeps its altitude, and the ground pushes it up only from inside a 15 m sphere, at up to 60 m/s². */
export const DEFAULT_EYE_CONTACT: EyeContact = Object.freeze({
  enabled: true,
  maxAccelerationMetersPerSecondSquared: 60,
  clearanceMeters: 15,
  glideKeepPerFrame: 0.82,
});
