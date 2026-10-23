import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { createExternalLinkIcon, createTabPresetSave } from "@foss-earth/ui/browser";
import { attachSafariGestures, isSafariGestureSupported } from "../browser/safariGestures.js";
import { createInertialCameraController } from "../input/inertialCameraController.js";
import { DEFAULT_INPUT_RATES } from "../input/inputRates.js";
import type { InputModePreference } from "../input/inputSettings.js";
import { createWheelGestureReader } from "../input/wheelGesture.js";
import { withSourceKey, type RasterBaseMapSource } from "./rasterBaseMaps.js";
import {
  OVERVIEW_PROJECTION_ID,
  OVERVIEW_PROJECTION_MERCATOR,
  OVERVIEW_PROVIDER_CHARTS,
  OVERVIEW_PROVIDER_CURRENT,
  OVERVIEW_PROVIDER_ID,
} from "../settings/catalogue/map.js";

/** Web Mercator metres per pixel at zoom 0 on the equator. */
const WEB_MERCATOR_MPP = 156543.033928;
const EARTH_RADIUS_M = 6378137;
const TILE_PX = 256;
/** The longer side of the panel never asks for more tiles than this. */
const MAX_TILES_ACROSS = 8;
const MAX_CACHED_TILES = 96;
const MAX_TILE_REQUESTS = 4;

/**
 * FAA VFR sectional charts. Zooms 8–12 return JPEG tiles; 7 and 13 do not
 * (checked 2026-10-22). Closer and farther views scale those tiles.
 */
export const AERONAUTICAL_CHART = {
  id: OVERVIEW_PROVIDER_CHARTS,
  label: "Aeronautical charts",
  urlTemplate: "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}",
  minZoom: 8,
  maxZoom: 12,
  attribution: "Federal Aviation Administration, Aeronautical Information Services",
  attributionUrl: "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/",
} as const;

export interface OverviewSource {
  id: string;
  label: string;
  urlTemplate: string;
  minZoom: number;
  maxZoom: number;
  attribution: string;
  attributionUrl?: string;
}

export interface OverviewBasemap {
  mode: "google-tiles" | "raster-basemap" | "fallback";
  source: RasterBaseMapSource | null;
}

export interface OverviewView {
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
  zoomMeters: number;
}

export interface OverviewTile {
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
}

export interface OverviewFrame {
  zoom: number;
  scale: number;
  originX: number;
  originY: number;
  tilePx: number;
  tiles: OverviewTile[];
}

const GOOGLE_NOTE = "Google 3D Tiles has no flat image. Choose a chart or another map.";
const WAITING_NOTE = "The current basemap has no flat image yet.";

export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replaceAll("{z}", String(z)).replaceAll("{x}", String(x)).replaceAll("{y}", String(y));
}

export function mercatorX(lonDeg: number, zoom: number): number {
  return ((lonDeg + 180) / 360) * 2 ** zoom;
}

export function mercatorY(latDeg: number, zoom: number): number {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latDeg)) * Math.PI / 180;
  return (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * 2 ** zoom;
}

