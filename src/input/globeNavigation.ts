import {
  DEFAULT_BINDING_TRANSFORM,
  createDefaultProfile,
  type ActionDescriptor,
  type ActionIntentFrame,
  type BindingProfile,
  type BindingSource,
  type BindingSpec,
  type HostInputAdapter,
} from "@felipegalind0/gamepad-tools/core";

export type GlobeNavigationActionId =
  | "globe.panX"
  | "globe.panY"
  | "globe.orbitHeading"
  | "globe.orbitPitch"
  | "globe.zoom";

export interface GlobeNavigationIntent {
  actionId: GlobeNavigationActionId;
  value: number;
}

export interface GlobeNavigationIntentFrame {
  dt: number;
  intents: readonly GlobeNavigationIntent[];
}

export interface GlobeNavigationTarget {
  applyGlobeNavigationIntents(frame: GlobeNavigationIntentFrame): void;
}

export interface GlobeGamepadAdapterOptions {
  getContext?(): string;
  onResetNorth?(): void;
}

export const GLOBE_GAMEPAD_ACTIONS: readonly ActionDescriptor[] = [
  { id: "globe.panX", label: "Pan left / right", category: "Navigation", kind: "rate", range: [-1, 1], contexts: ["globe"], available: true },
  { id: "globe.panY", label: "Pan forward / back", category: "Navigation", kind: "rate", range: [-1, 1], contexts: ["globe"], available: true },
  { id: "globe.orbitHeading", label: "Orbit heading", category: "Navigation", kind: "rate", range: [-1, 1], contexts: ["globe"], available: true },
  { id: "globe.orbitPitch", label: "Orbit pitch", category: "Navigation", kind: "rate", range: [-1, 1], contexts: ["globe"], available: true },
  { id: "globe.zoom", label: "Zoom", category: "Navigation", kind: "rate", range: [-1, 1], contexts: ["globe"], available: true },
  { id: "globe.resetNorth", label: "Reset north-up", category: "Navigation", kind: "command", contexts: ["globe"], available: true },
];

/**
 * Host-owned action adapter. It deliberately works in rates and delegates
 * conversion to screen-space/inertial camera motion to the runtime.
 */
export function createGlobeGamepadAdapter(
  target: GlobeNavigationTarget,
  options: GlobeGamepadAdapterOptions = {},
): HostInputAdapter {
  let captureActive = false;
  return {
    namespace: "foss-earth",
    actions: GLOBE_GAMEPAD_ACTIONS,
    getContext: () => options.getContext?.() ?? "globe",
    applyIntents(frame: ActionIntentFrame): void {
      if (captureActive) {
        return;
      }
      if (frame.intents.some((intent) => intent.actionId === "globe.resetNorth"
        && intent.kind === "command" && intent.edge === "press")) {
        options.onResetNorth?.();
      }
      const intents: GlobeNavigationIntent[] = [];
      for (const intent of frame.intents) {
        // A resting stick reports zero on every poll. Forwarding it would wake
        // the on-demand renderer each time without moving the camera.
        if (intent.kind !== "rate" || !Number.isFinite(intent.value) || intent.value === 0) {
          continue;
        }
        if (intent.actionId === "globe.panX"
          || intent.actionId === "globe.panY"
          || intent.actionId === "globe.orbitHeading"
          || intent.actionId === "globe.orbitPitch"
          || intent.actionId === "globe.zoom") {
          intents.push({ actionId: intent.actionId, value: intent.value });
        }
      }
      if (intents.length > 0) {
        target.applyGlobeNavigationIntents({ dt: frame.dt, intents });
      }
    },
    setBindingCapture(active: boolean): void {
      captureActive = active;
    },
  };
}

export const STANDARD_GLOBE_PROFILE_ID = "foss-earth-standard-globe";
export const STANDARD_GLOBE_PROFILE_NAME = "Standard controller";

/**
 * Navigation actions are rates, so any stick drift outside the deadzone keeps
 * the camera creeping and the scene rendering: `input.gamepad.deadzone`'s default.
 */
export const DEFAULT_GLOBE_STICK_DEADZONE = 0.15;

function axisSource(slot: number, axisIndex: number): BindingSource {
  return { selector: { kind: "gamepad-axis", gamepadSlot: slot, axisIndex } };
}

function buttonSource(slot: number, buttonIndex: number): BindingSource {
  return { selector: { kind: "gamepad-button", gamepadSlot: slot, buttonIndex } };
}

function stickRate(id: string, actionId: GlobeNavigationActionId, source: BindingSource, deadzone: number, invert = false): BindingSpec {
  return {
    id,
    actionId,
    kind: "single",
    semantics: "rate",
    contexts: ["globe"],
    enabled: true,
    precedence: 0,
    transform: { ...DEFAULT_BINDING_TRANSFORM, deadzone, invert },
    source,
  };
}

/**
 * Bindings for a controller that reports the browser's "standard" layout.
 * Directions match the mouse: the right stick orbits the way a right drag
 * does, and the left stick moves the view the way it points.
 */
export function createStandardGlobeProfile(slot = 0, deadzone = DEFAULT_GLOBE_STICK_DEADZONE): BindingProfile {
  return {
    ...createDefaultProfile("foss-earth"),
    profileId: STANDARD_GLOBE_PROFILE_ID,
    name: STANDARD_GLOBE_PROFILE_NAME,
    contexts: ["globe"],
    bindings: [
      stickRate("standard-pan-x", "globe.panX", axisSource(slot, 0), deadzone),
      // Stick Y reads negative when pushed up; up should move forward.
      stickRate("standard-pan-y", "globe.panY", axisSource(slot, 1), deadzone, true),
      stickRate("standard-orbit-heading", "globe.orbitHeading", axisSource(slot, 2), deadzone),
      stickRate("standard-orbit-pitch", "globe.orbitPitch", axisSource(slot, 3), deadzone),
      {
        id: "standard-zoom",
        actionId: "globe.zoom",
        kind: "paired",
        semantics: "rate",
        contexts: ["globe"],
        enabled: true,
        precedence: 0,
        transform: { ...DEFAULT_BINDING_TRANSFORM, inputRange: [0, 1], outputRange: [-1, 1] },
        // Right trigger zooms in, left trigger zooms out.
        positiveSource: buttonSource(slot, 7),
        negativeSource: buttonSource(slot, 6),
      },
      {
        id: "standard-reset-north",
        actionId: "globe.resetNorth",
        kind: "single",
        semantics: "command",
        contexts: ["globe"],
        enabled: true,
        precedence: 0,
        transform: { ...DEFAULT_BINDING_TRANSFORM, inputRange: [0, 1], outputRange: [0, 1] },
        // The top face button: Y on an Xbox layout.
        source: buttonSource(slot, 3),
      },
    ],
  };
}

/**
 * The profile with every stick bound to a navigation rate at `deadzone`, the
 * one `input.gamepad.deadzone` sets. Other bindings are left as they are; the
 * same profile comes back when nothing changes.
 */
export function withStickDeadzone(profile: BindingProfile, deadzone: number): BindingProfile {
  let changed = false;
  const bindings = profile.bindings.map((binding) => {
    if (binding.kind !== "single" || binding.semantics !== "rate" || binding.source.selector.kind !== "gamepad-axis"
      || binding.transform.deadzone === deadzone) return binding;
    changed = true;
    return { ...binding, transform: { ...binding.transform, deadzone } };
  });
  return changed ? { ...profile, bindings } : profile;
}
