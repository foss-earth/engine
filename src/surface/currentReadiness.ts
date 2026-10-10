import type { DisplayedSurfaceHeight } from "./access.js";
import type { SurfaceHit, SurfaceQuery } from "./contracts.js";

/** Loading may settle its reservation bookkeeping after the notification. */
export type SurfaceOwnerChange = "geometry" | "loading" | "status" | "disposed";

export interface SurfaceLocation {
  readonly latDeg: number;
  readonly lonDeg: number;
}

/** A bounded set of points, not a proof of continuous polygon/footprint coverage. */
export interface SurfaceLocality {
  readonly samples: readonly SurfaceLocation[];
}

/** Actual map-owner status. Loading and suspension do not disqualify usable hits. */
export interface CurrentSurfaceOwnerState {
  readonly revision: number;
  readonly sourceGeneration: number;
  readonly selectedSource: string;
  readonly displayedSources: readonly string[];
  readonly loading: boolean;
  /** Last render-pause request through this runtime; external scheduler state is unknown. */
  readonly paused: boolean;
  /** External simulation state supplied to this runtime, or null outside simulation mode. */
  readonly simulationRunning: boolean | null;
  readonly suspended: boolean;
  readonly error: string | null;
}

export type CurrentSurfaceSample =
  | { readonly location: SurfaceLocation; readonly status: "hit"; readonly hit: Readonly<SurfaceHit>; readonly height: DisplayedSurfaceHeight }
  | { readonly location: SurfaceLocation; readonly status: "missing"; readonly reason: "no-displayed-hit" | "stale-revision" | "invalid-hit" | "query-failed" };

export interface CurrentSurfaceReadiness extends CurrentSurfaceOwnerState {
  readonly state: "ready" | "loading" | "unavailable" | "failed";
  /** Monotonic within this observation; changes with locality, evidence or status. */
  readonly sequence: number;
  readonly locality: SurfaceLocality;
  readonly samples: readonly CurrentSurfaceSample[];
  readonly readySamples: number;
  readonly totalSamples: number;
  readonly disposed: boolean;
}

export interface CurrentSurfaceObservation {
  /** Refresh from the owner's current displayed query; never starts loading. */
  read(): CurrentSurfaceReadiness;
  /** Rejects a stale retained snapshot, including source/locality/disposal changes. */
  isCurrent(snapshot: CurrentSurfaceReadiness): boolean;
  updateLocality(locality: SurfaceLocality): void;
  /** Immediately supplies current evidence, then meaningful owner changes, even paused. */
  subscribe(listener: (snapshot: CurrentSurfaceReadiness) => void): () => void;
  /** Publishes one terminal unavailable snapshot and releases all callbacks. */
  dispose(): void;
}

export interface CurrentDisplayedSurface {
  /** Observe 1–25 explicit WGS84 locations; readiness applies only to these points. */
  observe(locality: SurfaceLocality): CurrentSurfaceObservation;
}

export interface CurrentDisplayedSurfaceAuthority extends CurrentDisplayedSurface {
  /** Called by the same map owner after commits, async/status or suspension changes. */
  refresh(): void;
  dispose(): void;
}

function copyLocality(locality: SurfaceLocality): SurfaceLocality {
  if (!Array.isArray(locality.samples) || locality.samples.length < 1 || locality.samples.length > 25) {
    throw new RangeError("Displayed surface locality requires 1–25 sample locations.");
  }
  return Object.freeze({ samples: Object.freeze(locality.samples.map(location => {
    if (!Number.isFinite(location.latDeg) || Math.abs(location.latDeg) > 90
      || !Number.isFinite(location.lonDeg) || Math.abs(location.lonDeg) > 180) {
      throw new RangeError("Displayed surface locations require finite WGS84 latitude/longitude.");
    }
    return Object.freeze({ latDeg: location.latDeg, lonDeg: location.lonDeg });
  })) });
}

function validHit(hit: SurfaceHit): boolean {
  return [hit.heightMeters, hit.distanceMeters, hit.quality, hit.point.x, hit.point.y, hit.point.z,
    hit.normal.x, hit.normal.y, hit.normal.z].every(Number.isFinite)
    && hit.distanceMeters >= 0 && Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z) > 0
    && (hit.geometricErrorMeters === undefined || (Number.isFinite(hit.geometricErrorMeters) && hit.geometricErrorMeters >= 0));
}

