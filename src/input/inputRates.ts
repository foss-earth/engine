// A leaf module: the settings catalogue reads these defaults, so it imports nothing.

/**
 * The rates each device moves the camera at, at sensitivity 1: `input.mouse.*`,
 * `input.wheel.*`, `input.trackpad.*` and `input.touch.*`. Sensitivities multiply them.
 */
export interface InputRates {
  /** Degrees of orbit per pixel of right-button drag. */
  mouseOrbitDegPerPx: number;
  /** Pixels a press must travel before it is a drag rather than a click. */
  mouseDragThresholdPx: number;
  /** The share of the distance one wheel notch zooms out by. */
  wheelZoomPerNotch: number;
  /** Degrees of orbit per pixel of shift-scroll or orbit-mode swipe. */
  wheelOrbitDegPerPx: number;
  /** The share of the distance a pixel of trackpad pinch zooms by. */
  trackpadPinchZoomPerPx: number;
  /** Degrees of orbit per pixel of two-finger drag. */
  touchOrbitDegPerPx: number;
  /** Pan per pixel of one-finger drag, as a multiple of the drag. */
  touchPanRate: number;
  /** How strongly a pinch zooms: the pinch's ratio is raised to this power. */
  touchZoomExponent: number;
}

/** The rates the controllers were tuned at, and the parameters' defaults. */
export const DEFAULT_INPUT_RATES: InputRates = Object.freeze({
  mouseOrbitDegPerPx: 0.03,
  mouseDragThresholdPx: 4,
  // Each notch scaled the distance by 1.08 to the power 0.03.
  wheelZoomPerNotch: 1.08 ** 0.03 - 1,
  wheelOrbitDegPerPx: 0.015,
  trackpadPinchZoomPerPx: 0.001,
  touchOrbitDegPerPx: 0.1,
  touchPanRate: 0.48,
  touchZoomExponent: 0.24,
});
