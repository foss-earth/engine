export type TouchDebugEventType =
  | "down"
  | "move"
  | "up"
  | "cancel"
  | "classify"
  | "session";

export interface TouchDebugEvent {
  type: TouchDebugEventType;
  timestamp: number;
  pointerId?: number;
  pointerType?: string;
  clientX?: number;
  clientY?: number;
  activePointerIds?: number[];
  sessionKind?: "none" | "single" | "multi";
  intent?: "swipe" | "pinch" | null;
  /** Total centroid translation from the (re-baselined) session start. */
  centroidTranslationPx?: number;
  /** Total distance change from the (re-baselined) session start. */
  distanceDeltaPx?: number;
  hasTwoMovingTouches?: boolean;
  touchesMovingTogether?: boolean;
  /** Number of pointermove events seen for each pointer in the current session. */
  perPointerMoveCount?: Record<number, number>;
  /** Free-form note attached to a `session` or `classify` event. */
  note?: string;
}

export interface TouchDebugOverlayHandle {
  onDebug: (event: TouchDebugEvent) => void;
  destroy: () => void;
}