export function lonFromMercatorX(x: number, zoom: number): number {
  const lon = (x / 2 ** zoom) * 360 - 180;
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

export function latFromMercatorY(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return Math.atan(Math.sinh(n)) * (180 / Math.PI);
}

/** Zoom whose ground scale matches the camera distance across about half the panel. */
export function overviewZoom(latDeg: number, zoomMeters: number, heightPx: number, offset: number): number {
  const desired = Math.max(zoomMeters, 1) / Math.max(heightPx * 0.45, 1);
  const cosine = Math.cos(Math.min(80, Math.abs(latDeg)) * Math.PI / 180);
  return Math.log2((WEB_MERCATOR_MPP * Math.max(cosine, 0.05)) / desired) + offset;
}

export function planOverview(input: {
  latDeg: number;
  lonDeg: number;
  widthPx: number;
  heightPx: number;
  zoomMeters: number;
  zoomOffset: number;
  minZoom: number;
  maxZoom: number;
  /** Caps how far a coarse chart is magnified. The camera stays centered and more ground shows. */
  maxScale?: number;
}): OverviewFrame {
  const raw = overviewZoom(input.latDeg, input.zoomMeters, input.heightPx, input.zoomOffset);
  const zoom = Math.round(Math.min(input.maxZoom, Math.max(input.minZoom, raw)));
  let scale = 2 ** (raw - zoom);
  if (input.maxScale !== undefined) scale = Math.min(scale, input.maxScale);
  const longer = Math.max(input.widthPx, input.heightPx, 1);
  const span = longer / Math.max(TILE_PX * scale, 1e-6);
  if (span > MAX_TILES_ACROSS) scale *= span / MAX_TILES_ACROSS;
  const tilePx = TILE_PX * scale;
  const n = 2 ** zoom;
  const originX = input.widthPx / 2 - mercatorX(input.lonDeg, zoom) * tilePx;
  const originY = input.heightPx / 2 - mercatorY(input.latDeg, zoom) * tilePx;
  const x0 = Math.floor(-originX / tilePx);
  const x1 = Math.floor((input.widthPx - originX) / tilePx);
  const y0 = Math.max(0, Math.floor(-originY / tilePx));
  const y1 = Math.min(n - 1, Math.floor((input.heightPx - originY) / tilePx));
  const tiles: OverviewTile[] = [];
  for (let x = x0; x <= x1; x += 1) {
    const wrapped = ((x % n) + n) % n;
    for (let y = y0; y <= y1; y += 1) tiles.push({ z: zoom, x: wrapped, y, left: originX + x * tilePx, top: originY + y * tilePx });
  }
  return { zoom, scale, originX, originY, tilePx, tiles };
}

export function overviewPointToLatLon(frame: OverviewFrame, xPx: number, yPx: number): { latDeg: number; lonDeg: number } {
  return {
    latDeg: latFromMercatorY((yPx - frame.originY) / frame.tilePx, frame.zoom),
    lonDeg: lonFromMercatorX((xPx - frame.originX) / frame.tilePx, frame.zoom),
  };
}

export interface SphereSample {
  x: number;
  y: number;
  front: boolean;
}

/** Orthographic globe. Screen y grows downward. At offset 0 the disc fits in the panel. */
export function sphereRadiusPx(widthPx: number, heightPx: number, zoomOffset: number): number {
  return Math.max(32, Math.min(widthPx, heightPx)) * 0.46 * 2 ** zoomOffset;
}

export function orthographicPoint(
  latDeg: number,
  lonDeg: number,
  centerLat: number,
  centerLon: number,
  radiusPx: number,
  cx: number,
  cy: number,
): SphereSample {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const lat0 = centerLat * Math.PI / 180;
  const lon0 = centerLon * Math.PI / 180;
  const cosc = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(lon - lon0);
  const x = Math.cos(lat) * Math.sin(lon - lon0);
  const y = Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(lon - lon0);
  return { x: cx + x * radiusPx, y: cy - y * radiusPx, front: cosc >= -1e-6 };
}

/** The ground under a screen point, or null when that point is off the disc. */
export function inverseOrthographic(
  x: number,
  y: number,
  centerLat: number,
  centerLon: number,
  radiusPx: number,
  cx: number,
  cy: number,
): { latDeg: number; lonDeg: number } | null {
  if (radiusPx <= 0) return null;
  const dx = (x - cx) / radiusPx;
  const dy = (cy - y) / radiusPx;
  const rho2 = dx * dx + dy * dy;
  if (rho2 > 1) return null;
  const rho = Math.sqrt(rho2);
  const c = Math.asin(Math.min(1, rho));
  const lat0 = centerLat * Math.PI / 180;
  const lon0 = centerLon * Math.PI / 180;
  if (rho < 1e-8) return { latDeg: centerLat, lonDeg: centerLon };
  const lat = Math.asin(Math.max(-1, Math.min(1, Math.cos(c) * Math.sin(lat0) + (dy * Math.sin(c) * Math.cos(lat0)) / rho)));
  let lon = (lon0 + Math.atan2(dx * Math.sin(c), rho * Math.cos(lat0) * Math.cos(c) - dy * Math.sin(lat0) * Math.sin(c))) * 180 / Math.PI;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return { latDeg: lat * 180 / Math.PI, lonDeg: lon };
}

interface SphereTile {
  z: number;
  x: number;
  y: number;
  west: number;
  east: number;
  north: number;
  south: number;
}

function sphereTiles(latDeg: number, lonDeg: number, widthPx: number, heightPx: number, radiusPx: number, minZoom: number, maxZoom: number): { zoom: number; tiles: SphereTile[] } {
  const mpp = EARTH_RADIUS_M / Math.max(radiusPx, 1);
  const cosine = Math.cos(Math.min(80, Math.abs(latDeg)) * Math.PI / 180);
  const raw = Math.log2((WEB_MERCATOR_MPP * Math.max(cosine, 0.05)) / mpp);
  const zoom = Math.round(Math.min(maxZoom, Math.max(minZoom, raw)));
  const n = 2 ** zoom;
  const tileMpp = (WEB_MERCATOR_MPP * Math.max(cosine, 0.05)) / n;
  const tileScreen = TILE_PX * tileMpp / mpp;
  const visibleReach = Math.max(1, Math.ceil(Math.max(widthPx, heightPx) / Math.max(tileScreen, 1)) + 1);
  // A zoomed-out globe needs every tile of a coarse world. A close view only needs the ones on screen.
  const reach = n <= MAX_TILES_ACROSS ? n : Math.min(MAX_TILES_ACROSS, visibleReach);
  const centerX = mercatorX(lonDeg, zoom);
  const centerY = mercatorY(latDeg, zoom);
  const x0 = reach >= n ? 0 : Math.floor(centerX) - Math.floor((reach - 1) / 2);
  const y0 = reach >= n ? 0 : Math.max(0, Math.floor(centerY) - Math.floor((reach - 1) / 2));
  const tiles: SphereTile[] = [];
  for (let step = 0; step < reach; step += 1) {
    const x = x0 + step;
    const wrapped = ((x % n) + n) % n;
    for (let y = y0; y < y0 + reach && y < n; y += 1) {
      tiles.push({
        z: zoom,
        x: wrapped,
        y,
        west: (x / n) * 360 - 180,
        east: ((x + 1) / n) * 360 - 180,
        north: latFromMercatorY(y, zoom),
        south: latFromMercatorY(y + 1, zoom),
      });
    }
  }
  return { zoom, tiles };
}

const SPHERE_MOSAIC = 1024;
const SPHERE_COLS = 72;
const SPHERE_ROWS = 48;

/** Drape tiles on the globe. Coarse world tiles are assembled, then sampled on a fine grid so the poles do not fan out. */
function drawSphereSurface(
  context: CanvasRenderingContext2D,
  mosaic: HTMLCanvasElement,
  images: Map<string, HTMLImageElement>,
  template: string,
  tiles: SphereTile[],
  zoom: number,
  centerLat: number,
  centerLon: number,
  radiusPx: number,
  cx: number,
  cy: number,
): void {
  const n = 2 ** zoom;
  const span = 360 / n;
  if (span <= 15) {
    const cells = span > 8 ? 6 : span > 4 ? 4 : 2;
    for (const tile of tiles) {
      const image = images.get(tileUrl(template, tile.z, tile.x, tile.y));
      if (!image) continue;
      const midLon = tile.west + (tile.east - tile.west) / 2;
      const mid = orthographicPoint((tile.north + tile.south) / 2, midLon, centerLat, centerLon, radiusPx, cx, cy);
      if (!mid.front) continue;
      drawWarpedTile(context, image, tile, cells, centerLat, centerLon, radiusPx, cx, cy);
    }
    return;
  }
  const mosaicContext = mosaic.getContext("2d");
  if (!mosaicContext) return;
  const size = mosaic.width;
  mosaicContext.setTransform(1, 0, 0, 1, 0, 0);
  mosaicContext.fillStyle = "#16324f";
  mosaicContext.fillRect(0, 0, size, size);
  const dest = size / n;
  for (const tile of tiles) {
    const image = images.get(tileUrl(template, tile.z, tile.x, tile.y));
    if (image) mosaicContext.drawImage(image, tile.x * dest, tile.y * dest, dest, dest);
  }
  // A cell narrower than a few pixels is a mercator sliver and streaks toward the pole. The cap covers that.
  const lonStep = (360 / SPHERE_COLS) * Math.PI / 180;
  const capLat = Math.acos(Math.min(1, Math.max(0, 3.5 / Math.max(radiusPx * lonStep, 1e-3)))) * 180 / Math.PI;
  const latMax = 85;
  for (let row = 0; row < SPHERE_ROWS; row += 1) {
    const lat0 = latMax - (2 * latMax * row) / SPHERE_ROWS;
    const lat1 = latMax - (2 * latMax * (row + 1)) / SPHERE_ROWS;
    if (Math.abs(lat0) > capLat && Math.abs(lat1) > capLat) continue;
    const sy = mercatorY(lat0, 0) * size;
    const sh = mercatorY(lat1, 0) * size - sy;
    if (sh <= 0) continue;
    for (let col = 0; col < SPHERE_COLS; col += 1) {
      const lon0 = -180 + (360 * col) / SPHERE_COLS;
      const lon1 = lon0 + 360 / SPHERE_COLS;
      const topLeft = orthographicPoint(lat0, lon0, centerLat, centerLon, radiusPx, cx, cy);
      const topRight = orthographicPoint(lat0, lon1, centerLat, centerLon, radiusPx, cx, cy);
      const bottomLeft = orthographicPoint(lat1, lon0, centerLat, centerLon, radiusPx, cx, cy);
      if (!topLeft.front || !topRight.front || !bottomLeft.front) continue;
      const sx = ((lon0 + 180) / 360) * size;
      const sw = (360 / SPHERE_COLS / 360) * size;
      const midX = (topLeft.x + topRight.x + bottomLeft.x) / 3;
      const midY = (topLeft.y + topRight.y + bottomLeft.y) / 3;
      const pad = (point: SphereSample): SphereSample => {
        const vx = point.x - midX;
        const vy = point.y - midY;
        const length = Math.hypot(vx, vy) || 1;
        return { ...point, x: point.x + (vx / length) * 1.25, y: point.y + (vy / length) * 1.25 };
      };
      const left = pad(topLeft);
      const right = pad(topRight);
      const down = pad(bottomLeft);
      context.save();
      context.transform(
        (right.x - left.x) / sw, (right.y - left.y) / sw,
        (down.x - left.x) / sh, (down.y - left.y) / sh,
        left.x, left.y,
      );
      context.drawImage(mosaic, sx, sy, sw, sh, 0, 0, sw, sh);
      context.restore();
    }
  }
  for (const lat of [capLat, -capLat]) {
    const pole = orthographicPoint(lat > 0 ? 90 : -90, centerLon, centerLat, centerLon, radiusPx, cx, cy);
    if (!pole.front || capLat >= 89) continue;
    context.beginPath();
    context.moveTo(pole.x, pole.y);
    for (let col = 0; col <= SPHERE_COLS; col += 1) {
      const lon = -180 + (360 * col) / SPHERE_COLS;
      const edge = orthographicPoint(lat, lon, centerLat, centerLon, radiusPx, cx, cy);
      if (edge.front) context.lineTo(edge.x, edge.y);
    }
    context.closePath();
    context.fillStyle = lat > 0 ? "#e7eef2" : "#16324f";
    context.fill();
  }
}

function drawWarpedTile(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  tile: SphereTile,
  cells: number,
  centerLat: number,
  centerLon: number,
  radiusPx: number,
  cx: number,
  cy: number,
): void {
  const imageWidth = image.naturalWidth > 0 ? image.naturalWidth : TILE_PX;
  const imageHeight = image.naturalHeight > 0 ? image.naturalHeight : TILE_PX;
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const lat0 = tile.north + (tile.south - tile.north) * (row / cells);
      const lat1 = tile.north + (tile.south - tile.north) * ((row + 1) / cells);
      const lon0 = tile.west + (tile.east - tile.west) * (col / cells);
      const lon1 = tile.west + (tile.east - tile.west) * ((col + 1) / cells);
      const topLeft = orthographicPoint(lat0, lon0, centerLat, centerLon, radiusPx, cx, cy);
      const topRight = orthographicPoint(lat0, lon1, centerLat, centerLon, radiusPx, cx, cy);
      const bottomLeft = orthographicPoint(lat1, lon0, centerLat, centerLon, radiusPx, cx, cy);
      if (!topLeft.front || !topRight.front || !bottomLeft.front) continue;
      const sw = imageWidth / cells;
      const sh = imageHeight / cells;
      context.save();
      context.transform(
        (topRight.x - topLeft.x) / sw, (topRight.y - topLeft.y) / sw,
        (bottomLeft.x - topLeft.x) / sh, (bottomLeft.y - topLeft.y) / sh,
        topLeft.x, topLeft.y,
      );
      context.drawImage(image, col * sw, row * sh, sw, sh, 0, 0, sw, sh);
      context.restore();
    }
  }
}

