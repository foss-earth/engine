import { describe, expect, it } from "vitest";
import {
  componentExecutionChoices, componentExecutionEdits, NATIVE_CORE_SETTING_IDS, NATIVE_EXECUTION_TIERS, NATIVE_MAX_THREADS, NATIVE_PARAMETERS, NATIVE_THREADS_ID, NATIVE_TIER_ID,
  nativeCorePlan, nativeTierPreference,
} from "../src/settings/catalogue/native.js";

const reading = (values: Record<string, unknown>) => ({ get: <T>(id: string) => (id in values ? values[id] : "inherit") as T });

describe("native execution settings", () => {
  it("are reload-only, in their own tab, with the original TypeScript default and every tier explicit", () => {
    const spec = NATIVE_PARAMETERS.find(parameter => parameter.id === NATIVE_TIER_ID)!;
    expect(spec).toMatchObject({ kind: "choice", default: "typescript", appliesLive: false, home: { tab: "native" } });
    expect(spec.kind === "choice" && spec.choices?.map(choice => choice.id)).toEqual([...NATIVE_EXECUTION_TIERS]);
    for (const id of Object.values(NATIVE_CORE_SETTING_IDS)) {
      const core = NATIVE_PARAMETERS.find(parameter => parameter.id === id)!;
      expect(core).toMatchObject({ kind: "choice", default: "inherit", appliesLive: false, home: { tab: "native" } });
      expect(core.kind === "choice" && core.choices?.map(choice => choice.id)).toEqual(["inherit", ...NATIVE_EXECUTION_TIERS]);
    }
  });

  it("gives the A/B pair the same placement, and keeps the original placement for TypeScript", () => {
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "typescript" }), "sky")).toMatchObject({ placement: "original", kernel: "typescript", requestedBy: NATIVE_TIER_ID });
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "typescript-worker" }), "sky")).toMatchObject({ placement: "worker", kernel: "typescript" });
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "single" }), "sky")).toMatchObject({ placement: "worker", kernel: "single" });
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "threaded" }), "sky")).toMatchObject({ placement: "worker", kernel: "threaded" });
    // Auto takes each core's recorded choice, and says why.
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "auto" }), "sky")).toMatchObject({ resolved: "typescript-worker", placement: "worker", autoReason: expect.any(String) });
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "auto" }), "raster")).toMatchObject({ resolved: "typescript", kernel: "typescript" });
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "auto" }), "terrain")).toMatchObject({ resolved: "typescript", placement: "original" });
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "typescript-worker" }), "terrain")).toMatchObject({ placement: "worker", kernel: "typescript" });
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "single" }), "terrain")).toMatchObject({ placement: "worker", kernel: "single" });
  });

  it("lets one core override the selection, and refuses unknown values", () => {
    const values = { [NATIVE_TIER_ID]: "single", [NATIVE_CORE_SETTING_IDS.sky]: "typescript-worker" };
    expect(nativeCorePlan(reading(values), "sky")).toMatchObject({ requested: "typescript-worker", requestedBy: NATIVE_CORE_SETTING_IDS.sky, kernel: "typescript" });
    expect(nativeCorePlan(reading(values), "raster")).toMatchObject({ requested: "single", requestedBy: NATIVE_TIER_ID });
    for (const value of [undefined, null, 0, "wasm"]) expect(() => nativeCorePlan(reading({ [NATIVE_TIER_ID]: value }), "sky")).toThrow("Native execution must be");
    expect(() => nativeCorePlan(reading({ [NATIVE_TIER_ID]: "single", [NATIVE_CORE_SETTING_IDS.raster]: "wasm" }), "raster")).toThrow(NATIVE_CORE_SETTING_IDS.raster);
  });

  it("gives the terrain decoder the kernel its plan names", () => {
    for (const [tier, decoder] of [["typescript", "typescript"], ["typescript-worker", "typescript"], ["single", "single"], ["auto", "typescript"], ["threaded", "threaded"]] as const) {
      expect(nativeTierPreference(reading({ [NATIVE_TIER_ID]: tier }))).toBe(decoder);
    }
  });

  it("separates manual implementation, placement and independent-job parallelism", () => {
    const settings = reading({ "native.tier": "custom", "native.implementation": "typescript", "native.placement": "worker", "native.parallelism": "serial" });
    expect(nativeCorePlan(settings, "sky")).toMatchObject({ requested: "custom", resolved: "typescript-worker", kernel: "typescript", placement: "worker", parallelism: "serial" });
    expect(nativeCorePlan(reading({ "native.tier": "custom", "native.implementation": "wasm", "native.placement": "original" }), "sky"))
      .toMatchObject({ resolved: "single", kernel: "single", placement: "worker" });
  });

  it("inherits individual choices from current global defaults, including measured Auto choices", () => {
    const values = { "native.tier": "custom", "native.implementation": "wasm", "native.placement": "worker", "native.parallelism": "serial",
      "native.core.sky": "custom", "native.core.sky.implementation": "typescript" };
    expect(nativeCorePlan(reading(values), "sky")).toMatchObject({ kernel: "typescript", placement: "worker", parallelism: "serial" });
    expect(nativeCorePlan(reading({ ...values, "native.placement": "original", "native.parallelism": "auto" }), "sky"))
      .toMatchObject({ kernel: "typescript", placement: "original", parallelism: "auto" });
    expect(nativeCorePlan(reading({ "native.tier": "auto", "native.core.sky": "custom", "native.core.sky.implementation": "wasm" }), "sky"))
      .toMatchObject({ kernel: "single", placement: "worker" });
    expect(nativeCorePlan(reading({ "native.tier": "single", "native.core.raster": "custom", "native.core.raster.parallelism": "serial" }), "raster"))
      .toMatchObject({ kernel: "single", parallelism: "serial" });
  });

  it("edits legacy selections atomically without changing unrelated manual choices", () => {
    const legacy = reading({ "native.tier": "single" });
    expect(componentExecutionChoices(legacy)).toEqual({ implementation: "wasm", placement: "worker", parallelism: "auto" });
    expect(componentExecutionEdits(legacy, undefined, "implementation", "typescript")).toEqual({
      "native.tier": "custom", "native.implementation": "typescript", "native.placement": "worker", "native.parallelism": "auto" });
    expect(componentExecutionEdits(reading({ "native.tier": "typescript" }), "sky", "implementation", "wasm"))
      .toEqual({ "native.core.sky": "custom", "native.core.sky.implementation": "wasm", "native.core.sky.placement": "inherit", "native.core.sky.parallelism": "inherit" });
    expect(componentExecutionEdits(legacy, undefined, "mode", "auto")).toMatchObject({ "native.tier": "auto", "native.implementation": "wasm", "native.placement": "worker" });
  });

  it("asks for shared memory only where a shared build exists, and never relabels worker pools as threads", () => {
    const threaded = reading({ [NATIVE_TIER_ID]: "threaded", [NATIVE_THREADS_ID]: 4 });
    expect(nativeCorePlan(threaded, "sky")).toMatchObject({ kernel: "threaded", sharedMemory: true, threads: 4, threadedFallback: null, parallelism: "auto" });
    for (const core of ["raster", "terrain", "imagery", "google", "ground"] as const) {
      expect(nativeCorePlan(threaded, core)).toMatchObject({ kernel: "threaded", sharedMemory: false, threads: 1, threadedFallback: "no-shared-build" });
    }
    for (const tier of ["typescript", "typescript-worker", "single", "auto", "custom"]) {
      expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: tier, [NATIVE_THREADS_ID]: 8, "native.implementation": "wasm", "native.placement": "worker" }), "sky"))
        .toMatchObject({ sharedMemory: false, threads: 1, threadedFallback: null });
    }
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "single", [NATIVE_CORE_SETTING_IDS.sky]: "threaded", [NATIVE_THREADS_ID]: 99 }), "sky")).toMatchObject({ threads: NATIVE_MAX_THREADS });
    // A reader without the thread count runs the coordinator alone.
    expect(nativeCorePlan(reading({ [NATIVE_TIER_ID]: "threaded" }), "sky")).toMatchObject({ sharedMemory: true, threads: 1 });
    const spec = NATIVE_PARAMETERS.find(parameter => parameter.id === NATIVE_THREADS_ID)!;
    expect(spec).toMatchObject({ kind: "number", appliesLive: false, home: { tab: "native" } });
    const derive = spec.default as unknown as (context: { hardwareConcurrency: number | null; deviceMemoryGiB: number | null }) => { value: number };
    expect([null, 1, 2, 4, 16].map(hardwareConcurrency => derive({ hardwareConcurrency, deviceMemoryGiB: null }).value)).toEqual([1, 1, 1, 3, 4]);
  });

});
