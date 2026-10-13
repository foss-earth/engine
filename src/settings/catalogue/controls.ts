import { DEFAULT_CAMERA_LIMITS, DEFAULT_GROUND_FOLLOW } from "../../camera/cameraLimits.js";
import { DEFAULT_GRAB_FOLLOW_MS, DEFAULT_INERTIA_DECAY_PER_FRAME, GRAB_FOLLOW_ID } from "../../input/inertialCameraController.js";
import { DEFAULT_INPUT_RATES, type InputRates } from "../../input/inputRates.js";
import { DEFAULT_GLOBE_INTENT_RATES } from "../../input/globeIntentMotion.js";
import { DEFAULT_GLOBE_STICK_DEADZONE } from "../../input/gamepadDefaults.js";
import {
  DEFAULT_NAVIGATION_ANCHORS, NAVIGATION_ANCHOR_CHOICES, NAVIGATION_ANCHOR_PRESET_VALUES, SHOW_NAVIGATION_ANCHORS_ID, ZOOM_CENTER_ID,
  navigationAnchorSettingId, type AnchorChoice, type AnchorFamily,
} from "../../input/navigationAnchors.js";
import type { ParameterSpec, ParameterUnit, SettingsPreset } from "@foss-earth/ui/settings";

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

const CAMERA_STATE = "src/babylon/cameraState.ts";
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
    source: "src/settings/cameraSettings.ts",
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
    description: "How much of its speed the camera keeps each 60 Hz frame after a drag or flick ends, or after a flight into or out of a 360 image is cut short: 0 stops at once, more glides further.",
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
    id: GRAB_FOLLOW_ID,
    label: "Grab follow time",
    description: "With Grab the globe, how long the grabbed ground takes to catch up with the pointer or finger: the camera moves like a mass pulled to it, and carries on gliding when you let go. 0 keeps the ground exactly under the pointer.",
    unit: "ms",
    kind: "number",
    bounds: () => ({ min: 0, max: 250 }),
    step: 5,
    scale: "linear",
    default: DEFAULT_GRAB_FOLLOW_MS,
    defaultReason: "The grabbed ground stays under the pointer. A longer time lets it trail, like a mass being pulled.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "main" },
    appliesLive: true,
    source: "src/babylon/cameraState.ts",
  },
  {
    id: "camera.surfaceFollowSpeed",
    label: "Ground following speed",
    description: "The fastest the point the camera orbits, and the compass, rise or fall with the ground under them. Faster keeps up with cliffs; slower glides over them.",
    unit: "m/s",
    kind: "number",
    bounds: () => ({ min: 10, max: 5000 }),
    step: 0.05,
    scale: "log2",
    default: DEFAULT_GROUND_FOLLOW.speedMetersPerSecond,
    defaultReason: "What the orbit target and compass followed the ground at before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "all" },
    appliesLive: true,
    source: CAMERA_STATE,
  },
  {
    id: "camera.orbitTargetZoomStep",
    label: "Zoom lowers the raised target",
    description: "With the orbit point raised above the ground (Compass orbit height), zooming in at the closest distance lowers it by this much for each e-fold (2.7×) of zoom.",
    unit: "m",
    kind: "number",
    bounds: () => ({ min: 10, max: 100_000 }),
    step: 0.05,
    scale: "log2",
    default: DEFAULT_GROUND_FOLLOW.zoomStepMeters,
    defaultReason: "What zooming in lowered the target by before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "all" },
    appliesLive: true,
    source: CAMERA_STATE,
  },
  {
    id: "camera.surfaceRetry",
    label: "Ground height retry",
    description: "How soon the ground height under the orbit point and compass is looked up again where no terrain was loaded. Sooner finds it as soon as terrain arrives, for a ray test against the terrain each time.",
    unit: "ms",
    kind: "number",
    bounds: () => ({ min: 50, max: 60_000 }),
    step: 0.05,
    scale: "log2",
    default: DEFAULT_GROUND_FOLLOW.retryMs,
    defaultReason: "What a missing height was retried after before this became a parameter.",
    home: { tab: CONTROLS_TAB, section: "camera", level: "all" },
    appliesLive: true,
    source: "src/terrain/anchorHeight.ts",
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
  mousePanRate: "input.mouse.panRate",
  mouseDragThresholdPx: "input.mouse.dragThreshold",
  wheelZoomPerNotch: "input.wheel.zoomRate",
  wheelOrbitDegPerPx: "input.wheel.orbitRate",
  trackpadPinchZoomPerPx: "input.trackpad.pinchZoomRate",
  trackpadPanRate: "input.trackpad.panRate",
  trackpadRotateRate: "input.trackpad.rotateRate",
  trackpadGestureZoomExponent: "input.trackpad.gestureZoomExponent",
  touchOrbitDegPerPx: "input.touch.orbitRate",
  touchPanRate: "input.touch.panRate",
  touchZoomExponent: "input.touch.zoomExponent",
});

