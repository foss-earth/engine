import { GeospatialCamera, NullEngine, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostCameraController } from "../fixtures/composition/runtimeHost.js";
import { createNavigationAnchorService, type NavigationAnchorService } from "../src/babylon/navigationAnchorService.js";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef, type EcefCoord } from "../src/camera/cameraMath.js";
import type { CameraPose } from "../src/camera/anchoredMotion.js";
import { ANCHOR_FALLBACK_MESSAGES, DEFAULT_NAVIGATION_ANCHORS, type AnchorAcquisition, type AnchorRequest, type NavigationAnchorPreferences } from "../src/input/navigationAnchors.js";
import type { SurfaceHit } from "../src/surface/contracts.js";
import type { GlobeViewState } from "../src/view.js";

const WIDTH = 800;
const HEIGHT = 600;
const CENTRE = { x: WIDTH / 2, y: HEIGHT / 2 };
const DOWN: GlobeViewState = { latDeg: 44, lonDeg: -93, headingDeg: 0, pitchDeg: 60, zoomMeters: 2000 };
const SKY = { x: WIDTH / 2, y: 2 };
const NO_GLIDE = { orbit: null, zoom: null };

function hitAt(point: EcefCoord, revision = 7): SurfaceHit {
  return { point: { ...point }, normal: { x: 0, y: 0, z: 1 }, distanceMeters: 1, heightMeters: 0, meshId: "tile", revision, quality: 1 };
}

const fixtures: { engine: NullEngine; service: NavigationAnchorService }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) { f.service.dispose(); f.engine.dispose(); }
});

/** `level`: looking nearly at the horizon, past the pitch limit the controller keeps, so the top of the canvas shows sky. */
function fixture(level = false) {
  const engine = new NullEngine({ renderWidth: WIDTH, renderHeight: HEIGHT, textureSize: 1024, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine); scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("anchor-test", scene, { planetRadius: 6378137 });
  const controller = new HostCameraController(camera, () => 0);
  controller.applyViewState(DOWN);
  if (level) camera.pitch = Math.PI / 2 - 0.02;
  const canvas = { clientWidth: WIDTH, clientHeight: HEIGHT,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT, right: WIDTH, bottom: HEIGHT, x: 0, y: 0 }) } as unknown as HTMLCanvasElement;
  let hit: SurfaceHit | null = null;
  const raycast = vi.fn<(origin: EcefCoord, direction: EcefCoord, length: number) => SurfaceHit | null>(() => hit);
  let preferences: NavigationAnchorPreferences = DEFAULT_NAVIGATION_ANCHORS;
  let tracking = false;
  let blocked: string | null = null;
  let pose: (() => CameraPose | null) = () => controller.getPose();
  const changed = vi.fn();
  const service = createNavigationAnchorService({ scene, canvas, getCamera: () => camera, getPose: () => pose(),
    surface: { raycast, revision: () => 3 }, preferences: () => preferences, tracking: () => tracking,
    pinningBlocked: () => blocked, owner: () => "globe", changed });
  fixtures.push({ engine, service });
  return { engine, camera, controller, service, raycast, changed,
    setHit: (value: SurfaceHit | null) => { hit = value; },
    prefer: (value: Partial<NavigationAnchorPreferences>) => { preferences = { ...DEFAULT_NAVIGATION_ANCHORS, ...value }; },
    setTracking: (value: boolean) => { tracking = value; },
    block: (value: string | null) => { blocked = value; },
    setPose: (value: () => CameraPose | null) => { pose = value; },
    eye: (): EcefCoord => { const p = controller.getPose().eye; return { x: p[0], y: p[1], z: p[2] }; },
    centre: (): EcefCoord => ({ x: camera.center.x, y: camera.center.y, z: camera.center.z }) };
}

