import { DEFAULT_CAMERA_LIMITS } from "../../camera/cameraLimits";
import { DEFAULT_INERTIA_DECAY_PER_FRAME } from "../../input/inertialCameraController";
import { DEFAULT_INPUT_RATES, type InputRates } from "../../input/inputRates";
import { DEFAULT_GLOBE_STICK_DEADZONE } from "../../input/globeNavigation";
import type { ParameterSpec, ParameterUnit } from "../types";

export const CONTROLS_TAB = "controls";

const MOVEMENTS = [
  ["pan", "Pan"],
  ["orbit", "Orbit"],
  ["zoom", "Zoom"],
] as const;

const DEVICES = [
  ["mouse", "Mouse"],
  ["trackpad", "Trackpad"],
  ["touch", "Touch"],
] as const;

export const INPUT_SENSITIVITY_IDS = DEVICES.flatMap(([device]) => MOVEMENTS.map(([movement]) => `input.sensitivity.${device}.${movement}`));

const SENSITIVITY_PARAMETERS: ParameterSpec[] = DEVICES.flatMap(([device, deviceLabel]) => MOVEMENTS.map(([movement, movementLabel]): ParameterSpec => ({
  id: `input.sensitivity.${device}.${movement}`,
  label: `${deviceLabel} ${movementLabel.toLowerCase()} sensitivity`,
  description: `How far the globe ${movement === "zoom" ? "zooms" : movement === "pan" ? "pans" : "orbits"} per ${device === "touch" ? "finger" : device} movement, as a multiple of the standard rate.`,
  unit: "ratio",
  kind: "number",
  bounds: () => ({ min: 0.1, max: 10 }),
  step: 0.05,
  scale: "log2",
  default: 1,
  defaultReason: "The standard rate the controller was tuned at.",
  home: { tab: CONTROLS_TAB, section: "input-method", level: "all" },
  appliesLive: true,
  source: "src/input/inputSettings.ts",
})));

const CAMERA_STATE = "src/camera/cameraState.ts";
const TUNED = "The rate the controller was tuned at before this became a parameter.";

/** A device's rate at sensitivity 1, homed in its device's section. */
function rate(id: string, label: string, description: string, unit: ParameterUnit, fallback: number,
  bounds: { min: number; max: number }, section: string, source: string): ParameterSpec {
  return {
    id, label, description, unit, kind: "number",
    bounds: () => bounds, step: 0.05, scale: "log2",
    default: fallback, defaultReason: TUNED,
    home: { tab: CONTROLS_TAB, section, level: "main" },
    appliesLive: true, source,
  };
}

export const CAMERA_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "camera.fieldOfView",
    label: "Field of view",
    description: "How much of the globe the camera shows, top to bottom. Wider shows more at once; each pixel then covers more ground, so detail loads coarser.",
    unit: "deg",
    kind: "number",
    bounds: () => ({ min: 10, max: 120 }),
    step: 1,
    scale: "linear",
    default: (0.8 * 180) / Math.PI,
    defaultReason: "Babylon's 0.8 rad, which the globe camera had before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "main" },
    appliesLive: true,
    source: "src/engine/babylon/createBabylonRuntime.ts",
  },
  {
    id: "camera.pitchLimits",
    label: "Tilt",
    description: "How far the camera may tilt, from near the horizon (0°) to straight down (90°).",
    unit: "deg",
    kind: "range",
    // A level view can flip the camera; a vertical one loses its heading.
    bounds: () => ({ min: 1, max: 89, reason: "At 0° the camera can flip over; at 90° it has no heading." }),
    step: 1,
    scale: "linear",
    default: { ...DEFAULT_CAMERA_LIMITS.pitchDeg },
    defaultReason: "The whole of what the camera can safely do.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "main" },
    appliesLive: true,
    source: CAMERA_STATE,
  },
  {
    id: "camera.zoomLimits",
    label: "Distance",
    description: "How near the camera may come to the point it orbits, and how far out it may go.",
    unit: "m",
    kind: "range",
    bounds: () => ({ min: 1, max: 80_000_000 }),
    step: 0.25,
    scale: "log2",
    default: { ...DEFAULT_CAMERA_LIMITS.zoomMeters },
    defaultReason: "25 m keeps the camera out of the ground's tiles; four Earth radii is where Babylon's globe camera stopped before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "main" },
    appliesLive: true,
    source: CAMERA_STATE,
  },
  {
    id: "camera.inertiaDecay",
    label: "Glide",
    description: "How much of its speed the camera keeps each 60 Hz frame after a drag or flick ends: 0 stops at once, more glides further.",
    unit: "per-frame",
    kind: "number",
    bounds: () => ({ min: 0, max: 0.99 }),
    step: 0.01,
    scale: "linear",
    default: DEFAULT_INERTIA_DECAY_PER_FRAME,
    defaultReason: "What the camera glided with before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "main" },
    appliesLive: true,
    source: "src/input/inertialCameraController.ts",
  },
  {
    id: "input.globeAnchorRotation",
    label: "Grab the globe",
    description: "Dragging keeps the grabbed point of the globe under the pointer; off, a drag moves the view flatly.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "The grabbed ground follows the pointer, as in Google Earth.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "main" },
    appliesLive: true,
    source: "src/input/inputSettings.ts",
  },
];

/** Each device rate's parameter. */
export const INPUT_RATE_IDS: Readonly<Record<keyof InputRates, string>> = Object.freeze({
  mouseOrbitDegPerPx: "input.mouse.orbitRate",
  mouseDragThresholdPx: "input.mouse.dragThreshold",
  wheelZoomPerNotch: "input.wheel.zoomRate",
  wheelOrbitDegPerPx: "input.wheel.orbitRate",
  trackpadPinchZoomPerPx: "input.trackpad.pinchZoomRate",
  touchOrbitDegPerPx: "input.touch.orbitRate",
  touchPanRate: "input.touch.panRate",
  touchZoomExponent: "input.touch.zoomExponent",
});

