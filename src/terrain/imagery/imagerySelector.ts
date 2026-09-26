/**
 * Chooses raster imagery by the size of its pixels projected into the actual
 * view. It measures; it does not load. The plan it returns names the imagery
 * each visible region should show and why a region falls short of the target.
 *
 * Selection is a budgeted quadtree traversal. Nodes are split in order of
 * their projected footprint, which does not depend on the target, so a finer
 * target only ever extends the sequence of splits: it never shrinks coverage
 * or asks for a coarser image. Hysteresis and pinning keep level changes
 * bounded when the camera or the slider jitters around a threshold.
 */

import { ecefToGeodetic } from "../../camera/cameraMath";
import type { DetailLimit } from "../mapDetailPolicy";
import {
  childTiles,
  isBelowHorizon,
  isSphereBelowHorizon,
  lonLatToTileXY,
  outcode,
  projectedPixelFootprint,
  screenGroundPoints,
  sagittaMeters,
  sampleTileSurface,
  tileAngularSpan,
  tileKey,
  tileLatDeg,
  tileLonDeg,
  toClip,
  toScreen,
  type ImageryView,
  type SurfaceSample,
  type TileId,
  type Vec3,
} from "./imageryGeometry";

export type ImagerySourceKind = "photographic" | "cartographic";

export interface ImageryVariant {
  /** Stable id used in residency keys, e.g. "2x". */
  id: string;
  width: number;
  height: number;
}

/** What the selector needs to know about a raster source. */
export interface ImagerySourceCapabilities {
  /** Stable source identity and version: residency and missing records are keyed by both. */
  id: string;
  version: string;
  kind: ImagerySourceKind;
  minLevel: number;
  /** The approved request ceiling. Metadata never raises it. */
  maxLevel: number;
  tileWidth: number;
  tileHeight: number;
  /** Verified same-zoom variants with the same extent and content, least dense first. */
  variants: readonly ImageryVariant[];
  /** Geographic coverage; outside it the source is not refined. */
  coverage?: { west: number; south: number; east: number; north: number };
}

export interface ImagerySurface {
  /** Height of the adopted surface, or null where only coarse bounds are known. */
  heightAt(latDeg: number, lonDeg: number): number | null;
  /** Conservative height bounds of a region from adopted terrain or coarse data. */
  boundsFor(tile: TileId): { min: number; max: number };
}

export interface ImageryAvailability {
  /** True when this image has a usable decoded page. */
  isResident(imageKey: string): boolean;
  /** True when the source is known not to have this image right now. */
  isMissing(imageKey: string): boolean;
}

export interface ImagerySelectionInput {
  view: ImageryView;
  source: ImagerySourceCapabilities;
  /** The requested offset `d`, positive for finer imagery. */
  offset: number;
  /** Physical render pixels per image pixel at Normal. */
  normalTargetPx?: number;
  surface: ImagerySurface;
  availability: ImageryAvailability;
  /** The finest level a region's binding can show, from the terrain it lies on. */
  maxLevelFor?(tile: TileId): number;
  /** Atlas pages the selection may occupy: one per standard tile. */
  maxPages: number;
  /** A hard cap on nodes evaluated by one traversal: `map.imagery.maxNodes`. */
  maxNodes: number;
  /** When a region changes level: the `map.imagery.*` hysteresis parameters. */
  hysteresis: ImageryHysteresis;
  /** What else to load around a focus point: `map.focus.*`. Null: only the view. */
  focus?: ImageryFocus | null;
  now: number;
}

/**
 * A region around a focus point loaded in every direction, refined by its
 * distance from that point rather than by the view, so turning the camera
 * around the point loads nothing new.
 */
export interface ImageryFocus {
  /** "around": only the region loads. "both": it loads as well as the view. */
  mode: "around" | "both";
  /** ECEF metres. */
  position: Vec3;
  radiusMeters: number;
  /** The region is never measured nearer than this, the camera's distance to the point. */
  minDistanceMeters: number;
  /** Radians one physical pixel spans at the centre of the view. */
  pixelAngle: number;
  /** The region's offset: never finer than the view's. */
  offset: number;
  /** Skip regions below the horizon of a viewer `minDistanceMeters` above the point. */
  horizonCull: boolean;
}

/** Keeps level changes bounded when the view or the target jitters around a threshold. */
export interface ImageryHysteresis {
  /** An existing leaf refines once its footprint exceeds the target by this ratio. */
  refineAbove: number;
  /** A split node may merge once its footprint is under the target by this ratio. */
  coarsenBelow: number;
  /** ...and has stayed so for this long, in ms. */
  coarsenAfterMs: number;
  /** Children stay shown at least this long, in ms. */
  pinMs: number;
}

