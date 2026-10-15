/**
 * Resolving where zoom acts, for the globe runtime: the point under a client
 * position on the displayed surface or the WGS84 ellipsoid, the pinned point,
 * or the compass target; the pin itself, which is session state; and a
 * one-shot Pick point selection. Every point is copied: loading terrain later
 * moves none of them. Rotation always resolves to the compass target.
 */
import type { GeospatialCamera, Scene } from "@babylonjs/core";
import { clientRay } from "./anchorPan.js";
import { RAD_TO_DEG, WGS84_B, ecefToGeodetic, type EcefCoord } from "../camera/cameraMath.js";
import { pointInViewProblem, rayToHeight, type CameraPose } from "../camera/anchoredMotion.js";
import { length, sub, type Vec3 } from "../camera/geographicFrames.js";
import type { SurfaceQuery } from "../surface/contracts.js";
import type { GlideAnchors } from "../input/inertialCameraController.js";
import {
  ANCHOR_FAMILIES,
  NAVIGATION_ANCHOR_CHOICES,
  samePoint,
  type AnchorAcquisition,
  type AnchorChoice,
  type AnchorFallback,
  type AnchorFamily,
  type AnchorOperation,
  type AnchorRequest,
  type AnchorSource,
  type NavigationAnchor,
  type NavigationAnchorPreferences,
  type GlobeNavigationAnchors,
  type NavigationAnchorStatus,
  type PinnedPoint,
  type PointSelectionState,
} from "../input/navigationAnchors.js";

export type { GlobeNavigationAnchors, NavigationAnchorStatus, PinnedPoint, PointSelectionState } from "../input/navigationAnchors.js";

/** A point a marker shows: what acts about it, and where it is. */
export interface AnchorMarkerPoint {
  readonly point: Readonly<EcefCoord>;
  readonly zoom: boolean;
  readonly orbit: boolean;
  /** A grab pan holds this ground, or is still gliding from having held it. */
  readonly grab: boolean;
  /** The finger is still down. False while this grab only waits out its glide. */
  readonly held: boolean;
  /** Zoom events are still arriving. False while this zoom only waits out its glide. */
  readonly zoomHeld: boolean;
  readonly pinned: boolean;
}

/**
 * Pick point, as the input controllers see it: whether a click or tap on
 * the globe now picks a point, and picking one.
 */
export interface PointSelectionPort {
  armed(): boolean;
  /** Pins the point under a client position. False when no surface is there: selection stays armed. */
  pickAt(client: { readonly x: number; readonly y: number }): boolean;
  cancel(): void;
}

export interface NavigationAnchorServicePorts {
  scene: Scene;
  canvas: HTMLCanvasElement;
  getCamera(): GeospatialCamera | null;
  /** The pose the camera draws now. */
  getPose(): CameraPose | null;
  /** The displayed map surface: terrain and 3D buildings, never sprites, markers, overlays or helpers. */
  surface: Pick<SurfaceQuery, "raycast" | "revision">;
  /** The four zoom choices, read when a gesture starts. */
  preferences(): NavigationAnchorPreferences;
  /** True while a tracked point is the camera's centre: it is then every gesture's anchor. */
  tracking(): boolean;
  /** Why picking or pinning is unavailable now (a navigation lease, another camera owner), or null. */
  pinningBlocked(): string | null;
  /** Who holds navigation now: "globe" while its own input does. */
  owner(): string;
  /** What the status or markers show changed. */
  changed(): void;
}

