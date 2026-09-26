import type { ParameterSpec } from "../types";

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

export const CONTROLS_PARAMETERS: readonly ParameterSpec[] = [
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
