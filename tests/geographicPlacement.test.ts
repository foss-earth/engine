import { describe, expect, it } from "vitest";
import {
  captureRelativeMarker, dot, enuFrame, geodeticPoint,
  groundQueryPoint, pointGeodetic, sub,
} from "../src/camera/geographicFrames.js";

// Original immutable sphereMath placement cases; assertions and bodies retained.
describe("geographic marker placement", () => {
  it("offsets a ground-relative query point east and north on the ellipsoid", () => {
    const capture = { longitudeDeg: -93.235, latitudeDeg: 44.974 };
    const point = groundQueryPoint(capture, 100, 50);
    const frame = enuFrame(capture.longitudeDeg, capture.latitudeDeg);
    const delta = sub(geodeticPoint(point.longitudeDeg, point.latitudeDeg, 0), geodeticPoint(capture.longitudeDeg, capture.latitudeDeg, 0));
    expect(dot(delta, frame.east)).toBeCloseTo(100, 1);
    expect(dot(delta, frame.north)).toBeCloseTo(50, 1);
    expect(groundQueryPoint(capture, 0, 0).latitudeDeg).toBeCloseTo(44.974, 12);
  });

  it("raises a capture-relative marker along the local vertical", () => {
    const capture = { longitudeDeg: 10, latitudeDeg: 50 };
    const marker = captureRelativeMarker(capture, 200, 0, 0, 30);
    expect(pointGeodetic(marker).heightMeters).toBeCloseTo(230, 6);
  });
});
