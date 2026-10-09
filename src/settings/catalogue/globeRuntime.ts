import type { ParameterSpec, SettingsRegistry } from "@foss-earth/ui/settings";
/** Actual source runtime costs; register once with the host catalogue. */
export const GLOBE_RUNTIME_PARAMETERS: readonly ParameterSpec[] = [
  ["visualization.fallback.segments", "Fallback sphere segments", "The subdivision of the fallback globe while map coverage is being prepared.", 96, 8, 512, "count", "renderer", "performance"],
  ["map.google.startupTimeout", "Google startup wait", "Time allowed for the first visible Google coverage before selecting the configured fallback.", 10000, 0, 600000, "ms", "map", "loading"],
  ["map.google.externalStartupTimeout", "External-camera startup wait", "Time allowed for the first Google coverage while the host owns an external camera/world root.", 120000, 0, 600000, "ms", "map", "loading"],
  ["map.preparation.timeout", "Destination preparation wait", "Time allowed for displayed terrain to meet the host's explicit destination policy.", 120000, 0, 600000, "ms", "map", "loading"],
  ["map.preparation.sampleInterval", "Destination sample interval", "Time between checks of displayed destination terrain on the host's existing frames.", 200, 0, 5000, "ms", "map", "loading"],
  ["map.preparation.stalledAfter", "Destination stall notice", "Time without usable-ground improvement before preparation reports stalled telemetry.", 15000, 0, 600000, "ms", "map", "loading"],
  ["map.debug.recentEvents", "Recent map debug events", "The maximum number of recent events retained only when the host explicitly enables map debug observation.", 100, 0, 10000, "count", "map", "loading"],
].map(([id,label,description,value,min,max,unit,tab,section]): ParameterSpec => ({
  id: String(id),label: String(label),description: String(description),kind: "number",unit: unit as "count" | "ms",
  bounds: () => ({ min: Number(min),max: Number(max) }),default: Number(value),...(unit === "count" ? { step: 1 } : {}),
  defaultReason: "The actual committed runtime value before it became a named host parameter.",
  home: { tab: String(tab),section: String(section),level: "all" },appliesLive: true,source: "src/engine/babylon/createBabylonRuntime.ts",
}));
export function createGlobeRuntimeBudgets(settings: Pick<SettingsRegistry,"get">) {
  return {
    fallbackSegments: () => settings.get<number>("visualization.fallback.segments"),
    googleStartupTimeoutMs: (external: boolean) => settings.get<number>(external ? "map.google.externalStartupTimeout" : "map.google.startupTimeout"),
    debugEventCapacity: () => settings.get<number>("map.debug.recentEvents"),
    sampleIntervalMs: () => settings.get<number>("map.preparation.sampleInterval"),
    stalledAfterMs: () => settings.get<number>("map.preparation.stalledAfter"),
    timeoutMs: () => settings.get<number>("map.preparation.timeout"),
  };
}
