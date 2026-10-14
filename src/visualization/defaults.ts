export interface PoiSpriteSizeParams {
  maxSize: number;
  minSize: number;
  minRefZoom: number;
  maxRefZoom: number;
}

export const DEFAULT_POI_SPRITE_SIZE_PARAMS: PoiSpriteSizeParams = {
  maxSize: 40_000,
  minSize: 200,
  minRefZoom: 100,
  maxRefZoom: 1_000_000,
};


export interface OrbitCompassScaleParams {
  /** Fallback when no distance range is set: radius is this share of camera distance, then clamped. */
  radiusScale: number;
  minRadius: number;
  maxRadius: number;
  /** Camera distance at the smallest radius. With `maxDistance`, the radius runs from `minRadius` to `maxRadius` across this span. */
  minDistance?: number;
  maxDistance?: number;
  labelSizeScale: number;
}

const COMPASS_RADIUS_SCALE = 0.035;
const COMPASS_MIN_RADIUS = 8_000;
const COMPASS_MAX_RADIUS = 240_000;
/** Axis lines fade across the nearer half of the near camera distance. */
const COMPASS_LINE_FADE_BAND = 0.5;

export const DEFAULT_ORBIT_COMPASS_SCALE_PARAMS: OrbitCompassScaleParams = {
  radiusScale: COMPASS_RADIUS_SCALE,
  minRadius: COMPASS_MIN_RADIUS,
  maxRadius: COMPASS_MAX_RADIUS,
  minDistance: COMPASS_MIN_RADIUS / COMPASS_RADIUS_SCALE,
  maxDistance: COMPASS_MAX_RADIUS / COMPASS_RADIUS_SCALE,
  labelSizeScale: 0.16,
};

export const COMPASS_SCALE_SETTING_IDS = [
  "visualization.compass.radius",
  "visualization.compass.distance",
  "visualization.compass.labelSizeScale",
] as const;

function finiteRange(value: unknown): { min: number; max: number } | null {
  if (!value || typeof value !== "object") return null;
  const range = value as { min?: unknown; max?: unknown };
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/** The compass size parameters the settings registry is holding. */
export function orbitCompassScaleFromSettings(get: (id: string) => unknown): OrbitCompassScaleParams {
  const fallback = DEFAULT_ORBIT_COMPASS_SCALE_PARAMS;
  const radius = finiteRange(get("visualization.compass.radius")) ?? { min: fallback.minRadius, max: fallback.maxRadius };
  const distance = finiteRange(get("visualization.compass.distance")) ?? { min: fallback.minDistance ?? radius.min, max: fallback.maxDistance ?? radius.max };
  const label = Number(get("visualization.compass.labelSizeScale"));
  const minRadius = Math.max(1, radius.min);
  const maxRadius = Math.max(minRadius, radius.max);
  const minDistance = Math.max(1, distance.min);
  const maxDistance = Math.max(minDistance, distance.max);
  return {
    radiusScale: minRadius / minDistance,
    minRadius,
    maxRadius,
    minDistance,
    maxDistance,
    labelSizeScale: Number.isFinite(label) && label > 0 ? label : fallback.labelSizeScale,
  };
}

/** Radius on the ground, and the unclamped value the line would have. */
export function compassRadiusMeters(zoomDistance: number, params: OrbitCompassScaleParams): { radius: number; natural: number } {
  const minRadius = Math.max(1, params.minRadius);
  const maxRadius = Math.max(minRadius, params.maxRadius);
  const minDistance = params.minDistance;
  const maxDistance = params.maxDistance;
  let natural: number;
  if (minDistance !== undefined && maxDistance !== undefined) {
    const span = maxDistance - minDistance;
    natural = span > 0 ? minRadius + (zoomDistance - minDistance) * ((maxRadius - minRadius) / span) : minRadius;
  } else {
    natural = zoomDistance * Math.max(0.000001, params.radiusScale);
  }
  return { radius: Math.max(minRadius, Math.min(maxRadius, natural)), natural };
}

/**
 * How solid the ground compass's axis lines are. 0 hides them.
 * Fades with camera distance, so a large minimum radius still disappears up close.
 */
export function compassLineFade(zoomDistance: number, params: OrbitCompassScaleParams): number {
  const minDistance = params.minDistance ?? params.minRadius / Math.max(0.000001, params.radiusScale);
  const fadeStart = minDistance;
  const fadeEnd = fadeStart * (1 - COMPASS_LINE_FADE_BAND);
  if (!(fadeStart > fadeEnd) || !Number.isFinite(zoomDistance)) return 1;
  return Math.max(0, Math.min(1, (zoomDistance - fadeEnd) / (fadeStart - fadeEnd)));
}

/**
 * Letter size in metres. Grows with camera distance, including while the ring
 * radius is clamped, so the letters keep a steady size on screen.
 */
export function compassLabelMeters(zoomDistance: number, params: OrbitCompassScaleParams): number {
  const share = Math.max(0.000001, params.labelSizeScale) * Math.max(0.000001, params.radiusScale);
  const zoom = Number.isFinite(zoomDistance) ? Math.max(0, zoomDistance) : 0;
  return Math.min(5_000_000, Math.max(1, zoom * share));
}


export const DEFAULT_COMPASS_LABEL_TEXTURE_SIZE = 128;
