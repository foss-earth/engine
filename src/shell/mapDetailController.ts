import {
  copyDetailPolicy,
  clampDetailValue,
  detailKindOfKey,
  GOOGLE_DETAIL_KEY,
  GOOGLE_ERROR_TARGET_BOUNDS,
  isValidDetailPolicy,
  readDeviceHints,
  resolveDetailDefault,
  type DetailKind,
  type DetailLimit,
  type DetailPolicy,
  type DetailRecommendationContext,
  type DetailState,
  type DetailTrackMarker,
  type DeviceHints,
  type GoogleDetailPolicy,
  type GoogleRecommendationPolicy,
  type RasterDetailPolicy,
} from "../terrain/mapDetailPolicy";
import { getAppSettings } from "../settings/appSettings";
import { FOSS_EARTH_MIGRATIONS } from "../settings/catalogue";
import { MAP_DETAIL_PARAMETERS } from "../settings/catalogue/map";
import { createSettingsRegistry, type SettingsRegistry, type SettingsStorage } from "../settings/registry";
import type { NumberRange, ParameterValue } from "../settings/types";

/**
 * @deprecated The record before the settings registry. It is migrated once into
 * the `map.detail.*` parameters and left in place for rollback.
 */
export const MAP_DETAIL_STORAGE_KEY = "foss-earth.map-detail.v1";

export type MapDetailStorage = SettingsStorage;

/** The parameters that hold each kind's policy. */
export const MAP_DETAIL_PARAMETER_IDS = {
  google: { range: "map.detail.google.range", default: "map.detail.google.default" },
  raster: { range: "map.detail.imagery.range", default: "map.detail.imagery.default" },
} as const;

export interface MapDetailActiveSource {
  /** "google" or "raster:<stable source id>". */
  key: string;
  availability: DetailState["availability"];
  /** Why detail is unavailable, shown on the rail and in the Map tab. */
  reason?: string;
}

/** What the renderer reports about delivering the active request. */
export interface MapDetailDelivery {
  pending: boolean;
  limits: readonly DetailLimit[];
  /** Raster only: the one delivered offset when every region agrees, otherwise null. */
  effectiveTarget?: number | null;
}

/**
 * A consumer's temporary need for finer Google mesh, such as a flight's low
 * spawn. It composes with the user's target, taking the finer of the two,
 * without moving the rail or editing the saved preference.
 */
export interface MapDetailRequirement {
  readonly active: boolean;
  readonly errorPx: number;
  update(errorPx: number): void;
  release(): void;
}

export type MapDetailSeedResult = "saved" | "unsaved" | "exists" | "forced" | "invalid";

export interface MapDetailControllerOptions {
  /** The registry that holds the `map.detail.*` parameters. The app's when omitted. */
  settings?: SettingsRegistry;
  /**
   * A private registry over this storage instead of the app's, for tests and
   * embedded hosts; null keeps it in memory. Ignored when `settings` is given.
   */
  storage?: MapDetailStorage | null;
  /**
   * Host policies that win over saved and edited ones while this controller
   * lives. They are never saved. Keyed like states.
   */
  forcedPolicies?: Readonly<Record<string, DetailPolicy>>;
  /** The app's defaults, used when neither a forced nor a saved policy exists. */
  defaults?: {
    google?: GoogleDetailPolicy;
    raster?: RasterDetailPolicy;
  };
  deviceHints?: () => DeviceHints;
  /**
   * The recommendation Google's "Recommended" default follows: the plugin's
   * own target (the default) or one chosen from device hints.
   */
  googleRecommendation?: GoogleRecommendationPolicy;
}

