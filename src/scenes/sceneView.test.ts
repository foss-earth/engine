import { describe, expect, it } from "vitest";
import { angleDifferenceDeg, interpolateView, presentationFromView, snapshotFromOverview, viewFromPresentation } from "./sceneView";
import { enuFrame, geodeticPoint } from "./panoramaMath";

const frame = enuFrame(-93.235, 44.974);
const position = geodeticPoint(-93.235, 44.974, 280);

describe("geographic views", () => {
  it("round-trips heading, pitch, roll and field of view through a presentation", () => {
    for (const view of [
      { headingDeg: 0, pitchDeg: 0, rollDeg: 0, verticalFovDeg: 60 },
      { headingDeg: 123.4, pitchDeg: -31, rollDeg: 12, verticalFovDeg: 45 },
      { headingDeg: 359, pitchDeg: 80, rollDeg: -170, verticalFovDeg: 90 },
    ]) {
      const back = viewFromPresentation(frame, presentationFromView(frame, position, view));
      expect(back.headingDeg).toBeCloseTo(view.headingDeg, 9);
      expect(back.pitchDeg).toBeCloseTo(view.pitchDeg, 9);
      expect(back.rollDeg).toBeCloseTo(view.rollDeg, 9);
      expect(back.verticalFovDeg).toBeCloseTo(view.verticalFovDeg, 9);
    }
  });

  it("looks north along the local north, with up away from the Earth", () => {
    const presentation = presentationFromView(frame, position, { headingDeg: 0, pitchDeg: 0, rollDeg: 0, verticalFovDeg: 60 });
    const f = [presentation.forward.x, presentation.forward.y, presentation.forward.z];
    const u = [presentation.up.x, presentation.up.y, presentation.up.z];
    frame.north.forEach((value, index) => expect(f[index]).toBeCloseTo(value, 12));
    frame.up.forEach((value, index) => expect(u[index]).toBeCloseTo(value, 12));
  });

  it("keeps the last heading at a vertical look", () => {
    const down = presentationFromView(frame, position, { headingDeg: 200, pitchDeg: -90, rollDeg: 0, verticalFovDeg: 60 });
    expect(viewFromPresentation(frame, down, 200).headingDeg).toBeCloseTo(200, 6);
  });

  it("turns the shorter way between headings", () => {
    expect(angleDifferenceDeg(350, 10)).toBe(20);
    expect(angleDifferenceDeg(10, 350)).toBe(-20);
    expect(interpolateView({ headingDeg: 350, pitchDeg: 10, rollDeg: 4, verticalFovDeg: 60 }, { headingDeg: 10, pitchDeg: 0, rollDeg: 0, verticalFovDeg: 60 }, 0.5))
      .toEqual({ headingDeg: 0, pitchDeg: 5, rollDeg: 2, verticalFovDeg: 60 });
  });
});

describe("overview snapshot", () => {
  it("puts the orbit target on the displayed ground and the camera where the record says", () => {
    const snapshot = snapshotFromOverview({
      target: { longitudeDeg: -93.235, latitudeDeg: 44.974, height: null },
      distanceMeters: 104.403, headingDeg: 0, pitchDeg: -16.699244, verticalFovDeg: 60,
    }, 252.5);
    const center = geodeticPoint(-93.235, 44.974, 252.5);
    expect(snapshot.camera.center).toEqual({ x: center[0], y: center[1], z: center[2] });
    expect(snapshot.view.pitchDeg).toBeCloseTo(16.699244);
    expect(snapshot.camera.pitch).toBeCloseTo((Math.PI / 2) * (1 - 16.699244 / 90));
    expect(snapshot.camera.fov).toBeCloseTo(Math.PI / 3);
    const known = snapshotFromOverview({
      target: { longitudeDeg: 0, latitudeDeg: 0, height: { meters: 12, datum: "WGS84-ellipsoid" } },
      distanceMeters: 50, headingDeg: 90, pitchDeg: -45, verticalFovDeg: 50,
    }, 999);
    expect(known.camera.center.x).toBeCloseTo(6378137 + 12, 6);
  });
});
