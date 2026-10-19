import type { ParameterSpec, SettingsRegistry } from "@foss-earth/ui/settings";
import type { NativeTierPreference } from "../../browser/terrainNativeDecoder.js";

export const NATIVE_TIER_ID = "native.tier";
export const NATIVE_THREADS_ID = "native.threads";
/** Sky → Shared memory: a sky that runs WebAssembly runs its shared-memory build. */
export const NATIVE_SHARED_SKY_ID = "native.sharedSky";
/** The shared builds' stack slots: a coordinator and at most seven helpers. */
export const NATIVE_MAX_THREADS = 8;

/**
 * Where a converted core runs and with which numbers, chosen at startup.
 * `typescript` keeps each core's original placement and code. The A/B pair is
 * `typescript-worker` and `single`: the same workers, inputs and quality, with
 * the TypeScript reference or the single-threaded WASM core inside them.
 * `auto` takes each core's recorded choice. `threaded` runs a core's
 * shared-memory WASM build, with `native.threads` cooperating threads over one
 * memory, where the core has one (sky) and the page is cross-origin isolated;
 * otherwise it reports its fallback and why, never a threaded backend.
 * `native.sharedSky` also runs the sky's shared build when it would run
 * single-threaded WASM, so a WASM selection can share memory without `threaded`.
 */
export type NativeExecutionTier = "typescript" | "typescript-worker" | "single" | "auto" | "threaded" | "custom";
export const NATIVE_EXECUTION_TIERS: readonly NativeExecutionTier[] = ["typescript", "typescript-worker", "single", "auto", "threaded", "custom"];

/** The cores the apps run through `native.tier`. */
export type NativeCoreId = "raster" | "sky" | "terrain" | "imagery" | "google" | "ground";

export interface NativeCoreFacts {
  label: string;
  /** What the core computes, and what stays where it was. */
  scope: string;
  /** Where the original TypeScript runs. */
  original: "page" | "worker";
  /** `auto`'s choice for this core, and why. */
  auto: Exclude<NativeExecutionTier, "auto" | "custom">;
  autoReason: string;
  /** Whether a shared-memory threaded build exists; `threaded` falls back without one. */
  sharedBuild: boolean;
  source: string;
}

export const NATIVE_CORES: Readonly<Record<NativeCoreId, NativeCoreFacts>> = {
  raster: {
    label: "Terrain heights",
    scope: "Terrarium RGBA-to-height conversion inside the terrain decode workers; image decoding stays the browser's, and the page's own decoding stays TypeScript.",
    original: "worker",
    auto: "typescript",
    autoReason: "The paired in-app runs measured WASM decode at 11.8–14.1 ms versus TypeScript 8.9–10.7 ms in the same decode workers, with no page-time gain. Keep TypeScript in auto; single remains force-selectable with first-input parity.",
    sharedBuild: false,
    source: "src/browser/terrainNativeDecoder.ts",
  },
  sky: {
    label: "Sky",
    scope: "Atmosphere tables, sky illumination and dome radiance in one sky worker. Optional atmosphere and final star colors use TypeScript batches in that worker; billboards follow the current scene transform synchronously, with exact page color fallback for changed presentation settings. Exposure, night lights and drawing stay on the page.",
    original: "page",
    auto: "typescript-worker",
    autoReason: "The unchanged-source sky placement pair measured page task time 7455 to 5138 ms and frame callback p95 6.0 to 2.9 ms. Earlier changing-source trials do not qualify an A/A spread. WASM in the same worker showed no gain; auto retains typescript-worker.",
    sharedBuild: true,
    source: "@foss-earth/sky/src/skyEvaluationWorker.ts",
  },
  terrain: {
    label: "Terrain geometry",
    scope: "Terrain mesh target positions and height bounds calculated in terrain mesh workers at the applyGrid seam; initial mesh creation and callback elevation stay on the page.",
    original: "page",
    auto: "typescript",
    autoReason: "Paired terrain runs added ~1.8 s page dispatch overhead across 1,200+ targets; WASM workers took 30–34 ms versus TS workers 25–28 ms. Keep the on-page reference.",
    sharedBuild: false,
    source: "src/browser/terrainMeshWorkers.ts",
  },
  imagery: {
    label: "Imagery heights",
    scope: "Batched interpolation of immutable adopted height grids in one worker, with exact page fallback on cache misses; cached Float64 heights preserve selection slopes. Selection and drawing stay on the page.",
    original: "page", auto: "typescript",
    autoReason: "Keep the original grid queries until whole-app paired measurements qualify the batch/cache path.",
    sharedBuild: false,
    source: "src/browser/terrainHeightBatches.ts",
  },
  google: {
    label: "Google tile preparation",
    scope: "Supported-profile GLB geometry and JPEG preparation in one worker; Babylon nodes, materials, textures and container ownership stay on the page. Unsupported tiles use the original loader.",
    original: "page", auto: "typescript",
    autoReason: "Keep Babylon's original loader until browser visual and paired performance qualification.",
    sharedBuild: false,
    source: "@foss-earth/renderer/src/babylon/googleTilePreparation.ts",
  },
  ground: {
    label: "Ground spatial index",
    scope: "BVH construction for supported displayed Float32 meshes in one worker. Finite-ray queries synchronously traverse that index in TypeScript using current scene transforms; pending, changed or unsupported meshes retain Babylon picking. Raster height samples keep their current cell walker.",
    original: "page", auto: "typescript",
    autoReason: "Keep the original picker until representative app/flight paired measurements qualify acceleration.",
    sharedBuild: false,
    source: "src/babylon/groundAcceleration.ts",
  },
};

