/** Host composition fixture: all world behavior remains engine-owned. */
import type { ViewerNavigationSnapshot, ViewerWorldMath } from "@foss-earth/sphere-image/core";
import { glideSettling, levelUp, orbitAngles, orbitLook, pointGeodetic, type NavigationSnapshot } from "@foss-earth/engine";

/** Inject this value into the viewer; no viewer runtime import or second clock. */
export const viewerWorldMath = {
  glideSettling,
  levelUp,
  orbitAngles,
  orbitLook,
  pointGeodetic,
} satisfies ViewerWorldMath;

/** The immutable E0 snapshot already matches the viewer's structural port. */
export function viewerNavigationSnapshot(snapshot: NavigationSnapshot): ViewerNavigationSnapshot {
  return snapshot;
}

/** Capture ENU is distinct from image attitude. The host must provide its frame. */
import type { ViewerImageInput, ViewerNavigationPresentation, ViewerPosePorts } from "@foss-earth/sphere-image/core";
import { enuFrame, presentationFromView, viewFromPresentation, type GeoView } from "@foss-earth/engine";

function frameFor(input: ViewerImageInput) {
  const capture = input.details?.capture;
  if (!capture) throw new Error("The host must supply the capture ENU frame for geographic viewer navigation.");
  return enuFrame(capture.longitudeDeg, capture.latitudeDeg);
}
/** Inject these methods as the viewer's separate pose ports. */
export const viewerPosePorts = {
  viewFromPresentation(input: ViewerImageInput, presentation: ViewerNavigationPresentation): GeoView {
    return viewFromPresentation(frameFor(input), presentation);
  },
  presentationFromView(input: ViewerImageInput, view: GeoView): ViewerNavigationPresentation {
    if (!input.placement.marker) throw new Error("The host has no resolved viewer marker.");
    return presentationFromView(frameFor(input), input.placement.marker, view);
  },
} satisfies ViewerPosePorts;