export const INPUT_RATE_PARAMETERS: readonly ParameterSpec[] = [
  rate("input.mouse.orbitRate", "Mouse orbit", "Degrees the view turns per pixel of right-button drag.",
    "deg/px", DEFAULT_INPUT_RATES.mouseOrbitDegPerPx, { min: 0.001, max: 1 }, "mouse", "src/browser/mouseController.ts"),
  rate("input.mouse.panRate", "Mouse pan", "How far the view pans per pixel of left-button drag when Grab the globe is off, as a multiple of the drag.",
    "ratio", DEFAULT_INPUT_RATES.mousePanRate, { min: 0.01, max: 2 }, "mouse", "src/browser/mouseController.ts"),
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
    source: "src/browser/mouseController.ts",
  },
  rate("input.wheel.zoomRate", "Wheel zoom", "The share of the distance one wheel notch zooms by.",
    "fraction", DEFAULT_INPUT_RATES.wheelZoomPerNotch, { min: 0.0001, max: 0.5 }, "mouse", "src/browser/wheelController.ts"),
  rate("input.wheel.orbitRate", "Scroll orbit", "Degrees the view turns per pixel of shift-scroll, or of a swipe while orbiting a point.",
    "deg/px", DEFAULT_INPUT_RATES.wheelOrbitDegPerPx, { min: 0.001, max: 1 }, "mouse", "src/browser/wheelController.ts"),
  rate("input.trackpad.pinchZoomRate", "Trackpad pinch zoom", "The share of the distance each pixel of a trackpad pinch zooms by.",
    "per-px", DEFAULT_INPUT_RATES.trackpadPinchZoomPerPx, { min: 0.00001, max: 0.05 }, "mouse", "src/browser/wheelController.ts"),
  rate("input.trackpad.panRate", "Trackpad pan", "How far the view pans per pixel of two-finger swipe, as a multiple of the swipe.",
    "ratio", DEFAULT_INPUT_RATES.trackpadPanRate, { min: 0.01, max: 2 }, "mouse", "src/browser/wheelController.ts"),
  rate("input.trackpad.rotateRate", "Trackpad rotate", "Degrees the heading turns per degree of a two-finger rotate, in Safari.",
    "ratio", DEFAULT_INPUT_RATES.trackpadRotateRate, { min: 0.01, max: 2 }, "mouse", "src/browser/safariGestures.ts"),
  rate("input.trackpad.gestureZoomExponent", "Trackpad pinch zoom (Safari)", "How strongly a pinch zooms in Safari: the pinch's change is raised to this power.",
    "none", DEFAULT_INPUT_RATES.trackpadGestureZoomExponent, { min: 0.01, max: 2 }, "mouse", "src/browser/safariGestures.ts"),
  rate("input.touch.orbitRate", "Two-finger orbit", "Degrees the view turns per pixel of two-finger drag.",
    "deg/px", DEFAULT_INPUT_RATES.touchOrbitDegPerPx, { min: 0.005, max: 2 }, "touch", "src/browser/touchController.ts"),
  rate("input.touch.panRate", "One-finger pan", "How far the view pans per pixel of one-finger drag, as a multiple of the drag.",
    "ratio", DEFAULT_INPUT_RATES.touchPanRate, { min: 0.05, max: 5 }, "touch", "src/browser/touchController.ts"),
  rate("input.touch.zoomExponent", "Pinch zoom", "How strongly a pinch zooms: the pinch's ratio is raised to this power.",
    "none", DEFAULT_INPUT_RATES.touchZoomExponent, { min: 0.02, max: 4 }, "touch", "src/browser/touchController.ts"),
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
    source: "src/gamepad/index.ts",
  },
];