/** No clock, loop, renderer, source inference, cached height or loading policy. */
export function createCurrentDisplayedSurface(query: Required<SurfaceQuery>, ownerState: () => CurrentSurfaceOwnerState): CurrentDisplayedSurfaceAuthority {
  const observations = new Set<{ refresh(): void; dispose(): void }>();
  let ownerDisposed = false;
  const pendingCallbacks: Array<() => void> = [];
  let dispatching = false;
  const dispatch = (callbacks: readonly (() => void)[]): void => {
    pendingCallbacks.push(...callbacks);
    if (dispatching) return;
    dispatching = true;
    const failures: unknown[] = [];
    try {
      // Reentrant reads/updates enqueue after the captured publication batch,
      // so every subscriber receives monotonically ordered sequences.
      for (let index = 0; index < pendingCallbacks.length; index += 1) {
        try { pendingCallbacks[index](); } catch (error) { failures.push(error); }
      }
    } finally { pendingCallbacks.length = 0; dispatching = false; }
    if (failures.length) throw new AggregateError(failures, "Displayed surface observation callbacks failed.");
  };
  const attempt = (actions: readonly (() => void)[]): void => {
    const failures: unknown[] = [];
    for (const action of actions) try { action(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Displayed surface owner observation updates failed.");
  };
  return {
    observe(input) {
      if (ownerDisposed) throw new Error("Displayed surface owner is disposed.");
      let locality = copyLocality(input), disposed = false, sequence = 0;
      let snapshot: CurrentSurfaceReadiness;
      let signature = "";
      let ownerSignature = "";
      const listeners = new Set<(snapshot: CurrentSurfaceReadiness) => void>();
      const refresh = (): void => {
        const before = ownerState();
        const nextOwnerSignature = JSON.stringify({ ...before, locality, disposed });
        // The map's revision is authoritative. An unchanged frame does no
        // repeated local triangle traversal, including while simulation runs.
        if (nextOwnerSignature === ownerSignature) return;
        ownerSignature = nextOwnerSignature;
        let queryFailed = false;
        let samples: CurrentSurfaceSample[] = disposed ? [] : locality.samples.map((location): CurrentSurfaceSample => {
          let hit: SurfaceHit | null;
          try { hit = query.sample(location.latDeg, location.lonDeg); }
          catch { queryFailed = true; return { location, status: "missing", reason: "query-failed" }; }
          if (!hit) return { location, status: "missing", reason: "no-displayed-hit" };
          if (hit.revision !== before.revision) return { location, status: "missing", reason: "stale-revision" };
          if (!validHit(hit)) return { location, status: "missing", reason: "invalid-hit" };
          return { location, status: "hit", hit: Object.freeze({ ...hit,
            point: Object.freeze({ ...hit.point }), normal: Object.freeze({ ...hit.normal }) }),
          height: Object.freeze({ kind: "displayed-geometry", datum: "wgs84-ellipsoid-coordinate",
            meters: hit.heightMeters, physicalDatum: "unknown" }) };
        });
        const after = ownerState();
        if (!disposed && (before.revision !== after.revision || before.sourceGeneration !== after.sourceGeneration
          || query.revision() !== after.revision)) {
          // One changed point invalidates the whole evidence batch; no mixed commit.
          samples = locality.samples.map(location => ({ location, status: "missing", reason: "stale-revision" }));
        }
        const readySamples = samples.filter(sample => sample.status === "hit").length;
        const state: CurrentSurfaceReadiness["state"] = disposed ? "unavailable" : readySamples === locality.samples.length ? "ready"
          : queryFailed ? "failed" : after.loading ? "loading" : after.error ? "failed" : "unavailable";
        const next = { ...after, displayedSources: Object.freeze([...after.displayedSources]), state,
          locality, samples: Object.freeze(samples.map(sample => Object.freeze(sample))),
          readySamples, totalSamples: locality.samples.length, disposed };
        const nextSignature = JSON.stringify(next);
        if (nextSignature === signature) return;
        signature = nextSignature;
        snapshot = Object.freeze({ ...next, state, sequence: ++sequence });
        const published = snapshot;
        dispatch([...listeners].map(listener => () => listener(published)));
      };
      const observation: CurrentSurfaceObservation = {
        read() { if (!disposed) refresh(); return snapshot; },
        isCurrent(candidate) { if (!disposed) refresh(); return !disposed && candidate === snapshot; },
        updateLocality(next) {
          if (disposed) throw new Error("Displayed surface observation is disposed.");
          locality = copyLocality(next); refresh();
        },
        subscribe(listener) {
          if (disposed) return () => undefined;
          refresh(); listeners.add(listener);
          try { listener(snapshot); } catch (error) { listeners.delete(listener); throw error; }
          return () => { listeners.delete(listener); };
        },
        dispose() {
          if (disposed) return;
          disposed = true; observations.delete(internal);
          try { refresh(); } finally { listeners.clear(); }
        },
      };
      const internal = { refresh, dispose: observation.dispose };
      refresh(); observations.add(internal);
      return observation;
    },
    refresh() { if (!ownerDisposed) attempt([...observations].map(observation => () => observation.refresh())); },
    dispose() {
      if (ownerDisposed) return;
      ownerDisposed = true;
      // Retire observations immediately even when disposal is reentrant;
      // only notifications wait behind an in-progress publication batch.
      try { attempt([...observations].map(observation => () => observation.dispose())); }
      finally { observations.clear(); }
    },
  };
}
