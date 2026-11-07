/**
 * A click or tap on the map, taken instead of Pick point while it is armed.
 * A drag still moves the camera. Escape cancels it.
 */
export interface MapClickPicker {
  armed(): boolean;
  /** False when the click misses. The picker stays armed. */
  pickAt(client: { readonly x: number; readonly y: number }): boolean;
  cancel(): void;
}
