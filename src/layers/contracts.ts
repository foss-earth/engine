export interface GlobeLayerContext {
  scene: unknown;
  engine: unknown;
}

export interface GlobeLayerState {
  poiEntities?: unknown[];
  getPoiOrbitTarget?: () => unknown | null;
  cullables?: unknown[];
  anchorHeightSamples?: unknown[];
}

export interface GlobeLayer {
  id: string;
  setup(context: GlobeLayerContext): GlobeLayerState;
  destroy(context: GlobeLayerContext): void;
}

