import { createOrbitViewSnapshot } from "../camera/orbitView.js";
import type { TerrainPreparationOptions, TerrainPreparationResult } from "../surface/terrainPreparation.js";
import type { NavigationSnapshot, NavigationAbortSignal, NavigationAbortController } from "./navigationLease.js";

/** Authored data belongs to the scene host; this is the reusable camera binding. */
export interface GlobeOverview {
  target: { longitudeDeg: number; latitudeDeg: number; height?: { meters: number } | null };
  distanceMeters: number; headingDeg: number; pitchDeg: number; verticalFovDeg: number;
}
export type GlobeOverviewResult = { ok: true; state: "applied" } | {
  ok: false; reason: "disposed" | "busy" | "cancelled"; message: string;
};
export interface GlobeOverviewOptions<TSignal extends NavigationAbortSignal = NavigationAbortSignal> {
  /** Structural existing Engine ports; core declarations borrow no Babylon/DOM. */
  runtime: {
    surface: { sample(latitudeDeg: number, longitudeDeg: number): { heightMeters: number } | null };
    prepareTerrain(options: TerrainPreparationOptions): Promise<TerrainPreparationResult>;
    captureNavigationSnapshot(): NavigationSnapshot | null;
    restoreNavigationSnapshot(snapshot: NavigationSnapshot): boolean;
    requestRender(): void;
  };
  isOverview(): boolean;
  minimumPreparationRadiusMeters(): number;
  /** Restore the host's configured camera FOV only if this binding applied one. */
  configuredFovDegrees(): number | null;
  createAbortController(): NavigationAbortController<TSignal>;
  combineSignals(signals: readonly TSignal[]): TSignal;
  abortReason(): unknown;
  signal?: TSignal;
}

/** Original App/sceneWorld overview/cancellation algorithm, without placement/UI. */
export function createGlobeOverviewBinding<TSignal extends NavigationAbortSignal>(options: GlobeOverviewOptions<TSignal>) {
  const { runtime } = options;
  let disposed = false, appliedFov = false;
  let pending: { controller: NavigationAbortController<TSignal>; baseline: NavigationSnapshot["view"] | null } | null = null;
  const operations = new Set<Promise<GlobeOverviewResult>>();
  const errors: unknown[] = [];
  const cancelled = (): GlobeOverviewResult => ({ ok: false, reason: "cancelled", message: "Cancelled." });
  const cancel = (): void => { pending?.controller.abort(options.abortReason()); };
  const cameraMoved = (): boolean => {
    const baseline = pending?.baseline, view = runtime.captureNavigationSnapshot()?.view;
    return Boolean(baseline && view && (view.latDeg !== baseline.latDeg || view.lonDeg !== baseline.lonDeg ||
      view.headingDeg !== baseline.headingDeg || view.pitchDeg !== baseline.pitchDeg || view.zoomMeters !== baseline.zoomMeters));
  };
  const observeFrame = (): void => { if (pending && (cameraMoved() || !options.isOverview())) cancel(); };
  async function apply(overview: GlobeOverview, external?: TSignal): Promise<GlobeOverviewResult> {
    if (disposed) return { ok: false, reason: "disposed", message: "The overview binding is disposed." };
    if (!options.isOverview()) return { ok: false, reason: "busy", message: "Exit the panorama first." };
    cancel();
    const op = { controller: options.createAbortController(), baseline: null as NavigationSnapshot["view"] | null };
    pending = op;
    let signal = op.controller.signal;
    try {
      signal = options.combineSignals([op.controller.signal, ...(external ? [external] : []), ...(options.signal ? [options.signal] : [])]);
      if (signal.aborted) return cancelled();
      let ground = overview.target.height?.meters ?? runtime.surface.sample(overview.target.latitudeDeg, overview.target.longitudeDeg)?.heightMeters ?? null;
      if (ground === null) {
        const preparing = runtime.prepareTerrain({ latDeg: overview.target.latitudeDeg, lonDeg: overview.target.longitudeDeg,
          radiusMeters: Math.max(overview.distanceMeters * 2, options.minimumPreparationRadiusMeters()),
          altitudeAboveGroundMeters: 0, clearanceMeters: 0, signal });
        op.baseline = runtime.captureNavigationSnapshot()?.view ?? null;
        ground = (await preparing).groundHeightMeters;
      }
      if (disposed || pending !== op || signal.aborted) return cancelled();
      if (cameraMoved() || !options.isOverview()) { op.controller.abort(options.abortReason()); return cancelled(); }
      const snapshot = createOrbitViewSnapshot({ ...overview, longitudeDeg: overview.target.longitudeDeg,
        latitudeDeg: overview.target.latitudeDeg, heightMeters: ground });
      if (!runtime.restoreNavigationSnapshot(snapshot)) return { ok: false, reason: "busy", message: "Another owner holds the camera." };
      appliedFov = true;
      return { ok: true, state: "applied" };
    } catch (error) { if (signal.aborted || disposed || pending !== op) return cancelled(); throw error; }
    finally { if (pending === op) pending = null; }
  }
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const action of [cancel, () => options.signal?.removeEventListener("abort", abort), () => {
      if (!appliedFov) return;
      const snapshot = runtime.captureNavigationSnapshot(), fov = options.configuredFovDegrees();
      if (snapshot && fov !== null && Number.isFinite(fov)) runtime.restoreNavigationSnapshot({ ...snapshot, camera: { ...snapshot.camera, fov: fov * Math.PI / 180 } });
    }, () => runtime.requestRender()]) { try { action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Globe overview cleanup failed.");
  };
  const abort = (): void => { try { dispose(); } catch { /* Recorded errors remain observable through whenSettled. */ } };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    showOverview(overview: GlobeOverview, { signal }: { signal?: TSignal } = {}) {
      const work = apply(overview, signal); operations.add(work);
      void work.then(() => operations.delete(work), () => operations.delete(work));
      return work;
    },
    /** Called by the host's existing frame observation and fresh-input listener. */
    observeFrame, cancel, dispose, isPending: () => pending !== null,
    async whenSettled() {
      while (operations.size) await Promise.allSettled([...operations]);
      if (errors.length) throw new AggregateError(errors, "Globe overview retirement failed.");
    },
  };
}