export const NATIVE_CORE_SETTING_IDS: Readonly<Record<NativeCoreId, string>> = {
  raster: "native.core.raster",
  sky: "native.core.sky",
  terrain: "native.core.terrain",
  imagery: "native.core.imagery",
  google: "native.core.google",
  ground: "native.core.ground",
};

export type ComponentImplementation = "typescript" | "wasm";
export type ComponentPlacement = "original" | "worker";
export type ComponentParallelism = "auto" | "serial";
export interface ComponentExecutionChoices {
  implementation: ComponentImplementation;
  placement: ComponentPlacement;
  parallelism: ComponentParallelism;
}
export const NATIVE_MANUAL_FIELDS = ["implementation", "placement", "parallelism"] as const;
export type ComponentExecutionField = typeof NATIVE_MANUAL_FIELDS[number];
export const componentExecutionSettingId = (field: ComponentExecutionField, core?: NativeCoreId): string =>
  `${core ? NATIVE_CORE_SETTING_IDS[core] : "native"}.${field}`;

const FIELD_CHOICES = {
  implementation: [{ id: "typescript", label: "TypeScript" }, { id: "wasm", label: "WebAssembly", shortLabel: "WASM" }],
  placement: [{ id: "original", label: "Component default", shortLabel: "Default" }, { id: "worker", label: "Background workers", shortLabel: "Workers" }],
  parallelism: [{ id: "serial", label: "One worker per component", shortLabel: "1 worker" }, { id: "auto", label: "Worker pools", shortLabel: "Pool" }],
};
const FIELD_LABELS = { implementation: "Implementation", placement: "Work location", parallelism: "Worker parallelism" };
const FIELD_DESCRIPTIONS = {
  implementation: "Choose TypeScript or WebAssembly for the supported numeric work. WebAssembly currently requires a background worker; rendering and browser APIs retain their host code.",
  placement: "Component default retains its original placement: raster decoding already uses workers, while the other components run on the main thread. Background workers use the same inputs and visual quality. WebAssembly always runs in a background worker.",
  parallelism: "One worker per component limits independent raster and terrain jobs to one worker each. Worker pools permit concurrent independent jobs within the existing worker budget. Sky, imagery, Google and ground currently have one worker each. This does not enable shared-memory Rust threads.",
};
const manualParameters = (core?: NativeCoreId): ParameterSpec[] => NATIVE_MANUAL_FIELDS.map(field => ({
  id: componentExecutionSettingId(field, core), label: FIELD_LABELS[field], kind: "choice", unit: "none",
  description: FIELD_DESCRIPTIONS[field],
  choices: [...(core ? [{ id: "inherit", label: "Global" }] : []), ...FIELD_CHOICES[field]],
  default: core ? "inherit" : field === "implementation" ? "typescript" : field === "placement" ? "original" : "auto",
  defaultReason: core ? "Inherit each decision from the global configuration." : "Retain the original TypeScript placement and existing independent-job pools.",
  home: { tab: "native", section: core ? "cores" : "selection", level: "main" }, appliesLive: false,
  source: "src/settings/catalogue/native.ts",
}));

/** Shared-memory threads by default: the hardware threads but the page's own, at most 4. */
const defaultSharedThreads = (threads: number | null): number => Math.max(1, Math.min(4, (threads ?? 2) - 1));
/**
 * The workers the default WebAssembly selection starts beside the elevation pool and the
 * imagery worker: one each for the sky, imagery heights, Google tiles and the ground index,
 * two terrain mesh workers, and the shared sky's helpers (used only on an isolated page).
 */
