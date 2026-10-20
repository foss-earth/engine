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

import { ecefToGeodetic } from "../../camera/cameraMath.js";
import type { DetailLimit } from "../mapDetailPolicy.js";
import {
  childTiles,
  clipOutcode,
  hullSphere,
  isBelowHorizon,
  isSphereBelowHorizon,
  lonLatToTileXY,
  outcode,
  projectedPixelFootprint,
  SCREEN_GROUND_RAYS,
  screenGroundPoints,
  sagittaMeters,
  sampleTileSurface,
  tileSurfaceBasis,
  positionOnTileBasis,
  tileAngularSpan,
  tileKey,
  tileLatDeg,
  tileLonDeg,
  tilesTouch,
  toClip,
  toScreen,
  type ImageryView,
  type SurfaceSample,
  type TileId,
  type Vec3,
} from "./imageryGeometry.js";

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
  /** Packed lat/lon pairs; NaN represents unknown. Float64 preserves the
   * reference interpolation and the slopes derived from it. */
  heightsAt?(coordinates: Float64Array): Float64Array;
  /** Conservative height bounds of a region from adopted terrain or coarse data. */
  boundsFor(tile: TileId): { min: number; max: number };
  /**
   * Changes whenever a height or bound this surface reports may change. When
   * given with `heightsAt`, the heights at points on a 65x65 lattice over each
   * tile are reused until it changes, and so are a view's measurements kept in
   * an `ImageryMeasurementCache`.
   */
  getRevision?(): number;
  /**
   * The tiles whose heights may have changed since `revision`, which
   * `getRevision` gave: at points of no tile touching them, `heightsAt` answers
   * as it did then. Null when that is not known. Given, a tile's lattice
   * heights are kept across revisions until a tile it touches changes.
   */
  changedSince?(revision: number): readonly TileId[] | null;
}

export interface ImageryAvailability {
  /** True when this image has a usable decoded page. */
  isResident(imageKey: string): boolean;
  /** True when the source is known not to have this image right now. */
  isMissing(imageKey: string): boolean;
  /**
   * Changes whenever residency changes. When given, a traversal looks again
   * for resident imagery it stopped short of only after it changed.
   */
  getRevision?(): number;
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
  /**
   * Where the regions the view sees are measured from:
   * `map.focus.refineBasemapFrom`. Null: their projected size in the view.
   */
  refineFrom?: ImageryRefinePoint | null;
  now: number;
}

/**
 * A point detail is measured from: a region's footprint is its image pixels'
 * size seen from the point, facing it, and never nearer than the camera is to
 * it. Turning or tilting the camera around the point changes no region's level.
 */
export interface ImageryRefinePoint {
  /** ECEF metres. */
  position: Vec3;
  /** No region is measured nearer than this, the camera's distance to the point. */
  minDistanceMeters: number;
  /** Radians one physical pixel spans at the centre of the view. */
  pixelAngle: number;
}

/**
 * A region around a focus point loaded in every direction, refined by its
 * distance from that point rather than by the view, so turning the camera
 * around the point loads nothing new.
 */
export interface ImageryFocus extends ImageryRefinePoint {
  /** "around": only the region loads. "both": it loads as well as the view. */
  mode: "around" | "both";
  radiusMeters: number;
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
  /** What `limit` stands for, as the log and the Map tab name it. */
  shortfall: ImageryShortfallCause | null;
  /** Within the focus region, so kept whatever the view. */
  inFocus: boolean;
  /**
   * The source does not have an ancestor's image, and nothing resident shows
   * it has this one: a resident ancestor stands in, and it is not requested.
   */
  presumedMissing: boolean;
}

/**
 * What keeps a region coarser than its target. The source's: its finest
 * level, no denser variant for a map's scale, an image it does not have
 * (or an ancestor's, below which nothing resident shows it has more), or its
 * coverage. The terrain binding's finest level, the node cap and the page
 * budget are this device's.
 */
export type ImageryShortfallCause = "ceiling" | "density" | "missing" | "outside" | "binding" | "nodes" | "pages";

/** The plan's limits in detail: what one traversal established, nothing more. */
export interface ImageryShortfall {
  /** On-screen regions coarser than the target, by cause. */
  regions: Record<ImageryShortfallCause, number>;
  /**
   * Pages one more level of each page-limited region would add: the least
   * the view needs beyond the budget. Finer levels could need more.
   */
  morePages: number;
  /** The finest levels the terrain binding allowed where it stopped refinement. */
  bindingLevels: { min: number; max: number } | null;
  /**
   * On-screen regions the page budget or node cap stops above resident
   * imagery the last plan showed: detail they took away, rather than a
   * request they do not meet.
   */
  reduced: { pages: number; nodes: number };
  /** Images the source does not have that selection refined past, on the way to resident imagery. Not a limit. */
  refinedPastMissing: number;
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
  shortfall: ImageryShortfall;
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
  shortfall: ImageryShortfallCause | null;
  /** Pages one more level would have added, when the page budget refused it. */
  extraPages: number;
  /** The finest level the terrain binding allows here, when it stopped refinement. */
  bindingLevel: number | null;
  /** Inside the focus region: loaded whatever the view. */
  inFocus: boolean;
  /**
   * Below an image the source does not have, reached only on the way to
   * resident imagery: refined further only on that way, or once an image of
   * its own is resident.
   */
  unproven: boolean;
  /** Refined past an image the source does not have, or past four missing children: its children are unproven. */
  pastMissing: boolean;
  presumedMissing: boolean;
  /** A budget stopped it although resident imagery the last plan showed lies below it. */
  reduced: boolean;
}