export interface NavigationAnchorService extends GlobeNavigationAnchors {
  acquire(request: AnchorRequest<HTMLCanvasElement>): AnchorAcquisition;
  /** A candidate gesture uses its anchors now: they show, and the status reports them. */
  hold(acquisition: AnchorAcquisition): void;
  /** The gesture holding these anchors ended; their markers stay while their glide does. */
  release(acquisition: AnchorAcquisition): void;
  /** True for an anchor acquired since the last `reset`: one from before is a cleared context. */
  isCurrent(anchor: NavigationAnchor): boolean;
  readonly selection: PointSelectionPort;
  /**
   * The ground under a client point, whatever the anchor choices say: the
   * displayed surface the camera's ray meets, else the ellipsoid. A copy,
   * frozen. Null for sky, or once disposed. What a grab pan holds on to.
   */
  groundAt(client: { readonly x: number; readonly y: number }): { readonly point: Readonly<EcefCoord>; readonly source: "surface" | "ellipsoid" } | null;
  /** The points markers show: those held by gestures, those gliding, a grab's ground, and the pin. */
  markerPoints(gliding: GlideAnchors): AnchorMarkerPoint[];
  /** Clears gesture contexts: the view was replaced. Pick point and the pin stay. */
  retire(): void;
  /** Clears gesture contexts and Pick point, and says so: navigation was leased. The pin stays. */
  reset(): void;
  /** Something the status reads changed outside the service, such as tracking. */
  refresh(): void;
  dispose(): void;
}

/** Past the ellipsoid, a ray still meets ground this far below it, metres: deeper than any. */
const BELOW_ELLIPSOID_METERS = 20_000;
/** Beyond the horizon, a ray can still meet a mountain this far away, metres. */
const BEYOND_HORIZON_METERS = 400_000;

const vec = (point: Readonly<EcefCoord>): Vec3 => [point.x, point.y, point.z];
const copy = (point: Readonly<EcefCoord> | Vec3): Readonly<EcefCoord> => Object.freeze(Array.isArray(point)
  ? { x: point[0], y: point[1], z: point[2] }
  : { x: (point as EcefCoord).x, y: (point as EcefCoord).y, z: (point as EcefCoord).z });

const PIN_PROBLEMS: Record<NonNullable<ReturnType<typeof pointInViewProblem>>, AnchorFallback> = {
  "not-finite": "pin-invalid",
  "too-near": "pin-too-near",
  "behind": "pin-behind",
  "beyond-horizon": "pin-beyond-horizon",
};

