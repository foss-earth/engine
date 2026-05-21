export interface GlobeViewState {
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
  pitchDeg: number;
  zoomMeters: number;
}

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

export interface GlobeHandle {
  addLayer(layer: GlobeLayer): void;
  removeLayer(layerId: string): void;
  destroy(): void;
  /** Return the current camera state. Returns null in fallback mode. */
  getViewState(): GlobeViewState | null;
  /**
   * Merge partial overrides into the current camera state.
   * No-op in fallback mode.
   */
  setViewState(partial: Partial<GlobeViewState>): void;
  /** Current UI theme. Default: "dark". */
  getTheme(): GlobeTheme;
  /** Set the UI theme and persist it. Notifies all subscribers. */
  setTheme(theme: GlobeTheme): void;
  /**
   * Subscribe to theme changes (including those originating from other tabs).
   * Returns an unsubscribe function.
   */
  onThemeChange(cb: (theme: GlobeTheme) => void): () => void;
}

export type GlobeTheme = "light" | "dark";
