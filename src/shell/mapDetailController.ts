import {
  copyDetailPolicy,
  clampDetailValue,
  DEFAULT_GOOGLE_DETAIL_POLICY,
  DEFAULT_RASTER_DETAIL_POLICY,
  detailKindOfKey,
  GOOGLE_DETAIL_KEY,
  GOOGLE_ERROR_TARGET_BOUNDS,
  isValidDetailPolicy,
  readDeviceHints,
  resolveDetailDefault,
  type DetailLimit,
  type DetailPolicy,
  type DetailRecommendationContext,
  type DetailState,
  type DeviceHints,
  type GoogleDetailPolicy,
  type GoogleRecommendationPolicy,
  type RasterDetailPolicy,
} from "../terrain/mapDetailPolicy";

/** One versioned record per browser origin, keyed by source. */
export const MAP_DETAIL_STORAGE_KEY = "foss-earth.map-detail.v1";
const RECORD_VERSION = 1;

export interface MapDetailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

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
  /**
   * Where policies persist. Omitted, the browser's localStorage when it can be
   * reached; null keeps everything in memory.
   */
  storage?: MapDetailStorage | null;
  /**
   * Host policies that win over saved ones on every load. They are not saved;
   * a user edit applies until the next load. Keyed like states.
   */
  forcedPolicies?: Readonly<Record<string, DetailPolicy>>;
  /** Registered defaults, used when neither a forced, saved nor seeded policy exists. */
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
  setActiveSource(source: MapDetailActiveSource | null): void;
  setRecommendationContext(context: Partial<Pick<DetailRecommendationContext, "rendererDefaultErrorPx" | "rendererMode">>): void;
  reportDelivery(key: string, delivery: MapDetailDelivery | null): void;
  dispose(): void;
}

interface Lease {
  errorPx: number;
  active: boolean;
}

function defaultStorage(): MapDetailStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function sanitizeErrorPx(errorPx: number): number {
  if (!Number.isFinite(errorPx)) throw new RangeError(`A detail requirement must be a finite number of pixels, not ${errorPx}.`);
  return Math.max(GOOGLE_ERROR_TARGET_BOUNDS.finest, Math.min(GOOGLE_ERROR_TARGET_BOUNDS.coarsest, errorPx));
}

function sameLimits(a: readonly DetailLimit[], b: readonly DetailLimit[]): boolean {
  return a.length === b.length && a.every((limit, index) => limit === b[index]);
}

const LIMIT_ORDER: readonly DetailLimit[] = ["consumer", "source", "backend", "memory", "loading"];

