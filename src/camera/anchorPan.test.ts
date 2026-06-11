import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import {
  intersectRayWgs84Ellipsoid,
  rotationFromTo,
} from "./anchorPan";
import { geodeticToEcef, DEG_TO_RAD } from "./cameraMath";

describe("anchorPan", () => {
  it("intersects a ray aimed at the Minneapolis area on the WGS84 ellipsoid", () => {
    const target = geodeticToEcef(44.977753 * DEG_TO_RAD, -93.265011 * DEG_TO_RAD, 0);
    const surface = new Vector3(target.x, target.y, target.z);
    const origin = surface.clone().add(new Vector3(0, 0, 600));
    const direction = surface.clone().subtract(origin).normalize();

    const hit = intersectRayWgs84Ellipsoid(origin, direction);
    expect(hit).not.toBeNull();
    expect(hit!.subtract(surface).length()).toBeLessThan(5);
  });

  it("returns null for rays that miss the ellipsoid", () => {
    const origin = new Vector3(0, 0, 20_000_000);
    const direction = new Vector3(0, 0, 1);
    expect(intersectRayWgs84Ellipsoid(origin, direction)).toBeNull();
  });

  it("builds a rotation between two surface points", () => {
    const a = new Vector3(1, 0, 0);
    const b = new Vector3(0, 1, 0);
    const rotation = rotationFromTo(a, b);
    expect(rotation).not.toBeNull();
    expect(rotation!.angleRad).toBeCloseTo(Math.PI / 2, 5);
  });

  it("returns a modest angle for separated surface points", () => {
    const a = geodeticToEcef(44.977753 * DEG_TO_RAD, -93.265011 * DEG_TO_RAD, 0);
    const b = geodeticToEcef(45.077753 * DEG_TO_RAD, -93.265011 * DEG_TO_RAD, 0);
    const rotation = rotationFromTo(
      new Vector3(a.x, a.y, a.z),
      new Vector3(b.x, b.y, b.z),
    );
    expect(rotation).not.toBeNull();
    expect(rotation!.angleRad).toBeGreaterThan(0.001);
    expect(rotation!.angleRad).toBeLessThan(0.003);
  });
});
