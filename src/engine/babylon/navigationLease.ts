/**
 * One cancellable owner of globe navigation (docs/proposals/panorama-scenes.md
 * §5). A lease suspends the globe's own input, tracking and map selection for
 * as long as it is held; its holder can present a view that is not the globe
 * camera's and hold rendering. The globe camera itself is never replaced, and
 * the snapshot taken at acquisition is what the holder returns to.
 *
 * This module is the bookkeeping only: the runtime supplies what acquiring
 * and releasing do to the camera, input and maps.
 */
import type { GlobeViewState } from "../types";

/**
 * The layer a navigation lease's presentation draws: while a lease presents
 * its own view, the globe camera draws only meshes in this layer, so the
 * globe is hidden without being disposed.
 */
export const NAVIGATION_PRESENTATION_LAYER = 0x10000000;

export type EcefVector = { readonly x: number; readonly y: number; readonly z: number };

/** Why a lease ended. */
export type NavigationEndReason = "exit" | "cancelled" | "replaced" | "disposed" | "device-lost" | "aborted";

/**
 * Everything needed to put the globe view back exactly: the orbit target's
 * ECEF position (not re-derived from the surface), the camera's orientation,
 * distance, field of view and clipping. Serializable: history keeps it.
 */
export interface NavigationSnapshot {
  readonly version: 1;
  /** The same view as `getViewState()` reports, for display. */
  readonly view: GlobeViewState;
  readonly camera: {
    readonly center: EcefVector;
    /** Babylon GeospatialCamera yaw and pitch, radians. */
    readonly yaw: number;
    readonly pitch: number;
    readonly radius: number;
    /** Vertical field of view, radians. */
    readonly fov: number;
  };
}

/**
 * A view the lease holder shows instead of the globe camera's: a position
 * and an orthonormal forward/up pair in ECEF, and a vertical field of view.
 * The runtime's presentation camera draws only the navigation layer.
 */
export interface NavigationPresentation {
  readonly position: EcefVector;
  readonly forward: EcefVector;
  readonly up: EcefVector;
  readonly verticalFovRad: number;
}

/** How a placed camera goes on moving when its owner hands it back to the globe. */
export interface NavigationGlide {
  /** The eye's velocity, m/s. */
  readonly velocity: EcefVector;
  /** How fast the look direction turns: its derivative, 1/s. */
  readonly turn: EcefVector;
  /** The field of view the camera eases to, radians. */
  readonly fovRad: number;
  /**
   * When the owner's own motion began (`performance.now()`): input begun
   * since is the person's, taking the camera over, and goes on moving it; a
   * wheel gesture from before is ignored to its end.
   */
  readonly inputSince: number;
  /** A mouse press that took the camera over and is still held, which goes on as a drag. */
  readonly press?: { readonly pointerId: number; readonly button: number; readonly clientX: number; readonly clientY: number } | null;
}

export interface NavigationRequest {
  /** Who asks, for messages: "foss-earth.scenes". */
  readonly owner: string;
  /** The input context controller bindings switch to while the lease is held. */
  readonly inputContext: string;
  readonly signal?: AbortSignal;
  /** What the maps do while the lease is held. Only "paused" exists. */
  readonly terrain?: "paused";
}

export interface NavigationLease {
  readonly owner: string;
  readonly inputContext: string;
  /** Increases with every acquisition in a runtime. */
  readonly generation: number;
  /** Aborted when the lease ends, for any reason. */
  readonly signal: AbortSignal;
  /** The globe view when the lease was acquired. Never changes. */
  readonly overview: NavigationSnapshot;
  /** The element that had keyboard focus at acquisition, if any. */
  readonly focusReturn: Element | null;
  /** Shows a view other than the globe camera's, or the globe camera's again with null. */
  setPresentationView(view: NavigationPresentation | null): void;
  getPresentationView(): NavigationPresentation | null;
  requestRender(): void;
  /** Renders every frame until the returned function is called; calling it twice is harmless. */
  holdRendering(): () => void;
  /** Ends the lease; the second and later calls do nothing. */
  release(reason: NavigationEndReason): void;
  readonly released: boolean;
}

