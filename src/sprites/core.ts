export const DEFAULT_POI_HEIGHT_REFINEMENT_MAX_ZOOM_M = 120_000;
export const DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_UP_M = 20_000;
export const DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_DOWN_M = 40_000;

/** Actual source costs, read from named host settings when composing point layers. */
export interface PoiRefinementPolicy {
  maxZoomMeters: number;
  probeUpMeters: number;
  probeDownMeters: number;
  lodDistancesMeters: readonly [number, number, number];
  lodLevels: readonly [number, number, number, number];
  tileRadiusDistancesMeters: readonly [number, number];
  tileRadii: readonly [number, number, number];
}
export const DEFAULT_POI_REFINEMENT_POLICY: PoiRefinementPolicy = {
  maxZoomMeters: DEFAULT_POI_HEIGHT_REFINEMENT_MAX_ZOOM_M,
  probeUpMeters: DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_UP_M,
  probeDownMeters: DEFAULT_POI_HEIGHT_REFINEMENT_PROBE_DOWN_M,
  lodDistancesMeters: [5_000, 20_000, 60_000], lodLevels: [17, 16, 15, 14],
  tileRadiusDistancesMeters: [10_000, 45_000], tileRadii: [1, 2, 3],
};
/** Reads only explicit named host values; it does not construct/register settings. */
export function poiRefinementPolicyFromSettings(get: (id: string) => number): PoiRefinementPolicy {
  return {
    maxZoomMeters: get("visualization.poiRefinement.maxZoom"), probeUpMeters: get("visualization.poiRefinement.probeUp"), probeDownMeters: get("visualization.poiRefinement.probeDown"),
    lodDistancesMeters: [0,1,2].map(n => get(`visualization.poiRefinement.lodDistance${n}`)) as [number,number,number],
    lodLevels: [0,1,2,3].map(n => get(`visualization.poiRefinement.lod${n}`)) as [number,number,number,number],
    tileRadiusDistancesMeters: [0,1].map(n => get(`visualization.poiRefinement.radiusDistance${n}`)) as [number,number],
    tileRadii: [0,1,2].map(n => get(`visualization.poiRefinement.tileRadius${n}`)) as [number,number,number],
  };
}

export function poiRefinementLod(
  zoomMeters: number,
  maxZoomOrPolicy: number | PoiRefinementPolicy = DEFAULT_POI_REFINEMENT_POLICY,
): number | null {
  const policy = typeof maxZoomOrPolicy === "number" ? DEFAULT_POI_REFINEMENT_POLICY : maxZoomOrPolicy;
  const maximum = typeof maxZoomOrPolicy === "number" ? maxZoomOrPolicy : policy.maxZoomMeters;
  if (zoomMeters > maximum) return null;
  for (let n = 0; n < policy.lodDistancesMeters.length; n++) if (zoomMeters <= policy.lodDistancesMeters[n]) return policy.lodLevels[n];
  return policy.lodLevels[3];
}

export function poiRefinementTileRadius(zoomMeters: number, policy: PoiRefinementPolicy = DEFAULT_POI_REFINEMENT_POLICY): number {
  for (let n = 0; n < policy.tileRadiusDistancesMeters.length; n++) if (zoomMeters <= policy.tileRadiusDistancesMeters[n]) return policy.tileRadii[n];
  return policy.tileRadii[2];
}

/** The original size curve without a camera/backend dependency. */
export function spriteSizeForDistance(distanceMeters: number, maxSize: number, minSize: number, minRefZoomMeters: number, maxRefZoomMeters: number): number {
  const range = maxRefZoomMeters - minRefZoomMeters;
  const t = range > 0 ? Math.min(1, Math.max(0, (Math.max(0, distanceMeters) - minRefZoomMeters) / range)) : 1;
  return minSize + t * (maxSize - minSize);
}

export function lonLatToTile(
  latDeg: number,
  lonDeg: number,
  zoom: number,
): { x: number; y: number; key: string } {
  const latRad = Math.max(-85.05112878, Math.min(85.05112878, latDeg)) * Math.PI / 180;
  const n = 2 ** zoom;
  const x = Math.max(0, Math.min(n - 1, Math.floor(((lonDeg + 180) / 360) * n)));
  const y = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    ),
  );
  return { x, y, key: `${zoom}/${x}/${y}` };
}

export function wrapTileX(x: number, zoom: number): number {
  const n = 2 ** zoom;
  return ((x % n) + n) % n;
}

export function makeTileKey(zoom: number, x: number, y: number): string | null {
  const n = 2 ** zoom;
  if (y < 0 || y >= n) return null;
  return `${zoom}/${wrapTileX(x, zoom)}/${y}`;
}

export function buildPoiTileIndex<T extends { lat: number; lng: number }>(
  points: Iterable<T>,
  zoom: number,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const point of points) {
    const tile = lonLatToTile(point.lat, point.lng, zoom);
    const bucket = index.get(tile.key);
    if (bucket) bucket.push(point);
    else index.set(tile.key, [point]);
  }
  return index;
}

export function distanceScoreMetersSq(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const latScale = 111_320;
  const lngScale = latScale * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  const dy = (aLat - bLat) * latScale;
  const dx = (aLng - bLng) * lngScale;
  return dx * dx + dy * dy;
}