export const GLOBE_INTENT_PARAMETERS: readonly ParameterSpec[] = [
  rate("input.gamepad.panRate", "Controller pan", "Pixels per second of globe pan at full controller input.",
    { id: "px-per-s", text: "px/s" }, DEFAULT_GLOBE_INTENT_RATES.panPxPerSecond, { min: 1, max: 10_000 }, "controller", "src/input/globeIntentMotion.ts"),
  rate("input.gamepad.headingRate", "Controller heading", "Degrees per second of heading turn at full controller input.",
    "deg/s", DEFAULT_GLOBE_INTENT_RATES.headingDegPerSecond, { min: 1, max: 720 }, "controller", "src/input/globeIntentMotion.ts"),
  rate("input.gamepad.pitchRate", "Controller tilt", "Degrees per second of tilt at full controller input.",
    "deg/s", DEFAULT_GLOBE_INTENT_RATES.pitchDegPerSecond, { min: 1, max: 720 }, "controller", "src/input/globeIntentMotion.ts"),
  rate("input.gamepad.zoomRate", "Controller zoom", "Natural logarithm of the distance change per second at full controller input.",
    "per-s", DEFAULT_GLOBE_INTENT_RATES.zoomLogPerSecond, { min: 0.01, max: 10 }, "controller", "src/input/globeIntentMotion.ts"),
].map(spec => ({ ...spec, defaultReason: "Retained committed globe runtime value; not measured or qualified across devices." }));

const ANCHOR_CHOICE_LABELS: { readonly [C in AnchorChoice]: string } = {
  pointer: "Under pointer",
  gesture: "Gesture start",
  target: "Compass target",
  pinned: "Pinned point",
};
const PINNED_HELP = "Pinned point is the point pinned in Controls → Orbit; without one, the compass target.";
const POINTING_REASON = "Operate on the place the person indicates without requiring a preliminary pan.";
const NON_POINTER_REASON = "There is no pointing position, so use the current compass target.";
const WHEN_GROUND_ANCHOR = "Shown while Zoom center is Ground anchor.";

/** Each family's zoom choice: label, section and help. Rotation is the compass, so it has no pivot here. */
const ANCHOR_PARAMETER_TEXT: ReadonlyArray<{ family: AnchorFamily; label: string; section: string; description: string }> = [
  { family: "mouse", label: "Wheel zoom anchor", section: "mouse",
    description: `${WHEN_GROUND_ANCHOR} Where a mouse wheel zooms toward or away from. Under pointer is the point under the pointer when the wheel turns; moving the pointer and turning it again picks a new one. ${PINNED_HELP}` },
  { family: "trackpad", label: "Trackpad zoom anchor", section: "mouse",
    description: `${WHEN_GROUND_ANCHOR} Where a trackpad pinch zooms toward or away from. Under pointer uses the browser's pointer location, since where the fingers are on the trackpad is not generally available. ${PINNED_HELP}` },
  { family: "touch", label: "Pinch zoom anchor", section: "touch",
    description: `${WHEN_GROUND_ANCHOR} Where a two-finger pinch zooms toward or away from. Gesture start is the point under the initial two-finger midpoint, held while those fingers stay down. ${PINNED_HELP}` },
  { family: "nonPointer", label: "Key, controller and button zoom anchor", section: "orbit",
    description: `${WHEN_GROUND_ANCHOR} Where keys, a controller and on-screen buttons zoom toward or away from. They have no pointing position: the compass target, or the pinned point. ${PINNED_HELP}` },
];

