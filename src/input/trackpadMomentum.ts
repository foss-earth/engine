/**
 * A two-finger swipe measured on this trackpad kept sending wheel events for
 * 1083 ms after its strongest sample, and those events got smaller. A pinch,
 * a button-drag turn and a one-finger pan stop when the fingers do. The globe
 * feeds those itself, on this curve, and leaves a swipe to the trackpad.
 */
export const TRACKPAD_MOMENTUM_MS = 1100;

/** The fraction of the release rate still being fed `elapsedMs` into the tail. */
export function trackpadMomentumFraction(elapsedMs: number): number {
  if (!(elapsedMs >= 0) || elapsedMs >= TRACKPAD_MOMENTUM_MS) return 0;
  return Math.exp(-3 * elapsedMs / TRACKPAD_MOMENTUM_MS);
}
