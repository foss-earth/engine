/** Shape shared by keyboard motion and its preview. Times are milliseconds. */
export interface NavigationSpeedCurve { accelerationMs: number; accelerationPower: number; slowdownMs: number; slowdownPower: number }
export const DEFAULT_NAVIGATION_SPEED_CURVE: Readonly<NavigationSpeedCurve> = Object.freeze({ accelerationMs: 350, accelerationPower: 1.5, slowdownMs: 450, slowdownPower: 2 });
export function navigationCurveShare(progress: number, power: number, slowing: boolean): number {
  const t = Math.max(0, Math.min(1, progress));
  const exponent = Number.isFinite(power) ? Math.max(0.75, Math.min(4, power)) : 1;
  // Quintic easing brings acceleration and braking to rest at both endpoints.
  const eased = t * t * t * (t * (6 * t - 15) + 10);
  return slowing ? (1 - eased) ** exponent : eased ** exponent;
}
/** Retarget from the current speed, including a direction reversal during a coast. */
export function createNavigationSpeedAxis() {
  let value = 0, from = 0, goal = 0, elapsed = 0;
  return {
    reset() { value = from = goal = elapsed = 0; },
    step(target: number, dtMs: number, curve: NavigationSpeedCurve): number {
      if (target !== goal) { from = value; goal = target; elapsed = 0; }
      elapsed += Math.max(0, dtMs);
      const slowing = goal === 0;
      const duration = slowing ? curve.slowdownMs : curve.accelerationMs;
      const progress = duration > 0 ? elapsed / duration : 1;
      const share = navigationCurveShare(progress, slowing ? curve.slowdownPower : curve.accelerationPower, slowing);
      value = progress >= 1 ? goal : slowing ? from * share : from + (goal - from) * share;
      return value;
    },
  };
}
