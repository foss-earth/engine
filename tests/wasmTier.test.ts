import { describe, expect, it } from "vitest";
import {
  componentExecutionChoices, componentExecutionEdits, WASM_CORE_SETTING_IDS, WASM_EXECUTION_TIERS, WASM_MAX_THREADS, WASM_PARAMETERS, WASM_SHARED_SKY_ID, WASM_THREADS_ID, WASM_TIER_ID,
  wasmCorePlan, wasmTierPreference,
} from "../src/settings/catalogue/wasm.js";

const reading = (values: Record<string, unknown>) => ({ get: <T>(id: string) => (id in values ? values[id] : "inherit") as T });

describe("WASM execution settings", () => {
  it("are reload-only, in their own tab, with WebAssembly in worker pools by default and every tier explicit", () => {
    const spec = WASM_PARAMETERS.find(parameter => parameter.id === WASM_TIER_ID)!;
    expect(spec).toMatchObject({ kind: "choice", default: "single", appliesLive: false, home: { tab: "wasm" } });
    expect(WASM_PARAMETERS.find(parameter => parameter.id === "wasm.parallelism")).toMatchObject({ default: "auto" });
    expect(spec.kind === "choice" && spec.choices?.map(choice => choice.id)).toEqual([...WASM_EXECUTION_TIERS]);
    for (const id of Object.values(WASM_CORE_SETTING_IDS)) {
      const core = WASM_PARAMETERS.find(parameter => parameter.id === id)!;
      expect(core).toMatchObject({ kind: "choice", default: "inherit", appliesLive: false, home: { tab: "wasm" } });
      expect(core.kind === "choice" && core.choices?.map(choice => choice.id)).toEqual(["inherit", ...WASM_EXECUTION_TIERS]);
    }
  });

  it("gives the A/B pair the same placement, and keeps the original placement for TypeScript", () => {
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "typescript" }), "sky")).toMatchObject({ placement: "original", kernel: "typescript", requestedBy: WASM_TIER_ID });
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "typescript-worker" }), "sky")).toMatchObject({ placement: "worker", kernel: "typescript" });
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "single" }), "sky")).toMatchObject({ placement: "worker", kernel: "single" });
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "threaded" }), "sky")).toMatchObject({ placement: "worker", kernel: "threaded" });
    // Auto takes each core's recorded choice, and says why.
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "auto" }), "sky")).toMatchObject({ resolved: "typescript-worker", placement: "worker", autoReason: expect.any(String) });
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "auto" }), "raster")).toMatchObject({ resolved: "typescript", kernel: "typescript" });
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "auto" }), "terrain")).toMatchObject({ resolved: "typescript", placement: "original" });
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "typescript-worker" }), "terrain")).toMatchObject({ placement: "worker", kernel: "typescript" });
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "single" }), "terrain")).toMatchObject({ placement: "worker", kernel: "single" });
  });

  it("lets one core override the selection, and refuses unknown values", () => {
    const values = { [WASM_TIER_ID]: "single", [WASM_CORE_SETTING_IDS.sky]: "typescript-worker" };
    expect(wasmCorePlan(reading(values), "sky")).toMatchObject({ requested: "typescript-worker", requestedBy: WASM_CORE_SETTING_IDS.sky, kernel: "typescript" });
    expect(wasmCorePlan(reading(values), "raster")).toMatchObject({ requested: "single", requestedBy: WASM_TIER_ID });
    for (const value of [undefined, null, 0, "wasm"]) expect(() => wasmCorePlan(reading({ [WASM_TIER_ID]: value }), "sky")).toThrow("WASM execution must be");
    expect(() => wasmCorePlan(reading({ [WASM_TIER_ID]: "single", [WASM_CORE_SETTING_IDS.raster]: "wasm" }), "raster")).toThrow(WASM_CORE_SETTING_IDS.raster);
  });

  it("gives the terrain decoder the kernel its plan names", () => {
    for (const [tier, decoder] of [["typescript", "typescript"], ["typescript-worker", "typescript"], ["single", "single"], ["auto", "typescript"], ["threaded", "threaded"]] as const) {
      expect(wasmTierPreference(reading({ [WASM_TIER_ID]: tier }))).toBe(decoder);
    }
  });

  it("separates manual implementation, placement and independent-job parallelism", () => {
    const settings = reading({ "wasm.tier": "custom", "wasm.implementation": "typescript", "wasm.placement": "worker", "wasm.parallelism": "serial" });
    expect(wasmCorePlan(settings, "sky")).toMatchObject({ requested: "custom", resolved: "typescript-worker", kernel: "typescript", placement: "worker", parallelism: "serial" });
    expect(wasmCorePlan(reading({ "wasm.tier": "custom", "wasm.implementation": "wasm", "wasm.placement": "original" }), "sky"))
      .toMatchObject({ resolved: "single", kernel: "single", placement: "worker" });
  });

  it("inherits individual choices from current global defaults, including measured Auto choices", () => {
    const values = { "wasm.tier": "custom", "wasm.implementation": "wasm", "wasm.placement": "worker", "wasm.parallelism": "serial",
      "wasm.core.sky": "custom", "wasm.core.sky.implementation": "typescript" };
    expect(wasmCorePlan(reading(values), "sky")).toMatchObject({ kernel: "typescript", placement: "worker", parallelism: "serial" });
    expect(wasmCorePlan(reading({ ...values, "wasm.placement": "original", "wasm.parallelism": "auto" }), "sky"))
      .toMatchObject({ kernel: "typescript", placement: "original", parallelism: "auto" });
    expect(wasmCorePlan(reading({ "wasm.tier": "auto", "wasm.core.sky": "custom", "wasm.core.sky.implementation": "wasm" }), "sky"))
      .toMatchObject({ kernel: "single", placement: "worker" });
    expect(wasmCorePlan(reading({ "wasm.tier": "single", "wasm.core.raster": "custom", "wasm.core.raster.parallelism": "serial" }), "raster"))
      .toMatchObject({ kernel: "single", parallelism: "serial" });
  });

  it("edits legacy selections atomically without changing unrelated manual choices", () => {
    const legacy = reading({ "wasm.tier": "single" });
    expect(componentExecutionChoices(legacy)).toEqual({ implementation: "wasm", placement: "worker", parallelism: "auto" });
    expect(componentExecutionEdits(legacy, undefined, "implementation", "typescript")).toEqual({
      "wasm.tier": "custom", "wasm.implementation": "typescript", "wasm.placement": "worker", "wasm.parallelism": "auto" });
    expect(componentExecutionEdits(reading({ "wasm.tier": "typescript" }), "sky", "implementation", "wasm"))
      .toEqual({ "wasm.core.sky": "custom", "wasm.core.sky.implementation": "wasm", "wasm.core.sky.placement": "inherit", "wasm.core.sky.parallelism": "inherit" });
    expect(componentExecutionEdits(legacy, undefined, "mode", "auto")).toMatchObject({ "wasm.tier": "auto", "wasm.implementation": "wasm", "wasm.placement": "worker" });
  });

  it("asks for shared memory only where a shared build exists, and never relabels worker pools as threads", () => {
    const threaded = reading({ [WASM_TIER_ID]: "threaded", [WASM_THREADS_ID]: 4 });
    expect(wasmCorePlan(threaded, "sky")).toMatchObject({ kernel: "threaded", sharedMemory: true, threads: 4, threadedFallback: null, parallelism: "auto" });
    for (const core of ["raster", "terrain", "imagery", "google", "ground"] as const) {
      expect(wasmCorePlan(threaded, core)).toMatchObject({ kernel: "threaded", sharedMemory: false, threads: 1, threadedFallback: "no-shared-build" });
    }
    for (const tier of ["typescript", "typescript-worker", "single", "auto", "custom"]) {
      expect(wasmCorePlan(reading({ [WASM_TIER_ID]: tier, [WASM_THREADS_ID]: 8, "wasm.implementation": "wasm", "wasm.placement": "worker" }), "sky"))
        .toMatchObject({ sharedMemory: false, threads: 1, threadedFallback: null });
    }
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "single", [WASM_CORE_SETTING_IDS.sky]: "threaded", [WASM_THREADS_ID]: 99 }), "sky")).toMatchObject({ threads: WASM_MAX_THREADS });
    // A reader without the thread count runs the coordinator alone.
    expect(wasmCorePlan(reading({ [WASM_TIER_ID]: "threaded" }), "sky")).toMatchObject({ sharedMemory: true, threads: 1 });
    const spec = WASM_PARAMETERS.find(parameter => parameter.id === WASM_THREADS_ID)!;
    expect(spec).toMatchObject({ kind: "number", appliesLive: false, home: { tab: "wasm" } });
    expect(WASM_PARAMETERS.find(parameter => parameter.id === WASM_SHARED_SKY_ID)).toMatchObject({ kind: "boolean", default: true, appliesLive: false });
    const derive = spec.default as unknown as (context: { hardwareConcurrency: number | null; deviceMemoryGiB: number | null }) => { value: number };
    expect([null, 1, 2, 4, 16].map(hardwareConcurrency => derive({ hardwareConcurrency, deviceMemoryGiB: null }).value)).toEqual([1, 1, 1, 3, 4]);
    // The budget keeps the elevation pool's recommendation beside the default selection's own workers.
    const budget = WASM_PARAMETERS.find(parameter => parameter.id === "wasm.workers")!.default as unknown as typeof derive;
    expect([[null, null], [2, null], [10, 8], [32, 8], [8, 1]].map(([hardwareConcurrency, deviceMemoryGiB]) => budget({ hardwareConcurrency, deviceMemoryGiB }).value))
      .toEqual([4 + 6, 2 + 6, 10 + 9, 26, 3 + 9]);
  });

  it("runs a WASM sky's shared build with wasm.sharedSky, and leaves TypeScript and the other cores as they were", () => {
    const shared = (values: Record<string, unknown>) => reading({ [WASM_SHARED_SKY_ID]: true, [WASM_THREADS_ID]: 4, ...values });
    expect(wasmCorePlan(shared({ [WASM_TIER_ID]: "single" }), "sky")).toMatchObject({ requested: "single", resolved: "single", kernel: "threaded", sharedMemory: true, threads: 4 });
    expect(wasmCorePlan(shared({ [WASM_TIER_ID]: "custom", "wasm.implementation": "wasm", "wasm.placement": "worker" }), "sky"))
      .toMatchObject({ kernel: "threaded", sharedMemory: true });
    expect(wasmCorePlan(shared({ [WASM_TIER_ID]: "single", [WASM_SHARED_SKY_ID]: false }), "sky")).toMatchObject({ kernel: "single", sharedMemory: false, threads: 1 });
    for (const tier of ["typescript", "typescript-worker", "auto"]) {
      expect(wasmCorePlan(shared({ [WASM_TIER_ID]: tier }), "sky")).toMatchObject({ kernel: "typescript", sharedMemory: false });
    }
    for (const core of ["raster", "terrain", "imagery", "google", "ground"] as const) {
      expect(wasmCorePlan(shared({ [WASM_TIER_ID]: "single" }), core)).toMatchObject({ kernel: "single", sharedMemory: false, threadedFallback: null });
    }
  });
});