export interface ImageryPlanLeaf {
  tile: TileId;
  /** "z/x/y": the region this leaf covers. */
  key: string;
  /** Null for the standard tile, otherwise a verified variant id. */
  variant: string | null;
  /** Residency key: source, version, variant and tile. */
  imageKey: string;
  /** Atlas pages the chosen image occupies. */
  pages: number;
  /** Physical render pixels covered by one image pixel of the chosen image, at worst. */
  footprintPx: number;
  /** The standard image's footprint in the selection's units (logical for cartographic). */
  selectionFootprint: number;
  /** Estimated visible screen area in physical pixels, for ranking loads. */
  screenArea: number;
  limit: DetailLimit | null;
  /** Within the focus region, so kept whatever the view. */
  inFocus: boolean;
}

export interface ImageryPlan {
  sourceKey: string;
  offset: number;
  /** The physical target, in render pixels per image pixel. */
  physicalTarget: number;
  /** The target levels were selected against, in the selection's units. */
  selectionTarget: number;
  leaves: ImageryPlanLeaf[];
  /** Root-level tiles that always stay resident as fallback coverage. */
  coverage: TileId[];
  /** Split nodes ready to merge once their own image is resident: load these. */
  mergeCandidates: TileId[];
  limits: DetailLimit[];
  nodesEvaluated: number;
  /** True when the node cap ended the traversal before every region met its target. */
  truncated: boolean;
  /** The earliest time a hysteresis or pinning deadline could change the plan. */
  wakeAt: number | null;
  cpuMs: number;
}

/**
 * The traversal's structure, not tuning: the root level whose 16 tiles are
 * always resident as fallback coverage, and the widest tile horizon rejection
 * is trusted for. Tuning comes in with each input.
 */
export const IMAGERY_SELECTION_CONSTANTS = Object.freeze({
  rootLevel: 2,
  /** Horizon rejection is trusted only for tiles narrower than this, in radians. */
  horizonTileSpan: Math.PI / 8,
});

const STANDARD_PAGE_SIZE = 256;

interface NodeMemory {
  split: boolean;
  /** When the node last changed between split and leaf. */
  since: number;
  /** Since when a split node has continuously been coarse enough to merge. */
  coarsenSince: number | null;
}

interface Evaluated {
  tile: TileId;
  key: string;
  visible: boolean;
  /** Worst projected footprint in selection units; Infinity when unmeasurable but visible. */
  footprint: number;
  /** Worst projected footprint in physical pixels for the standard image. */
  physicalFootprint: number;
  screenArea: number;
  outsideCoverage: boolean;
  limit: DetailLimit | null;
  /** Inside the focus region: loaded whatever the view. */
  inFocus: boolean;
}

interface Job {
  input: ImagerySelectionInput;
  sourceKey: string;
  target: number;
  physicalTarget: number;
  cartographic: boolean;
  camera: { lonDeg: number; latDeg: number };
  /** Where rays across the screen meet the ground, to measure tiles that surround the view. */
  screenGround: Array<{ latDeg: number; lonDeg: number }>;
  focus: ImageryFocus | null;
  focusLonLat: { lonDeg: number; latDeg: number };
  /** Where the focus region's horizon is seen from. */
  focusViewer: Vec3;
  heap: Evaluated[];
  leaves: Evaluated[];
  coverage: TileId[];
  mergeCandidates: TileId[];
  leafCount: number;
  nodes: number;
  limits: Set<DetailLimit>;
  nextMemory: Map<string, NodeMemory>;
  wakeAt: number | null;
  truncated: boolean;
  cpuMs: number;
}

export function imageSourceKey(source: Pick<ImagerySourceCapabilities, "id" | "version">): string {
  return `${source.id}@${source.version}`;
}

export function imageKey(source: Pick<ImagerySourceCapabilities, "id" | "version">, tile: TileId, variant: string | null): string {
  return `${imageSourceKey(source)}/${variant ?? "std"}/${tileKey(tile)}`;
}

/** Atlas pages an image of this size occupies: 256-pixel squares. */
export function pagesForImage(width: number, height: number): number {
  return Math.max(1, Math.round(width / STANDARD_PAGE_SIZE)) * Math.max(1, Math.round(height / STANDARD_PAGE_SIZE));
}