export function createMapDetailController(options: MapDetailControllerOptions = {}): MapDetailController {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let storageError: string | null = storage === null && options.storage === undefined
    ? "Browser storage is unavailable, so detail settings last only until the page reloads."
    : null;
  const deviceHints = options.deviceHints ?? readDeviceHints;
  const googleRecommendation = options.googleRecommendation ?? "renderer-default";
  const defaults = {
    google: options.defaults?.google && isValidDetailPolicy(options.defaults.google, "google")
      ? options.defaults.google
      : { ...DEFAULT_GOOGLE_DETAIL_POLICY, defaultValue: { mode: "recommended", policy: googleRecommendation } } as GoogleDetailPolicy,
    raster: options.defaults?.raster && isValidDetailPolicy(options.defaults.raster, "raster") ? options.defaults.raster : DEFAULT_RASTER_DETAIL_POLICY,
  };
  const forced = new Map<string, DetailPolicy>();
  for (const [key, policy] of Object.entries(options.forcedPolicies ?? {})) {
    const kind = detailKindOfKey(key);
    if (kind && isValidDetailPolicy(policy, kind)) forced.set(key, copyDetailPolicy(policy));
  }

  const saved = readSavedPolicies();
  // The policy in force per key once anything has touched it this session.
  const policies = new Map<string, DetailPolicy>();
  const overrides = new Map<string, number>();
  const deliveries = new Map<string, MapDetailDelivery>();
  const leases = new Set<Lease>();
  const listeners = new Set<(state: DetailState | null) => void>();
  let active: MapDetailActiveSource | null = null;
  let context: DetailRecommendationContext = { rendererDefaultErrorPx: null, rendererMode: null, deviceHints: deviceHints() };
  let state: DetailState | null = null;
  let disposed = false;

  function readRecord(): { policies: Record<string, unknown> } | null {
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(MAP_DETAIL_STORAGE_KEY);
    } catch {
      storageError = "Browser storage could not be read, so saved detail settings were not loaded.";
      return null;
    }
    if (raw === null) return { policies: {} };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version === RECORD_VERSION) {
        const stored = (parsed as { policies?: unknown }).policies;
        if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) return { policies: { ...(stored as Record<string, unknown>) } };
      }
    } catch {
      // A corrupt record is ignored as a whole and replaced by the next save.
    }
    return { policies: {} };
  }

  function readSavedPolicies(): Map<string, DetailPolicy> {
    const result = new Map<string, DetailPolicy>();
    const record = readRecord();
    for (const [key, value] of Object.entries(record?.policies ?? {})) {
      const kind = detailKindOfKey(key);
      if (kind && isValidDetailPolicy(value, kind)) result.set(key, copyDetailPolicy(value));
    }
    return result;
  }

  function writeSaved(key: string, policy: DetailPolicy | null): boolean {
    if (!storage) return false;
    const record = readRecord() ?? { policies: {} };
    if (policy) record.policies[key] = copyDetailPolicy(policy);
    else delete record.policies[key];
    try {
      storage.setItem(MAP_DETAIL_STORAGE_KEY, JSON.stringify({ version: RECORD_VERSION, policies: record.policies }));
      storageError = null;
      return true;
    } catch {
      storageError = "Detail settings could not be saved in this browser. They apply until the page reloads.";
      return false;
    }
  }

  function registeredDefault(key: string): DetailPolicy | null {
    const kind = detailKindOfKey(key);
    if (kind === "google") return defaults.google;
    if (kind === "raster") return defaults.raster;
    return null;
  }

  function policyFor(key: string): DetailPolicy | null {
    const current = policies.get(key) ?? forced.get(key) ?? saved.get(key) ?? registeredDefault(key);
    return current ? copyDetailPolicy(current) : null;
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
      && sameLimits(a.limits, b.limits);
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

  function releaseAllLeases(): void {
    for (const lease of leases) lease.active = false;
    leases.clear();
  }

  state = computeState();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    updatePolicy(policy) {
      if (!active || disposed) return false;
      const kind = detailKindOfKey(active.key);
      if (!kind || !isValidDetailPolicy(policy, kind)) return false;
      const next = copyDetailPolicy(policy);
      policies.set(active.key, next);
      if (writeSaved(active.key, next)) saved.set(active.key, next);
      reclampOverride(active.key, next);
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
      const key = active.key;
      policies.delete(key);
      saved.delete(key);
      writeSaved(key, null);
      const policy = policyFor(key);
      if (policy) reclampOverride(key, policy);
      refresh();
    },
    getPolicy: policyFor,
    hasSavedPolicy: (key) => saved.has(key),
    seedPolicy(key, policy) {
      const kind = detailKindOfKey(key);
      if (!kind || !isValidDetailPolicy(policy, kind)) return "invalid";
      if (forced.has(key)) return "forced";
      if (saved.has(key) || policies.has(key)) return "exists";
      const next = copyDetailPolicy(policy);
      policies.set(key, next);
      const written = writeSaved(key, next);
      if (written) saved.set(key, next);
      reclampOverride(key, next);
      refresh();
      return written ? "saved" : "unsaved";
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
    getStorageError: () => storageError,
    getGoogleRecommendation: () => googleRecommendation,
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
      disposed = true;
      listeners.clear();
    },
  };
}
