/**
 * Map detail policies: what the user asks each map source for, independently of
 * what the renderer has delivered.
 *
 * Raster values are signed offsets `d` in binary resolution steps, positive for
 * finer imagery; Normal is `d = 0`. Google values are the 3D Tiles renderer's
 * native screen-space error targets in pixels, smaller for finer mesh. The two
 * units never mix: a state carries the kind of its policy.
 */

export type DetailKind = "raster" | "google";

export interface RasterDetailPolicy {
  kind: "raster";
  /** The coarsest offset the user can select, at the rail's right end. */
  coarseOffset: number;
  /** The finest offset the user can select, at the rail's left end. */
  fineOffset: number;
  /** Normal follows the source's own baseline; a number is a Custom offset. */
  defaultValue: "normal" | number;
}

export type GoogleRecommendationPolicy = "device-hints" | "renderer-default";

export interface GoogleRecommendedDefault {
  mode: "recommended";
  /**
   * `device-hints` picks a target from the renderer and CPU/memory hints.
   * `renderer-default` is the target the 3D Tiles plugin itself sets.
   */
  policy: GoogleRecommendationPolicy;
}

export interface GoogleDetailPolicy {
  kind: "google";
  /** The finest error target the user can select, at the rail's left end. */
  finestErrorPx: number;
  /** The coarsest error target the user can select, at the rail's right end. */
  coarsestErrorPx: number;
  defaultValue: number | GoogleRecommendedDefault;
}

export type DetailPolicy = RasterDetailPolicy | GoogleDetailPolicy;

/** Why delivered detail can differ from the request. */
export type DetailLimit = "source" | "memory" | "loading" | "backend" | "consumer";

/**
 * One source's detail request and what limits it. Numeric values carry the
 * policy's kind: raster offsets or Google error pixels. A target is a request,
 * not a measurement of delivered detail.
 */
export interface DetailState {
  /** "google" or "raster:<stable source id>". */
  key: string;
  availability: "ready" | "initializing" | "unavailable";
  /** Why detail is not available, when the renderer says. */
  reason?: string;
  policy: DetailPolicy;
  /** The saved default resolved to a number, clamped to the saved range. */
  resolvedDefault: number;
  /** True when a recommended default fell outside the range and was clamped to it. */
  defaultLimitedByRange: boolean;
  sessionOverride: number | null;
  requestedTarget: number;
  /**
   * The single target the renderer uses, when one exists. Raster reports null
   * while different regions have different delivered detail.
   */
  effectiveTarget: number | null;
  pending: boolean;
  limits: readonly DetailLimit[];
}

/** Supported raster offsets. Selectable ranges are subranges of this envelope. */
export const RASTER_DETAIL_ENVELOPE = { coarsest: -3, finest: 1 } as const;
/** The rail's step for raster offsets. */
export const RASTER_DETAIL_STEP = 0.25;
/** The 3D Tiles renderer's accepted error targets, in px. */
export const GOOGLE_ERROR_TARGET_BOUNDS = { finest: 1, coarsest: 524_288 } as const;
/** The rail's step for Google targets, in log2 px. */
export const GOOGLE_DETAIL_STEP = 0.05;

export const DEFAULT_RASTER_DETAIL_POLICY: RasterDetailPolicy = Object.freeze({
  kind: "raster",
  coarseOffset: RASTER_DETAIL_ENVELOPE.coarsest,
  fineOffset: RASTER_DETAIL_ENVELOPE.finest,
  defaultValue: "normal",
});

export const DEFAULT_GOOGLE_DETAIL_POLICY: GoogleDetailPolicy = Object.freeze({
  kind: "google",
  finestErrorPx: 4,
  coarsestErrorPx: 64,
  defaultValue: Object.freeze({ mode: "recommended", policy: "renderer-default" }) as GoogleRecommendedDefault,
});

export const GOOGLE_DETAIL_KEY = "google";