// Heap ordered by footprint, largest first, then by key for determinism.
function heapBefore(a: Evaluated, b: Evaluated): boolean {
  if (a.footprint !== b.footprint) return a.footprint > b.footprint;
  return a.key < b.key;
}

function heapPush(heap: Evaluated[], item: Evaluated): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!heapBefore(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapPop(heap: Evaluated[]): Evaluated | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      let best = index;
      if (left < heap.length && heapBefore(heap[left], heap[best])) best = left;
      if (right < heap.length && heapBefore(heap[right], heap[best])) best = right;
      if (best === index) break;
      [heap[index], heap[best]] = [heap[best], heap[index]];
      index = best;
    }
  }
  return top;
}

const GRID = [0, 0.5, 1];
const QUADS = [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]] as const;
const SLOPE_STEP = 1 / 8;

function outsideCoverage(source: ImagerySourceCapabilities, tile: TileId): boolean {
  const bounds = source.coverage;
  if (!bounds) return false;
  const west = tileLonDeg(tile.z, tile.x), east = tileLonDeg(tile.z, tile.x + 1);
  const north = tileLatDeg(tile.z, tile.y), south = tileLatDeg(tile.z, tile.y + 1);
  return east <= bounds.west || west >= bounds.east || north <= bounds.south || south >= bounds.north;
}

/** Tile-local position of the camera's nadir clamped to the tile: its nearest surface point. */
function nearestLocal(tile: TileId, camera: { lonDeg: number; latDeg: number }): { u: number; v: number } {
  const n = 2 ** tile.z;
  const at = lonLatToTileXY(camera.lonDeg, camera.latDeg, tile.z);
  let dx = at.x - tile.x;
  // Choose the copy of the camera's longitude nearest this tile, across the dateline.
  if (dx > n / 2) dx -= n;
  if (dx < -n / 2) dx += n;
  return { u: Math.max(0, Math.min(1, dx)), v: Math.max(0, Math.min(1, at.y - tile.y)) };
}

/** The camera's geodetic position: its nadir is the nearest ground. */
function cameraLonLat(view: ImageryView): { lonDeg: number; latDeg: number } {
  const geo = ecefToGeodetic(view.camera.x, view.camera.y, view.camera.z);
  return { lonDeg: (geo.lonRad * 180) / Math.PI, latDeg: (geo.latRad * 180) / Math.PI };
}

function latLonAt(tile: TileId, u: number, v: number): { latDeg: number; lonDeg: number } {
  return { latDeg: tileLatDeg(tile.z, tile.y + v), lonDeg: tileLonDeg(tile.z, tile.x + u) };
}

/** A surface sample at the adopted height, tilted by the local slope. */
function surfaceSample(input: ImagerySelectionInput, tile: TileId, u: number, v: number, fallbackHeight: number): SurfaceSample {
  const heightAt = (uu: number, vv: number): number | null => {
    const { latDeg, lonDeg } = latLonAt(tile, uu, vv);
    return input.surface.heightAt(latDeg, lonDeg);
  };
  const height = heightAt(u, v);
  const h = height ?? fallbackHeight;
  let slopeU = 0, slopeV = 0;
  if (height !== null) {
    const uStep = u + SLOPE_STEP <= 1 ? SLOPE_STEP : -SLOPE_STEP;
    const vStep = v + SLOPE_STEP <= 1 ? SLOPE_STEP : -SLOPE_STEP;
    const east = heightAt(u + uStep, v);
    const south = heightAt(u, v + vStep);
    if (east !== null) slopeU = (east - h) / uStep;
    if (south !== null) slopeV = (south - h) / vStep;
  }
  return sampleTileSurface(tile, u, v, h, slopeU, slopeV);
}

/**
 * How the focus region needs a tile: whether any of it lies within the radius
 * (and above the viewer's horizon), and its worst footprint as seen from the
 * focus point, facing it, in the selection's units scaled to the view's target.
 */