function sourceFromRaster(source: RasterBaseMapSource): OverviewSource {
  return {
    id: source.id,
    label: source.label,
    urlTemplate: source.urlTemplate,
    minZoom: source.minZoom ?? 0,
    maxZoom: source.maxZoom ?? 19,
    attribution: source.attribution,
    ...(source.attributionUrl ? { attributionUrl: source.attributionUrl } : {}),
  };
}

/** The tiles to draw for this choice, or a note when the current map has no flat image. */
export function resolveOverviewSource(selection: string, basemap: OverviewBasemap, rasters: readonly RasterBaseMapSource[]): { source: OverviewSource | null; note: string | null } {
  if (selection === OVERVIEW_PROVIDER_CURRENT) {
    if (basemap.mode === "google-tiles") return { source: null, note: GOOGLE_NOTE };
    if (!basemap.source) return { source: null, note: WAITING_NOTE };
    return { source: sourceFromRaster(basemap.source), note: null };
  }
  if (selection === OVERVIEW_PROVIDER_CHARTS) return { source: AERONAUTICAL_CHART, note: null };
  const raster = rasters.find(item => item.id === selection);
  return raster ? { source: sourceFromRaster(raster), note: null } : { source: AERONAUTICAL_CHART, note: null };
}

/** A host's own marks on one drawn frame. Flight-only marks stay in that app. */
export interface OverviewMapOverlayFrame {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Where a place falls on this frame, or null when the sphere hides it. */
  project(latDeg: number, lonDeg: number): { x: number; y: number } | null;
}