export interface MapDetailController {
  /** The active source's state, or null when no map source has detail. */
  getState(): DetailState | null;
  /** Called after every meaningful change. Returns an unsubscribe function. */
  subscribe(listener: (state: DetailState | null) => void): () => void;
  /** Saves a policy for the active source. False when it is invalid or of another kind. */
  updatePolicy(policy: DetailPolicy): boolean;
  /** A temporary target for this session, clamped to the saved range. */
  setSessionOverride(value: number): boolean;
  /** Returns to the saved default. Consumer requirements stay in force. */
  clearSessionOverride(): void;
  /** Restores the active source's registered range and default. */
  resetPolicy(): void;
  /** The policy in force for a key, saved or not. */
  getPolicy(key: string): DetailPolicy | null;
  /** True when storage holds a valid policy for the key. */
  hasSavedPolicy(key: string): boolean;
  /**
   * Seeds a policy used only while no valid saved policy exists, and saves it.
   * A seed never overwrites a later user edit.
   */
  seedPolicy(key: string, policy: DetailPolicy): MapDetailSeedResult;
  /** A finer Google target a consumer needs; see MapDetailRequirement. */
  acquireRequirement(errorPx: number): MapDetailRequirement;
  /** The target the renderer should use for the active source, or null when none applies. */
  getRuntimeTarget(): { kind: "google" | "raster"; value: number } | null;
  /** Null after a storage failure: settings still work but will not survive a reload. */
  getStorageError(): string | null;
  /** The recommendation a Google "Recommended" default uses in this app. */
  getGoogleRecommendation(): GoogleRecommendationPolicy;
  /** The registry holding the policies, for the Map tab's parameter list. */
  readonly settings: SettingsRegistry;
  /**
   * A host's marker on a detail track, such as a flight's minimum. Setting a
   * marker with an existing id replaces it. Returns a function that removes it.
   */
  setTrackMarker(marker: DetailTrackMarker): () => void;
  removeTrackMarker(id: string): void;
  setActiveSource(source: MapDetailActiveSource | null): void;
  setRecommendationContext(context: Partial<Pick<DetailRecommendationContext, "rendererDefaultErrorPx" | "rendererMode">>): void;
  reportDelivery(key: string, delivery: MapDetailDelivery | null): void;
  dispose(): void;
}

interface Lease {
  errorPx: number;
  active: boolean;
}

function sanitizeErrorPx(errorPx: number): number {
  if (!Number.isFinite(errorPx)) throw new RangeError(`A detail requirement must be a finite number of pixels, not ${errorPx}.`);
  return Math.max(GOOGLE_ERROR_TARGET_BOUNDS.finest, Math.min(GOOGLE_ERROR_TARGET_BOUNDS.coarsest, errorPx));
}

function sameLimits(a: readonly DetailLimit[], b: readonly DetailLimit[]): boolean {
  return a.length === b.length && a.every((limit, index) => limit === b[index]);
}

const LIMIT_ORDER: readonly DetailLimit[] = ["consumer", "source", "backend", "memory", "loading"];

function asRange(value: ParameterValue): NumberRange | null {
  return typeof value === "object" && value !== null ? value : null;
}

/** The parameters' values for a policy. */
export function detailPolicyValues(policy: DetailPolicy): Record<string, ParameterValue> {
  if (policy.kind === "google") {
    return {
      [MAP_DETAIL_PARAMETER_IDS.google.range]: { min: policy.finestErrorPx, max: policy.coarsestErrorPx },
      [MAP_DETAIL_PARAMETER_IDS.google.default]: typeof policy.defaultValue === "number" ? policy.defaultValue : policy.defaultValue.policy,
    };
  }
  return {
    [MAP_DETAIL_PARAMETER_IDS.raster.range]: { min: policy.coarseOffset, max: policy.fineOffset },
    [MAP_DETAIL_PARAMETER_IDS.raster.default]: policy.defaultValue,
  };
}

/**
 * A policy from its parameters' values. A default outside the range (which
 * separate URL values can produce) is clamped to it, so the policy is valid.
 */
