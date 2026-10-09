import { describe, expect, it } from "vitest";
import { presentationFromView, viewFromPresentation } from "../src/camera/geographicView.js";
import { enuFrame, geodeticPoint } from "../src/camera/geographicFrames.js";
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

});
