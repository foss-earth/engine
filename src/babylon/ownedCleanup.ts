/** Attempt every Engine-owned release after retiring its references. Borrowed
 * scene/device/frame authorities are never registered here. */
export function finishOwnedCleanup(actions: readonly (() => void)[], message: string, priorFailures: readonly unknown[] = []): void {
  const failures = [...priorFailures];
  for (const action of actions) try { action(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}