const mouse = (extra: Partial<AnchorRequest<HTMLCanvasElement>> = {}): AnchorRequest<HTMLCanvasElement> =>
  ({ family: "mouse", operations: ["zoom", "orbit"], client: CENTRE, ...extra });

/** Pins `point` through Pick point with the surface stub answering it. */
function pin(f: ReturnType<typeof fixture>, point: EcefCoord): void {
  f.setHit(hitAt(point));
  expect(f.service.armPick()).toBe(true);
  expect(f.service.selection.pickAt(CENTRE)).toBe(true);
  f.setHit(null);
}

const distance = (p: EcefCoord, q: EcefCoord): number => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

describe("navigation anchor acquisition", () => {
  it("takes the displayed-surface hit under the pointer for zoom, copied and frozen, and turns about the compass target", () => {
    const f = fixture();
    const surface = geodeticToEcef(44 * DEG_TO_RAD, -93 * DEG_TO_RAD, 250);
    const hit = hitAt(surface, 12);
    f.setHit(hit);
    const { zoom, orbit } = f.service.acquire(mouse());
    expect(f.raycast).toHaveBeenCalledTimes(1);
    expect(zoom).toMatchObject({ family: "mouse", operation: "zoom", requested: "pointer", source: "surface", surfaceRevision: 12, fallback: null, owner: "globe" });
    expect(orbit).toMatchObject({ operation: "orbit", requested: "target", source: "target", point: null, fallback: null });
    expect(zoom!.point).toEqual(surface);
    expect(zoom!.session).toBe(orbit!.session);
    expect(Object.isFrozen(zoom!.point)).toBe(true);
    expect(Object.isFrozen(zoom)).toBe(true);
    hit.point.x += 500;
    f.setHit(hitAt(geodeticToEcef(44 * DEG_TO_RAD, -93 * DEG_TO_RAD, 900)));
    expect(zoom!.point).toEqual(surface);
  });

  it("casts the camera's own ray through the client point, with a reach past the ellipsoid", () => {
    const f = fixture();
    f.service.acquire(mouse());
    const [origin, direction, reach] = f.raycast.mock.calls[0]!;
    expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 9);
    const toCentre = { x: f.camera.center.x - origin.x, y: f.camera.center.y - origin.y, z: f.camera.center.z - origin.z };
    const along = toCentre.x * direction.x + toCentre.y * direction.y + toCentre.z * direction.z;
    // The canvas centre's ray passes through the compass target, under 2 km away.
    expect(Math.hypot(toCentre.x - along * direction.x, toCentre.y - along * direction.y, toCentre.z - along * direction.z)).toBeLessThan(0.5);
    expect(reach).toBeGreaterThan(along + 19_000);
  });

  it("falls back to the WGS84 ellipsoid on the same ray when no surface is hit", () => {
    const f = fixture();
    const { zoom } = f.service.acquire(mouse());
    expect(zoom).toMatchObject({ source: "ellipsoid", surfaceRevision: null, fallback: null });
    expect(Math.abs(ecefToGeodetic(zoom!.point!.x, zoom!.point!.y, zoom!.point!.z).altMeters)).toBeLessThan(1e-3);
    expect(distance(zoom!.point!, f.centre())).toBeLessThan(0.5);
    expect(Object.isFrozen(zoom!.point)).toBe(true);
  });

  it("uses the compass target, saying nothing was under the pointer, when the ray misses Earth", () => {
    const f = fixture(true);
    const { zoom, orbit } = f.service.acquire(mouse({ client: SKY }));
    expect(zoom).toMatchObject({ source: "target", point: null, fallback: "missed", requested: "pointer" });
    expect(orbit).toMatchObject({ source: "target", point: null, fallback: null });
    expect(ANCHOR_FALLBACK_MESSAGES.missed).toBe("Nothing under the pointer; using compass target");
  });

  it("uses the compass target, saying there is no pointer, when the request has no client point", () => {
    const f = fixture();
    const { zoom } = f.service.acquire(mouse({ client: null }));
    expect(zoom).toMatchObject({ source: "target", point: null, fallback: "no-pointer" });
    expect(f.raycast).not.toHaveBeenCalled();
  });

  it("treats a client point at zero as a point", () => {
    const f = fixture();
    const { zoom } = f.service.acquire(mouse({ client: { x: 0, y: 0 } }));
    expect(f.raycast).toHaveBeenCalledTimes(1);
    expect(zoom?.fallback).not.toBe("no-pointer");
  });

  it("gives the compass target without a raycast when target is chosen", () => {
    const f = fixture();
    f.prefer({ mouse: { zoom: "target" } });
    const { zoom, orbit } = f.service.acquire(mouse());
    expect(zoom).toMatchObject({ requested: "target", source: "target", point: null, fallback: null });
    expect(orbit).toMatchObject({ requested: "target", source: "target", point: null, fallback: null });
    f.service.acquire(mouse({ operations: ["zoom"] }));
    expect(f.raycast).not.toHaveBeenCalled();
  });

  it("turns every input about the compass target, without a raycast", () => {
    const f = fixture();
    f.setHit(hitAt(geodeticToEcef(44 * DEG_TO_RAD, -93 * DEG_TO_RAD, 250)));
    for (const family of ["mouse", "trackpad", "touch", "nonPointer"] as const) {
      const { orbit } = f.service.acquire({ family, operations: ["orbit"], client: family === "nonPointer" ? null : CENTRE });
      expect(orbit, family).toMatchObject({ family, requested: "target", source: "target", point: null, fallback: null });
    }
    expect(f.raycast).not.toHaveBeenCalled();
  });

  it("uses a latched choice over the current one, and ignores one the family does not offer", () => {
    const f = fixture();
    expect(f.service.acquire(mouse({ operations: ["zoom"], prefer: { zoom: "target" } })).zoom).toMatchObject({ requested: "target", source: "target" });
    expect(f.service.acquire(mouse({ operations: ["zoom"], prefer: { zoom: "gesture" } })).zoom).toMatchObject({ requested: "pointer", source: "ellipsoid" });
  });

  it("uses the compass target with no pinned point, keeping Pinned point requested", () => {
    const f = fixture();
    f.prefer({ mouse: { zoom: "pinned" } });
    const { zoom } = f.service.acquire(mouse());
    expect(zoom).toMatchObject({ requested: "pinned", source: "target", point: null, fallback: "no-pin" });
    expect(ANCHOR_FALLBACK_MESSAGES[zoom!.fallback!]).toBe("No pinned point; using compass target");
    expect(f.raycast).not.toHaveBeenCalled();
  });

  it("uses a pin in view as the anchor", () => {
    const f = fixture();
    const point = geodeticToEcef(44.001 * DEG_TO_RAD, -93 * DEG_TO_RAD, 100);
    pin(f, point);
    f.prefer({ nonPointer: { zoom: "pinned" } });
    const { zoom, orbit } = f.service.acquire({ family: "nonPointer", operations: ["zoom", "orbit"], client: null });
    expect(zoom).toMatchObject({ source: "pinned", point, surfaceRevision: 7, fallback: null });
    expect(orbit).toMatchObject({ source: "target", fallback: null });
  });

  it("keeps a pin behind the camera but uses the compass target for that gesture", () => {
    const f = fixture();
    const eye = f.eye(); const centre = f.centre();
    const behind = { x: 2 * eye.x - centre.x, y: 2 * eye.y - centre.y, z: 2 * eye.z - centre.z };
    pin(f, behind);
    f.prefer({ mouse: { zoom: "pinned" } });
    const { zoom } = f.service.acquire(mouse());
    expect(zoom).toMatchObject({ requested: "pinned", source: "target", point: null, fallback: "pin-behind" });
    expect(ANCHOR_FALLBACK_MESSAGES["pin-behind"]).toBe("Pinned point behind camera");
    expect(f.service.status().pin?.point).toEqual(behind);
  });

  it("keeps a pin beyond the horizon but uses the compass target for that gesture", () => {
    const f = fixture();
    const antipode = geodeticToEcef(-44 * DEG_TO_RAD, 87 * DEG_TO_RAD, 0);
    pin(f, antipode);
    f.prefer({ mouse: { zoom: "pinned" } });
    expect(f.service.acquire(mouse()).zoom).toMatchObject({ source: "target", fallback: "pin-beyond-horizon" });
    expect(ANCHOR_FALLBACK_MESSAGES["pin-beyond-horizon"]).toBe("Pinned point beyond horizon");
    expect(f.service.status().pin?.point).toEqual(antipode);
  });

  it("refuses a pin at the eye, and any pin without a pose", () => {
    const f = fixture();
    pin(f, f.eye());
    f.prefer({ mouse: { zoom: "pinned" } });
    expect(f.service.acquire(mouse()).zoom?.fallback).toBe("pin-too-near");
    f.setPose(() => null);
    expect(f.service.acquire(mouse()).zoom?.fallback).toBe("pin-invalid");
  });

  it("makes the compass target every gesture's anchor while tracking", () => {
    const f = fixture();
    pin(f, geodeticToEcef(44.001 * DEG_TO_RAD, -93 * DEG_TO_RAD, 0));
    f.setTracking(true);
    f.prefer({ mouse: { zoom: "pinned" } });
    const { zoom, orbit } = f.service.acquire(mouse());
    expect(zoom).toMatchObject({ requested: "pinned", source: "target", point: null, fallback: "tracking" });
    expect(orbit).toMatchObject({ requested: "target", source: "target", point: null, fallback: "tracking" });
    expect(f.raycast).toHaveBeenCalledTimes(1); // only the pin's own pick
    expect(f.service.status().tracking).toBe(true);
  });
});

