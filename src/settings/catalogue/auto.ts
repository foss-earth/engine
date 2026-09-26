import type { ParameterSpec } from "../types";
import { MAP_TAB } from "./map";

const CONTROLLER = "src/terrain/autoDetail.ts";
const REPLACED = "the quality profiles' automatic mode this replaces";

function auto(spec: Omit<ParameterSpec, "home" | "appliesLive" | "source"> & { level?: "main" | "all" }): ParameterSpec {
  const { level, ...rest } = spec;
  return { ...rest, home: { tab: MAP_TAB, section: "auto", level: level ?? "all" }, appliesLive: true, source: CONTROLLER };
}

/**
 * Map → Automatic adjustment: what may coarsen when frames take too long, and
 * how quickly. It moves detail only from the requested value toward the
 * coarse end of that detail's range, and back.
 */
export const MAP_AUTO_PARAMETERS: readonly ParameterSpec[] = [
  auto({
    id: "map.auto.terrainDetail",
    label: "Coarsen terrain to hold the frame time",
    description: "When frames take too long, the terrain mesh's error may grow toward the coarse end of its range, and shrink back once they are fast again.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: `Terrain was the detail ${REPLACED} moved.`,
    level: "main",
  }),
  auto({
    id: "map.auto.imageryDetail",
    label: "Coarsen 2D imagery to hold the frame time",
    description: "When frames take too long, 2D imagery may drop toward the coarse end of its range, and return once they are fast again.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "Imagery detail is the other cost the detail rail sets.",
    level: "main",
  }),
  auto({
    id: "map.auto.frameTimeGoal",
    label: "Frame time goal",
    description: "The time between frames the adjustment aims for; its thresholds are multiples of it.",
    unit: "ms",
    kind: "number",
    named: [{ id: "display", label: "The display's refresh interval, measured" }],
    bounds: () => ({ min: 4, max: 100 }),
    step: 0.5,
    scale: "log2",
    default: "display",
    defaultReason: "The display shows no more frames than it refreshes: the shortest interval between frames measured so far.",
    level: "main",
  }),
  auto({
    id: "map.auto.coarsenAbove",
    label: "Coarsen above",
    description: "A window whose frames average more than this multiple of the goal counts toward coarsening.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 1, max: 3 }),
    step: 0.01,
    scale: "linear",
    default: 1.2,
    defaultReason: `20 ms at 60 Hz, the threshold of ${REPLACED}.`,
  }),
  auto({
    id: "map.auto.refineBelow",
    label: "Refine below",
    description: "A window whose frames average less than this multiple of the goal counts toward refining again. At 1 or above, frames held at the display's rate count; below, only spare time does.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 0.5, max: 1.2 }),
    step: 0.01,
    scale: "linear",
    default: 0.84,
    defaultReason: `14 ms at 60 Hz, the threshold of ${REPLACED}: a display holding 60 Hz is not taken as spare time.`,
  }),
  auto({
    id: "map.auto.window",
    label: "Observation window",
    description: "Frames are averaged over windows this long.",
    unit: "ms",
    kind: "number",
    bounds: () => ({ min: 250, max: 10_000 }),
    step: 50,
    scale: "log2",
    default: 1000,
    defaultReason: `The window of ${REPLACED}.`,
  }),
  auto({
    id: "map.auto.coarsenWindows",
    label: "Slow windows before coarsening",
    description: "How many slow windows in a row it takes to coarsen.",
    unit: "count",
    kind: "number",
    bounds: () => ({ min: 1, max: 20 }),
    step: 1,
    scale: "linear",
    default: 2,
    defaultReason: `The count of ${REPLACED}.`,
  }),
  auto({
    id: "map.auto.refineWindows",
    label: "Fast windows before refining",
    description: "How many fast windows in a row it takes to refine again.",
    unit: "count",
    kind: "number",
    bounds: () => ({ min: 1, max: 60 }),
    step: 1,
    scale: "linear",
    default: 10,
    defaultReason: `The count of ${REPLACED}.`,
  }),
  auto({
    id: "map.auto.step",
    label: "Step",
    description: "How far one adjustment moves detail, in levels: a level halves the terrain mesh's error target, or halves imagery's pixel size.",
    unit: "levels",
    kind: "number",
    bounds: () => ({ min: 0.05, max: 2 }),
    step: 0.05,
    scale: "linear",
    default: 0.25,
    defaultReason: "A quarter level, the detail rail's own step, in place of the profiles' whole-profile hops.",
  }),
  auto({
    id: "map.auto.interval",
    label: "Time between adjustments",
    description: "The least time between two adjustments, so each one's effect can be seen before the next.",
    unit: "ms",
    kind: "number",
    bounds: () => ({ min: 0, max: 60_000 }),
    step: 100,
    scale: "linear",
    default: 5000,
    defaultReason: `The interval of ${REPLACED}.`,
  }),
];
