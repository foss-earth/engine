/** The frame the globe's glide (`camera.inertiaDecay`) is given per. */
const GLIDE_FRAME_MS = 1000 / 60;
/** A glide has settled once this share of its motion is left: nothing on screen still moves. */
const SETTLED_SHARE = 0.001;

/**
 * The globe's glide over time, keeping `keepPerFrame` of its speed each
 * 60 Hz frame: how much of its motion is done `ms` after it starts, from 0
 * to 1, and when it has settled. What changes with a glide, such as an
 * orb's sphere turning back into the orb, follows it on this curve.
 */
export function glideSettling(keepPerFrame: number): { durationMs: number; settled(ms: number): number } {
  const keep = Math.max(0, Math.min(0.999, keepPerFrame));
  if (keep === 0) return { durationMs: 0, settled: () => 1 };
  const decay = -Math.log(keep) / GLIDE_FRAME_MS;
  const durationMs = Math.log(1 / SETTLED_SHARE) / decay;
  return { durationMs, settled: ms => (ms >= durationMs ? 1 : (1 - Math.exp(-decay * Math.max(0, ms))) / (1 - SETTLED_SHARE)) };
}
