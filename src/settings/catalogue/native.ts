import type { ParameterSpec, SettingsRegistry } from "@foss-earth/ui/settings";
import type { NativeTierPreference } from "../../browser/terrainNativeDecoder.js";

export const NATIVE_TIER_ID = "native.tier";
export const NATIVE_PARAMETERS: readonly ParameterSpec[] = [{
  id: NATIVE_TIER_ID, label: "Terrain numeric backend", kind: "choice", unit: "none",
  description: "Selects Terrarium RGBA-to-height conversion inside terrain decode workers after reload. Image decoding and page execution keep their existing browser/TypeScript paths. Auto and single try single-threaded WASM after exact first-input parity; failures permanently use TypeScript for that worker. Threaded is not supported by this slice.",
  choices: [
    { id: "auto", label: "Auto (worker WASM after parity)" },
    { id: "typescript", label: "TypeScript" },
    { id: "single", label: "Single-threaded WASM" },
    { id: "threaded", label: "Threaded (TypeScript fallback)" },
  ],
  default: "typescript", defaultReason: "Keep the existing backend until this narrow native slice has qualified parity and performance evidence.",
  home: { tab: "native", section: "terrain", level: "all" }, appliesLive: false,
  source: "src/browser/terrainNativeDecoder.ts",
}];
/** Capture once when constructing workers; the setting deliberately needs reload. */
export function nativeTierPreference(settings: Pick<SettingsRegistry, "get">): NativeTierPreference {
  const value = settings.get(NATIVE_TIER_ID);
  if (value !== "auto" && value !== "typescript" && value !== "single" && value !== "threaded") throw new Error("Native tier must be auto, typescript, single, or threaded.");
  return value;
}
