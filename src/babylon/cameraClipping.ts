import { GeospatialClippingBehavior, type GeospatialCamera } from "@babylonjs/core";
import type { NumberRange, SettingsRegistry } from "@foss-earth/ui/settings";
/** The camera consumes renderer's public clipping settings without owning their catalogue or backend. */
export function createCameraClipping(camera: GeospatialCamera, settings: Pick<SettingsRegistry, "get">) {
  let behavior: GeospatialClippingBehavior | null = null;
  return {
    apply() {
      if (settings.get("renderer.clipping") === "fixed") {
        if (behavior) camera.removeBehavior(behavior);
        behavior = null;
        const value = settings.get("renderer.clipping.fixed") as NumberRange | undefined;
        if (value && typeof value.min === "number" && typeof value.max === "number") { camera.minZ = value.min; camera.maxZ = value.max; }
      } else if (!behavior) { behavior = new GeospatialClippingBehavior(); camera.addBehavior(behavior); }
    },
    dispose() { const retiring = behavior; behavior = null; if (retiring) camera.removeBehavior(retiring); },
  };
}
