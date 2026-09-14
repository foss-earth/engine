import type {
  ActionDescriptor,
  ActionIntentFrame,
  HostInputAdapter,
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
        if (intent.kind !== "rate" || !Number.isFinite(intent.value)) {
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
