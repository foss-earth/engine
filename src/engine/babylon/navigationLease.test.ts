import { describe, expect, it } from "vitest";
import { createNavigationOwner, type NavigationHost, type NavigationSnapshot } from "./navigationLease";

const SNAPSHOT: NavigationSnapshot = {
  version: 1,
  view: { latDeg: 44.974, lonDeg: -93.235, headingDeg: 0, pitchDeg: 16.7, zoomMeters: 104.4 },
  camera: { center: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 1.2, radius: 104.4, fov: 1.05 },
};

function host(overrides: Partial<NavigationHost> = {}) {
  const log: string[] = [];
  let continuous = 0;
  const value: NavigationHost = {
    unavailable: () => null,
    snapshot: () => SNAPSHOT,
    suspend: request => log.push(`suspend:${request.inputContext}`),
    resume: () => log.push("resume"),
    present: view => log.push(view ? "present" : "present:none"),
    requestRender: () => log.push("render"),
    beginContinuous: () => { continuous += 1; },
    endContinuous: () => { continuous -= 1; },
    ...overrides,
  };
  return { value, log, continuous: () => continuous };
}

const REQUEST = { owner: "foss-earth.scenes", inputContext: "panorama" };

describe("navigation lease", () => {
  it("has one owner at a time and says who holds it", () => {
    const owner = createNavigationOwner(host().value);
    const first = owner.acquire(REQUEST);
    expect(first.ok).toBe(true);
    const second = owner.acquire({ owner: "other", inputContext: "globe" });
    expect(second).toMatchObject({ ok: false, reason: "busy" });
    expect(!second.ok && second.message).toContain("foss-earth.scenes");
    if (first.ok) first.lease.release("exit");
    expect(owner.acquire(REQUEST).ok).toBe(true);
  });

  it("is refused while the host is unavailable, such as a simulation holding the camera", () => {
    const owner = createNavigationOwner(host({ unavailable: () => "A flight owns the camera." }).value);
    expect(owner.acquire(REQUEST)).toMatchObject({ ok: false, reason: "busy", message: "A flight owns the camera." });
  });

  it("numbers every acquisition and keeps the overview it started from", () => {
    const owner = createNavigationOwner(host().value);
    const a = owner.acquire(REQUEST);
    if (!a.ok) throw new Error("busy");
    expect(a.lease.overview).toBe(SNAPSHOT);
    a.lease.release("exit");
    const b = owner.acquire(REQUEST);
    if (!b.ok) throw new Error("busy");
    expect(b.lease.generation).toBe(a.lease.generation + 1);
  });

  it("suspends on acquisition, resumes once on release, and aborts its signal", () => {
    const h = host();
    const owner = createNavigationOwner(h.value);
    const result = owner.acquire(REQUEST);
    if (!result.ok) throw new Error("busy");
    const { lease } = result;
    lease.setPresentationView({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 }, verticalFovRad: 1 });
    expect(owner.state()).toMatchObject({ presenting: true, inputContext: "panorama" });
    lease.release("exit");
    lease.release("exit");
    expect(lease.signal.aborted).toBe(true);
    expect(h.log.filter(entry => entry === "resume")).toHaveLength(1);
    expect(h.log).toContain("present:none");
    expect(owner.state()).toBeNull();
    lease.setPresentationView({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 }, verticalFovRad: 1 });
    expect(h.log.filter(entry => entry === "present")).toHaveLength(1);
  });

  it("balances rendering holds, released twice or by the lease", () => {
    const h = host();
    const owner = createNavigationOwner(h.value);
    const result = owner.acquire(REQUEST);
    if (!result.ok) throw new Error("busy");
    const one = result.lease.holdRendering();
    result.lease.holdRendering();
    expect(h.continuous()).toBe(2);
    one();
    one();
    expect(h.continuous()).toBe(1);
    result.lease.release("cancelled");
    expect(h.continuous()).toBe(0);
    expect(result.lease.holdRendering()).toBeTypeOf("function");
    expect(h.continuous()).toBe(0);
  });

  it("ends when the caller's signal aborts, and refuses an already aborted request", () => {
    const owner = createNavigationOwner(host().value);
    const controller = new AbortController();
    const result = owner.acquire({ ...REQUEST, signal: controller.signal });
    if (!result.ok) throw new Error("busy");
    controller.abort();
    expect(result.lease.released).toBe(true);
    expect(owner.acquire({ ...REQUEST, signal: controller.signal })).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("ends the lease on device loss and refuses everything once disposed", () => {
    const owner = createNavigationOwner(host().value);
    const states: unknown[] = [];
    owner.subscribe(state => states.push(state));
    const result = owner.acquire(REQUEST);
    if (!result.ok) throw new Error("busy");
    owner.end("device-lost");
    expect(result.lease.released).toBe(true);
    expect(states.at(-1)).toBeNull();
    owner.dispose();
    expect(owner.acquire(REQUEST)).toMatchObject({ ok: false, reason: "disposed" });
  });
});