export function createNavigationAnchorService(ports: NavigationAnchorServicePorts): NavigationAnchorService {
  let session = 0;
  // Anchors acquired before this session were cleared by a reset.
  let firstCurrentSession = 1;
  let pin: PinnedPoint | null = null;
  let selection: PointSelectionState = "off";
  let disposed = false;
  const last = Object.fromEntries(ANCHOR_FAMILIES.map(family => [family, {}])) as Record<AnchorFamily, Partial<Record<AnchorOperation, NavigationAnchor>>>;
  const held = new Set<NavigationAnchor>();
  const listeners = new Set<() => void>();

  function notify(): void {
    if (disposed) return;
    for (const listener of [...listeners]) listener();
    ports.changed();
  }

  /**
   * The point under a client position: the nearest displayed surface the
   * camera's own ray through it meets, or else where it meets the ellipsoid.
   * Null when it meets neither.
   */
  function pointUnder(client: { readonly x: number; readonly y: number }): { point: Readonly<EcefCoord>; source: "surface" | "ellipsoid"; revision: number | null } | null {
    const camera = ports.getCamera();
    if (!camera || !Number.isFinite(client.x) || !Number.isFinite(client.y)) return null;
    const ray = clientRay(ports.scene, camera, ports.canvas, client.x, client.y);
    if (!ray) return null;
    const origin: Vec3 = [ray.origin.x, ray.origin.y, ray.origin.z];
    const direction: Vec3 = [ray.direction.x, ray.direction.y, ray.direction.z];
    if (!origin.every(Number.isFinite) || !direction.every(Number.isFinite)) return null;
    // The ellipsoid point lies on the ray itself; a height sampled under it would leave the ray in a tilted view.
    const ellipsoid = rayToHeight(origin, direction, 0);
    const reach = ellipsoid
      ? length(sub(ellipsoid, origin)) + BELOW_ELLIPSOID_METERS
      : Math.sqrt(Math.max(0, length(origin) ** 2 - WGS84_B ** 2)) + BEYOND_HORIZON_METERS;
    const hit = ports.surface.raycast({ x: origin[0], y: origin[1], z: origin[2] }, { x: direction[0], y: direction[1], z: direction[2] }, reach);
    if (hit && [hit.point.x, hit.point.y, hit.point.z].every(Number.isFinite)) {
      return { point: copy(hit.point), source: "surface", revision: Number.isFinite(hit.revision) ? hit.revision : ports.surface.revision?.() ?? null };
    }
    return ellipsoid ? { point: copy(ellipsoid), source: "ellipsoid", revision: null } : null;
  }

  function pinned(point: Readonly<EcefCoord>, source: PinnedPoint["source"], revision: number | null): PinnedPoint {
    const place = ecefToGeodetic(point.x, point.y, point.z);
    return Object.freeze({ point: copy(point), latDeg: place.latRad * RAD_TO_DEG, lonDeg: place.lonRad * RAD_TO_DEG,
      heightMeters: place.altMeters, source, surfaceRevision: revision });
  }

  /** Why the pin cannot be this gesture's anchor, or null when it can. */
  function pinProblem(point: Readonly<EcefCoord>): AnchorFallback | null {
    const pose = ports.getPose();
    if (!pose) return "pin-invalid";
    const problem = pointInViewProblem(pose, vec(point));
    return problem ? PIN_PROBLEMS[problem] : null;
  }

  function acquire(request: AnchorRequest<HTMLCanvasElement>): AnchorAcquisition {
    if (disposed) return {};
    session += 1;
    const owner = ports.owner();
    const choices = ports.preferences()[request.family];
    const offered = NAVIGATION_ANCHOR_CHOICES[request.family] as readonly string[];
    const tracking = ports.tracking();
    const acquired: Partial<Record<AnchorOperation, NavigationAnchor>> = {};
    for (const operation of request.operations) {
      const latched = request.prefer?.zoom;
      const requested: AnchorChoice = operation === "orbit" ? "target"
        : latched !== undefined && offered.includes(latched) ? latched : choices.zoom;
      const anchor = (source: AnchorSource, point: Readonly<EcefCoord> | null, revision: number | null, fallback: AnchorFallback | null): NavigationAnchor => Object.freeze({
        session, owner, family: request.family, operation, requested, source, point, surfaceRevision: revision, fallback,
      });
      let resolved: NavigationAnchor;
      if (tracking) {
        resolved = anchor("target", null, null, "tracking");
      } else if (requested === "target") {
        resolved = anchor("target", null, null, null);
      } else if (requested === "pinned") {
        const problem = pin ? pinProblem(pin.point) : "no-pin";
        resolved = pin && !problem ? anchor("pinned", pin.point, pin.surfaceRevision, null) : anchor("target", null, null, problem);
      } else if (!request.client) {
        resolved = anchor("target", null, null, "no-pointer");
      } else {
        const picked = pointUnder(request.client);
        resolved = picked ? anchor(picked.source, picked.point, picked.revision, null) : anchor("target", null, null, "missed");
      }
      acquired[operation] = resolved;
    }
    // A candidate shows nothing until it is used.
    if (!request.candidate) record(acquired, request.hold ?? false);
    return acquired;
  }

  /** Reports what a gesture uses, and shows the points it holds. */
  function record(acquisition: AnchorAcquisition, hold: boolean): void {
    for (const anchor of [acquisition.zoom, acquisition.orbit]) {
      if (!anchor) continue;
      last[anchor.family][anchor.operation] = anchor;
      if (hold && anchor.point && anchor.session >= firstCurrentSession) held.add(anchor);
    }
    notify();
  }

  function release(acquisition: AnchorAcquisition): void {
    let changed = false;
    for (const anchor of [acquisition.zoom, acquisition.orbit]) if (anchor && held.delete(anchor)) changed = true;
    if (changed) notify();
  }

  function armPick(): boolean {
    if (disposed || ports.pinningBlocked()) return false;
    if (selection === "armed") return true;
    selection = "armed";
    notify();
    return true;
  }

  function cancelPick(): void {
    if (selection === "off") return;
    selection = "off";
    notify();
  }

  const selectionPort: PointSelectionPort = {
    armed: () => selection !== "off",
    pickAt(client) {
      if (selection === "off" || disposed) return false;
      if (ports.pinningBlocked()) { cancelPick(); return false; }
      const found = pointUnder(client);
      if (!found) {
        selection = "missed";
        notify();
        return false;
      }
      pin = pinned(found.point, found.source, found.revision);
      selection = "off";
      notify();
      return true;
    },
    cancel: cancelPick,
  };

  return {
    acquire,
    hold(acquisition) {
      if (!disposed) record(acquisition, true);
    },
    release,
    isCurrent: anchor => anchor.session >= firstCurrentSession,
    selection: selectionPort,
    groundAt(client) {
      if (disposed) return null;
      const found = pointUnder(client);
      return found ? { point: found.point, source: found.source } : null;
    },
    togglePick() {
      if (selection !== "off") { cancelPick(); return false; }
      return armPick();
    },
    armPick,
    cancelPick,
    pinTarget() {
      const camera = ports.getCamera();
      if (disposed || !camera || ports.pinningBlocked()) return false;
      const center = camera.center;
      if (![center.x, center.y, center.z].every(Number.isFinite)) return false;
      pin = pinned({ x: center.x, y: center.y, z: center.z }, "target", null);
      selection = "off";
      notify();
      return true;
    },
    clearPin() {
      if (!pin) return;
      pin = null;
      notify();
    },
    status: () => ({ pin, selection, pinningBlocked: ports.pinningBlocked(), tracking: ports.tracking(),
      last: Object.fromEntries(ANCHOR_FAMILIES.map(family => [family, { ...last[family] }])) as NavigationAnchorStatus["last"] }),
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    markerPoints(gliding) {
      const points: { point: Readonly<EcefCoord>; zoom: boolean; orbit: boolean; grab: boolean; held: boolean; zoomHeld: boolean; pinned: boolean }[] = [];
      const add = (anchor: NavigationAnchor | null | undefined) => {
        if (!anchor?.point || anchor.session < firstCurrentSession) return null;
        const same = points.find(entry => samePoint(entry.point, anchor.point));
        const entry = same ?? { point: anchor.point, zoom: false, orbit: false, grab: false, held: false, zoomHeld: false, pinned: false };
        if (!same) points.push(entry);
        if (anchor.operation === "zoom") entry.zoom = true; else entry.orbit = true;
        if (anchor.source === "pinned") entry.pinned = true;
        return entry;
      };
      for (const anchor of held) {
        const entry = add(anchor);
        if (entry && anchor.operation === "zoom") entry.zoomHeld = true;
      }
      add(gliding.orbit);
      const zooming = add(gliding.zoom);
      if (zooming && gliding.zoomHeld) zooming.zoomHeld = true;
      if (gliding.pan) {
        const at = points.find(entry => samePoint(entry.point, gliding.pan));
        if (at) { at.grab = true; at.held = gliding.panHeld === true; }
        else points.push({ point: gliding.pan, zoom: false, orbit: false, grab: true, held: gliding.panHeld === true, zoomHeld: false, pinned: false });
      }
      if (pin) {
        const at = points.find(entry => samePoint(entry.point, pin!.point));
        if (at) at.pinned = true;
        else points.push({ point: pin.point, zoom: false, orbit: false, grab: false, held: false, zoomHeld: false, pinned: true });
      }
      return points;
    },
    retire() {
      firstCurrentSession = session + 1;
      if (held.size === 0) return;
      held.clear();
      notify();
    },
    reset() {
      firstCurrentSession = session + 1;
      held.clear();
      selection = "off";
      // Whether pinning is available changed with who holds navigation.
      notify();
    },
    refresh: notify,
    dispose() {
      if (disposed) return;
      held.clear();
      selection = "off";
      pin = null;
      notify();
      disposed = true;
      listeners.clear();
    },
  };
}
