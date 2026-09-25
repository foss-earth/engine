export type RasterBaseMapProtocol = "xyz" | "arcgis-tile";

/** Photographic imagery, or a cartographic map with baked labels, contours or symbols. */
export type RasterImageryKind = "photographic" | "cartographic";

/**
 * A reviewed image variant at the same zoom: the same extent and content at a
 * higher pixel density, such as a provider's documented retina tiles. None is
 * ever inferred from a URL pattern, and a returned image of another size is
 * rejected.
 */
export interface RasterImageVariant {
  /** Stable id used in cache keys, e.g. "2x". */
  id: string;
  width: number;
  height: number;
  urlTemplate: string;
  /** The variant shows the standard tile's extent and cartographic content. */
  preservesContent: true;
}

/** Endpoint rules the imagery scheduler follows. */
export interface RasterRequestPolicy {
  /** Most concurrent requests to this endpoint; the resource profile may allow fewer. */
  maxConcurrent?: number;
  /** False where the provider's policy forbids prefetching beyond the view. */
  prefetch: boolean;
}

export interface RasterBaseMapSource {
  id: string;
  label: string;
  provider: string;
  protocol: RasterBaseMapProtocol;
  urlTemplate: string;
  attribution: string;
  /** Photographic or cartographic; see RasterImageryKind. Cartographic when omitted. */
  kind?: RasterImageryKind;
  /** Changes when the provider's content or URL scheme changes; caches and missing-tile records key on it. */
  version?: string;
  /** Standard tile pixels; 256×256 when omitted. */
  tileSize?: { width: number; height: number };
  /** Reviewed same-zoom variants, least dense first. */
  variants?: readonly RasterImageVariant[];
  requestPolicy?: RasterRequestPolicy;
  minZoom?: number;
  /** The approved request ceiling. Provider metadata never raises it. */
  maxZoom?: number;
  /** Geographic coverage; outside it imagery is not refined. */
  bounds?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}

export const DEFAULT_RASTER_BASE_MAP_ID = "usgs-imagery-topo";

export const RASTER_BASE_MAP_SOURCES: readonly RasterBaseMapSource[] = [
  {
    id: "usgs-imagery",
    label: "USGS Imagery",
    provider: "USGS The National Map",
    protocol: "arcgis-tile",
    urlTemplate: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    kind: "photographic",
    version: "1",
    tileSize: { width: 256, height: 256 },
    requestPolicy: { prefetch: true },
    attribution: "USGS The National Map",
    minZoom: 0,
    maxZoom: 16,
    bounds: { west: -180, south: -14, east: 180, north: 72 },
  },
  {
    id: "usgs-imagery-topo",
    label: "USGS Imagery Topo",
    provider: "USGS The National Map",
    protocol: "arcgis-tile",
    urlTemplate: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}",
    // Imagery with baked labels and contours reads as a map, so it keeps map scale.
    kind: "cartographic",
    version: "1",
    tileSize: { width: 256, height: 256 },
    requestPolicy: { prefetch: true },
    attribution: "USGS The National Map",
    minZoom: 0,
    maxZoom: 16,
    bounds: { west: -180, south: -14, east: 180, north: 72 },
  },
  {
    id: "usgs-topo",
    label: "USGS Topo",
    provider: "USGS The National Map",
    protocol: "arcgis-tile",
    urlTemplate: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    kind: "cartographic",
    version: "1",
    tileSize: { width: 256, height: 256 },
    requestPolicy: { prefetch: true },
    attribution: "USGS The National Map",
    minZoom: 0,
    maxZoom: 16,
    bounds: { west: -180, south: -14, east: 180, north: 72 },
  },
  {
    id: "osm-standard",
    label: "OpenStreetMap",
    provider: "OpenStreetMap",
    protocol: "xyz",
    urlTemplate: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    kind: "cartographic",
    version: "1",
    tileSize: { width: 256, height: 256 },
    // The OSM tile policy forbids bulk prefetch: visible demand only.
    requestPolicy: { prefetch: false },
    attribution: "OpenStreetMap contributors",
    minZoom: 0,
    maxZoom: 19,
  },
  {
    id: "carto-positron",
    label: "CARTO Positron",
    provider: "CARTO",
    protocol: "xyz",
    urlTemplate: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    kind: "cartographic",
    version: "1",
    tileSize: { width: 256, height: 256 },
    // CARTO documents a double-density "@2x" suffix; 512×512 checked 2026-09-24.
    variants: [{ id: "2x", width: 512, height: 512, urlTemplate: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png", preservesContent: true }],
    requestPolicy: { prefetch: true },
    attribution: "OpenStreetMap contributors, CARTO",
    minZoom: 0,
    maxZoom: 20,
  },
  {
    id: "carto-dark-matter",
    label: "CARTO Dark Matter",
    provider: "CARTO",
    protocol: "xyz",
    urlTemplate: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    kind: "cartographic",
    version: "1",
    tileSize: { width: 256, height: 256 },
    variants: [{ id: "2x", width: 512, height: 512, urlTemplate: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png", preservesContent: true }],
    requestPolicy: { prefetch: true },
    attribution: "OpenStreetMap contributors, CARTO",
    minZoom: 0,
    maxZoom: 20,
  },
  {
    id: "open-topo-map",
    label: "OpenTopoMap",
    provider: "OpenTopoMap",
    protocol: "xyz",
    urlTemplate: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
    kind: "cartographic",
    version: "1",
    tileSize: { width: 256, height: 256 },
    requestPolicy: { prefetch: true },
    attribution: "OpenTopoMap, OpenStreetMap contributors",
    minZoom: 0,
    maxZoom: 17,
  },
];

const RASTER_BASE_MAP_BY_ID = new Map(RASTER_BASE_MAP_SOURCES.map((source) => [source.id, source]));

export function resolveRasterBaseMapSource(source: string | RasterBaseMapSource | null | undefined): RasterBaseMapSource {
  if (source && typeof source !== "string") {
    return source;
  }

  const sourceId = typeof source === "string" ? source : "";
  return RASTER_BASE_MAP_BY_ID.get(sourceId)
    ?? RASTER_BASE_MAP_BY_ID.get(DEFAULT_RASTER_BASE_MAP_ID)
    ?? RASTER_BASE_MAP_SOURCES[0];
}

export function isKnownRasterBaseMapId(value: string | null | undefined): boolean {
  return typeof value === "string" && RASTER_BASE_MAP_BY_ID.has(value);
}