export function detailPolicyFromValues(kind: DetailKind, range: ParameterValue, fallback: ParameterValue): DetailPolicy | null {
  const span = asRange(range);
  if (!span) return null;
  if (kind === "google") {
    const defaultValue = typeof fallback === "number"
      ? Math.max(span.min, Math.min(span.max, fallback))
      : { mode: "recommended" as const, policy: fallback === "device-hints" ? "device-hints" as const : "renderer-default" as const };
    return { kind, finestErrorPx: span.min, coarsestErrorPx: span.max, defaultValue };
  }
  const normal = fallback === "normal" && span.min <= 0 && span.max >= 0;
  const value = typeof fallback === "number" ? fallback : 0;
  return { kind, coarseOffset: span.min, fineOffset: span.max, defaultValue: normal ? "normal" : Math.max(span.min, Math.min(span.max, value)) };
}

function privateRegistry(storage: MapDetailStorage | null): SettingsRegistry {
  const registry = createSettingsRegistry({ storage });
  registry.register(MAP_DETAIL_PARAMETERS.filter(spec => spec.id.startsWith("map.detail.") && spec.kind !== "choice"));
  registry.migrateLegacy(FOSS_EARTH_MIGRATIONS.filter(migration => migration.key === MAP_DETAIL_STORAGE_KEY));
  return registry;
}