/**
 * Marks a host draws on the map. The map does not know what they are, and an
 * app that never passes one does not load their code.
 */
export interface OverviewMapOverlay {
  /** Changes when the marks change, so the map draws them again. */
  revision(): string;
  paint(frame: OverviewMapOverlayFrame): void;
}

export interface OverviewMapOptions {
  document: Document;
  /** The same 2D basemaps the globe can drape, offered beside the charts. */
  sources: readonly RasterBaseMapSource[];
  settings: SettingsRegistry;
  basemap(): OverviewBasemap;
  subscribeBasemap(listener: () => void): () => void;
  view(): OverviewView | null;
  frames: { subscribe(listener: () => void): () => void };
  /** Host-only marks, drawn over the map and under the place marker. */
  overlay?: OverviewMapOverlay;
  /** Starting magnification. The globe opens fitted to the panel. */
  initialZoomOffset?: number;
}

export interface OverviewMapHandle {
  element: HTMLElement;
  destroy(): void;
}

/**
 * A north-up map of where the camera is. It opens as a globe draped with the
 * same tiles a flat map uses, including aeronautical charts. A drag or a
 * two-finger swipe pans this map and glides the way the globe does. A button
 * brings it back to the view. A click does not move the camera. A pinch or
 * the mouse wheel zooms only this map.
 */