describe("candidate, held and released anchors", () => {
  it("shows and reports a candidate's anchors only once it is held", () => {
    const f = fixture();
    const acquisition = f.service.acquire(mouse({ candidate: true }));
    expect(acquisition.zoom?.source).toBe("ellipsoid");
    expect(f.service.status().last.mouse).toEqual({});
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([]);
    f.service.hold(acquisition);
    expect(f.service.status().last.mouse).toEqual({ zoom: acquisition.zoom, orbit: acquisition.orbit });
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([{ point: acquisition.zoom!.point, zoom: true, orbit: false, grab: false, pinned: false, held: false, zoomHeld: true }]);
    f.service.release(acquisition);
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([]);
    expect(f.service.status().last.mouse.zoom).toBe(acquisition.zoom);
    f.service.release(acquisition);
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it("reports but does not hold a gesture that does not ask to", () => {
    const f = fixture();
    const acquisition = f.service.acquire({ family: "trackpad", operations: ["zoom"], client: CENTRE });
    expect(f.service.status().last.trackpad).toEqual({ zoom: acquisition.zoom });
    expect(f.service.status().last.mouse).toEqual({});
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([]);
    expect(f.service.markerPoints({ orbit: null, zoom: acquisition.zoom!, zoomHeld: true })).toEqual([{ point: acquisition.zoom!.point, zoom: true, orbit: false, grab: false, pinned: false, held: false, zoomHeld: true }]);
    expect(f.service.markerPoints({ orbit: null, zoom: acquisition.zoom! })).toEqual([{ point: acquisition.zoom!.point, zoom: true, orbit: false, grab: false, pinned: false, held: false, zoomHeld: false }]);
  });

  it("holds an acquisition that asks to, and holds no compass target", () => {
    const f = fixture();
    const acquisition = f.service.acquire(mouse({ hold: true }));
    expect(acquisition.orbit).toMatchObject({ source: "target", point: null });
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([{ point: acquisition.zoom!.point, zoom: true, orbit: false, grab: false, pinned: false, held: false, zoomHeld: true }]);
    f.prefer({ mouse: { zoom: "target" } });
    f.service.release(acquisition);
    f.service.acquire(mouse({ hold: true }));
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([]);
  });

  it("returns a copy of the last acquisitions from status", () => {
    const f = fixture();
    f.service.acquire(mouse());
    const status = f.service.status();
    f.service.acquire(mouse({ operations: ["zoom"], client: null }));
    expect(status.last.mouse.zoom?.source).toBe("ellipsoid");
    expect(f.service.status().last.mouse.zoom?.fallback).toBe("no-pointer");
    expect(f.service.status().last.mouse.orbit?.source).toBe("target");
  });
});

describe("retire and reset", () => {
  it("makes anchors acquired before retire stale, keeping Pick point armed and the pin", () => {
    const f = fixture();
    const point = geodeticToEcef(44.001 * DEG_TO_RAD, -93 * DEG_TO_RAD, 0);
    pin(f, point);
    const before = f.service.acquire(mouse({ hold: true }));
    expect(f.service.isCurrent(before.zoom!)).toBe(true);
    f.service.armPick();
    f.changed.mockClear();
    f.service.retire();
    expect(f.service.isCurrent(before.zoom!)).toBe(false);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.service.status()).toMatchObject({ selection: "armed" });
    expect(f.service.status().pin?.point).toEqual(point);
    expect(f.service.markerPoints({ orbit: before.orbit!, zoom: before.zoom! })).toEqual([{ point, zoom: false, orbit: false, grab: false, pinned: true, held: false, zoomHeld: false }]);
    const after = f.service.acquire(mouse());
    expect(f.service.isCurrent(after.zoom!)).toBe(true);
    f.changed.mockClear();
    f.service.retire();
    expect(f.changed).not.toHaveBeenCalled();
  });

  it("does not hold a stale acquisition", () => {
    const f = fixture();
    const before = f.service.acquire(mouse({ candidate: true }));
    f.service.retire();
    f.service.hold(before);
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([]);
  });

  it("cancels Pick point on reset, keeps the pin, and says so", () => {
    const f = fixture();
    const point = geodeticToEcef(44.001 * DEG_TO_RAD, -93 * DEG_TO_RAD, 0);
    pin(f, point);
    const before = f.service.acquire(mouse({ hold: true }));
    f.service.armPick();
    const listener = vi.fn();
    f.service.subscribe(listener);
    f.changed.mockClear();
    f.service.reset();
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.service.isCurrent(before.zoom!)).toBe(false);
    expect(f.service.status().selection).toBe("off");
    expect(f.service.selection.armed()).toBe(false);
    expect(f.service.status().pin?.point).toEqual(point);
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([{ point, zoom: false, orbit: false, grab: false, pinned: true, held: false, zoomHeld: false }]);
  });
});

