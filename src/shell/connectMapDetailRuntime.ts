import type { BabylonRuntimeStatus } from "../engine/babylon/createBabylonRuntime";
import type { RasterDetailFeedback } from "../engine/babylon/createRasterTilesRuntime";
import { GOOGLE_DETAIL_KEY, rasterDetailKey } from "../terrain/mapDetailPolicy";
import type { MapDetailController } from "./mapDetailController";

/** The part of the Babylon runtime the detail controller drives. */
export interface MapDetailRuntime {
  readonly status: Pick<BabylonRuntimeStatus, "mode" | "rasterBaseMap">;
  readonly renderer: { mode: string };
  getGoogleTerrainDetailState(): { defaultErrorTarget: number; loadedErrorTarget?: number | null } | null;
  setGoogleTerrainDetailTarget(errorTarget: number | null): void;
  setRasterDetailTarget(offset: number): void;
  getRasterDetailFeedback(): RasterDetailFeedback | null;
  subscribeStatus(listener: (status: BabylonRuntimeStatus) => void): () => void;
  onRasterDetailFeedback(listener: () => void): () => void;
  onGoogleDetailFeedback?(listener: () => void): () => void;
  isStreamingTiles(): boolean;
  onTilesStreamingChange(listener: (streaming: boolean) => void): () => void;
}

/**
 * Makes the controller the one writer of the renderer's detail target: it
 * follows the active map source, and applies the controller's target, with any
 * consumer requirement composed in, whenever either changes. Returns a
 * function that disconnects both directions.
 */
export function connectMapDetailRuntime(controller: MapDetailController, runtime: MapDetailRuntime): () => void {
  let appliedGoogle: number | null = null;
  let appliedRaster: number | null = null;
  let rasterKey: string | null = null;
  const reportGoogleDelivery = (): void => {
    if (runtime.status.mode !== "google-tiles") return;
    const streaming = runtime.isStreamingTiles();
    controller.reportDelivery(GOOGLE_DETAIL_KEY, {
      pending: streaming,
      limits: streaming ? ["loading"] : [],
      loadedTarget: runtime.getGoogleTerrainDetailState()?.loadedErrorTarget ?? null,
    });
  };

  const sync = (): void => {
    const { mode, rasterBaseMap } = runtime.status;
    const nextRasterKey = mode === "raster-basemap" && rasterBaseMap ? rasterDetailKey(rasterBaseMap.id) : null;
    if (nextRasterKey !== rasterKey) {
      // Source/runtime replacements must receive the target even if unchanged.
      appliedRaster = null;
      rasterKey = nextRasterKey;
    }
    const google = runtime.getGoogleTerrainDetailState();
    controller.setRecommendationContext({
      rendererMode: runtime.renderer.mode,
      rendererDefaultErrorPx: google?.defaultErrorTarget ?? null,
    });
    if (mode === "google-tiles") {
      controller.setActiveSource({ key: GOOGLE_DETAIL_KEY, availability: google ? "ready" : "initializing" });
      reportGoogleDelivery();
      return;
    }
    // A later return to Google must apply its target to the new tiles runtime.
    appliedGoogle = null;
    if (mode === "raster-basemap" && rasterBaseMap) {
      const key = rasterDetailKey(rasterBaseMap.id);
      let feedback = runtime.getRasterDetailFeedback();
      controller.setActiveSource({
        key,
        availability: feedback?.support === "ready" ? "ready" : "unavailable",
        reason: feedback?.reason,
      });
      // Activating the source applies its target synchronously. Keep any newer
      // feedback that setter emitted, rather than restoring the previous target.
      feedback = runtime.getRasterDetailFeedback();
      controller.reportDelivery(key, feedback && {
        pending: feedback.pending,
        limits: feedback.limits,
        activeTarget: feedback.activeTarget,
        loadedTarget: feedback.loadedTarget,
        effectiveTarget: feedback.effectiveTarget,
        constraints: feedback.constraints,
      });
      return;
    }
    controller.setActiveSource(null);
  };

  const apply = (): void => {
    const target = controller.getRuntimeTarget();
    if (!target) return;
    if (target.kind === "google" && runtime.status.mode === "google-tiles") {
      if (appliedGoogle === target.value) return;
      appliedGoogle = target.value;
      runtime.setGoogleTerrainDetailTarget(target.value);
    } else if (target.kind === "raster" && runtime.status.mode === "raster-basemap") {
      if (appliedRaster === target.value) return;
      appliedRaster = target.value;
      runtime.setRasterDetailTarget(target.value);
    }
  };

  const unsubscribeController = controller.subscribe(apply);
  const unsubscribeStatus = runtime.subscribeStatus(() => { sync(); apply(); });
  const unsubscribeRaster = runtime.onRasterDetailFeedback(() => { sync(); apply(); });
  const unsubscribeGoogle = runtime.onGoogleDetailFeedback?.(reportGoogleDelivery);
  const unsubscribeStreaming = runtime.onTilesStreamingChange(() => sync());
  sync();
  apply();
  return () => {
    unsubscribeController();
    unsubscribeStatus();
    unsubscribeRaster();
    unsubscribeGoogle?.();
    unsubscribeStreaming();
  };
}