function measureFocus(job: Job, tile: TileId): { within: boolean; footprint: number; physicalFootprint: number } {
  const { input } = job;
  const focus = job.focus!;
  const bounds = input.surface.boundsFor(tile);
  const points: Array<{ u: number; v: number }> = [];
  for (const v of GRID) for (const u of GRID) points.push({ u, v });
  points.push(nearestLocal(tile, job.focusLonLat));
  let nearest = Infinity;
  let worst = 0;
  for (const point of points) {
    const sample = surfaceSample(input, tile, point.u, point.v, bounds.max);
    const d = Math.hypot(sample.position.x - focus.position.x, sample.position.y - focus.position.y, sample.position.z - focus.position.z);
    nearest = Math.min(nearest, d);
    const pixelMeters = Math.max(
      Math.hypot(sample.du.x, sample.du.y, sample.du.z) / input.source.tileWidth,
      Math.hypot(sample.dv.x, sample.dv.y, sample.dv.z) / input.source.tileHeight,
    );
    worst = Math.max(worst, pixelMeters / Math.max(1, d, focus.minDistanceMeters) / focus.pixelAngle);
  }
  let within = nearest <= focus.radiusMeters;
  if (within && focus.horizonCull) {
    const span = tileAngularSpan(tile);
    const lift = sagittaMeters(span / 2);
    const hull: Vec3[] = [];
    for (const point of points) for (const height of [bounds.min, bounds.max + lift]) hull.push(sampleTileSurface(tile, point.u, point.v, height).position);
    const center = hull.reduce((sum, p) => ({ x: sum.x + p.x / hull.length, y: sum.y + p.y / hull.length, z: sum.z + p.z / hull.length }), { x: 0, y: 0, z: 0 });
    const radius = Math.max(...hull.map(p => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z))) * 1.1;
    if (isSphereBelowHorizon(job.focusViewer, center, radius)) within = false;
  }
  // The region's own offset, expressed against the view's target so one traversal ranks both.
  const view = input.view;
  const toSelection = job.cartographic ? view.logicalHeight / view.renderHeight : 1;
  const focusSelectionTarget = job.cartographic ? 2 ** Math.max(0, -focus.offset) : 2 ** -focus.offset;
  return {
    within,
    footprint: worst * toSelection * (job.target / focusSelectionTarget),
    physicalFootprint: worst * (job.physicalTarget / 2 ** -focus.offset),
  };
}

/**
 * About how many standard pages the focus region needs, before any is
 * selected. Ground at distance d wants image pixels of d·α·t metres (α the
 * pixel angle, t the target, 2^−offset), and a leaf lands between half and all
 * of that, so a ring of width dd holds 2π·d·dd / (W·d·α·t/√2)² pages of W px.
 * Nearer than the camera's distance D the density stays at D's, and with the
 * horizon culled nothing past the raised viewer's horizon counts. On flat
 * ground that sums to 2π/(W·α·t)² · (1 + 2·ln(R/D)).
 */
export function estimateFocusPages(focus: Pick<ImageryFocus, "position" | "radiusMeters" | "minDistanceMeters" | "pixelAngle" | "offset" | "horizonCull">): number {
  const distance = Math.max(1, focus.minDistanceMeters);
  const earth = Math.hypot(focus.position.x, focus.position.y, focus.position.z);
  const horizon = Math.sqrt(2 * earth * distance + distance * distance);
  const radius = focus.horizonCull ? Math.min(focus.radiusMeters, horizon) : focus.radiusMeters;
  const perRing = (2 * Math.PI) / (STANDARD_PAGE_SIZE * focus.pixelAngle * 2 ** -focus.offset) ** 2;
  return radius <= distance ? perRing * (radius / distance) ** 2 : perRing * (1 + 2 * Math.log(radius / distance));
}

function evaluate(job: Job, tile: TileId): Evaluated {
  if (!job.focus) return evaluateView(job, tile);
  if (job.focus.mode === "around") {
    // Only the focus region: the view does not decide what loads.
    job.nodes += 1;
    const focus = measureFocus(job, tile);
    return {
      tile, key: tileKey(tile), visible: focus.within, footprint: focus.within ? focus.footprint : 0,
      physicalFootprint: focus.within ? focus.physicalFootprint : 0, screenArea: 0,
      outsideCoverage: outsideCoverage(job.input.source, tile), limit: null, inFocus: focus.within,
    };
  }
  const result = evaluateView(job, tile);
  const focus = measureFocus(job, tile);
  if (focus.within) {
    result.visible = true;
    result.inFocus = true;
    result.footprint = Math.max(result.footprint, focus.footprint);
    result.physicalFootprint = Math.max(result.physicalFootprint, focus.physicalFootprint);
  }
  return result;
}