export function createOverviewMap(options: OverviewMapOptions): OverviewMapHandle {
  const { document, settings } = options;
  const view = document.defaultView;
  if (!view) throw new Error("The map tab needs its window.");
  const element = document.createElement("div");
  element.className = "overview-map";
  const choices = [
    { id: OVERVIEW_PROVIDER_CURRENT, label: "Current basemap" },
    { id: AERONAUTICAL_CHART.id, label: AERONAUTICAL_CHART.label },
    ...options.sources.map(source => ({ id: source.id, label: source.label })),
  ];
  const stage = document.createElement("div");
  stage.className = "overview-map__view";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Map of the view. Drag or a two-finger swipe pans this map and glides. Pinch or the mouse wheel zooms it.");
  const note = document.createElement("p");
  note.className = "overview-map__note";
  note.setAttribute("role", "status");
  note.hidden = true;
  const picker = document.createElement("div");
  picker.className = "overview-map__picker";
  picker.hidden = true;
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Map providers");
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overview-map__provider";
    button.dataset.provider = choice.id;
    button.textContent = choice.label;
    picker.append(button);
  }
  const chip = document.createElement("div");
  chip.className = "overview-map__chip";
  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "overview-map__name";
  nameButton.setAttribute("aria-haspopup", "true");
  nameButton.setAttribute("aria-expanded", "false");
  const credit = document.createElement("a");
  credit.className = "overview-map__credit";
  credit.target = "_blank";
  credit.rel = "noopener noreferrer";
  credit.append(createExternalLinkIcon(document));
  credit.hidden = true;
  credit.addEventListener("click", event => {
    event.stopPropagation();
    if (!credit.getAttribute("href")) event.preventDefault();
  });
  chip.append(nameButton, credit);
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "overview-map__menu";
  menuButton.setAttribute("aria-label", "Map menu");
  menuButton.setAttribute("aria-haspopup", "true");
  menuButton.setAttribute("aria-expanded", "false");
  const bars = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  bars.setAttribute("viewBox", "0 0 16 16");
  bars.setAttribute("width", "16");
  bars.setAttribute("height", "16");
  bars.setAttribute("aria-hidden", "true");
  const barPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  barPath.setAttribute("fill", "currentColor");
  barPath.setAttribute("d", "M1 3.5h14v1.5H1zm0 4h14v1.5H1zm0 4h14V13H1z");
  bars.append(barPath);
  menuButton.append(bars);
  const menuPanel = document.createElement("div");
  menuPanel.className = "overview-map__menu-panel";
  menuPanel.hidden = true;
  menuPanel.setAttribute("role", "group");
  menuPanel.setAttribute("aria-label", "Map options");
  const shape = document.createElement("div");
  shape.className = "overview-map__shape";
  shape.setAttribute("role", "group");
  shape.setAttribute("aria-label", "Map shape");
  for (const choice of [
    { id: "sphere", label: "Sphere" },
    { id: OVERVIEW_PROJECTION_MERCATOR, label: "2D" },
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overview-map__shape-choice";
    button.dataset.projection = choice.id;
    button.textContent = choice.label;
    shape.append(button);
  }
  const preset = createTabPresetSave(settings, "overview", "Map", document);
  menuPanel.append(shape, preset.element);
  const recenter = document.createElement("button");
  recenter.type = "button";
  recenter.className = "overview-map__recenter";
  recenter.textContent = "Recenter";
  recenter.setAttribute("aria-label", "Recenter on the view");
  recenter.hidden = true;
  stage.append(canvas, note, picker, chip, menuButton, menuPanel, recenter);
  element.append(stage);

  const images = new Map<string, HTMLImageElement>();
  const mosaic = document.createElement("canvas");
  mosaic.width = SPHERE_MOSAIC;
  mosaic.height = SPHERE_MOSAIC;
  const failed = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  let active = 0;
  let disposed = false;
  let zoomOffset = Number.isFinite(options.initialZoomOffset) ? Math.min(14, Math.max(-8, options.initialZoomOffset!)) : 0;
  let signature = "";
  let browsed: { latDeg: number; lonDeg: number } | null = null;
  let drawn: {
    projection: "sphere" | "mercator";
    frame: OverviewFrame | null;
    radiusPx: number;
    centerLat: number;
    centerLon: number;
    width: number;
    height: number;
  } | null = null;
  const readSetting = (id: string): unknown => settings.has(id) ? settings.get(id) : undefined;
  const readNumber = (id: string): number => {
    const value = readSetting(id);
    return typeof value === "number" && Number.isFinite(value) ? value : 1;
  };
  const inputMode = (): InputModePreference => {
    const value = readSetting("input.mode");
    return value === "mouse" || value === "trackpad" || value === "touch" || value === "auto" ? value : "auto";
  };
  const projection = (): "sphere" | "mercator" => readSetting(OVERVIEW_PROJECTION_ID) === OVERVIEW_PROJECTION_MERCATOR ? "mercator" : "sphere";
  const pointAt = (x: number, y: number): { latDeg: number; lonDeg: number } | null => {
    if (!drawn) return null;
    if (drawn.projection === "sphere") return inverseOrthographic(x, y, drawn.centerLat, drawn.centerLon, drawn.radiusPx, drawn.width / 2, drawn.height / 2);
    if (!drawn.frame) return null;
    const point = overviewPointToLatLon(drawn.frame, x, y);
    return Number.isFinite(point.latDeg) && Number.isFinite(point.lonDeg) ? point : null;
  };
  const navigation = createInertialCameraController({
    panBy(dx, dy) {
      if (!drawn || (dx === 0 && dy === 0)) return;
      const next = pointAt(drawn.width / 2 + dx, drawn.height / 2 + dy);
      if (!next) return;
      browsed = next;
      signature = "";
    },
    orbitBy() {},
    zoomBy(factor) {
      if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
      const limit = projection() === "sphere" ? { min: -2, max: 14 } : { min: -8, max: 6 };
      zoomOffset = Math.min(limit.max, Math.max(limit.min, zoomOffset - Math.log2(factor)));
      signature = "";
    },
  }, { nowMs: () => view.performance.now() });
  const readWheel = createWheelGestureReader({
    nowMs: () => view.performance.now(),
    isSafariWithGestures: isSafariGestureSupported({ userAgent: view.navigator.userAgent, hasGestureEvent: "GestureEvent" in view }),
    mode: inputMode,
  });
  const wheelExponent = Math.log1p(Math.max(0, DEFAULT_INPUT_RATES.wheelZoomPerNotch)) / Math.log(1.08);

  const keyed = (source: OverviewSource): OverviewSource => {
    const raster = options.sources.find(item => item.id === source.id);
    if (!raster) return source;
    const key = settings.has("map.source.cartoKey") ? settings.get("map.source.cartoKey") : "";
    return sourceFromRaster(withSourceKey(raster, typeof key === "string" ? key : ""));
  };

  const pump = (): void => {
    while (active < MAX_TILE_REQUESTS && queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      queued.delete(url);
      if (images.has(url) || failed.has(url)) continue;
      active += 1;
      const image = document.createElement("img");
      image.decoding = "async";
      image.alt = "";
      image.onload = () => {
        active -= 1;
        if (!disposed) {
          images.set(url, image);
          while (images.size > MAX_CACHED_TILES) {
            const oldest = images.keys().next().value;
            if (oldest === undefined) break;
            images.delete(oldest);
          }
          signature = "";
          paint();
        }
        pump();
      };
      image.onerror = () => {
        active -= 1;
        failed.add(url);
        pump();
      };
      image.src = url;
    }
  };

  const enqueue = (url: string): void => {
    if (images.has(url) || failed.has(url) || queued.has(url)) return;
    queued.add(url);
    queue.push(url);
    pump();
  };

  const paint = (): void => {
    if (disposed) return;
    const selection = String(settings.get(OVERVIEW_PROVIDER_ID));
    const selectedId = choices.some(choice => choice.id === selection) ? selection : OVERVIEW_PROVIDER_CHARTS;
    const resolved = resolveOverviewSource(selectedId, options.basemap(), options.sources);
    const source = resolved.source ? keyed(resolved.source) : null;
    const shown = selectedId === OVERVIEW_PROVIDER_CURRENT && source
      ? source.label
      : choices.find(choice => choice.id === selectedId)?.label ?? AERONAUTICAL_CHART.label;
    nameButton.textContent = shown;
    nameButton.setAttribute("aria-label", `${shown}. Choose a map provider.`);
    for (const button of picker.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", button.dataset.provider === selectedId ? "true" : "false");
    }
    note.hidden = resolved.note === null;
    note.textContent = resolved.note ?? "";
    canvas.toggleAttribute("aria-hidden", resolved.note !== null);
    if (source?.attributionUrl) {
      credit.hidden = false;
      credit.href = source.attributionUrl;
      credit.setAttribute("aria-label", `${source.attribution}, opens in a new tab`);
    } else {
      credit.hidden = true;
      credit.removeAttribute("href");
    }
    const shapeId = projection();
    for (const button of shape.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", button.dataset.projection === shapeId ? "true" : "false");
    }
    recenter.hidden = browsed === null;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    // A tab without the map's layout can report a huge height and blow the canvas.
    const place = options.view();
    if (!source || !place || width < 2 || height < 2 || width > 8192 || height > 8192) {
      drawn = null;
      signature = "";
      return;
    }
    const center = browsed ?? { latDeg: place.latDeg, lonDeg: place.lonDeg };
    const sphere = shapeId === "sphere";
    const radiusPx = sphere ? sphereRadiusPx(width, height, zoomOffset) : 0;
    const frame = sphere ? null : planOverview({
      latDeg: center.latDeg, lonDeg: center.lonDeg, widthPx: width, heightPx: height,
      zoomMeters: place.zoomMeters, zoomOffset, minZoom: source.minZoom, maxZoom: source.maxZoom,
      // A chart has no closer tiles. Magnifying one fills the panel with a single label,
      // so the default view stays at the chart's own scale. Scrolling in may still enlarge it.
      ...(source.id === AERONAUTICAL_CHART.id && zoomOffset <= 0 ? { maxScale: 1 } : {}),
    });
    const draped = sphere ? sphereTiles(center.latDeg, center.lonDeg, width, height, radiusPx, source.minZoom, source.maxZoom) : null;
    drawn = { projection: shapeId, frame, radiusPx, centerLat: center.latDeg, centerLon: center.lonDeg, width, height };
    const tiles = frame ? frame.tiles : draped?.tiles ?? [];
    let loaded = 0;
    for (const tile of tiles) {
      const url = tileUrl(source.urlTemplate, tile.z, tile.x, tile.y);
      if (images.has(url)) loaded += 1;
      else enqueue(url);
    }
    const zoom = frame?.zoom ?? draped?.zoom ?? 0;
    const marks = options.overlay?.revision() ?? "";
    const next = `${shapeId}|${source.urlTemplate}|${center.latDeg.toFixed(5)}|${center.lonDeg.toFixed(5)}|${place.latDeg.toFixed(5)}|${place.lonDeg.toFixed(5)}|${place.headingDeg.toFixed(1)}|${place.zoomMeters.toFixed(0)}|${zoomOffset}|${width}x${height}|${loaded}|${zoom}|${marks}`;
    if (next === signature) return;
    signature = next;
    const dpr = Math.min(view.devicePixelRatio || 1, 2);
    const bitmapWidth = Math.max(1, Math.round(width * dpr));
    const bitmapHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#d5deea";
    context.fillRect(0, 0, width, height);
    const cx = width / 2;
    const cy = height / 2;
    if (sphere && draped) {
      const clipR = Math.max(1, Math.min(radiusPx, Math.hypot(width, height) / 2));
      context.save();
      context.beginPath();
      context.arc(cx, cy, clipR, 0, Math.PI * 2);
      context.clip();
      context.fillStyle = "#16324f";
      context.fillRect(cx - clipR, cy - clipR, clipR * 2, clipR * 2);
      context.imageSmoothingEnabled = true;
      drawSphereSurface(context, mosaic, images, source.urlTemplate, draped.tiles, draped.zoom, center.latDeg, center.lonDeg, radiusPx, cx, cy);
      const shade = context.createRadialGradient(cx - clipR * 0.22, cy - clipR * 0.28, clipR * 0.15, cx, cy, clipR);
      shade.addColorStop(0, "rgba(255, 255, 255, 0.08)");
      shade.addColorStop(1, "rgba(2, 8, 23, 0.38)");
      context.fillStyle = shade;
      context.fillRect(cx - clipR, cy - clipR, clipR * 2, clipR * 2);
      context.restore();
      if (radiusPx < Math.hypot(width, height) / 2) {
        context.beginPath();
        context.arc(cx, cy, radiusPx, 0, Math.PI * 2);
        context.strokeStyle = "rgba(15, 23, 42, 0.65)";
        context.lineWidth = 2;
        context.stroke();
      }
    } else if (frame) {
      for (const tile of frame.tiles) {
        const image = images.get(tileUrl(source.urlTemplate, tile.z, tile.x, tile.y));
        if (image) context.drawImage(image, tile.left, tile.top, frame.tilePx, frame.tilePx);
      }
    }
    if (options.overlay) {
      const project = (latDeg: number, lonDeg: number): { x: number; y: number } | null => {
        if (sphere) {
          const point = orthographicPoint(latDeg, lonDeg, center.latDeg, center.lonDeg, radiusPx, cx, cy);
          return point.front ? { x: point.x, y: point.y } : null;
        }
        if (!frame) return null;
        return {
          x: frame.originX + mercatorX(lonDeg, frame.zoom) * frame.tilePx,
          y: frame.originY + mercatorY(latDeg, frame.zoom) * frame.tilePx,
        };
      };
      options.overlay.paint({ context, width, height, project });
    }
    const marker = sphere
      ? orthographicPoint(place.latDeg, place.lonDeg, center.latDeg, center.lonDeg, radiusPx, cx, cy)
      : { x: frame ? frame.originX + mercatorX(place.lonDeg, frame.zoom) * frame.tilePx : cx, y: frame ? frame.originY + mercatorY(place.latDeg, frame.zoom) * frame.tilePx : cy, front: true };
    context.fillStyle = "rgba(15, 23, 42, 0.8)";
    context.font = "700 12px sans-serif";
    context.textAlign = "center";
    const northY = sphere ? Math.max(16, cy - Math.min(radiusPx, cy) + 14) : 16;
    context.fillText("N", cx, Math.min(height - 4, northY));
    if (marker.front && marker.x >= -20 && marker.y >= -20 && marker.x <= width + 20 && marker.y <= height + 20) {
      context.save();
      context.translate(marker.x, marker.y);
      context.rotate(place.headingDeg * Math.PI / 180);
      context.beginPath();
      context.moveTo(0, -13);
      context.lineTo(7, 9);
      context.lineTo(0, 4);
      context.lineTo(-7, 9);
      context.closePath();
      context.fillStyle = "#f97316";
      context.strokeStyle = "#0f172a";
      context.lineWidth = 2;
      context.stroke();
      context.fill();
      context.restore();
    }
  };

  const setPickerOpen = (open: boolean): void => {
    picker.hidden = !open;
    nameButton.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const setMenuOpen = (open: boolean): void => {
    menuPanel.hidden = !open;
    menuButton.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const onNameClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const open = picker.hidden;
    setPickerOpen(open);
    if (open) setMenuOpen(false);
  };
  const onMenuClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const open = menuPanel.hidden;
    setMenuOpen(open);
    if (open) setPickerOpen(false);
  };
  const onShapeClick = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!(button instanceof HTMLButtonElement) || !button.dataset.projection) return;
    event.stopPropagation();
    if (!settings.has(OVERVIEW_PROJECTION_ID)) return;
    zoomOffset = 0;
    browsed = null;
    settings.set(OVERVIEW_PROJECTION_ID, button.dataset.projection);
    signature = "";
    paint();
  };
  const onRecenter = (event: MouseEvent): void => {
    event.stopPropagation();
    navigation.cancel();
    browsed = null;
    signature = "";
    paint();
  };
  const onPickerClick = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!(button instanceof HTMLButtonElement) || !button.dataset.provider) return;
    event.stopPropagation();
    settings.set(OVERVIEW_PROVIDER_ID, button.dataset.provider);
    setPickerOpen(false);
    signature = "";
    paint();
  };
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    const node = target instanceof Node ? target : null;
    if (!picker.hidden && node && !picker.contains(node) && !nameButton.contains(node)) setPickerOpen(false);
    if (!menuPanel.hidden && node && !menuPanel.contains(node) && !menuButton.contains(node)) setMenuOpen(false);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!picker.hidden) setPickerOpen(false);
    if (!menuPanel.hidden) setMenuOpen(false);
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const reading = readWheel(event).mode;
    const mode = reading === "orbit" ? "pan" : reading;
    if (mode === "pan") {
      const rate = DEFAULT_INPUT_RATES.trackpadPanRate * readNumber("input.sensitivity.trackpad.pan");
      navigation.panBy(event.deltaX * rate, event.deltaY * rate, stage.clientHeight || 1);
      return;
    }
    if (mode === "ignore") return;
    if (mode === "pinchZoom") {
      const factor = 1 + event.deltaY * DEFAULT_INPUT_RATES.trackpadPinchZoomPerPx * readNumber("input.sensitivity.trackpad.zoom");
      if (factor > 0) navigation.zoomBy(factor);
      navigation.armReleaseMomentum("zoom");
      return;
    }
    if (Math.abs(event.deltaY) <= 0.001) return;
    const factor = Math.pow(event.deltaY > 0 ? 1.08 : 0.92, readNumber("input.sensitivity.mouse.zoom") * wheelExponent);
    navigation.zoomBy(factor);
  };
  let press: { id: number; x: number; y: number; lastX: number; lastY: number; dragging: boolean; pointerType: string } | null = null;
  const dragRate = (pointerType: string): number => pointerType === "touch"
    ? DEFAULT_INPUT_RATES.touchPanRate * readNumber("input.sensitivity.touch.pan")
    : DEFAULT_INPUT_RATES.mousePanRate * readNumber("input.sensitivity.mouse.pan");
  const onPressDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.target !== canvas) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, dragging: false, pointerType: event.pointerType };
    try { canvas.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
  };
  const onPressMove = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.id) return;
    if (!press.dragging) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DEFAULT_INPUT_RATES.mouseDragThresholdPx) return;
      press.dragging = true;
      navigation.cancel();
      canvas.style.cursor = "grabbing";
    }
    const dx = event.clientX - press.lastX;
    const dy = event.clientY - press.lastY;
    press.lastX = event.clientX;
    press.lastY = event.clientY;
    if (dx === 0 && dy === 0) return;
    event.preventDefault();
    // The ground follows the pointer, as a drag on the globe does.
    navigation.panBy(-dx * dragRate(press.pointerType), -dy * dragRate(press.pointerType), stage.clientHeight || 1);
    navigation.armReleaseMomentum("pan");
  };
  const onPressUp = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.id) return;
    const dragged = press.dragging;
    press = null;
    canvas.style.cursor = "";
    if (!dragged) return;
    navigation.releaseMomentum("pan");
    event.preventDefault();
  };
  const onClick = (): void => {
    setPickerOpen(false);
    setMenuOpen(false);
  };
  const onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    navigation.cancel();
    zoomOffset = 0;
    signature = "";
    paint();
  };
  nameButton.addEventListener("click", onNameClick);
  menuButton.addEventListener("click", onMenuClick);
  shape.addEventListener("click", onShapeClick);
  recenter.addEventListener("click", onRecenter);
  picker.addEventListener("click", onPickerClick);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKey);
  stage.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPressDown);
  canvas.addEventListener("pointermove", onPressMove);
  canvas.addEventListener("pointerup", onPressUp);
  canvas.addEventListener("pointercancel", onPressUp);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("dblclick", onDoubleClick);
  const stopSafari = isSafariGestureSupported({ userAgent: view.navigator.userAgent, hasGestureEvent: "GestureEvent" in view })
    ? attachSafariGestures(stage as unknown as HTMLCanvasElement, navigation)
    : () => {};
  const stopFrames = options.frames.subscribe(() => {
    if (!element.isConnected) return;
    navigation.update();
    paint();
  });
  const stopBasemap = options.subscribeBasemap(() => { signature = ""; paint(); });
  const stopProvider = settings.watch(OVERVIEW_PROVIDER_ID, () => { signature = ""; paint(); });
  const stopProjection = settings.has(OVERVIEW_PROJECTION_ID) ? settings.watch(OVERVIEW_PROJECTION_ID, () => { signature = ""; paint(); }) : () => {};
  const stopKey = settings.has("map.source.cartoKey") ? settings.watch("map.source.cartoKey", () => { signature = ""; paint(); }) : () => {};
  const resize = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(() => { signature = ""; paint(); }) : null;
  resize?.observe(stage);
  paint();

  return {
    element,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      queue.length = 0;
      queued.clear();
      nameButton.removeEventListener("click", onNameClick);
      menuButton.removeEventListener("click", onMenuClick);
      shape.removeEventListener("click", onShapeClick);
      recenter.removeEventListener("click", onRecenter);
      picker.removeEventListener("click", onPickerClick);
      preset.destroy();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      stage.removeEventListener("wheel", onWheel);
      stopSafari();
      navigation.cancel();
      canvas.removeEventListener("pointerdown", onPressDown);
      canvas.removeEventListener("pointermove", onPressMove);
      canvas.removeEventListener("pointerup", onPressUp);
      canvas.removeEventListener("pointercancel", onPressUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDoubleClick);
      stopFrames();
      stopBasemap();
      stopProvider();
      stopProjection();
      stopKey();
      resize?.disconnect();
      element.remove();
    },
  };
}