describe("Pick point and the pin", () => {
  it("arms, pins the surface point under a click, and disarms", () => {
    const f = fixture();
    expect(f.service.selection.armed()).toBe(false);
    expect(f.service.selection.pickAt(CENTRE)).toBe(false);
    expect(f.service.armPick()).toBe(true);
    expect(f.service.status().selection).toBe("armed");
    expect(f.service.selection.armed()).toBe(true);
    const point = geodeticToEcef(36.1 * DEG_TO_RAD, -112.14 * DEG_TO_RAD, 812);
    f.setHit(hitAt(point, 21));
    expect(f.service.selection.pickAt(CENTRE)).toBe(true);
    const pinned = f.service.status().pin!;
    expect(pinned).toMatchObject({ point, source: "surface", surfaceRevision: 21 });
    expect(pinned.latDeg).toBeCloseTo(36.1, 9);
    expect(pinned.lonDeg).toBeCloseTo(-112.14, 9);
    expect(pinned.heightMeters).toBeCloseTo(812, 3);
    expect(Object.isFrozen(pinned) && Object.isFrozen(pinned.point)).toBe(true);
    expect(f.service.status().selection).toBe("off");
    expect(f.service.selection.armed()).toBe(false);
  });

  it("pins the ellipsoid point when no surface is there", () => {
    const f = fixture();
    f.service.armPick();
    expect(f.service.selection.pickAt(CENTRE)).toBe(true);
    expect(f.service.status().pin).toMatchObject({ source: "ellipsoid", surfaceRevision: null });
    expect(f.service.status().pin!.heightMeters).toBeCloseTo(0, 3);
  });

  it("stays armed, as missed, when neither surface nor ellipsoid is there", () => {
    const f = fixture(true);
    f.service.armPick();
    f.changed.mockClear();
    expect(f.service.selection.pickAt(SKY)).toBe(false);
    expect(f.service.status()).toMatchObject({ selection: "missed", pin: null });
    expect(f.service.selection.armed()).toBe(true);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.service.selection.pickAt(CENTRE)).toBe(true);
    expect(f.service.status().selection).toBe("off");
  });

  it("toggles Pick point, from armed or missed", () => {
    const f = fixture(true);
    expect(f.service.togglePick()).toBe(true);
    expect(f.service.status().selection).toBe("armed");
    expect(f.service.togglePick()).toBe(false);
    expect(f.service.status().selection).toBe("off");
    f.service.togglePick();
    f.service.selection.pickAt(SKY);
    expect(f.service.togglePick()).toBe(false);
    expect(f.service.status().selection).toBe("off");
  });

  it("notifies once per change, not when arming what is armed or cancelling what is off", () => {
    const f = fixture();
    f.service.armPick(); f.service.armPick();
    expect(f.changed).toHaveBeenCalledTimes(1);
    f.service.cancelPick(); f.service.cancelPick(); f.service.selection.cancel();
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it("pins the compass target as it is, disarming Pick point", () => {
    const f = fixture();
    f.service.armPick();
    expect(f.service.pinTarget()).toBe(true);
    const pinned = f.service.status().pin!;
    expect(pinned).toMatchObject({ point: f.centre(), source: "target", surfaceRevision: null });
    expect(pinned.latDeg).toBeCloseTo(44, 6);
    expect(pinned.lonDeg).toBeCloseTo(-93, 6);
    expect(f.service.status().selection).toBe("off");
    f.controller.applyViewState({ ...DOWN, lonDeg: -92 });
    expect(f.service.status().pin!.point).toEqual(pinned.point);
  });

  it("refuses to arm or pin while pinning is blocked, and cancels a pick that becomes blocked", () => {
    const f = fixture();
    f.service.armPick();
    f.block("A panorama holds navigation.");
    f.setHit(hitAt(geodeticToEcef(44 * DEG_TO_RAD, -93 * DEG_TO_RAD, 0)));
    expect(f.service.selection.pickAt(CENTRE)).toBe(false);
    expect(f.service.status()).toMatchObject({ selection: "off", pin: null, pinningBlocked: "A panorama holds navigation." });
    expect(f.service.armPick()).toBe(false);
    expect(f.service.togglePick()).toBe(false);
    expect(f.service.pinTarget()).toBe(false);
    expect(f.service.status()).toMatchObject({ selection: "off", pin: null });
  });

  it("clears the pin, and lets a blocked runtime clear it too", () => {
    const f = fixture();
    f.service.pinTarget();
    f.block("Navigation is leased.");
    f.changed.mockClear();
    f.service.clearPin();
    expect(f.service.status().pin).toBeNull();
    expect(f.changed).toHaveBeenCalledTimes(1);
    f.service.clearPin();
    expect(f.changed).toHaveBeenCalledTimes(1);
  });
});

describe("marker points", () => {
  it("marks a zoom about the pin as one marker at the pin", () => {
    const f = fixture();
    const point = geodeticToEcef(44.001 * DEG_TO_RAD, -93 * DEG_TO_RAD, 0);
    pin(f, point);
    f.prefer({ mouse: { zoom: "pinned" } });
    f.service.acquire(mouse({ hold: true }));
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([{ point, zoom: true, orbit: false, grab: false, pinned: true, held: false, zoomHeld: true }]);
  });

  it("shows separate points, gliding ones, and the pin apart from them", () => {
    const f = fixture();
    const pinPoint = geodeticToEcef(44.002 * DEG_TO_RAD, -93 * DEG_TO_RAD, 0);
    pin(f, pinPoint);
    const held: AnchorAcquisition = f.service.acquire(mouse({ hold: true }));
    const gliding = f.service.acquire({ family: "trackpad", operations: ["zoom"], client: { x: 100, y: 500 } });
    const points = f.service.markerPoints({ orbit: held.orbit!, zoom: gliding.zoom! });
    expect(points).toEqual([
      { point: held.zoom!.point, zoom: true, orbit: false, grab: false, pinned: false, held: false, zoomHeld: true },
      { point: gliding.zoom!.point, zoom: true, orbit: false, grab: false, pinned: false, held: false, zoomHeld: false },
      { point: pinPoint, zoom: false, orbit: false, grab: false, pinned: true, held: false, zoomHeld: false },
    ]);
  });

  it("marks a grabbed point, and merges it with the pin when they are the same place", () => {
    const f = fixture();
    const point = geodeticToEcef(44.003 * DEG_TO_RAD, -93.01 * DEG_TO_RAD, 0);
    pin(f, point);
    const elsewhere = geodeticToEcef(44.01 * DEG_TO_RAD, -93.02 * DEG_TO_RAD, 0);
    expect(f.service.markerPoints({ orbit: null, zoom: null, pan: elsewhere })).toEqual([
      { point: elsewhere, zoom: false, orbit: false, grab: true, pinned: false, held: false, zoomHeld: false },
      { point, zoom: false, orbit: false, grab: false, pinned: true, held: false, zoomHeld: false },
    ]);
    expect(f.service.markerPoints({ orbit: null, zoom: null, pan: elsewhere, panHeld: true })).toEqual([
      { point: elsewhere, zoom: false, orbit: false, grab: true, pinned: false, held: true, zoomHeld: false },
      { point, zoom: false, orbit: false, grab: false, pinned: true, held: false, zoomHeld: false },
    ]);
    expect(f.service.markerPoints({ orbit: null, zoom: null, pan: point })).toEqual([
      { point, zoom: false, orbit: false, grab: true, pinned: true, held: false, zoomHeld: false },
    ]);
    expect(f.service.markerPoints(NO_GLIDE)).toEqual([{ point, zoom: false, orbit: false, grab: false, pinned: true, held: false, zoomHeld: false }]);
  });
});

describe("disposal", () => {
  it("says it is gone once, then stops notifying and acquiring", () => {
    const f = fixture();
    f.service.pinTarget();
    f.service.armPick();
    const listener = vi.fn();
    const unsubscribe = f.service.subscribe(listener);
    f.changed.mockClear();
    f.service.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.service.status()).toMatchObject({ pin: null, selection: "off" });
    f.service.refresh();
    expect(f.service.armPick()).toBe(false);
    expect(f.service.pinTarget()).toBe(false);
    expect(f.service.selection.pickAt(CENTRE)).toBe(false);
    expect(f.service.acquire(mouse())).toEqual({});
    f.service.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.service.subscribe(listener)).toBeTypeOf("function");
    unsubscribe();
  });

  it("stops notifying an unsubscribed listener", () => {
    const f = fixture();
    const listener = vi.fn();
    const unsubscribe = f.service.subscribe(listener);
    f.service.refresh();
    unsubscribe();
    f.service.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(2);
  });
});