function evaluateView(job: Job, tile: TileId): Evaluated {
  const { input } = job;
  const { view, source } = input;
  job.nodes += 1;
  const result: Evaluated = {
    tile, key: tileKey(tile), visible: false, footprint: 0, physicalFootprint: 0, screenArea: 0,
    outsideCoverage: outsideCoverage(source, tile), limit: null, inFocus: false,
  };
  const bounds = input.surface.boundsFor(tile);
  const span = tileAngularSpan(tile);
  const nearest = nearestLocal(tile, job.camera);
  const m = view.ecefToClip;

  // Hull: a 3x3 grid and the nearest point, at the lowest height and at the
  // highest lifted by the curvature between grid points.
  const hullPoints: Array<{ u: number; v: number }> = [];
  for (const v of GRID) for (const u of GRID) hullPoints.push({ u, v });
  hullPoints.push(nearest);
  const lift = sagittaMeters(span / 2);
  let allOutside = 0b11111;
  let anyAboveHorizon = false;
  const hull: Array<{ x: number; y: number; z: number }> = [];
  for (const point of hullPoints) {
    for (const height of [bounds.min, bounds.max + lift]) {
      const sample = sampleTileSurface(tile, point.u, point.v, height);
      hull.push(sample.position);
      allOutside &= outcode(view, toClip(m, sample.position));
      if (!anyAboveHorizon && !isBelowHorizon(view.camera, sample.position)) anyAboveHorizon = true;
    }
  }
  if (allOutside !== 0) return result;
  // A tile wider than the visible cap could hide its visible part between
  // samples, so only small tiles are rejected point by point. Any tile is
  // rejected when its whole bounding sphere is behind the globe.
  if (!anyAboveHorizon && span < IMAGERY_SELECTION_CONSTANTS.horizonTileSpan) return result;
  const center = hull.reduce((sum, p) => ({ x: sum.x + p.x / hull.length, y: sum.y + p.y / hull.length, z: sum.z + p.z / hull.length }), { x: 0, y: 0, z: 0 });
  const radius = Math.max(...hull.map(p => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z))) * 1.1;
  if (isSphereBelowHorizon(view.camera, center, radius)) return result;
  result.visible = true;

  const selectionWidth = job.cartographic ? view.logicalWidth : view.renderWidth;
  const selectionHeight = job.cartographic ? view.logicalHeight : view.renderHeight;
  const measured = hullPoints.map(point => {
    const surface = surfaceSample(input, tile, point.u, point.v, bounds.max);
    const clip = toClip(m, surface.position);
    return { ...point, surface, clip, inside: outcode(view, clip) === 0 };
  });
  const measure: SurfaceSample[] = measured.filter(sample => sample.inside).map(sample => sample.surface);
  // Bisect from an inside sample toward outside ones to measure where the
  // surface meets the view's edge or the near plane.
  const from = measured.find(sample => sample.inside);
  if (from) {
    for (const outside of measured.filter(sample => !sample.inside).slice(0, 4)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2;
        const probe = surfaceSample(input, tile, from.u + (outside.u - from.u) * mid, from.v + (outside.v - from.v) * mid, bounds.max);
        if (outcode(view, toClip(m, probe.position)) === 0) lo = mid; else hi = mid;
      }
      measure.push(surfaceSample(input, tile, from.u + (outside.u - from.u) * lo, from.v + (outside.v - from.v) * lo, bounds.max));
    }
  }
  if (measure.length === 0) {
    // No sample of the actual surface is in view. Loose height bounds can make
    // a tile look visible while its surface is not; test a hull at the heights
    // actually sampled before deciding it straddles the view.
    const heights = hullPoints.map(point => {
      const { latDeg, lonDeg } = latLonAt(tile, point.u, point.v);
      return input.surface.heightAt(latDeg, lonDeg);
    });
    if (heights.every(height => height !== null)) {
      const known = heights as number[];
      const low = Math.min(...known), high = Math.max(...known);
      const margin = Math.max(100, (high - low) * 0.5);
      let outside = 0b11111;
      for (const point of hullPoints) {
        for (const height of [low - margin, high + margin + lift]) {
          outside &= outcode(view, toClip(m, sampleTileSurface(tile, point.u, point.v, height).position));
        }
      }
      if (outside !== 0) {
        result.visible = false;
        return result;
      }
    }
    // A tile around the view is measured where screen rays meet it; one just
    // past the view's edge measures like its visible neighbours.
    const west = tileLonDeg(tile.z, tile.x), east = tileLonDeg(tile.z, tile.x + 1);
    const north = tileLatDeg(tile.z, tile.y), south = tileLatDeg(tile.z, tile.y + 1);
    for (const point of job.screenGround) {
      if (point.lonDeg < west || point.lonDeg > east || point.latDeg < south || point.latDeg > north) continue;
      const at = lonLatToTileXY(point.lonDeg, point.latDeg, tile.z);
      measure.push(surfaceSample(input, tile, at.x - tile.x, at.y - tile.y, bounds.max));
    }
    if (measure.length === 0) {
      for (const sample of measured) {
        if ((outcode(view, sample.clip) & 16) === 0) measure.push(sample.surface);
      }
    }
  }
  if (measure.length === 0) {
    // Every sample is behind the near plane: the tile surrounds the camera,
    // so it is large on screen and has to be split before it can be measured.
    result.footprint = Infinity;
    result.physicalFootprint = Infinity;
    result.screenArea = view.renderWidth * view.renderHeight;
    return result;
  }
  for (const sample of measure) {
    const selection = projectedPixelFootprint(view, sample, source.tileWidth, source.tileHeight, selectionWidth, selectionHeight);
    const physical = job.cartographic
      ? projectedPixelFootprint(view, sample, source.tileWidth, source.tileHeight, view.renderWidth, view.renderHeight)
      : selection;
    if (selection !== null) result.footprint = Math.max(result.footprint, selection);
    if (physical !== null) result.physicalFootprint = Math.max(result.physicalFootprint, physical);
  }

  // Screen area from the grid's four quads with vertices kept in the viewport.
  const screen = measured.slice(0, 9).map(sample => toScreen(view, sample.clip, view.renderWidth, view.renderHeight));
  const clampX = (value: number) => Math.max(0, Math.min(view.renderWidth, value));
  const clampY = (value: number) => Math.max(0, Math.min(view.renderHeight, value));
  for (const quad of QUADS) {
    const points = quad.map(index => screen[index]);
    if (points.some(point => point === null)) continue;
    let twice = 0;
    for (let i = 0; i < 4; i++) {
      const p = points[i]!, q = points[(i + 1) % 4]!;
      twice += clampX(p.x) * clampY(q.y) - clampX(q.x) * clampY(p.y);
    }
    result.screenArea += Math.abs(twice) / 2;
  }
  return result;
}

