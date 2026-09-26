/** How the automatic adjustment observes frames and moves: `map.auto.*`. */
export interface AutoDetailTuning {
  /** The frame interval aimed for, ms; null measures the display's. */
  goalMs: number | null;
  /** Multiples of the goal: a slower window counts toward coarsening, a faster one toward refining. */
  coarsenAbove: number;
  refineBelow: number;
  windowMs: number;
  coarsenWindows: number;
  refineWindows: number;
  /** Levels per adjustment. */
  step: number;
  /** The least time between adjustments, ms. */
  intervalMs: number;
}

export interface AutoDetailDecision {
  at: number;
  /** Levels coarser than requested, before and after. */
  from: number;
  to: number;
  meanFrameMs: number;
  goalMs: number;
}

export interface AutoDetailState {
  /** Levels coarser than requested: 0 is the request itself. */
  adjustment: number;
  /** The most it may coarsen: the room left in the enabled details' ranges. */
  room: number;
  /** The goal in use, ms: set, or measured; null until a frame is measured. */
  goalMs: number | null;
  /** The last window's average frame interval, ms. */
  lastMeanMs: number | null;
  lastDecision: AutoDetailDecision | null;
}

/**
 * One adjustment, in levels, shared by every detail allowed to move: each
 * turns it into its own scale and stops at its own range. It only ever
 * coarsens from what was requested, and returns toward it; it never refines
 * past it. Frame intervals over 250 ms, and frames while suspended (a hidden
 * page), are not evidence of load.
 */
export function createAutoDetailController(initial: AutoDetailTuning) {
  let tuning = initial;
  let adjustment = 0;
  let room = 0;
  let measuredGoal: number | null = null;
  let windowStartedAt: number | null = null;
  let total = 0;
  let frames = 0;
  let slow = 0;
  let fast = 0;
  let nextChangeAt = 0;
  let lastMeanMs: number | null = null;
  let lastDecision: AutoDetailDecision | null = null;

  const restartWindow = (): void => { windowStartedAt = null; total = 0; frames = 0; };
  const goal = (): number | null => tuning.goalMs ?? measuredGoal;

  function decide(now: number, to: number, mean: number, goalMs: number): AutoDetailDecision {
    lastDecision = { at: now, from: adjustment, to, meanFrameMs: mean, goalMs };
    adjustment = to;
    slow = 0;
    fast = 0;
    nextChangeAt = now + tuning.intervalMs;
    return lastDecision;
  }

  return {
    getState: (): AutoDetailState => ({ adjustment, room, goalMs: goal(), lastMeanMs, lastDecision }),
    getAdjustment: () => adjustment,
    setTuning(next: AutoDetailTuning): void {
      if (next.windowMs !== tuning.windowMs) restartWindow();
      tuning = next;
    },
    /**
     * How far the enabled details can still coarsen, in levels. Less room than
     * the current adjustment pulls it back at once; none stops adjusting.
     */
    setRoom(next: number): AutoDetailDecision | null {
      room = Math.max(0, next);
      if (adjustment <= room) return null;
      const decision = { at: lastDecision?.at ?? 0, from: adjustment, to: room, meanFrameMs: lastMeanMs ?? 0, goalMs: goal() ?? 0 };
      adjustment = room;
      lastDecision = decision;
      return decision;
    },
    /** Returns a decision when the adjustment changed. */
    observe(now: number, frameMs: number, suspended: boolean): AutoDetailDecision | null {
      if (suspended || !Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250) return null;
      // Vsync holds frames at the refresh interval: the shortest interval seen is the display's.
      if (frameMs >= 2) measuredGoal = measuredGoal === null ? frameMs : Math.min(measuredGoal, frameMs);
      if (windowStartedAt === null) windowStartedAt = now;
      total += frameMs;
      frames += 1;
      if (now - windowStartedAt < tuning.windowMs) return null;
      const mean = total / frames;
      restartWindow();
      lastMeanMs = mean;
      const goalMs = goal();
      if (goalMs === null || (room <= 0 && adjustment === 0)) return null;
      if (mean > goalMs * tuning.coarsenAbove) {
        slow += 1;
        fast = 0;
        if (slow >= tuning.coarsenWindows && now >= nextChangeAt && adjustment < room) {
          return decide(now, Math.min(room, adjustment + tuning.step), mean, goalMs);
        }
      } else if (mean < goalMs * tuning.refineBelow) {
        fast += 1;
        slow = 0;
        if (fast >= tuning.refineWindows && now >= nextChangeAt && adjustment > 0) {
          return decide(now, Math.max(0, adjustment - tuning.step), mean, goalMs);
        }
      } else {
        slow = 0;
        fast = 0;
      }
      return null;
    },
  };
}

export type AutoDetailController = ReturnType<typeof createAutoDetailController>;
