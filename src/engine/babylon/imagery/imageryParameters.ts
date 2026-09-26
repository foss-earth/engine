import type { SettingsRegistry } from "../../../settings/registry";
import type { ImageryTuning } from "./createImageryRuntime";
import type { ImageryResourceLimits } from "./imageryResidency";

const MiB = 1024 * 1024;

/** The parameters that bound imagery work: a change applies at the next update. */
export const IMAGERY_LIMIT_IDS = [
  "map.imagery.gpuBudget",
  "map.imagery.stagingBudget",
  "map.imagery.concurrentRequests",
  "map.imagery.queuedRequests",
  "map.imagery.uploadPerFrame",
  "map.imagery.selectionTimePerFrame",
] as const;

/** The parameters that tune how imagery is chosen and drawn. */
export const IMAGERY_TUNING_IDS = [
  "map.imagery.reselectWhileMoving",
  "map.imagery.anisotropy",
  "map.imagery.fallbackGap",
  "map.imagery.fallbackStep",
  "map.imagery.pageTablePatches",
  "map.imagery.maxNodes",
  "map.imagery.refineAbove",
  "map.imagery.coarsenBelow",
  "map.imagery.coarsenAfter",
  "map.imagery.pinFor",
] as const;

function number(settings: SettingsRegistry, id: string): number {
  const value = settings.get(id);
  if (typeof value !== "number") throw new Error(`${id} is not a number.`);
  return value;
}

export function imageryLimitsFrom(settings: SettingsRegistry): ImageryResourceLimits {
  return {
    gpuBytes: number(settings, "map.imagery.gpuBudget") * MiB,
    stagingBytes: number(settings, "map.imagery.stagingBudget") * MiB,
    concurrentRequests: Math.round(number(settings, "map.imagery.concurrentRequests")),
    queuedRequests: Math.round(number(settings, "map.imagery.queuedRequests")),
    uploadBytesPerUpdate: number(settings, "map.imagery.uploadPerFrame") * MiB,
    cpuMsPerUpdate: number(settings, "map.imagery.selectionTimePerFrame"),
  };
}

export function imageryTuningFrom(settings: SettingsRegistry): ImageryTuning {
  return {
    reselectWhileMovingMs: number(settings, "map.imagery.reselectWhileMoving"),
    anisotropy: Math.round(number(settings, "map.imagery.anisotropy")),
    fallbackGap: Math.round(number(settings, "map.imagery.fallbackGap")),
    fallbackStep: Math.round(number(settings, "map.imagery.fallbackStep")),
    tablePatches: Math.round(number(settings, "map.imagery.pageTablePatches")),
    maxNodes: Math.round(number(settings, "map.imagery.maxNodes")),
    hysteresis: {
      refineAbove: number(settings, "map.imagery.refineAbove"),
      coarsenBelow: number(settings, "map.imagery.coarsenBelow"),
      coarsenAfterMs: number(settings, "map.imagery.coarsenAfter"),
      pinMs: number(settings, "map.imagery.pinFor"),
    },
  };
}