const defaultDedicatedWorkers = (threads: number | null): number => 6 + defaultSharedThreads(threads) - 1;

const TIER_CHOICES = [
  { id: "typescript", label: "TypeScript, original placement" },
  { id: "typescript-worker", label: "TypeScript in workers (A/B reference)" },
  { id: "single", label: "Single-threaded WASM in workers" },
  { id: "auto", label: "Auto (each core's recorded choice)" },
  { id: "threaded", label: "Shared-memory threaded WASM (sky only)" },
  { id: "custom", label: "Manual (separate choices)" },
] as const;

export const NATIVE_PARAMETERS: readonly ParameterSpec[] = [{
  id: NATIVE_TIER_ID, label: "Execution selection", kind: "choice", unit: "none",
  description: "After a reload, chooses how every converted core runs. TypeScript keeps each core where it always ran. For an A/B, compare TypeScript in workers with single-threaded WASM: both use the same workers, inputs and quality. WASM is admitted only after its first result equals the TypeScript reference; a failed fetch, compile, start or comparison returns that core to TypeScript and says why. Threaded runs the sky's shared-memory build with cooperating threads where the page is cross-origin isolated, and otherwise its single-threaded core; the other cores have no shared build and report their fallback.",
  choices: [...TIER_CHOICES],
  default: "single", defaultReason: "WebAssembly in worker pools, chosen on 19 October 2026 after it was tried on a Mac and an Android phone and judged to work well enough. It is not a speed claim: paired runs measured Terrain heights and Terrain geometry slower in WASM than in TypeScript, and Auto keeps each core's recorded choice. Each core is admitted only after its first result equals the TypeScript reference, and otherwise returns to TypeScript and says why.",
  home: { tab: "native", section: "selection", level: "main" }, appliesLive: false,
  source: "src/settings/catalogue/native.ts",
}, {
  id: "native.workers", label: "Total preparation workers", kind: "number", unit: "count",
  description: "After reload, limits the combined imagery decode, elevation, mesh, sky, imagery height, Google and ground worker factories. The elevation pool gets what the other workers leave, so a smaller budget decodes more elevation tiles on the page. A full budget keeps the complete JavaScript fallback usable.",
  default: context => {
    const threads = context.hardwareConcurrency ?? 4;
    const base = Math.max(2, Math.min(context.deviceMemoryGiB !== null && context.deviceMemoryGiB <= 1 ? 3 : 17, threads));
    const dedicated = defaultDedicatedWorkers(context.hardwareConcurrency);
    return { value: Math.min(32, base + dedicated),
      derivedFrom: `the elevation worker recommendation plus one imagery worker (${base}, capped at 17, or 3 with at most 1 GiB memory), plus ${dedicated} for the default WebAssembly selection's own workers` };
  },
  bounds: () => ({ min: 1, max: 32 }), step: 1,
  defaultReason: "Keeps the elevation pool its recommended size beside the default WebAssembly selection's sky, imagery height, Google, ground and terrain mesh workers and the shared sky's helpers. Those are idle between bursts of work, so they are counted rather than taken from the elevation pool.",
  home: { tab: "native", section: "selection", level: "all" }, appliesLive: false,
  source: "src/settings/catalogue/native.ts",
}, {
  id: NATIVE_THREADS_ID, label: "Shared-memory threads", kind: "number", unit: "count",
  description: "After reload, how many cooperating threads a threaded core uses over one shared memory, its coordinator included. Only a threaded request of a core with a shared build uses them; each helper thread is a worker taken from the total preparation workers.",
  default: context => {
    const threads = context.hardwareConcurrency;
    const value = defaultSharedThreads(threads);
    return { value, derivedFrom: threads ? `the ${threads} hardware threads the browser reports but the page's own, at most 4` : "1 helper beside the coordinator, because this browser does not say how many hardware threads the device has" };
  },
  bounds: () => ({ min: 1, max: NATIVE_MAX_THREADS }), step: 1,
  defaultReason: "Leaves the page a thread. In the measured app sky, 8 threads saved little worker time over 4 and used more CPU in all.",
  home: { tab: "native", section: "selection", level: "all" }, appliesLive: false,
  source: "src/settings/catalogue/native.ts",
}, {
  id: NATIVE_SHARED_SKY_ID, label: "Sky in shared memory", kind: "boolean", unit: "none",
  description: "After a reload, a sky that runs WebAssembly runs its shared-memory build: its worker coordinates helper threads over one shared memory, and Shared-memory threads says how many. Used only on a cross-origin isolated page; elsewhere the sky runs its single-threaded WASM core and says why. TypeScript selections are unchanged. Turn it off to compare single-threaded WASM with TypeScript in workers.",
  default: true,
  defaultReason: "On since 19 October 2026, with WebAssembly in worker pools, after the shared-memory sky was tried in isolated browsers and judged to work well enough. It is not a speed claim.",
  home: { tab: "native", section: "cores", level: "all" }, appliesLive: false,
  source: "src/settings/catalogue/native.ts",
}, ...(Object.keys(NATIVE_CORE_SETTING_IDS) as NativeCoreId[]).map((core): ParameterSpec => ({
  id: NATIVE_CORE_SETTING_IDS[core], label: NATIVE_CORES[core].label, kind: "choice", unit: "none",
  description: `After a reload, overrides global execution for this component alone, to attribute a difference to it. ${NATIVE_CORES[core].scope}`,
  choices: [{ id: "inherit", label: "Global" }, ...TIER_CHOICES],
  default: "inherit", defaultReason: "One selection governs every core unless an A/B isolates one.",
  home: { tab: "native", section: "cores", level: "main" }, appliesLive: false,
  source: NATIVE_CORES[core].source,
})), ...manualParameters(), ...(Object.keys(NATIVE_CORE_SETTING_IDS) as NativeCoreId[]).flatMap(core => manualParameters(core))];