export function createMapDetailController(options: MapDetailControllerOptions = {}): MapDetailController {
  const settings = options.settings ?? (options.storage !== undefined ? privateRegistry(options.storage) : getAppSettings());
  const deviceHints = options.deviceHints ?? readDeviceHints;
  const hostDefaultReason = "the app's default";
  for (const kind of ["google", "raster"] as const) {
    const policy = options.defaults?.[kind];
    if (!policy || !isValidDetailPolicy(policy, kind)) continue;
    for (const [id, value] of Object.entries(detailPolicyValues(policy))) settings.setHostDefault(id, value, hostDefaultReason);
  }
  if (options.googleRecommendation && !options.defaults?.google) {
    settings.setHostDefault(MAP_DETAIL_PARAMETER_IDS.google.default, options.googleRecommendation, `the app recommends ${options.googleRecommendation === "device-hints" ? "from device hints" : "the renderer's target"}`);
  }
  const releaseForced: Array<() => void> = [];
  const forcedKinds = new Set<DetailKind>();
  for (const [key, policy] of Object.entries(options.forcedPolicies ?? {})) {
    const kind = detailKindOfKey(key);
    if (!kind || !isValidDetailPolicy(policy, kind) || forcedKinds.has(kind)) continue;
    forcedKinds.add(kind);
    for (const [id, value] of Object.entries(detailPolicyValues(policy))) releaseForced.push(settings.force(id, value, "set by the app"));
  }

  const overrides = new Map<string, number>();
  const deliveries = new Map<string, MapDetailDelivery>();
  const leases = new Set<Lease>();
  const markers = new Map<string, DetailTrackMarker>();
  const listeners = new Set<(state: DetailState | null) => void>();
  let active: MapDetailActiveSource | null = null;
  let context: DetailRecommendationContext = { rendererDefaultErrorPx: null, rendererMode: null, deviceHints: deviceHints() };
  let state: DetailState | null = null;
  let disposed = false;

  function policyFor(key: string): DetailPolicy | null {
    const kind = detailKindOfKey(key);
    if (!kind) return null;
    const ids = MAP_DETAIL_PARAMETER_IDS[kind];
    return detailPolicyFromValues(kind, settings.get(ids.range), settings.get(ids.default));
  }

  function hasSaved(kind: DetailKind): boolean {
    if (settings.getStorageError() !== null) return false;
    const ids = MAP_DETAIL_PARAMETER_IDS[kind];
    return [ids.range, ids.default].some(id => settings.inspect(id).layers.saved !== undefined);
  }

  function composeLimits(key: string, requirementApplied: boolean): DetailLimit[] {
    const reported = deliveries.get(key)?.limits ?? [];
    const set = new Set<DetailLimit>(reported);
    if (requirementApplied) set.add("consumer");
    return LIMIT_ORDER.filter(limit => set.has(limit));
  }

  function finestLease(): number | null {
    let finest: number | null = null;
    for (const lease of leases) if (finest === null || lease.errorPx < finest) finest = lease.errorPx;
    return finest;
  }

  function computeState(): DetailState | null {
    if (!active) return null;
    const kind = detailKindOfKey(active.key);
    const policy = policyFor(active.key);
    if (!kind || !policy) return null;
    const resolved = resolveDetailDefault(policy, context);
    let availability = active.availability;
    if (!resolved && availability === "ready") availability = "initializing";
    const range = policy.kind === "raster"
      ? { coarser: policy.coarseOffset }
      : { coarser: policy.coarsestErrorPx };
    // Until a recommendation can be resolved, show the cheaper end of the range.
    const resolvedDefault = resolved?.value ?? range.coarser;
    const override = overrides.get(active.key);
    const sessionOverride = override === undefined ? null : clampDetailValue(policy, override);
    const requestedTarget = sessionOverride ?? resolvedDefault;
    const delivery = deliveries.get(active.key);
    let effectiveTarget: number | null;
    let requirementApplied = false;
    if (kind === "google") {
      const lease = finestLease();
      requirementApplied = lease !== null && lease < requestedTarget;
      effectiveTarget = requirementApplied ? lease : requestedTarget;
    } else {
      effectiveTarget = delivery?.effectiveTarget ?? null;
    }
    return {
      key: active.key,
      availability,
      ...(availability !== "ready" && active.reason ? { reason: active.reason } : {}),
      policy,
      resolvedDefault,
      defaultLimitedByRange: resolved?.limitedByRange ?? false,
      sessionOverride,
      requestedTarget,
      effectiveTarget,
      pending: availability === "ready" && (delivery?.pending ?? false),
      limits: availability === "ready" ? composeLimits(active.key, requirementApplied) : [],
      markers: [...markers.values()].filter(marker => marker.kind === kind),
    };
  }

  function sameState(a: DetailState | null, b: DetailState | null): boolean {
    if (a === null || b === null) return a === b;
    return a.key === b.key
      && a.availability === b.availability
      && a.reason === b.reason
      && JSON.stringify(a.policy) === JSON.stringify(b.policy)
      && a.resolvedDefault === b.resolvedDefault
      && a.defaultLimitedByRange === b.defaultLimitedByRange
      && a.sessionOverride === b.sessionOverride
      && a.requestedTarget === b.requestedTarget
      && a.effectiveTarget === b.effectiveTarget
      && a.pending === b.pending
      && sameLimits(a.limits, b.limits)
      && a.markers.length === b.markers.length
      && a.markers.every((marker, index) => marker === b.markers[index]);
  }

  function refresh(): void {
    if (disposed) return;
    const next = computeState();
    if (sameState(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener(state);
  }

  function reclampOverride(key: string, policy: DetailPolicy): void {
    const override = overrides.get(key);
    if (override !== undefined) overrides.set(key, clampDetailValue(policy, override));
  }

  function reclampOverrides(): void {
    for (const key of overrides.keys()) {
      const policy = policyFor(key);
      if (policy) reclampOverride(key, policy);
    }
  }

  function releaseAllLeases(): void {
    for (const lease of leases) lease.active = false;
    leases.clear();
  }

  const detailIds = new Set<string>(Object.values(MAP_DETAIL_PARAMETER_IDS).flatMap(ids => [ids.range, ids.default]));
  // Edits from the parameter list, another tab or a preset reach the rail and the renderer too.
  const unsubscribeSettings = settings.subscribe(changed => {
    if (![...changed].some(id => detailIds.has(id))) return;
    reclampOverrides();
    refresh();
  });

  state = computeState();

  const controller: MapDetailController = {
    settings,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    updatePolicy(policy) {
      if (!active || disposed) return false;
      const kind = detailKindOfKey(active.key);
      if (!kind || !isValidDetailPolicy(policy, kind)) return false;
      if (!settings.setMany(detailPolicyValues(policy)).ok) return false;
      reclampOverride(active.key, copyDetailPolicy(policy));
      refresh();
      return true;
    },
    setSessionOverride(value) {
      if (!active || disposed || !Number.isFinite(value)) return false;
      if (state?.availability !== "ready") return false;
      const policy = policyFor(active.key);
      if (!policy) return false;
      overrides.set(active.key, clampDetailValue(policy, value));
      refresh();
      return true;
    },
    clearSessionOverride() {
      if (!active) return;
      overrides.delete(active.key);
      refresh();
    },
    resetPolicy() {
      if (!active || disposed) return;
      const kind = detailKindOfKey(active.key);
      if (!kind) return;
      const ids = MAP_DETAIL_PARAMETER_IDS[kind];
      settings.reset(ids.range);
      settings.reset(ids.default);
      reclampOverrides();
      refresh();
    },
    getPolicy: policyFor,
    hasSavedPolicy(key) {
      const kind = detailKindOfKey(key);
      return kind !== null && hasSaved(kind);
    },
    seedPolicy(key, policy) {
      const kind = detailKindOfKey(key);
      if (!kind || !isValidDetailPolicy(policy, kind)) return "invalid";
      if (forcedKinds.has(kind)) return "forced";
      if (hasSaved(kind)) return "exists";
      if (!settings.setMany(detailPolicyValues(policy)).ok) return "invalid";
      reclampOverrides();
      refresh();
      return settings.getStorageError() === null ? "saved" : "unsaved";
    },
    acquireRequirement(errorPx) {
      const lease: Lease = { errorPx: sanitizeErrorPx(errorPx), active: !disposed };
      if (lease.active) leases.add(lease);
      refresh();
      return {
        get active() { return lease.active; },
        get errorPx() { return lease.errorPx; },
        update(next) {
          const value = sanitizeErrorPx(next);
          if (!lease.active || value === lease.errorPx) return;
          lease.errorPx = value;
          refresh();
        },
        release() {
          if (!lease.active) return;
          lease.active = false;
          leases.delete(lease);
          refresh();
        },
      };
    },
    getRuntimeTarget() {
      if (!state || state.availability !== "ready") return null;
      const kind = state.policy.kind;
      return kind === "google"
        ? { kind, value: state.effectiveTarget ?? state.requestedTarget }
        : { kind, value: state.requestedTarget };
    },
    getStorageError: () => settings.getStorageError(),
    getGoogleRecommendation() {
      const current = settings.get(MAP_DETAIL_PARAMETER_IDS.google.default);
      if (current === "device-hints" || current === "renderer-default") return current;
      const fallback = settings.inspect(MAP_DETAIL_PARAMETER_IDS.google.default).defaultValue;
      return fallback === "device-hints" ? "device-hints" : "renderer-default";
    },
    setTrackMarker(marker) {
      if (disposed) return () => {};
      const stored = { ...marker };
      markers.set(marker.id, stored);
      refresh();
      return () => {
        if (markers.get(marker.id) !== stored) return;
        markers.delete(marker.id);
        refresh();
      };
    },
    removeTrackMarker(id) {
      if (!markers.delete(id)) return;
      refresh();
    },
    setActiveSource(source) {
      if (disposed) return;
      const previousKey = active?.key ?? null;
      active = source ? { ...source } : null;
      // Leaving Google ends its requirements; a return prepares afresh.
      if (previousKey === GOOGLE_DETAIL_KEY && active?.key !== GOOGLE_DETAIL_KEY) releaseAllLeases();
      refresh();
    },
    setRecommendationContext(next) {
      context = { ...context, ...next, deviceHints: context.deviceHints };
      refresh();
    },
    reportDelivery(key, delivery) {
      if (delivery) {
        deliveries.set(key, { pending: delivery.pending, limits: [...delivery.limits], effectiveTarget: delivery.effectiveTarget ?? null });
      } else {
        deliveries.delete(key);
      }
      if (key === active?.key) refresh();
    },
    dispose() {
      if (disposed) return;
      releaseAllLeases();
      unsubscribeSettings();
      for (const release of releaseForced) release();
      disposed = true;
      listeners.clear();
      markers.clear();
    },
  };
  return controller;
}
