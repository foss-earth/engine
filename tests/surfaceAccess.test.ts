import { describe, expect, it, vi } from "vitest";
import { createDisplayedSurfaceAccess, type SurfaceReadiness } from "../src/surface/access.js";
import type { SurfaceHit } from "../src/surface/contracts.js";

const hit: SurfaceHit = { point: { x: 6378137, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 },
  distanceMeters: 10, heightMeters: 200, meshId: "visible-map", revision: 3, quality: 15 };

describe("displayed surface access", () => {
  it("declares geometry coordinate height without inventing physical datum correction", () => {
    const query = { sample: () => hit, raycast: () => hit };
    const access = createDisplayedSurfaceAccess(query, { readiness: () => ({ state: "ready", revision: 3 }) });
    expect(access.sample(44, -93)).toMatchObject({ status: "hit", height: {
      kind: "displayed-geometry", datum: "wgs84-ellipsoid-coordinate", meters: 200, physicalDatum: "unknown" } });
  });
  it("reports invalid input, unavailable geometry and a real miss distinctly", () => {
    const sample = vi.fn(() => null);
    let state: SurfaceReadiness = { state: "unavailable", revision: 3 };
    const access = createDisplayedSurfaceAccess({ sample, raycast: sample }, { readiness: () => state });
    expect(access.sample(91, 0)).toMatchObject({ status: "missing", reason: "invalid-input" });
    expect(access.sample(44, -93)).toMatchObject({ status: "missing", reason: "geometry-unavailable" });
    expect(sample).not.toHaveBeenCalled();
    state = { state: "loading", revision: 3 };
    expect(access.sample(44, -93)).toMatchObject({ status: "missing", reason: "no-displayed-hit", readiness: { state: "loading" } });
  });
  it("retains drawable outgoing geometry during loading and rejects a changed revision", () => {
    let state: SurfaceReadiness = { state: "loading", revision: 3 };
    const access = createDisplayedSurfaceAccess({ sample: () => hit, raycast: () => hit }, { readiness: () => state });
    expect(access.sample(44, -93)).toMatchObject({ status: "hit", readiness: { state: "loading" } });
    state = { state: "ready", revision: 4 };
    expect(access.sample(44, -93)).toMatchObject({ status: "missing", reason: "stale-revision" });
  });
  it("rejects a hit if the host declares the displayed geometry unavailable during the query", () => {
    let state: SurfaceReadiness = { state: "ready", revision: 3 };
    const sample = () => { state = { state: "failed", revision: 3 }; return hit; };
    const access = createDisplayedSurfaceAccess({ sample, raycast: sample }, { readiness: () => state });
    expect(access.sample(44, -93)).toMatchObject({ status: "missing", reason: "geometry-unavailable", readiness: { state: "failed" } });
  });

});