const isTier = (value: unknown): value is NativeExecutionTier => NATIVE_EXECUTION_TIERS.includes(value as NativeExecutionTier);

export interface NativeCorePlan {
  core: NativeCoreId;
  /** The tier asked for, and the setting that asked. */
  requested: NativeExecutionTier;
  requestedBy: string;
  /** `auto` resolved to this core's recorded choice; otherwise the request. */
  resolved: Exclude<NativeExecutionTier, "auto" | "custom">;
  /** Original: the code and place the core always had. Worker: the A/B placement. */
  placement: "original" | "worker";
  /** The numbers inside that placement; a single-threaded sky with native.sharedSky is threaded. */
  kernel: "typescript" | "single" | "threaded";
  /** Why `auto` chose as it did; null otherwise. */
  autoReason: string | null;
  /** Independent-job worker pools, not shared-memory Rust threads. */
  parallelism: ComponentParallelism;
  /**
   * Cooperating threads over one shared memory, the coordinator included, for
   * a threaded request of a core with a shared build; 1 otherwise. Helpers are
   * workers from `native.workers`, so fewer may start; the report says how many did.
   */
  threads: number;
  /** Whether this plan asks for shared WebAssembly memory. */
  sharedMemory: boolean;
  /** Why a threaded request cannot be threaded, known before startup; null otherwise. */
  threadedFallback: "no-shared-build" | null;
}

type ExecutionSettings = Pick<SettingsRegistry, "get">;
const fieldValue = (settings: ExecutionSettings, field: ComponentExecutionField, core?: NativeCoreId): string => {
  // Old host/test readers may only expose the legacy tier settings.
  const value = settings.get(componentExecutionSettingId(field, core));
  const valid = FIELD_CHOICES[field].some(choice => choice.id === value);
  return valid ? String(value) : core ? "inherit" : field === "implementation" ? "typescript" : field === "placement" ? "original" : "auto";
};

/** Values shown by the separate manual controls, including retained legacy URL selections. */
export function componentExecutionChoices(settings: ExecutionSettings, core?: NativeCoreId): Record<ComponentExecutionField, string> {
  const tier = settings.get(core ? NATIVE_CORE_SETTING_IDS[core] : NATIVE_TIER_ID);
  if (core && tier === "inherit") return { implementation: "inherit", placement: "inherit", parallelism: "inherit" };
  if (tier === "custom" || tier === "auto") return Object.fromEntries(NATIVE_MANUAL_FIELDS.map(field => [field, fieldValue(settings, field, core)])) as Record<ComponentExecutionField, string>;
  return { implementation: tier === "single" || tier === "threaded" ? "wasm" : "typescript",
    placement: tier === "typescript" ? "original" : "worker", parallelism: fieldValue(settings, "parallelism", core) };
}