export function rasterDetailKey(sourceId: string): string {
  return `raster:${sourceId}`;
}

export function detailKindOfKey(key: string): DetailKind | null {
  if (key === GOOGLE_DETAIL_KEY) return "google";
  return key.startsWith("raster:") && key.length > "raster:".length ? "raster" : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRasterPolicy(value: Record<string, unknown>): boolean {
  const { coarseOffset, fineOffset, defaultValue } = value;
  if (!isFiniteNumber(coarseOffset) || !isFiniteNumber(fineOffset)) return false;
  if (coarseOffset > fineOffset) return false;
  if (coarseOffset < RASTER_DETAIL_ENVELOPE.coarsest || fineOffset > RASTER_DETAIL_ENVELOPE.finest) return false;
  if (defaultValue === "normal") return coarseOffset <= 0 && fineOffset >= 0;
  return isFiniteNumber(defaultValue) && defaultValue >= coarseOffset && defaultValue <= fineOffset;
}

function isGooglePolicy(value: Record<string, unknown>): boolean {
  const { finestErrorPx, coarsestErrorPx, defaultValue } = value;
  if (!isFiniteNumber(finestErrorPx) || !isFiniteNumber(coarsestErrorPx)) return false;
  if (finestErrorPx > coarsestErrorPx) return false;
  if (finestErrorPx < GOOGLE_ERROR_TARGET_BOUNDS.finest || coarsestErrorPx > GOOGLE_ERROR_TARGET_BOUNDS.coarsest) return false;
  if (isRecord(defaultValue)) {
    return defaultValue.mode === "recommended"
      && (defaultValue.policy === "device-hints" || defaultValue.policy === "renderer-default");
  }
  return isFiniteNumber(defaultValue) && defaultValue >= finestErrorPx && defaultValue <= coarsestErrorPx;
}

/** Validates a policy from storage or a host. Invalid values are rejected, never repaired. */
export function isValidDetailPolicy(value: unknown, kind?: DetailKind): value is DetailPolicy {
  if (!isRecord(value)) return false;
  if (kind && value.kind !== kind) return false;
  if (value.kind === "raster") return isRasterPolicy(value);
  if (value.kind === "google") return isGooglePolicy(value);
  return false;
}

/** A detached copy, so callers cannot mutate a policy the controller holds. */
export function copyDetailPolicy<T extends DetailPolicy>(policy: T): T {
  if (policy.kind === "google" && typeof policy.defaultValue === "object") {
    return { ...policy, defaultValue: { ...policy.defaultValue } };
  }
  return { ...policy };
}

/** The selectable range as numbers, finer end first. */
export function detailRange(policy: DetailPolicy): { finer: number; coarser: number } {
  return policy.kind === "raster"
    ? { finer: policy.fineOffset, coarser: policy.coarseOffset }
    : { finer: policy.finestErrorPx, coarser: policy.coarsestErrorPx };
}

/** The supported envelope for a kind, finer end first. */
export function detailEnvelope(kind: DetailKind): { finer: number; coarser: number } {
  return kind === "raster"
    ? { finer: RASTER_DETAIL_ENVELOPE.finest, coarser: RASTER_DETAIL_ENVELOPE.coarsest }
    : { finer: GOOGLE_ERROR_TARGET_BOUNDS.finest, coarser: GOOGLE_ERROR_TARGET_BOUNDS.coarsest };
}

/**
 * A linear position for sliders, increasing toward coarser detail so that
 * right is coarser for both kinds: log2 px for Google, `-d` for raster.
 */
export function detailPosition(kind: DetailKind, value: number): number {
  return kind === "raster" ? -value : Math.log2(Math.max(GOOGLE_ERROR_TARGET_BOUNDS.finest, value));
}

export function detailValueAtPosition(kind: DetailKind, position: number): number {
  if (kind === "raster") {
    const value = -Math.round(position / RASTER_DETAIL_STEP) * RASTER_DETAIL_STEP;
    return Object.is(value, -0) ? 0 : value;
  }
  const px = 2 ** position;
  // Keep small targets usable at the rail's resolution without float noise.
  return Math.max(GOOGLE_ERROR_TARGET_BOUNDS.finest, px >= 16 ? Math.round(px) : Math.round(px * 100) / 100);
}

/** Clamps a value into the policy's selectable range. */
export function clampDetailValue(policy: DetailPolicy, value: number): number {
  const { finer, coarser } = detailRange(policy);
  const low = Math.min(finer, coarser);
  const high = Math.max(finer, coarser);
  return Math.max(low, Math.min(high, value));
}

export function isWithinDetailRange(policy: DetailPolicy, value: number): boolean {
  return Number.isFinite(value) && clampDetailValue(policy, value) === value;
}

export interface DeviceHints {
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

export function readDeviceHints(): DeviceHints {
  if (typeof navigator === "undefined") return {};
  return {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  };
}

/**
 * A conservative Google target without a GPU benchmark. CPU and memory hints
 * cannot prove that 1 px refinement is sustainable, so the finest targets stay
 * an explicit choice.
 */
export function chooseDeviceHintErrorTarget(rendererMode: string | null, hints: DeviceHints): number {
  const cores = Math.max(1, hints.hardwareConcurrency ?? 4);
  const hasRoom = hints.deviceMemory === undefined || hints.deviceMemory >= 8;
  if (rendererMode === "webgpu" && cores >= 12 && hasRoom) return 16;
  if (cores >= 8 && hasRoom) return 32;
  if (cores >= 4) return 64;
  return 128;
}

export interface DetailRecommendationContext {
  /** The target the 3D Tiles plugin set, once the Google runtime exists. */
  rendererDefaultErrorPx: number | null;
  rendererMode: string | null;
  deviceHints: DeviceHints;
}

/** The recommended Google target, or null until what it depends on is known. */
export function resolveGoogleRecommendation(
  policy: GoogleRecommendationPolicy,
  context: DetailRecommendationContext,
): number | null {
  if (policy === "renderer-default") {
    const value = context.rendererDefaultErrorPx;
    return isFiniteNumber(value) && value > 0 ? value : null;
  }
  if (context.rendererMode === null) return null;
  return chooseDeviceHintErrorTarget(context.rendererMode, context.deviceHints);
}

/**
 * The saved default as a number. A recommendation outside the saved range is
 * clamped to it and says so; the saved mode itself is never replaced.
 */
export function resolveDetailDefault(
  policy: DetailPolicy,
  context: DetailRecommendationContext,
): { value: number; limitedByRange: boolean } | null {
  if (policy.kind === "raster") {
    return { value: policy.defaultValue === "normal" ? 0 : policy.defaultValue, limitedByRange: false };
  }
  if (typeof policy.defaultValue === "number") return { value: policy.defaultValue, limitedByRange: false };
  const recommended = resolveGoogleRecommendation(policy.defaultValue.policy, context);
  if (recommended === null) return null;
  const value = clampDetailValue(policy, recommended);
  return { value, limitedByRange: value !== recommended };
}

/**
 * Moves one end of a raster range. The range stays ordered, stays inside the
 * envelope, keeps 0 while Normal is selected, and clamps a Custom default once.
 * It never turns Normal into Custom.
 */
export function editRasterRange(
  policy: RasterDetailPolicy,
  edit: { coarseOffset?: number; fineOffset?: number },
): RasterDetailPolicy {
  const normal = policy.defaultValue === "normal";
  let coarseOffset = policy.coarseOffset;
  let fineOffset = policy.fineOffset;
  if (edit.coarseOffset !== undefined && Number.isFinite(edit.coarseOffset)) {
    const upper = normal ? 0 : fineOffset;
    coarseOffset = Math.max(RASTER_DETAIL_ENVELOPE.coarsest, Math.min(upper, edit.coarseOffset));
  }
  if (edit.fineOffset !== undefined && Number.isFinite(edit.fineOffset)) {
    const lower = normal ? 0 : coarseOffset;
    fineOffset = Math.min(RASTER_DETAIL_ENVELOPE.finest, Math.max(lower, edit.fineOffset));
  }
  const next: RasterDetailPolicy = { ...policy, coarseOffset, fineOffset };
  if (typeof next.defaultValue === "number") next.defaultValue = clampDetailValue(next, next.defaultValue);
  return next;
}

/** Moves one end of a Google range, keeping it ordered and clamping a manual default once. */
export function editGoogleRange(
  policy: GoogleDetailPolicy,
  edit: { finestErrorPx?: number; coarsestErrorPx?: number },
): GoogleDetailPolicy {
  let finestErrorPx = policy.finestErrorPx;
  let coarsestErrorPx = policy.coarsestErrorPx;
  if (edit.finestErrorPx !== undefined && Number.isFinite(edit.finestErrorPx)) {
    finestErrorPx = Math.max(GOOGLE_ERROR_TARGET_BOUNDS.finest, Math.min(coarsestErrorPx, edit.finestErrorPx));
  }
  if (edit.coarsestErrorPx !== undefined && Number.isFinite(edit.coarsestErrorPx)) {
    coarsestErrorPx = Math.min(GOOGLE_ERROR_TARGET_BOUNDS.coarsest, Math.max(finestErrorPx, edit.coarsestErrorPx));
  }
  const next: GoogleDetailPolicy = copyDetailPolicy({ ...policy, finestErrorPx, coarsestErrorPx });
  if (typeof next.defaultValue === "number") next.defaultValue = clampDetailValue(next, next.defaultValue);
  return next;
}

/** Selects Normal, widening the range to include 0 if it has to. */
export function selectRasterNormal(policy: RasterDetailPolicy): RasterDetailPolicy {
  return {
    ...policy,
    coarseOffset: Math.min(0, policy.coarseOffset),
    fineOffset: Math.max(0, policy.fineOffset),
    defaultValue: "normal",
  };
}

/** Makes the default a fixed value, clamped into the range. */
export function selectCustomDefault<T extends DetailPolicy>(policy: T, value: number): T {
  const next = copyDetailPolicy(policy);
  next.defaultValue = clampDetailValue(policy, value);
  return next;
}

export function selectGoogleRecommendation(policy: GoogleDetailPolicy, recommendation: GoogleRecommendationPolicy): GoogleDetailPolicy {
  return { ...policy, defaultValue: { mode: "recommended", policy: recommendation } };
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const LEVEL_WORDS = ["zero", "one", "two", "three"];

/** An accessible description of a value, such as "one level finer than Normal". */
export function describeDetailValue(kind: DetailKind, value: number): string {
  if (kind === "google") return `Google error target ${formatNumber(value)} pixels`;
  if (Math.abs(value) < 1e-9) return "Normal";
  const magnitude = Math.abs(value);
  const direction = value > 0 ? "finer" : "coarser";
  const words = Number.isInteger(magnitude) && magnitude < LEVEL_WORDS.length ? LEVEL_WORDS[magnitude] : formatNumber(magnitude);
  return `${words} ${magnitude === 1 ? "level" : "levels"} ${direction} than Normal`;
}

/** A short label for rails and ticks: "Normal", "+1", "−0.5" or "32 px". */
export function formatDetailValue(kind: DetailKind, value: number): string {
  if (kind === "google") return `${formatNumber(value)} px`;
  if (Math.abs(value) < 1e-9) return "Normal";
  return `${value > 0 ? "+" : "−"}${formatNumber(Math.abs(value))}`;
}

/**
 * The allowed projected size of one image pixel, in physical render pixels,
 * for a raster offset: `normalTargetPx * 2^(-d)`.
 */
export function rasterImagePixelTarget(offset: number, normalTargetPx = 1): number {
  return normalTargetPx * 2 ** -offset;
}