/** `input.zoomCenter`, each family's `input.<family>.zoomAnchor`, and whether those points are marked. */
export const NAVIGATION_ANCHOR_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: ZOOM_CENTER_ID,
    label: "Zoom center",
    description: "Where zoom moves toward. Ground anchor is the point the gesture picks: the wheel, trackpad and pinch choose theirs in Mouse and Touch, and keys, the controller and buttons choose theirs below. View center is the compass. Turning always stays on the compass.",
    unit: "none",
    kind: "choice",
    choiceControl: "two-position",
    choices: [
      { id: "anchor", label: "Ground anchor" },
      { id: "view", label: "View center" },
    ],
    default: "anchor",
    defaultReason: "Zoom moves toward the ground a gesture indicates. A turn stays on the compass.",
    persistDefault: true,
    home: { tab: CONTROLS_TAB, section: "orbit", level: "main" },
    appliesLive: true,
    source: "src/babylon/cameraState.ts",
  },
  ...ANCHOR_PARAMETER_TEXT.map(({ family, label, section, description }): ParameterSpec => ({
    id: navigationAnchorSettingId(family),
    label,
    description,
    unit: "none",
    kind: "choice",
    choices: NAVIGATION_ANCHOR_CHOICES[family].map(id => ({ id, label: ANCHOR_CHOICE_LABELS[id] })),
    default: DEFAULT_NAVIGATION_ANCHORS[family].zoom,
    defaultReason: family === "nonPointer" ? NON_POINTER_REASON : POINTING_REASON,
    persistDefault: true,
    visibleWhen: { id: ZOOM_CENTER_ID, value: "anchor" },
    home: { tab: CONTROLS_TAB, section, level: "main" },
    appliesLive: true,
    source: "src/input/navigationAnchors.ts",
  })),
  {
    id: SHOW_NAVIGATION_ANCHORS_ID,
    label: "Show grab and zoom points",
    description: "A small marker shows the ground a drag grabs, while it is held and while the camera glides on, the point a zoom acts about while it moves, and the pinned point while there is one. Turning is about the compass, which is shown or hidden on its own.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "Seeing the grabbed ground, and where a zoom acts, makes the motion predictable.",
    home: { tab: CONTROLS_TAB, section: "orbit", level: "main" },
    appliesLive: true,
    source: "src/browser/navigationAnchorMarkers.ts",
  },
];

/**
 * The zoom choices' two named sets, for a host's preset list. The FOSS Earth
 * app registers these beside its own presets; a standalone host registers the
 * same values. Rotation is the compass in both.
 */
export const NAVIGATION_ANCHOR_PRESETS: readonly SettingsPreset[] = Object.freeze([
  {
    id: "pointer-and-touch-anchors",
    name: "Pointer and touch anchors",
    description: "Zoom acts where you point: under the mouse or trackpad pointer, or where two fingers land; keys and controllers zoom about the compass. Turning stays on the compass.",
    values: NAVIGATION_ANCHOR_PRESET_VALUES.pointerAndTouch,
  },
  {
    id: "compass-centered",
    name: "Compass-centered",
    description: "Zoom and turning both act about the compass at the centre of the view, whatever the input.",
    values: NAVIGATION_ANCHOR_PRESET_VALUES.compassCentered,
  },
]);

export const CONTROLS_PARAMETERS: readonly ParameterSpec[] = [
  ...GLOBE_INTENT_PARAMETERS,
  ...CAMERA_PARAMETERS,
  ...INPUT_RATE_PARAMETERS,
  ...NAVIGATION_ANCHOR_PARAMETERS,
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
