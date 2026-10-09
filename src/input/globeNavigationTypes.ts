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