export type NavigationAcquisition =
  | { ok: true; lease: NavigationLease }
  | { ok: false; reason: "busy" | "disposed" | "aborted"; message: string };

export interface NavigationState {
  owner: string;
  inputContext: string;
  generation: number;
  presenting: boolean;
}

export interface NavigationHost {
  /** Why navigation cannot be leased right now (a simulation owns the camera), or null. */
  unavailable(): string | null;
  snapshot(): NavigationSnapshot | null;
  /** Suspends globe input, tracking and map selection. */
  suspend(request: NavigationRequest): void;
  /** Undoes suspend. The holder restores the camera itself before releasing. */
  resume(): void;
  present(view: NavigationPresentation | null): void;
  requestRender(): void;
  beginContinuous(): void;
  endContinuous(): void;
}

export interface NavigationOwner {
  acquire(request: NavigationRequest): NavigationAcquisition;
  current(): NavigationLease | null;
  state(): NavigationState | null;
  subscribe(listener: (state: NavigationState | null) => void): () => void;
  /** Ends any lease with this reason, such as on device loss. */
  end(reason: NavigationEndReason): void;
  dispose(): void;
}

export function createNavigationOwner(host: NavigationHost): NavigationOwner {
  let lease: (NavigationLease & { presentation: NavigationPresentation | null }) | null = null;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<(state: NavigationState | null) => void>();

  const state = (): NavigationState | null => (lease
    ? { owner: lease.owner, inputContext: lease.inputContext, generation: lease.generation, presenting: lease.presentation !== null }
    : null);
  const emit = (): void => {
    const current = state();
    for (const listener of [...listeners]) listener(current);
  };

  function acquire(request: NavigationRequest): NavigationAcquisition {
    if (disposed) return { ok: false, reason: "disposed", message: "The globe has been disposed." };
    if (request.signal?.aborted) return { ok: false, reason: "aborted", message: "The request was cancelled before it started." };
    if (lease) return { ok: false, reason: "busy", message: `Navigation is held by ${lease.owner}.` };
    const unavailable = host.unavailable();
    if (unavailable) return { ok: false, reason: "busy", message: unavailable };
    const overview = host.snapshot();
    if (!overview) return { ok: false, reason: "busy", message: "The globe camera is not ready." };

    generation += 1;
    const controller = new AbortController();
    const holds = new Set<() => void>();
    let released = false;
    const onExternalAbort = (): void => current.release("aborted");
    const current: NavigationLease & { presentation: NavigationPresentation | null } = {
      owner: request.owner,
      inputContext: request.inputContext,
      generation,
      signal: controller.signal,
      overview,
      focusReturn: typeof document !== "undefined" ? document.activeElement : null,
      presentation: null,
      get released() { return released; },
      setPresentationView(view) {
        if (released) return;
        const changed = (current.presentation === null) !== (view === null);
        current.presentation = view;
        host.present(view);
        host.requestRender();
        // Listeners hear when presenting starts or stops, not every look.
        if (changed) emit();
      },
      getPresentationView() {
        return current.presentation;
      },
      requestRender() {
        if (!released) host.requestRender();
      },
      holdRendering() {
        if (released) return () => {};
        let held = true;
        host.beginContinuous();
        const releaseHold = (): void => {
          if (!held) return;
          held = false;
          holds.delete(releaseHold);
          host.endContinuous();
        };
        holds.add(releaseHold);
        return releaseHold;
      },
      release(reason) {
        if (released) return;
        released = true;
        request.signal?.removeEventListener("abort", onExternalAbort);
        for (const releaseHold of [...holds]) releaseHold();
        if (current.presentation) host.present(null);
        current.presentation = null;
        if (lease === current) lease = null;
        host.resume();
        controller.abort(new DOMException(`Navigation ended: ${reason}.`, "AbortError"));
        host.requestRender();
        emit();
      },
    };
    lease = current;
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });
    host.suspend(request);
    host.requestRender();
    emit();
    return { ok: true, lease: current };
  }

  return {
    acquire,
    current: () => lease,
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    end(reason) {
      lease?.release(reason);
    },
    dispose() {
      lease?.release("disposed");
      disposed = true;
      listeners.clear();
    },
  };
}