/** Atomic edits preserve the other manual decisions and legacy URL compatibility. */
export function componentExecutionEdits(settings: ExecutionSettings, core: NativeCoreId | undefined,
  field: ComponentExecutionField | "mode", value: string): Record<string, string> {
  const tierId = core ? NATIVE_CORE_SETTING_IDS[core] : NATIVE_TIER_ID;
  const current = settings.get(tierId);
  const choices = field === "mode" && value === "custom" && current === "inherit"
    ? Object.fromEntries(NATIVE_MANUAL_FIELDS.map(key => [key, fieldValue(settings, key, core)])) as Record<ComponentExecutionField, string>
    : componentExecutionChoices(settings, core);
  if (field === "mode" && value !== "custom") return { [tierId]: value,
    ...(current !== "auto" && current !== "inherit" ? Object.fromEntries(NATIVE_MANUAL_FIELDS.map(key => [componentExecutionSettingId(key, core), choices[key]])) : {}) };
  if (field !== "mode") choices[field] = value;
  // A local implementation choice is enough to opt into its required placement.
  if (choices.implementation === "wasm" && choices.placement === "original") choices.placement = "worker";
  return { [tierId]: "custom", ...Object.fromEntries(NATIVE_MANUAL_FIELDS.map(key => [componentExecutionSettingId(key, core), choices[key]])) };
}

/** Read once when the component's services are created: changes require applying/reloading. */
export function nativeCorePlan(settings: ExecutionSettings, core: NativeCoreId): NativeCorePlan {
  const global = settings.get(NATIVE_TIER_ID);
  if (!isTier(global)) throw new Error(`Native execution must be one of ${NATIVE_EXECUTION_TIERS.join(", ")}.`);
  const own = settings.get(NATIVE_CORE_SETTING_IDS[core]);
  if (own !== "inherit" && !isTier(own)) throw new Error(`${NATIVE_CORE_SETTING_IDS[core]} must be inherit or an execution selection.`);
  const requested = own === "inherit" ? global : own;
  const facts = NATIVE_CORES[core];
  const globalTier = global === "auto" ? facts.auto : global;
  const base: ComponentExecutionChoices = globalTier === "custom"
    ? { implementation: fieldValue(settings, "implementation") as ComponentImplementation,
      placement: fieldValue(settings, "placement") as ComponentPlacement, parallelism: fieldValue(settings, "parallelism") as ComponentParallelism }
    : { implementation: globalTier === "single" || globalTier === "threaded" ? "wasm" : "typescript",
      placement: globalTier === "typescript" ? "original" : "worker", parallelism: fieldValue(settings, "parallelism") as ComponentParallelism };
  if (own === "custom") for (const field of NATIVE_MANUAL_FIELDS) {
    const value = fieldValue(settings, field, core);
    if (value !== "inherit") Object.assign(base, { [field]: value });
  }
  const resolved = requested === "auto" ? facts.auto : requested === "custom"
    ? base.implementation === "wasm" ? "single" : base.placement === "worker" ? "typescript-worker" : "typescript"
    : requested;
  const placement = resolved === "typescript" ? "original" : "worker";
  // Old host/test readers may not expose native.sharedSky: single-threaded WASM.
  const sharedSky = core === "sky" && resolved === "single" && settings.get(NATIVE_SHARED_SKY_ID) === true;
  const kernel = resolved === "single" ? sharedSky ? "threaded" : "single" : resolved === "threaded" ? "threaded" : "typescript";
  const sharedMemory = kernel === "threaded" && facts.sharedBuild;
  const asked = Number(settings.get(NATIVE_THREADS_ID));
  // Old host/test readers may not expose the thread count: the coordinator alone.
  const threads = sharedMemory ? Number.isFinite(asked) ? Math.max(1, Math.min(NATIVE_MAX_THREADS, Math.round(asked))) : 1 : 1;
  return { core, requested, requestedBy: own === "inherit" ? NATIVE_TIER_ID : NATIVE_CORE_SETTING_IDS[core], resolved, placement, kernel,
    autoReason: requested === "auto" ? facts.autoReason : null, parallelism: base.parallelism,
    threads, sharedMemory, threadedFallback: kernel === "threaded" && !facts.sharedBuild ? "no-shared-build" : null };
}

/** The terrain decoder's tier for a plan: its workers are its original placement. */
export function terrainDecoderTier(plan: NativeCorePlan): NativeTierPreference {
  return plan.kernel;
}

/** @deprecated Use `nativeCorePlan(settings, "raster")`; kept for hosts that read the decoder's tier directly. */
export function nativeTierPreference(settings: Pick<SettingsRegistry, "get">): NativeTierPreference {
  return terrainDecoderTier(nativeCorePlan(settings, "raster"));
}