export interface ImagerySelectorStep {
  /** The newest complete plan; the previous one while a traversal is still running. */
  plan: ImageryPlan | null;
  /** True when this call finished a traversal. */
  completed: boolean;
  /** True while a traversal awaits more work. */
  running: boolean;
}

export interface ImagerySelector {
  /**
   * Advances selection until `deadline`, a `clock()` time. A new traversal
   * starts from `input` when none is running. A running traversal keeps its
   * own snapshot unless `restart` is set, e.g. for a source or target change;
   * an incomplete traversal leaves the previous plan in force.
   */
  step(input: ImagerySelectionInput, deadline: number, clock?: () => number, restart?: boolean): ImagerySelectorStep;
  getPlan(): ImageryPlan | null;
  isRunning(): boolean;
  /** Forgets hysteresis history and any running traversal, e.g. after a source switch. */
  reset(): void;
}

export function createImagerySelector(): ImagerySelector {
  let memory = new Map<string, NodeMemory>();
  let job: Job | null = null;
  let plan: ImageryPlan | null = null;

  function begin(input: ImagerySelectionInput): Job {
    const cartographic = input.source.kind === "cartographic";
    const physicalTarget = (input.normalTargetPx ?? 1) * 2 ** -input.offset;
    // Cartographic levels keep readable map scale in logical pixels: finer
    // offsets never advance them, coarser ones may choose parents.
    const target = cartographic ? 2 ** Math.max(0, -input.offset) : physicalTarget;
    const focus = input.focus ?? null;
    const focusPosition = focus?.position ?? { x: 0, y: 0, z: 0 };
    const focusGeo = ecefToGeodetic(focusPosition.x, focusPosition.y, focusPosition.z);
    const up = Math.hypot(focusPosition.x, focusPosition.y, focusPosition.z) || 1;
    const lift = focus ? focus.minDistanceMeters / up : 0;
    const next: Job = {
      input, sourceKey: imageSourceKey(input.source), target, physicalTarget, cartographic,
      camera: cameraLonLat(input.view),
      screenGround: [],
      focus,
      focusLonLat: { lonDeg: (focusGeo.lonRad * 180) / Math.PI, latDeg: (focusGeo.latRad * 180) / Math.PI },
      focusViewer: { x: focusPosition.x * (1 + lift), y: focusPosition.y * (1 + lift), z: focusPosition.z * (1 + lift) },
      heap: [], leaves: [], coverage: [], mergeCandidates: [], leafCount: 0, nodes: 0, limits: new Set(),
      nextMemory: new Map(), wakeAt: null, truncated: false, cpuMs: 0,
    };
    {
      // The ground under the camera sets the sphere the screen rays meet.
      const camera = next.camera;
      const ground = input.surface.heightAt(camera.latDeg, camera.lonDeg) ?? 0;
      const lat = (camera.latDeg * Math.PI) / 180;
      const surfaceRadius = Math.hypot(6378137 * Math.cos(lat), 6356752.314245 * Math.sin(lat)) + ground;
      next.screenGround = screenGroundPoints(input.view, surfaceRadius);
    }
    const root = Math.max(input.source.minLevel, Math.min(IMAGERY_SELECTION_CONSTANTS.rootLevel, input.source.maxLevel));
    const count = 2 ** root;
    for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
      const tile = { z: root, x, y };
      next.coverage.push(tile);
      const evaluated = evaluate(next, tile);
      if (!evaluated.visible) continue;
      next.leafCount += 1;
      heapPush(next.heap, evaluated);
    }
    return next;
  }

  /** Split or keep one node, applying hysteresis, pinning and source limits. */
  function decide(current: Job, node: Evaluated): { split: boolean; coarsenSince: number | null } {
    const { input } = current;
    const previous = memory.get(node.key);
    const now = input.now;
    // An existing leaf refines only past 1.2x its target; a new node at 1x.
    const { hysteresis } = input;
    const threshold = previous && !previous.split ? hysteresis.refineAbove : 1;
    const over = node.footprint > current.target * threshold;
    let split = over;
    let coarsenSince: number | null = null;
    if (previous?.split && !over) {
      // Merge only once the parent has been coarse enough for a while, the
      // children have been shown long enough, and the parent can be shown.
      const coarseEnough = node.footprint < current.target * hysteresis.coarsenBelow;
      coarsenSince = coarseEnough ? previous.coarsenSince ?? now : null;
      if (coarsenSince !== null) {
        const mergeAt = Math.max(
          coarsenSince + hysteresis.coarsenAfterMs,
          previous.since + hysteresis.pinMs,
        );
        const parentUsable = input.availability.isResident(imageKey(input.source, node.tile, null));
        split = !(now >= mergeAt && parentUsable);
        if (split && parentUsable) current.wakeAt = Math.min(current.wakeAt ?? Infinity, mergeAt);
        // A merge needs the parent's own image; ask for it rather than wait forever.
        if (split && !parentUsable) current.mergeCandidates.push(node.tile);
      } else {
        split = true;
      }
    }
    if (!split) return { split, coarsenSince: null };
    const maxLevel = Math.min(input.source.maxLevel, input.maxLevelFor?.(node.tile) ?? Infinity);
    if (node.outsideCoverage) {
      node.limit = "source";
      return { split: false, coarsenSince: null };
    }
    // The source has no image here: its area shows the nearest ancestor, and
    // nothing below it is worth asking for.
    if (input.availability.isMissing(imageKey(input.source, node.tile, null))) {
      node.limit = "source";
      return { split: false, coarsenSince: null };
    }
    if (node.tile.z >= maxLevel) {
      node.limit = node.tile.z >= input.source.maxLevel ? "source" : "backend";
      return { split: false, coarsenSince: null };
    }
    if (childTiles(node.tile).every(child => input.availability.isMissing(imageKey(input.source, child, null)))) {
      node.limit = "source";
      return { split: false, coarsenSince: null };
    }
    return { split, coarsenSince };
  }

  function remember(current: Job, node: Evaluated, split: boolean, coarsenSince: number | null): void {
    const previous = memory.get(node.key);
    const changed = !previous || previous.split !== split;
    current.nextMemory.set(node.key, {
      split,
      since: changed ? current.input.now : previous.since,
      coarsenSince: split ? coarsenSince : null,
    });
  }

  function advance(current: Job, deadline: number, clock: () => number): boolean {
    const { input } = current;
    const started = clock();
    const maxNodes = input.maxNodes;
    let iterations = 0;
    while (current.heap.length > 0) {
      // Check the clock every few nodes; each evaluation costs microseconds.
      if (++iterations % 8 === 0 && clock() >= deadline) {
        current.cpuMs += clock() - started;
        return false;
      }
      const node = heapPop(current.heap)!;
      const decision = decide(current, node);
      const { coarsenSince } = decision;
      let { split } = decision;
      let children: Evaluated[] = [];
      if (split && current.nodes + 4 > maxNodes) {
        split = false;
        current.truncated = true;
        node.limit = "backend";
      }
      if (split) {
        children = childTiles(node.tile).map(child => evaluate(current, child));
        const visible = children.filter(child => child.visible).length;
        if (visible === 0) {
          // The hull was conservative and no child is actually in view: keep
          // the node, so a finer target never drops coverage it had, but it
          // has nothing on screen to measure or rank.
          split = false;
          node.footprint = 0;
          node.physicalFootprint = 0;
          node.screenArea = 0;
        } else if (current.leafCount - 1 + visible > input.maxPages) {
          split = false;
          node.limit = "memory";
        }
      }
      remember(current, node, split, coarsenSince);
      if (!split) {
        current.leaves.push(node);
        continue;
      }
      node.limit = null;
      current.leafCount -= 1;
      for (const child of children) {
        if (!child.visible) continue;
        current.leafCount += 1;
        heapPush(current.heap, child);
      }
    }
    current.cpuMs += clock() - started;
    return true;
  }

  function finish(current: Job): ImageryPlan {
    const { input } = current;
    const leaves: ImageryPlanLeaf[] = [];
    let pages = current.leaves.length;
    // Leaves come out in footprint order, so variant pages go where they help most.
    for (const node of current.leaves) {
      let limit = node.limit;
      let variant: string | null = null;
      let footprintPx = node.physicalFootprint;
      let imagePages = 1;
      const standardMissing = input.availability.isMissing(imageKey(input.source, node.tile, null));
      const atCeiling = node.tile.z >= input.source.maxLevel || limit === "source";
      // Cartographic leaves meet the physical sampling target with verified
      // same-zoom variants; photographic ones only where no finer level exists.
      // Nothing on screen gains from a denser image; it only costs pages.
      // The focus region counts as seen: its images must not depend on the view.
      const onScreen = node.screenArea > 0 || node.inFocus;
      const mayUseVariant = (current.cartographic || atCeiling) && onScreen && Number.isFinite(node.physicalFootprint);
      if (mayUseVariant && (footprintPx > current.physicalTarget || standardMissing)) {
        for (const candidate of input.source.variants) {
          if (input.availability.isMissing(imageKey(input.source, node.tile, candidate.id))) continue;
          const candidatePages = pagesForImage(candidate.width, candidate.height);
          if (pages - imagePages + candidatePages > input.maxPages) {
            if (limit === null) limit = "memory";
            break;
          }
          pages += candidatePages - imagePages;
          imagePages = candidatePages;
          variant = candidate.id;
          footprintPx = node.physicalFootprint * (input.source.tileWidth / candidate.width);
          if (footprintPx <= current.physicalTarget) break;
        }
      }
      if (variant === null && standardMissing) limit = "source";
      if (limit === null && footprintPx > current.physicalTarget && Number.isFinite(footprintPx)) {
        // A cartographic level is chosen for readable scale, so sampling
        // density it cannot reach at that level is the source's limit.
        if (current.cartographic || atCeiling) limit = "source";
      }
      // Only what is on screen limits what the user sees.
      if (limit && onScreen) current.limits.add(limit);
      leaves.push({
        tile: node.tile,
        key: node.key,
        variant,
        imageKey: imageKey(input.source, node.tile, variant),
        pages: imagePages,
        footprintPx,
        selectionFootprint: node.footprint,
        screenArea: node.screenArea,
        limit,
        inFocus: node.inFocus,
      });
    }
    memory = current.nextMemory;
    return {
      sourceKey: current.sourceKey,
      offset: input.offset,
      physicalTarget: current.physicalTarget,
      selectionTarget: current.target,
      leaves,
      coverage: current.coverage,
      mergeCandidates: current.mergeCandidates,
      limits: [...current.limits].sort(),
      nodesEvaluated: current.nodes,
      truncated: current.truncated,
      wakeAt: current.wakeAt,
      cpuMs: current.cpuMs,
    };
  }

  return {
    step(input, deadline, clock = () => performance.now(), restart = false) {
      if (restart) job = null;
      if (!job) {
        const started = clock();
        job = begin(input);
        job.cpuMs += clock() - started;
      }
      const done = advance(job, deadline, clock);
      if (!done) return { plan, completed: false, running: true };
      plan = finish(job);
      job = null;
      return { plan, completed: true, running: false };
    },
    getPlan: () => plan,
    isRunning: () => job !== null,
    reset() {
      memory = new Map();
      job = null;
      plan = null;
    },
  };
}