/**
 * Resident imagery the last complete plan showed: each leaf's own image, or
 * else its finest resident ancestor, the page standing in for it. Its paths
 * prove the source has imagery below an image it reports missing, so a
 * missing ancestor never discards it. Only current residency counts: a split
 * that loaded nothing, a request in flight or an evicted page proves nothing.
 */
interface Evidence {
  /** Strict ancestors, "z/x/y", of that resident imagery. */
  leadsTo: Set<string>;
  /** `availability.getRevision()` when gathered. */
  revision: number | null;
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
  refine: RefineContext | null;
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
  /** Gathered when the traversal first meets a missing image; null until then. */
  evidence: Evidence | null;
  /** Leaves stopped at a missing image for want of resident imagery below: taken up again if some arrives. */
  barred: Evaluated[];
  refinedPastMissing: number;
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
/** The 3x3 grid's points, row by row. */
const GRID_POINTS: ReadonlyArray<{ u: number; v: number }> = GRID.flatMap(v => GRID.map(u => ({ u, v })));
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
function surfaceSample(input: Pick<ImagerySelectionInput, "surface">, tile: TileId, u: number, v: number, fallbackHeight: number): SurfaceSample {
  if (input.surface.heightsAt) return surfaceSamples(input, tile, [{ u, v }], fallbackHeight)[0];
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
 * What a tile gives at one surface revision: a traversal, the focus and the
 * loaded-detail measurements ask for the same points many times between
 * surface changes. Kept for points on a 65x65 lattice over the tile, which
 * holds the 3x3 grid, its corners as nearest points, and the bisection probes
 * between grid points. A point's height depends only on the point and the
 * surface, never on the rest of its batch, so leaving known points out of a
 * batch changes nothing; samples and hull positions are kept with the
 * fallback and bounds they were taken at. A surface that names the tiles a
 * revision changed keeps the others' entries into the next revision.
 */
interface TileSurface {
  tile: TileId;
  /** Centre, east and south heights of lattice points, as `heightsAt` answered them. */
  heights: Map<number, Float64Array>;
  /** Lattice points' samples, and the fallback height each was taken with. */
  samples: Map<number, { sample: SurfaceSample; fallback: number }>;
  /** The grid's hull positions, low then high at each point, at the heights they were taken at. */
  hull: { low: number; high: number; positions: Vec3[] } | null;
  /** The revision's record, which counts the points kept for all tiles. */
  owner: { points: number };
}
const tileSurfaces = new WeakMap<ImagerySurface, { revision: number; points: number; tiles: Map<string, TileSurface> }>();
const LATTICE = 64, MAX_LATTICE_POINTS = 1 << 17;

/** The tile's entry at the surface's current revision, or null for a surface without revisions. */
function tileSurface(surface: ImagerySurface, tile: TileId, key = tileKey(tile)): TileSurface | null {
  const revision = surface.getRevision?.();
  if (revision === undefined) return null;
  let cached = tileSurfaces.get(surface);
  if (cached && cached.revision !== revision && cached.points < MAX_LATTICE_POINTS) {
    // Only a tile touching one that changed can answer differently now.
    const changed = surface.changedSince?.(cached.revision);
    if (changed) {
      if (changed.length > 0) for (const [kept, entry] of cached.tiles) {
        if (!changed.some(other => tilesTouch(entry.tile, other))) continue;
        cached.points -= entry.heights.size;
        cached.tiles.delete(kept);
      }
      cached.revision = revision;
    }
  }
  if (!cached || cached.revision !== revision || cached.points >= MAX_LATTICE_POINTS) tileSurfaces.set(surface, cached = { revision, points: 0, tiles: new Map() });
  let entry = cached.tiles.get(key);
  if (!entry) cached.tiles.set(key, entry = { tile: { z: tile.z, x: tile.x, y: tile.y }, heights: new Map(), samples: new Map(), hull: null, owner: cached });
  return entry;
}

/** The point's place on the tile's lattice, row by row, or -1 off it. */
function latticeIndex(u: number, v: number): number {
  const column = u * LATTICE, row = v * LATTICE;
  return Number.isInteger(column) && Number.isInteger(row) && column >= 0 && column <= LATTICE && row >= 0 && row <= LATTICE
    ? row * (LATTICE + 1) + column : -1;
}

/** A point's centre, east and south probes as lat/lon pairs, from `at` in `coordinates`. */
function writeProbes(coordinates: Float64Array, at: number, tile: TileId, u: number, v: number): void {
  const uStep = u + SLOPE_STEP <= 1 ? SLOPE_STEP : -SLOPE_STEP;
  const vStep = v + SLOPE_STEP <= 1 ? SLOPE_STEP : -SLOPE_STEP;
  [[u, v], [u + uStep, v], [u, v + vStep]].forEach(([uu, vv], j) => {
    const position = latLonAt(tile, uu, vv);
    coordinates[at + j * 2] = position.latDeg; coordinates[at + j * 2 + 1] = position.lonDeg;
  });
}

/** A sample from a point's centre, east and south heights, at `at` in `heights`. */
function probedSample(tile: TileId, u: number, v: number, heights: Float64Array, at: number, fallbackHeight: number): SurfaceSample {
  const height = heights[at], east = heights[at + 1], south = heights[at + 2];
  const known = !Number.isNaN(height), h = known ? height : fallbackHeight;
  const uStep = u + SLOPE_STEP <= 1 ? SLOPE_STEP : -SLOPE_STEP;
  const vStep = v + SLOPE_STEP <= 1 ? SLOPE_STEP : -SLOPE_STEP;
  return sampleTileSurface(tile, u, v, h, known && !Number.isNaN(east) ? (east - h) / uStep : 0,
    known && !Number.isNaN(south) ? (south - h) / vStep : 0);
}

/** All centre/east/south probes cross the height-query seam as one contiguous
 * batch. The complete scalar path remains the reference for other surfaces. */
function surfaceSamples(input: Pick<ImagerySelectionInput, "surface">, tile: TileId,
  points: ReadonlyArray<{ u: number; v: number }>, fallbackHeight: number): SurfaceSample[] {
  const surface = input.surface;
  if (!surface.heightsAt) return points.map(({ u, v }) => surfaceSample(input, tile, u, v, fallbackHeight));
  // Lattice points known at this revision are not asked for again.
  const lattice = points.map(({ u, v }) => latticeIndex(u, v));
  const known = lattice.some(index => index >= 0) ? tileSurface(surface, tile) : null;
  const slots = points.map(() => -1);
  let asked = 0;
  points.forEach((_, i) => { if (!known || lattice[i] < 0 || !known.heights.has(lattice[i])) slots[i] = asked++; });
  let heights: Float64Array | null = null;
  if (asked > 0) {
    const coordinates = new Float64Array(asked * 6);
    points.forEach(({ u, v }, i) => { if (slots[i] >= 0) writeProbes(coordinates, slots[i] * 6, tile, u, v); });
    heights = surface.heightsAt(coordinates);
    if (heights.length !== asked * 3) throw new Error("Imagery height batch has the wrong length");
    if (known) points.forEach((_, i) => {
      if (slots[i] < 0 || lattice[i] < 0) return;
      known.heights.set(lattice[i], heights!.subarray(slots[i] * 3, slots[i] * 3 + 3));
      known.owner.points += 1;
    });
  }
  return points.map(({ u, v }, i) => {
    const index = lattice[i];
    if (!known || index < 0) return probedSample(tile, u, v, heights!, slots[i] * 3, fallbackHeight);
    // A known height's sample does not depend on the fallback.
    const probes = known.heights.get(index)!;
    let kept = known.samples.get(index);
    if (!kept || Number.isNaN(probes[0]) && !Object.is(kept.fallback, fallbackHeight)) {
      known.samples.set(index, kept = { sample: probedSample(tile, u, v, probes, 0, fallbackHeight), fallback: fallbackHeight });
    }
    return kept.sample;
  });
}

/**
 * Heights at points of a tile, as `heightAt` gives them, with null where a
 * kept lattice height is NaN: lattice points whose heights `surfaceSamples`
 * kept at this revision are not asked for again.
 */
function surfaceHeights(surface: ImagerySurface, tile: TileId, points: ReadonlyArray<{ u: number; v: number }>, key = tileKey(tile)): Array<number | null> {
  const known = surface.heightsAt ? tileSurface(surface, tile, key) : null;
  return points.map(({ u, v }) => {
    const index = latticeIndex(u, v), probes = index >= 0 ? known?.heights.get(index) : undefined;
    if (probes) return Number.isNaN(probes[0]) ? null : probes[0];
    const { latDeg, lonDeg } = latLonAt(tile, u, v);
    return surface.heightAt(latDeg, lonDeg);
  });
}

/** A refine point and where it lies, worked out once per traversal. */
interface RefineContext {
  point: ImageryRefinePoint;
  lonLat: { lonDeg: number; latDeg: number };
  altitudeMeters: number;
}

function refineContext(point: ImageryRefinePoint): RefineContext {
  const geo = ecefToGeodetic(point.position.x, point.position.y, point.position.z);
  return { point, lonLat: { lonDeg: (geo.lonRad * 180) / Math.PI, latDeg: (geo.latRad * 180) / Math.PI }, altitudeMeters: geo.altMeters };
}

/**
 * A tile's nearest distance to a point and its worst footprint seen from
 * there, facing it, never nearer than `point.minDistanceMeters`: physical
 * pixels per image pixel. Where a height is unknown the surface is taken at
 * `fallbackHeight`.
 */
function footprintFrom(
  input: Pick<ImagerySelectionInput, "surface" | "source">,
  tile: TileId,
  points: ReadonlyArray<{ u: number; v: number }>,
  point: ImageryRefinePoint,
  fallbackHeight: number,
): { nearest: number; worst: number } {
  let nearest = Infinity;
  let worst = 0;
  for (const sample of surfaceSamples(input, tile, points, fallbackHeight)) {
    const d = Math.hypot(sample.position.x - point.position.x, sample.position.y - point.position.y, sample.position.z - point.position.z);
    nearest = Math.min(nearest, d);
    const pixelMeters = Math.max(
      Math.hypot(sample.du.x, sample.du.y, sample.du.z) / input.source.tileWidth,
      Math.hypot(sample.dv.x, sample.dv.y, sample.dv.z) / input.source.tileHeight,
    );
    worst = Math.max(worst, pixelMeters / Math.max(1, d, point.minDistanceMeters) / point.pixelAngle);
  }
  return { nearest, worst };
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
  const points = [...GRID_POINTS, nearestLocal(tile, job.focusLonLat)];
  const { nearest, worst } = footprintFrom(input, tile, points, focus, bounds.max);
  let within = nearest <= focus.radiusMeters;
  if (within && focus.horizonCull) {
    const span = tileAngularSpan(tile);
    const lift = sagittaMeters(span / 2);
    const hull: Vec3[] = [];
    for (const point of points) {
      const basis = tileSurfaceBasis(tile, point.u, point.v);
      for (const height of [bounds.min, bounds.max + lift]) hull.push(positionOnTileBasis(basis, height));
    }
    const { center, radius } = hullSphere(hull);
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

function unmeasured(tile: TileId, outside: boolean): Evaluated {
  return {
    tile, key: tileKey(tile), visible: false, footprint: 0, physicalFootprint: 0, screenArea: 0, outsideCoverage: outside,
    limit: null, shortfall: null, extraPages: 0, bindingLevel: null, inFocus: false,
    unproven: false, pastMissing: false, presumedMissing: false, reduced: false,
  };
}

function evaluate(job: Job, tile: TileId): Evaluated {
  if (!job.focus) return evaluateView(job, tile);
  if (job.focus.mode === "around") {
    // Only the focus region: the view does not decide what loads.
    job.nodes += 1;
    const focus = measureFocus(job, tile);
    return {
      ...unmeasured(tile, outsideCoverage(job.input.source, tile)), visible: focus.within,
      footprint: focus.within ? focus.footprint : 0, physicalFootprint: focus.within ? focus.physicalFootprint : 0, inFocus: focus.within,
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

type ViewMeasurementContext = Pick<Job, "cartographic" | "camera" | "screenGround" | "nodes"> & Partial<Pick<Job, "refine">> & {
  input: Pick<ImagerySelectionInput, "view" | "source" | "surface">;
};

/**
 * Regions measured at one view, given again when the same view measures them:
 * the loaded-detail readouts measure a plan's regions and the loaded pages,
 * mostly the same tiles, at each view, and measure again as pages arrive
 * while the view holds still. A region is given again only at a view, source,
 * surface revision and camera ground equal to the bit, while its bounds hold.
 */
export interface ImageryMeasurementCache {
  /** Regions given without measuring them again. */
  reused: number;
  kept: { surface: ImagerySurface; revision: number; ground: number; view: unknown[]; source: unknown[]; regions: Map<string, KeptMeasurement> } | null;
}
interface KeptMeasurement { min: number; max: number; footprintPx: number; screenArea: number }
const MAX_KEPT_MEASUREMENTS = 1 << 14;

export function createImageryMeasurementCache(): ImageryMeasurementCache {
  return { reused: 0, kept: null };
}

/** Every value in a plain object, keys sorted and arrays by element: equal lists describe the same view or source. */
function flatValues(value: unknown, out: unknown[] = []): unknown[] {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const list = value as unknown as ArrayLike<unknown>;
      out.push(list.length);
      for (let i = 0; i < list.length; i++) flatValues(list[i], out);
    } else for (const key of Object.keys(value).sort()) { out.push(key); flatValues((value as Record<string, unknown>)[key], out); }
  } else out.push(value);
  return out;
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** The cache's regions for this view, started again when anything they were measured with changed; null for a surface without revisions. */
function keptMeasurements(cache: ImageryMeasurementCache, input: ViewMeasurementContext["input"], ground: number): Map<string, KeptMeasurement> | null {
  const revision = input.surface.getRevision?.();
  if (revision === undefined) return null;
  const view = flatValues(input.view), source = flatValues(input.source);
  const kept = cache.kept;
  if (kept && kept.surface === input.surface && kept.revision === revision && Object.is(kept.ground, ground)
    && kept.regions.size < MAX_KEPT_MEASUREMENTS && sameValues(kept.view, view) && sameValues(kept.source, source)) return kept.regions;
  cache.kept = { surface: input.surface, revision, ground, view, source, regions: new Map() };
  return cache.kept.regions;
}

/**
 * Measures existing regions from the view alone, independent of a loading
 * focus. Optional coverage fills gaps outside the selected leaves, splitting
 * roots only along existing leaf paths; it never traverses for more detail.
 * With a cache, regions it measured at the same view are not measured again.
 */
export function measureImageryView(input: ViewMeasurementContext["input"], tiles: readonly TileId[], coverage: readonly TileId[] = [], cache?: ImageryMeasurementCache): Array<{ tile: TileId; footprintPx: number; screenArea: number }> {
  const camera = cameraLonLat(input.view);
  const ground = input.surface.heightAt(camera.latDeg, camera.lonDeg) ?? 0;
  const lat = camera.latDeg * Math.PI / 180;
  const radius = Math.hypot(6378137 * Math.cos(lat), 6356752.314245 * Math.sin(lat)) + ground;
  const context: ViewMeasurementContext = {
    input, camera, cartographic: input.source.kind === "cartographic",
    screenGround: screenGroundPoints(input.view, radius), nodes: 0,
  };
  const regions: TileId[] = [];
  if (coverage.length > 0) {
    const ancestors = new Set<string>();
    for (const tile of tiles) {
      let { z, x, y } = tile;
      while (z > 0) {
        z--; x >>= 1; y >>= 1;
        const key = `${z}/${x}/${y}`;
        if (ancestors.has(key)) break;
        ancestors.add(key);
      }
    }
    const visit = (tile: TileId): void => {
      if (!ancestors.has(tileKey(tile))) { regions.push(tile); return; }
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) visit({ z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy });
    };
    for (const tile of coverage) visit(tile);
  } else regions.push(...tiles);
  const kept = cache ? keptMeasurements(cache, input, ground) : null;
  return regions.map(tile => {
    if (!kept) {
      const measured = evaluateView(context, tile);
      return { tile, footprintPx: measured.physicalFootprint, screenArea: measured.screenArea };
    }
    const key = tileKey(tile), bounds = input.surface.boundsFor(tile);
    let known = kept.get(key);
    if (known && Object.is(known.min, bounds.min) && Object.is(known.max, bounds.max)) cache!.reused += 1;
    else {
      const measured = evaluateView(context, tile, bounds);
      kept.set(key, known = { min: bounds.min, max: bounds.max, footprintPx: measured.physicalFootprint, screenArea: measured.screenArea });
    }
    return { tile, footprintPx: known.footprintPx, screenArea: known.screenArea };
  });
}

function evaluateView(job: ViewMeasurementContext, tile: TileId, bounds = job.input.surface.boundsFor(tile)): Evaluated {
  const { input } = job;
  const { view, source } = input;
  job.nodes += 1;
  const result = unmeasured(tile, outsideCoverage(source, tile));
  const span = tileAngularSpan(tile);
  const nearest = nearestLocal(tile, job.camera);
  const m = view.ecefToClip;

  // Hull: a 3x3 grid and the nearest point, at the lowest height and at the
  // highest lifted by the curvature between grid points.
  const hullPoints = [...GRID_POINTS, nearest];
  const lift = sagittaMeters(span / 2);
  let allOutside = 0b11111;
  let anyAboveHorizon = false;
  const hull: Array<{ x: number; y: number; z: number }> = [];
  // The grid's positions depend only on the tile and the two heights.
  const low = bounds.min, high = bounds.max + lift;
  const grid = tileSurface(input.surface, tile, result.key);
  if (grid && !(grid.hull && Object.is(grid.hull.low, low) && Object.is(grid.hull.high, high))) {
    grid.hull = { low, high, positions: GRID_POINTS.flatMap(point => [low, high].map(height => sampleTileSurface(tile, point.u, point.v, height).position)) };
  }
  hullPoints.forEach((point, i) => {
    for (let j = 0; j < 2; j++) {
      const position = grid?.hull && i < 9 ? grid.hull.positions[i * 2 + j] : sampleTileSurface(tile, point.u, point.v, j === 0 ? low : high).position;
      hull.push(position);
      allOutside &= clipOutcode(view, m, position);
      if (!anyAboveHorizon && !isBelowHorizon(view.camera, position)) anyAboveHorizon = true;
    }
  });
  if (allOutside !== 0) return result;
  // A tile wider than the visible cap could hide its visible part between
  // samples, so only small tiles are rejected point by point. Any tile is
  // rejected when its whole bounding sphere is behind the globe.
  if (!anyAboveHorizon && span < IMAGERY_SELECTION_CONSTANTS.horizonTileSpan) return result;
  const { center, radius } = hullSphere(hull);
  if (isSphereBelowHorizon(view.camera, center, radius)) return result;
  result.visible = true;

  const selectionWidth = job.cartographic ? view.logicalWidth : view.renderWidth;
  const selectionHeight = job.cartographic ? view.logicalHeight : view.renderHeight;
  const surfaces = surfaceSamples(input, tile, hullPoints, bounds.max);
  const measured = hullPoints.map((point, i) => {
    const surface = surfaces[i];
    const clip = toClip(m, surface.position);
    return { u: point.u, v: point.v, surface, clip, inside: outcode(view, clip) === 0 };
  });
  const measure: SurfaceSample[] = measured.filter(sample => sample.inside).map(sample => sample.surface);
  /** The screen rays that meet the ground inside this tile. */
  const raysWithin = (): Array<{ latDeg: number; lonDeg: number }> => {
    const west = tileLonDeg(tile.z, tile.x), east = tileLonDeg(tile.z, tile.x + 1);
    const north = tileLatDeg(tile.z, tile.y), south = tileLatDeg(tile.z, tile.y + 1);
    return job.screenGround.filter(point => point.lonDeg >= west && point.lonDeg <= east && point.latDeg >= south && point.latDeg <= north);
  };
  // Bisect from an inside sample toward outside ones to measure where the
  // surface meets the view's edge or the near plane.
  const from = measured.find(sample => sample.inside);
  // Measured from a point, the view only has to show the tile is seen.
  const refine = job.refine ?? null;
  if (from && !refine) {
    // Each outside sample bisects on its own; their probes go to the surface together, a step at a time.
    const outsides = measured.filter(sample => !sample.inside).slice(0, 4);
    const lo = outsides.map(() => 0), hi = outsides.map(() => 1);
    const toward = (fractions: number[]) => outsides.map((outside, k) => ({
      u: from.u + (outside.u - from.u) * fractions[k], v: from.v + (outside.v - from.v) * fractions[k],
    }));
    for (let i = 0; i < 5 && outsides.length > 0; i++) {
      const mids = outsides.map((_, k) => (lo[k] + hi[k]) / 2);
      surfaceSamples(input, tile, toward(mids), bounds.max).forEach((probe, k) => {
        if (clipOutcode(view, m, probe.position) === 0) lo[k] = mids[k]; else hi[k] = mids[k];
      });
    }
    if (outsides.length > 0) measure.push(...surfaceSamples(input, tile, toward(lo), bounds.max));
  }
  if (measure.length === 0) {
    // No sample of the actual surface is in view. Loose height bounds can make
    // a tile look visible while its surface is not; test a hull at the heights
    // actually sampled before deciding it straddles the view.
    const heights = surfaceHeights(input.surface, tile, hullPoints, result.key);
    if (heights.every(height => height !== null)) {
      const known = heights as number[];
      const low = Math.min(...known), high = Math.max(...known);
      const margin = Math.max(100, (high - low) * 0.5);
      let outside = 0b11111;
      const positionScratch = { x: 0, y: 0, z: 0 };
      for (const point of hullPoints) {
        const basis = tileSurfaceBasis(tile, point.u, point.v);
        for (const height of [low - margin, high + margin + lift]) {
          outside &= clipOutcode(view, m, positionOnTileBasis(basis, height, positionScratch));
        }
      }
      if (outside !== 0) {
        result.visible = false;
        return result;
      }
    }
    // A tile around the view is measured where screen rays meet it; one just
    // past the view's edge measures like its visible neighbours.
    if (!refine) {
      const rays = raysWithin().map(point => {
        const at = lonLatToTileXY(point.lonDeg, point.latDeg, tile.z);
        return { u: at.x - tile.x, v: at.y - tile.y };
      });
      if (rays.length > 0) measure.push(...surfaceSamples(input, tile, rays, bounds.max));
      if (measure.length === 0) {
        for (const sample of measured) {
          if ((outcode(view, sample.clip) & 16) === 0) measure.push(sample.surface);
        }
      }
    }
  }
  if (refine) {
    // Where heights are unknown, the ground is taken at the point's own
    // height within the tile's bounds: the nearest it may be.
    const fallback = Math.max(bounds.min, Math.min(bounds.max, refine.altitudeMeters));
    const { worst } = footprintFrom(input, tile, [...GRID_POINTS, nearestLocal(tile, refine.lonLat)], refine.point, fallback);
    result.physicalFootprint = worst;
    result.footprint = job.cartographic ? worst * (view.logicalHeight / view.renderHeight) : worst;
  } else {
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
  }

  // Screen area from the grid's four quads with vertices kept in the viewport.
  const screen = measured.slice(0, 9).map(sample => toScreen(view, sample.clip, view.renderWidth, view.renderHeight));
  const clampX = (value: number) => Math.max(0, Math.min(view.renderWidth, value));
  const clampY = (value: number) => Math.max(0, Math.min(view.renderHeight, value));
  let behind = false;
  for (const quad of QUADS) {
    const points = quad.map(index => screen[index]);
    if (points.some(point => point === null)) {
      behind = true;
      continue;
    }
    let twice = 0;
    for (let i = 0; i < 4; i++) {
      const p = points[i]!, q = points[(i + 1) % 4]!;
      twice += clampX(p.x) * clampY(q.y) - clampX(q.x) * clampY(p.y);
    }
    result.screenArea += Math.abs(twice) / 2;
  }
  if (behind) {
    // A quad with a corner behind the near plane has no polygon to measure,
    // as when the tile lies around the camera. The screen rays that land in
    // the tile say how much of the view it fills.
    const share = raysWithin().length / SCREEN_GROUND_RAYS;
    result.screenArea = Math.max(result.screenArea, share * view.renderWidth * view.renderHeight);
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

/** An image of this tile is resident, standard or a variant: the source has imagery here. */
function hasResidentImage(input: ImagerySelectionInput, tile: TileId): boolean {
  const { availability, source } = input;
  return availability.isResident(imageKey(source, tile, null))
    || source.variants.some(variant => availability.isResident(imageKey(source, tile, variant.id)));
}

/**
 * What the last plan showed that is resident now: each leaf's own image or,
 * while that loads, its finest resident ancestor, as the display binds them.
 * Leaves × depth at worst; siblings share ancestors, so each is walked about
 * once. A plan from another source or version proves nothing.
 */
function gatherEvidence(input: ImagerySelectionInput, sourceKey: string, previous: ImageryPlan | null): Evidence {
  const leadsTo = new Set<string>();
  const evidence: Evidence = { leadsTo, revision: input.availability.getRevision?.() ?? null };
  if (!previous || previous.sourceKey !== sourceKey) return evidence;
  const { availability, source } = input;
  const addPath = (tile: TileId): void => {
    let { z, x, y } = tile;
    while (z > 0) {
      z -= 1; x >>= 1; y >>= 1;
      const key = `${z}/${x}/${y}`;
      if (leadsTo.has(key)) return;
      leadsTo.add(key);
    }
  };
  // The finest resident ancestor of each node walked, or null for none.
  const standIn = new Map<string, TileId | null>();
  for (const leaf of previous.leaves) {
    if (availability.isResident(leaf.imageKey)) {
      addPath(leaf.tile);
      continue;
    }
    const walked: string[] = [];
    let found: TileId | null = null;
    let { z, x, y } = leaf.tile;
    while (z > 0) {
      z -= 1; x >>= 1; y >>= 1;
      const key = `${z}/${x}/${y}`;
      const known = standIn.get(key);
      if (known !== undefined) {
        found = known;
        break;
      }
      walked.push(key);
      if (availability.isResident(imageKey(source, { z, x, y }, null))) {
        found = { z, x, y };
        break;
      }
    }
    for (const key of walked) standIn.set(key, found);
    if (found) addPath(found);
  }
  return evidence;
}

export function createImagerySelector(clockPort: () => number): ImagerySelector {
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
      refine: input.refineFrom ? refineContext(input.refineFrom) : null,
      heap: [], leaves: [], coverage: [], mergeCandidates: [], leafCount: 0, nodes: 0, limits: new Set(),
      nextMemory: new Map(), wakeAt: null, truncated: false, cpuMs: 0,
      evidence: null, barred: [], refinedPastMissing: 0,
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

  /** Resident imagery the last plan showed lies below this node. */
  function leadsToResident(current: Job, node: Evaluated): boolean {
    current.evidence ??= gatherEvidence(current.input, current.sourceKey, plan);
    return current.evidence.leadsTo.has(node.key);
  }

  /** A missing image ends refinement here: a resident ancestor stands in for the whole node. */
  function bar(current: Job, node: Evaluated, presumed: boolean): { split: boolean; coarsenSince: number | null } {
    node.limit = "source";
    node.shortfall = "missing";
    node.presumedMissing = presumed;
    current.barred.push(node);
    return { split: false, coarsenSince: null };
  }

  /** Split or keep one node, applying hysteresis, pinning and source limits. */
  function decide(current: Job, node: Evaluated): { split: boolean; coarsenSince: number | null } {
    const { input } = current;
    node.pastMissing = false;
    // Below an image the source does not have, go on only toward imagery
    // already resident, or under an image of this node's own. Nothing else
    // there is requested.
    if (node.unproven) {
      if (hasResidentImage(input, node.tile)) node.unproven = false;
      else if (!leadsToResident(current, node)) return bar(current, node, true);
    }
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
      node.shortfall = "outside";
      return { split: false, coarsenSince: null };
    }
    // The source has no image here: its area shows the nearest ancestor, and
    // nothing below it is worth asking for, unless imagery already resident
    // below shows otherwise. Then refinement goes on toward that imagery;
    // the image itself stays missing.
    if (input.availability.isMissing(imageKey(input.source, node.tile, null))) {
      if (!leadsToResident(current, node)) return bar(current, node, false);
      node.pastMissing = true;
    }
    if (node.tile.z >= maxLevel) {
      const source = node.tile.z >= input.source.maxLevel;
      node.limit = source ? "source" : "backend";
      node.shortfall = source ? "ceiling" : "binding";
      node.bindingLevel = source ? null : maxLevel;
      return { split: false, coarsenSince: null };
    }
    // Four missing children make the same inference one level up.
    if (childTiles(node.tile).every(child => input.availability.isMissing(imageKey(input.source, child, null)))) {
      if (!leadsToResident(current, node)) return bar(current, node, false);
      node.pastMissing = true;
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

  /**
   * A traversal can span several updates, and imagery arriving meanwhile is
   * shown under the previous plan. Before finishing, take up again each
   * region stopped at a missing image that resident imagery now shows the way
   * into, so the new plan never drops what was just shown. Evidence only
   * grows from the previous plan's bounded leaves, so this ends.
   */
  function reopenBarred(current: Job): boolean {
    const { input } = current;
    if (!current.evidence || current.barred.length === 0) return false;
    const revision = input.availability.getRevision?.() ?? null;
    if (revision !== null && revision === current.evidence.revision) return false;
    const evidence = gatherEvidence(input, current.sourceKey, plan);
    current.evidence = evidence;
    const reopened = new Set(current.barred.filter(node => evidence.leadsTo.has(node.key) || (node.unproven && hasResidentImage(input, node.tile))));
    if (reopened.size === 0) return false;
    current.barred = current.barred.filter(node => !reopened.has(node));
    current.leaves = current.leaves.filter(node => !reopened.has(node));
    for (const node of reopened) {
      node.limit = null;
      node.shortfall = null;
      node.presumedMissing = false;
      // Still counted in leafCount: it is decided again like any open node.
      heapPush(current.heap, node);
    }
    return true;
  }

  function advance(current: Job, deadline: number, clock: () => number): boolean {
    const { input } = current;
    const started = clock();
    const maxNodes = input.maxNodes;
    let iterations = 0;
    do {
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
          node.shortfall = "nodes";
          node.reduced = leadsToResident(current, node);
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
            node.shortfall = "pages";
            node.extraPages = visible - 1;
            node.reduced = leadsToResident(current, node);
          }
        }
        remember(current, node, split, coarsenSince);
        if (!split) {
          current.leaves.push(node);
          continue;
        }
        node.limit = null;
        node.shortfall = null;
        node.reduced = false;
        if (node.pastMissing) current.refinedPastMissing += 1;
        current.leafCount -= 1;
        // Past a missing image, children have to prove themselves too.
        const unproven = node.unproven || node.pastMissing;
        for (const child of children) {
          if (!child.visible) continue;
          child.unproven = unproven;
          current.leafCount += 1;
          heapPush(current.heap, child);
        }
      }
    } while (reopenBarred(current));
    current.cpuMs += clock() - started;
    return true;
  }

  function finish(current: Job): ImageryPlan {
    const { input } = current;
    const leaves: ImageryPlanLeaf[] = [];
    const regions: Record<ImageryShortfallCause, number> = { ceiling: 0, density: 0, missing: 0, outside: 0, binding: 0, nodes: 0, pages: 0 };
    const reduced = { pages: 0, nodes: 0 };
    let morePages = 0;
    let finestBinding = Infinity, coarsestBinding = -Infinity;
    let pages = current.leaves.length;
    // Leaves come out in footprint order, so variant pages go where they help most.
    for (const node of current.leaves) {
      let limit = node.limit;
      let shortfall = node.shortfall;
      let extraPages = node.extraPages;
      let variant: string | null = null;
      let footprintPx = node.physicalFootprint;
      let imagePages = 1;
      const standardMissing = input.availability.isMissing(imageKey(input.source, node.tile, null));
      const atCeiling = node.tile.z >= input.source.maxLevel || limit === "source";
      // Cartographic leaves meet the physical sampling target with verified
      // same-zoom variants; photographic ones only where no finer level exists.
      // Nothing on screen gains from a denser image; it only costs pages.
      // The focus region counts as seen: its images must not depend on the view.
      // Below a missing ancestor, nothing unproven is asked for at all.
      const onScreen = node.screenArea > 0 || node.inFocus;
      const mayUseVariant = !node.presumedMissing && (current.cartographic || atCeiling) && onScreen && Number.isFinite(node.physicalFootprint);
      if (mayUseVariant && (footprintPx > current.physicalTarget || standardMissing)) {
        for (const candidate of input.source.variants) {
          if (input.availability.isMissing(imageKey(input.source, node.tile, candidate.id))) continue;
          const candidatePages = pagesForImage(candidate.width, candidate.height);
          if (pages - imagePages + candidatePages > input.maxPages) {
            if (limit === null) {
              limit = "memory";
              shortfall = "pages";
              extraPages = candidatePages - imagePages;
            }
            break;
          }
          pages += candidatePages - imagePages;
          imagePages = candidatePages;
          variant = candidate.id;
          footprintPx = node.physicalFootprint * (input.source.tileWidth / candidate.width);
          if (footprintPx <= current.physicalTarget) break;
        }
      }
      // A missing image is the source's limit, unless this device's budget
      // or binding is what stops refinement toward imagery below it.
      if (variant === null && standardMissing && (limit === null || limit === "source")) {
        limit = "source";
        shortfall = "missing";
      }
      if (limit === null && footprintPx > current.physicalTarget && Number.isFinite(footprintPx)) {
        // A cartographic level is chosen for readable scale, so sampling
        // density it cannot reach at that level is the source's limit.
        if (current.cartographic || atCeiling) {
          limit = "source";
          shortfall = atCeiling ? "ceiling" : "density";
        }
      }
      // Only what is on screen limits what the user sees.
      if (limit && onScreen) {
        current.limits.add(limit);
        if (shortfall) regions[shortfall] += 1;
        if (shortfall === "pages") morePages += extraPages;
        if (node.reduced && (shortfall === "pages" || shortfall === "nodes")) reduced[shortfall] += 1;
        if (shortfall === "binding" && node.bindingLevel !== null) {
          finestBinding = Math.min(finestBinding, node.bindingLevel);
          coarsestBinding = Math.max(coarsestBinding, node.bindingLevel);
        }
      }
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
        shortfall,
        inFocus: node.inFocus,
        presumedMissing: node.presumedMissing,
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
      shortfall: {
        regions, morePages, reduced, refinedPastMissing: current.refinedPastMissing,
        bindingLevels: finestBinding <= coarsestBinding ? { min: finestBinding, max: coarsestBinding } : null,
      },
      nodesEvaluated: current.nodes,
      truncated: current.truncated,
      wakeAt: current.wakeAt,
      cpuMs: current.cpuMs,
    };
  }

  return {
    step(input, deadline, clock = clockPort, restart = false) {
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
