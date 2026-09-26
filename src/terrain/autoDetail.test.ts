import { describe, expect, it } from "vitest";
import { createAutoDetailController, type AutoDetailTuning } from "./autoDetail";

/** Today's values: 1 s windows, 20 and 14 ms at 60 Hz, two and ten windows, 5 s apart, quarter levels. */
const TUNING: AutoDetailTuning = {
  goalMs: null, coarsenAbove: 1.2, refineBelow: 0.84, windowMs: 1000,
  coarsenWindows: 2, refineWindows: 10, step: 0.25, intervalMs: 5000,
};

/** Frames of `frameMs` for `seconds`, starting at `from` ms; returns the decisions and the end time. */
function run(controller: ReturnType<typeof createAutoDetailController>, from: number, seconds: number, frameMs: number) {
  const decisions = [];
  let now = from;
  while (now < from + seconds * 1000) {
    now += frameMs;
    const decision = controller.observe(now, frameMs, false);
    if (decision) decisions.push(decision);
  }
  return { decisions, now };
}

describe("automatic detail adjustment", () => {
  it("measures the display's interval as its goal and coarsens by steps when frames are slow", () => {
    const controller = createAutoDetailController(TUNING);
    controller.setRoom(2);
    let { now } = run(controller, 0, 2, 1000 / 60);
    expect(controller.getState().goalMs).toBeCloseTo(16.67, 1);
    expect(controller.getAdjustment()).toBe(0);
    const slow = run(controller, now, 14, 25);
    now = slow.now;
    // Two slow windows, then at most one step every five seconds.
    expect(slow.decisions.map(decision => decision.to)).toEqual([0.25, 0.5, 0.75]);
    expect(slow.decisions[0]).toMatchObject({ from: 0, to: 0.25, goalMs: expect.closeTo(16.67, 1) });
    expect(slow.decisions[0].meanFrameMs).toBeCloseTo(25, 0);
  });

  it("does not take frames held at the display's rate as spare time, unless told to", () => {
    const controller = createAutoDetailController(TUNING);
    controller.setRoom(2);
    const fast = run(controller, 0, 1, 1000 / 60);
    const slow = run(controller, fast.now, 3, 25);
    expect(controller.getAdjustment()).toBe(0.25);
    const held = run(controller, slow.now, 30, 1000 / 60);
    expect(held.decisions).toEqual([]);
    controller.setTuning({ ...TUNING, refineBelow: 1.05 });
    expect(run(controller, held.now, 30, 1000 / 60).decisions.map(decision => decision.to)).toEqual([0]);
    expect(controller.getAdjustment()).toBe(0);
  });

  it("measures its goal from the fastest frames seen, so frames that were never faster are not slow", () => {
    const controller = createAutoDetailController(TUNING);
    controller.setRoom(2);
    run(controller, 0, 10, 25);
    expect(controller.getState().goalMs).toBe(25);
    expect(controller.getAdjustment()).toBe(0);
  });

  it("stays within the room the ranges leave, and returns inside it when that shrinks", () => {
    const controller = createAutoDetailController({ ...TUNING, goalMs: 16, intervalMs: 0, coarsenWindows: 1 });
    controller.setRoom(0.5);
    run(controller, 0, 10, 40);
    expect(controller.getAdjustment()).toBe(0.5);
    expect(controller.setRoom(0.25)).toMatchObject({ from: 0.5, to: 0.25 });
    expect(controller.getAdjustment()).toBe(0.25);
    // With nothing enabled, it neither coarsens nor waits to.
    controller.setRoom(0);
    expect(run(controller, 10_000, 10, 40).decisions).toEqual([]);
    expect(controller.getAdjustment()).toBe(0);
  });

  it("ignores hidden pages and stalls longer than 250 ms", () => {
    const controller = createAutoDetailController({ ...TUNING, goalMs: 16, intervalMs: 0, coarsenWindows: 1 });
    controller.setRoom(2);
    for (let now = 0; now < 5000; now += 40) controller.observe(now, 40, true);
    for (let now = 0; now < 5000; now += 300) controller.observe(now, 300, false);
    expect(controller.getAdjustment()).toBe(0);
    expect(controller.getState().lastMeanMs).toBeNull();
  });

  it("takes a frame-rate cap's interval as the least goal, so capped frames are not slow ones", () => {
    const controller = createAutoDetailController({ ...TUNING, goalMs: null, leastGoalMs: 1000 / 30 });
    controller.setRoom(4);
    let now = 0;
    // The display refreshes at 60 Hz; capped at 30 fps, frames come every 33 ms.
    controller.observe(now, 1000 / 60, false);
    for (let i = 0; i < 600; i++) { now += 1000 / 30; controller.observe(now, 1000 / 30, false); }
    expect(controller.getState().goalMs).toBeCloseTo(1000 / 30, 6);
    expect(controller.getAdjustment()).toBe(0);
  });
});
