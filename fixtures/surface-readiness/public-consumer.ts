import type { CurrentSurfaceObservation, CurrentSurfaceReadiness, SurfaceLocality } from "@foss-earth/engine/core";
import type { GlobeRuntime } from "@foss-earth/engine/babylon";

/** Compile against a newly sealed package, never a website/private/deep import. */
export function observeCurrentGround(runtime: GlobeRuntime, locality: SurfaceLocality,
  accept: (snapshot: CurrentSurfaceReadiness) => void): { observation: CurrentSurfaceObservation; dispose(): void } {
  const observation = runtime.displayedSurface.observe(locality);
  const unsubscribe = observation.subscribe(accept);
  return { observation, dispose() { unsubscribe(); observation.dispose(); } };
}

export function currentDisplayedHeight(observation: CurrentSurfaceObservation, snapshot: CurrentSurfaceReadiness): number | null {
  if (!observation.isCurrent(snapshot) || snapshot.state !== "ready") return null;
  const center = snapshot.samples[0];
  return center?.status === "hit" && center.height.physicalDatum === "unknown" ? center.height.meters : null;
}