export const INPUT_RATE_PARAMETERS: readonly ParameterSpec[] = [
  rate("input.mouse.orbitRate", "Mouse orbit", "Degrees the view turns per pixel of right-button drag.",
    "deg/px", DEFAULT_INPUT_RATES.mouseOrbitDegPerPx, { min: 0.001, max: 1 }, "mouse", "src/input/mouseController.ts"),
  {
    id: "input.mouse.dragThreshold",
    label: "Drag threshold",
    description: "How far a press must move before it is a drag rather than a click on the map.",
    unit: "px",
    kind: "number",
    bounds: () => ({ min: 0, max: 32 }),
    step: 1,
    scale: "linear",
    default: DEFAULT_INPUT_RATES.mouseDragThresholdPx,
    defaultReason: "Enough to keep a click a click on an unsteady hand, before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "mouse", level: "main" },
    appliesLive: true,
    source: "src/input/mouseController.ts",
  },
  rate("input.wheel.zoomRate", "Wheel zoom", "The share of the distance one wheel notch zooms by.",
    "fraction", DEFAULT_INPUT_RATES.wheelZoomPerNotch, { min: 0.0001, max: 0.5 }, "mouse", "src/input/wheelController.ts"),
  rate("input.wheel.orbitRate", "Scroll orbit", "Degrees the view turns per pixel of shift-scroll, or of a swipe while orbiting a point.",
    "deg/px", DEFAULT_INPUT_RATES.wheelOrbitDegPerPx, { min: 0.001, max: 1 }, "mouse", "src/input/wheelController.ts"),
  rate("input.trackpad.pinchZoomRate", "Trackpad pinch zoom", "The share of the distance each pixel of a trackpad pinch zooms by.",
    "per-px", DEFAULT_INPUT_RATES.trackpadPinchZoomPerPx, { min: 0.00001, max: 0.05 }, "mouse", "src/input/wheelController.ts"),
  rate("input.touch.orbitRate", "Two-finger orbit", "Degrees the view turns per pixel of two-finger drag.",
    "deg/px", DEFAULT_INPUT_RATES.touchOrbitDegPerPx, { min: 0.005, max: 2 }, "touch", "src/input/touchController.ts"),
  rate("input.touch.panRate", "One-finger pan", "How far the view pans per pixel of one-finger drag, as a multiple of the drag.",
    "ratio", DEFAULT_INPUT_RATES.touchPanRate, { min: 0.05, max: 5 }, "touch", "src/input/touchController.ts"),
  rate("input.touch.zoomExponent", "Pinch zoom", "How strongly a pinch zooms: the pinch's ratio is raised to this power.",
    "none", DEFAULT_INPUT_RATES.touchZoomExponent, { min: 0.02, max: 4 }, "touch", "src/input/touchController.ts"),
  {
    id: "input.gamepad.deadzone",
    label: "Stick deadzone",
    description: "How far a stick must move from centre before it moves the view. Too small, and a worn stick's drift keeps the view creeping and the map drawing.",
    unit: "fraction",
    kind: "number",
    bounds: () => ({ min: 0, max: 0.5 }),
    step: 0.01,
    scale: "linear",
    default: DEFAULT_GLOBE_STICK_DEADZONE,
    defaultReason: "Enough for the drift of a typical used controller, before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "controller", level: "main" },
    appliesLive: true,
    source: "src/input/globeNavigation.ts",
  },
];

export const CONTROLS_PARAMETERS: readonly ParameterSpec[] = [
  ...CAMERA_PARAMETERS,
  ...INPUT_RATE_PARAMETERS,
  {
    id: "input.mode",
    label: "Mouse or trackpad",
    description: "How wheel and gesture events are read: as a mouse wheel, or as trackpad scrolls and pinches. Touch works either way.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "trackpad", label: "Trackpad" },
      { id: "mouse", label: "Mouse" },
      { id: "touch", label: "Touch" },
    ],
    default: "trackpad",
    defaultReason: "Trackpad reads both scroll gestures and pinches; a device without one falls back to what it has.",
    home: { tab: CONTROLS_TAB, section: "input-method", level: "main" },
    appliesLive: true,
    source: "src/input/inputSettings.ts",
  },
  ...SENSITIVITY_PARAMETERS,
  {
    id: "input.orbit.invertYaw",
    label: "Invert orbit left and right",
    description: "Dragging or pushing right turns the view the other way around its target.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: "The view turns the way the pointer or stick moves.",
    home: { tab: CONTROLS_TAB, section: "orbit", level: "main" },
    appliesLive: true,
    source: "src/input/orbitInvertSettings.ts",
  },
  {
    id: "input.orbit.invertPitch",
    label: "Invert orbit up and down",
    description: "Dragging or pushing up tilts the view the other way.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: "The view tilts the way the pointer or stick moves.",
    home: { tab: CONTROLS_TAB, section: "orbit", level: "main" },
    appliesLive: true,
    source: "src/input/orbitInvertSettings.ts",
  },
  {
    id: "input.orbit.recenterMode",
    label: "After an orbit",
    description: "Whether the view stays where an orbit left it or springs back.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "hold", label: "Stay" },
      { id: "recenter", label: "Spring back" },
    ],
    default: "hold",
    defaultReason: "A view the user turned stays turned.",
    home: { tab: CONTROLS_TAB, section: "orbit", level: "main" },
    appliesLive: true,
    source: "src/input/orbitInvertSettings.ts",
  },
];
