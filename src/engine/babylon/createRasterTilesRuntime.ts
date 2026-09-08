import { loadMapTexture } from "./loadMapTexture";
import {
  Color3,
  Mesh,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  type Scene,
} from "@babylonjs/core";

import {
  DEG_TO_RAD,
  WGS84_A,
  geodeticToEcef,
} from "../../camera/cameraMath";
import { createTerrainTileLoader, sampleTerrainGrid, type TerrainGrid, type TerrainSource } from "../../terrain/terrainTiles";
import { GLOBAL_TERRAIN } from "../../terrain/globalTerrain";
import { createRasterSurfaceSampler } from "../../terrain/rasterSurfaceSampler";
import type { SurfaceHit } from "../../terrain/surfaceQuery";
import type { TerrainPerformanceCapture } from "../../terrain/terrainPerformanceCapture";
import { meshPositions, stitchTerrainEdges } from "../../terrain/meshRefinement";
import type { GlobeViewState } from "../types";
import type { RasterBaseMapSource } from "./rasterBaseMaps";
import { createRasterQualityController, RASTER_QUALITY_PROFILES, resolveRasterQualityState, type RasterQualityProfile, type RasterQualitySetting, type RasterQualityState } from "./rasterQuality";

const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * WGS84_A;
const TILE_REQUEST_DEBOUNCE_METERS = 5;

export interface RasterTileMetrics {
  visibleTiles: number;
  activeTiles: number;
}

export interface RasterTilesRuntimeOptions {
  scene: Scene;
  source: RasterBaseMapSource;
  worldRoot?: TransformNode;
  alwaysRefresh?: boolean;
  getViewState: () => GlobeViewState | null;
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
  terrainSource?: TerrainSource;
  performanceCapture?: TerrainPerformanceCapture;
  quality?: RasterQualitySetting;
  /** Internal active profile used by the runtime's Auto controller. */
  activeQualityProfile?: Exclude<RasterQualitySetting, "auto">;
  requestRender?: () => void;
  onLoadStart?: () => void;
  onDownloadBytes?: (bytes: number) => void;
  onLoadEnd?: (visibleTiles: number, activeTiles: number) => void;
  onLoadError?: (error: Error, url: string) => void;
  onDebugEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface RasterTilesRuntime {
  readonly source: RasterBaseMapSource;
  update(): void;
  /** Replace imagery in-place; elevation grids and displayed terrain stay put. */
  setSource(source: RasterBaseMapSource): void;
  /** Stream a replacement elevation source onto the current displayed mesh. */
  setTerrainSource(source: TerrainSource): void;
  getMetrics(): RasterTileMetrics;
  getRevision(): number;
  sample(latDeg: number, lonDeg: number): SurfaceHit | null;
  getQualityState(): RasterQualityState;
  setQuality(setting: RasterQualitySetting): void;
  reportFrame(now: number, frameMs: number, suspended: boolean): void;
  dispose(): void;
}

interface TileCoord {
  z: number;
  x: number;
  y: number;
}

interface HighLodTile {
  x: number;
  y: number;
}

interface RasterTileRecord {
  tile: TileCoord;
  key: string;
  mesh: Mesh;
  material: StandardMaterial;
  texture: Texture | null;
  loaded: boolean;
  failed: boolean;
  settled: boolean;
  grid?: TerrainGrid;
  target: number[];
  imageryGeneration: number;
  replaceImagery(source: RasterBaseMapSource, generation: number): void;
  terrainGeneration: number;
  appliedTerrainGeneration: number;
  replaceTerrain(loadTerrain: (tile: TileCoord, progress: (grid: TerrainGrid) => void) => Promise<TerrainGrid>, generation: number): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function wrapTileX(x: number, z: number): number {
  const n = 2 ** z;
  return ((x % n) + n) % n;
}

function lonToTileX(lonDeg: number, z: number): number {
  const n = 2 ** z;
  return Math.floor(((lonDeg + 180) / 360) * n);
}

function latToTileY(latDeg: number, z: number): number {
  const clampedLat = clamp(latDeg, -WEB_MERCATOR_MAX_LAT_DEG, WEB_MERCATOR_MAX_LAT_DEG);
  const latRad = clampedLat * DEG_TO_RAD;
  const n = 2 ** z;
  return Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
}

function tileXToLon(x: number, z: number): number {
  return (x / (2 ** z)) * 360 - 180;
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (2 ** z);
  return Math.atan(Math.sinh(n)) / DEG_TO_RAD;
}

function chooseTileZoom(view: GlobeViewState, source: RasterBaseMapSource, profile: RasterQualityProfile): number {
  const minZoom = source.minZoom ?? 0;
  const maxZoom = source.maxZoom ?? 18;
  const targetTileMeters = clamp(view.zoomMeters * 0.65, 250, 8_000_000);
  const zoom = Math.round(Math.log2(EARTH_CIRCUMFERENCE_METERS / targetTileMeters)) + profile.zoomBias;
  return clamp(zoom, minZoom, maxZoom);
}

function chooseGlobalBaseZoom(source: RasterBaseMapSource, focusZoom: number, profile: RasterQualityProfile): number {
  const minZoom = source.minZoom ?? 0;
  const maxZoom = source.maxZoom ?? 18;
  return clamp(Math.min(profile.baseZoom, focusZoom), minZoom, maxZoom);
}

function tileKey(tile: TileCoord): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function buildTileUrl(source: RasterBaseMapSource, tile: TileCoord): string {
  return source.urlTemplate
    .replace(/\{z\}/g, String(tile.z))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y));
}

function getDesiredTiles(view: GlobeViewState, source: RasterBaseMapSource, profile = RASTER_QUALITY_PROFILES.balanced): TileCoord[] {
  const z = chooseTileZoom(view, source, profile);
  const baseZoom = chooseGlobalBaseZoom(source, z, profile);
  const n = 2 ** z;
  const centerX = lonToTileX(view.lonDeg, z);
  const centerY = clamp(latToTileY(view.latDeg, z), 0, n - 1);
  const radius = profile.ringRadius;
  const tiles: TileCoord[] = [];
  const seen = new Set<string>();

  const addTile = (tile: TileCoord): void => {
    const key = tileKey(tile);
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push(tile);
  };

  // High-LOD focus tiles around the camera anchor. Skipped at very low zoom
  // where the focus zoom collapses onto the global base zoom.
  const highLodTiles: HighLodTile[] = [];
  const markHighLod = (x: number, y: number): void => {
    highLodTiles.push({ x, y });
  };
  if (z > baseZoom) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const y = centerY + dy;
      if (y < 0 || y >= n) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = wrapTileX(centerX + dx, z);
        markHighLod(x, y);
      }
    }
    // Prefetch a short corridor ahead without changing the central resident ring.
    if (Number.isFinite(view.headingDeg)) {
      const heading = view.headingDeg * DEG_TO_RAD;
      for (let step = 1; step <= profile.corridorSteps; step++) for (let offset = -1; offset <= 1; offset++) {
        const x = wrapTileX(centerX + Math.round(Math.sin(heading) * (radius + step) + Math.cos(heading) * offset), z);
        const y = centerY + Math.round(-Math.cos(heading) * (radius + step) + Math.sin(heading) * offset);
        if (y >= 0 && y < n && !highLodTiles.some(tile => tile.x === x && tile.y === y)) markHighLod(x, y);
      }
    }
  }

  // Build a non-overlapping quadtree. Regions outside the focus ring stay as
  // coarse as possible; regions intersecting it split until the high-LOD tiles
  // become the leaves. This avoids partial base tiles underneath detail tiles.
  const baseTileCount = 2 ** baseZoom;
  for (let by = 0; by < baseTileCount; by += 1) {
    for (let bx = 0; bx < baseTileCount; bx += 1) {
      addDesiredCoverage({ z: baseZoom, x: bx, y: by }, z, highLodTiles, addTile);
    }
  }

  return tiles;
}

function addDesiredCoverage(
  tile: TileCoord,
  focusZoom: number,
  highLodTiles: readonly HighLodTile[],
  addTile: (tile: TileCoord) => void,
): void {
  const coverage = getHighLodCoverage(tile, focusZoom, highLodTiles);
  if (coverage === "none" || tile.z === focusZoom) {
    addTile(tile);
    return;
  }

  const childZ = tile.z + 1;
  const childX = tile.x * 2;
  const childY = tile.y * 2;
  addDesiredCoverage({ z: childZ, x: childX, y: childY }, focusZoom, highLodTiles, addTile);
  addDesiredCoverage({ z: childZ, x: childX + 1, y: childY }, focusZoom, highLodTiles, addTile);
  addDesiredCoverage({ z: childZ, x: childX, y: childY + 1 }, focusZoom, highLodTiles, addTile);
  addDesiredCoverage({ z: childZ, x: childX + 1, y: childY + 1 }, focusZoom, highLodTiles, addTile);
}

function getHighLodCoverage(
  tile: TileCoord,
  focusZoom: number,
  highLodTiles: readonly HighLodTile[],
): "none" | "partial" | "full" {
  if (tile.z > focusZoom || highLodTiles.length === 0) return "none";
  const ratio = 2 ** (focusZoom - tile.z);
  const x0 = tile.x * ratio;
  const x1 = x0 + ratio;
  const y0 = tile.y * ratio;
  const y1 = y0 + ratio;
  let covered = 0;
  for (const highTile of highLodTiles) {
    if (highTile.x >= x0 && highTile.x < x1 && highTile.y >= y0 && highTile.y < y1) {
      covered += 1;
    }
  }
  if (covered === 0) return "none";
  return covered === ratio * ratio ? "full" : "partial";
}

function chooseTilePatchSegments(tile: TileCoord, profile: RasterQualityProfile): number {
  if (tile.z <= profile.baseZoom) return profile.minSegments;
  if (tile.z <= 10) return Math.min(profile.maxSegments, Math.max(profile.minSegments, 32));
  return profile.maxSegments;
}

export function createTerrainMesh(options: RasterTilesRuntimeOptions, tile: TileCoord, grid?: TerrainGrid): Mesh {
  const started = options.performanceCapture ? performance.now() : 0;
  const { scene, source } = options;
  const mesh = new Mesh(`raster-basemap-tile-${source.id}-${tileKey(tile)}`, scene);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // Public mesh construction retains the prior high-resolution default. The
  // streamed runtime always supplies its resolved bounded profile explicitly.
  const quality = options.activeQualityProfile
    ?? (options.quality === "low" || options.quality === "balanced" || options.quality === "high" ? options.quality : "high");
  const segments = chooseTilePatchSegments(tile, RASTER_QUALITY_PROFILES[quality]);
  const center = geodeticToEcef(tileYToLat(tile.y + 0.5, tile.z) * DEG_TO_RAD, tileXToLon(tile.x + 0.5, tile.z) * DEG_TO_RAD, 0);

  for (let row = 0; row <= segments; row += 1) {
    const v = row / segments;
    const mercatorY = tile.y + v;
    const latDeg = tileYToLat(mercatorY, tile.z);

    for (let col = 0; col <= segments; col += 1) {
      const u = col / segments;
      const mercatorX = tile.x + u;
      const lonDeg = tileXToLon(mercatorX, tile.z);
      const scale = grid ? 2 ** (grid.z - tile.z) : 1;
      const altitudeMeters = grid
        ? sampleTerrainGrid(grid, mercatorX * scale, mercatorY * scale)
        : options.getSurfaceHeightMeters?.(latDeg, lonDeg) ?? 0;
      const ecef = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, altitudeMeters);
      positions.push(ecef.x - center.x, ecef.y - center.y, ecef.z - center.z);
      uvs.push(u, v);
    }
  }

  const stride = segments + 1;
  for (let row = 0; row < segments; row += 1) {
    for (let col = 0; col < segments; col += 1) {
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);

  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = uvs;
  data.applyToMesh(mesh, true);

  mesh.position = new Vector3(center.x, center.y, center.z);
  mesh.metadata = { mapSurface: true, terrainZoom: grid?.z ?? -1, segments };

  mesh.isPickable = true;
  mesh.renderingGroupId = 0;
  mesh.setEnabled(false);
  if (options.worldRoot) {
    mesh.parent = options.worldRoot;
  } else {
    mesh.freezeWorldMatrix();
  }

  if (options.performanceCapture) {
    options.performanceCapture.counters.preparationCpuMs += performance.now() - started;
    options.performanceCapture.counters.geometryWrites++;
  }
  return mesh;
}

function createTileRecord(
  options: RasterTilesRuntimeOptions,
  source: RasterBaseMapSource,
  tile: TileCoord,
  onSettled: (record: RasterTileRecord) => void,
  loadTerrain: (tile: TileCoord, progress: (grid: TerrainGrid) => void) => Promise<TerrainGrid>,
  onChanged: (record: RasterTileRecord) => void,
): RasterTileRecord {
  const { scene } = options;
  const key = tileKey(tile);
  const mesh = createTerrainMesh(options, tile, options.getSurfaceHeightMeters ? undefined : GLOBAL_TERRAIN);
  const material = new StandardMaterial(`raster-basemap-material-${source.id}-${key}`, scene);
  const record: RasterTileRecord = {
    key,
    tile,
    mesh,
    material,
    texture: null,
    loaded: false,
    failed: false,
    settled: false,
    grid: options.getSurfaceHeightMeters ? undefined : GLOBAL_TERRAIN,
    target: meshPositions(mesh),
    imageryGeneration: 0,
    replaceImagery: () => {},
    terrainGeneration: 0,
    appliedTerrainGeneration: 0,
    replaceTerrain: () => {},
  };

  let imageryReady = false;
  let terrainReady = false;
  const finish = () => {
    if (record.settled) return;
    if (imageryReady) { record.loaded = true; onChanged(record); }
    if (imageryReady && terrainReady) onSettled(record);
  };
  const applyGrid = (grid: TerrainGrid | undefined, generation: number) => {
    if (record.mesh.isDisposed() || generation !== record.terrainGeneration) return;
    if (grid && record.appliedTerrainGeneration === generation && grid.z <= record.mesh.metadata.terrainZoom) return;
    const readyMesh = createTerrainMesh(options, tile, grid);
    const started = options.performanceCapture ? performance.now() : 0;
    record.target = meshPositions(readyMesh);
    record.grid = grid;
    record.appliedTerrainGeneration = generation;
    record.mesh.metadata.terrainZoom = grid?.z ?? -1;
    readyMesh.dispose();
    if (options.performanceCapture) options.performanceCapture.counters.preparationCpuMs += performance.now() - started;
    onChanged(record);
  };
  const requestTerrain = (
    nextLoadTerrain: (tile: TileCoord, progress: (grid: TerrainGrid) => void) => Promise<TerrainGrid>,
    generation: number,
    settlesInitialRecord: boolean,
  ) => {
    record.terrainGeneration = generation;
    const terrain = options.getSurfaceHeightMeters ? Promise.resolve(undefined) : nextLoadTerrain(tile, grid => applyGrid(grid, generation));
    void terrain.then(grid => {
      applyGrid(grid, generation);
      if (record.mesh.isDisposed() || generation !== record.terrainGeneration) return;
      if (settlesInitialRecord) {
        terrainReady = true;
        finish();
      }
    }).catch(error => {
      if (record.mesh.isDisposed() || generation !== record.terrainGeneration) return;
      options.onLoadError?.(error instanceof Error ? error : new Error(String(error)), `terrain:${key}`);
      // Keep the best geometry already available when detail fails.
      if (settlesInitialRecord) {
        terrainReady = true;
        finish();
      }
    });
  };
  record.replaceTerrain = (nextLoadTerrain, generation) => requestTerrain(nextLoadTerrain, generation, false);
  requestTerrain(loadTerrain, 0, true);
  const loadImagery = (nextSource: RasterBaseMapSource, generation: number) => {
    const url = buildTileUrl(nextSource, tile);
    options.onDebugEvent?.("imagery-request-start", { key, source: nextSource.id, generation, url });
    // A source can switch before its first image settles. The replacement is
    // still responsible for activating this record once it arrives.
    const activatesRecord = !imageryReady;
    let texture: Texture | null = null;
    texture = loadMapTexture(url, scene,
      () => {
        if (!texture || record.mesh.isDisposed() || generation !== record.imageryGeneration) {
          texture?.dispose();
          return;
        }
        const oldTexture = record.texture;
        record.texture = texture;
        material.diffuseTexture = texture;
        options.onDebugEvent?.("texture-material-assignment", { key, source: nextSource.id, generation });
        if (oldTexture && oldTexture !== texture) oldTexture.dispose();
        if (activatesRecord) {
          imageryReady = true;
          finish();
        } else {
          options.requestRender?.();
        }
        options.onDebugEvent?.("imagery-request-success", { key, source: nextSource.id, generation });
      },
      (message, exception) => {
        if (record.mesh.isDisposed() || generation !== record.imageryGeneration) return;
        const detail = exception instanceof Error ? exception.message : String(message ?? "unknown texture load error");
        options.onDebugEvent?.("imagery-request-error", { key, source: nextSource.id, generation, url, error: detail });
        options.onLoadError?.(new Error(detail), url);
        if (activatesRecord) {
          record.failed = true;
          onSettled(record);
        }
        // During a hot swap the old texture remains visible after a failure.
      },
      (bytes) => options.onDownloadBytes?.(bytes),
    );
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 4;
    // New records have no usable old texture, so attach their pending texture
    // immediately. Existing records keep their previous map until replacement.
    if (!record.texture) {
      record.texture = texture;
      material.diffuseTexture = texture;
    }
  };
  record.replaceImagery = (nextSource, generation) => {
    record.imageryGeneration = generation;
    loadImagery(nextSource, generation);
  };
  record.replaceImagery(source, 0);

  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.White();
  material.disableLighting = true;
  material.backFaceCulling = false;
  mesh.material = material;

  return record;
}

function disposeTile(record: RasterTileRecord): void {
  record.texture?.dispose();
  record.material.dispose();
  record.mesh.dispose();
}

interface DesiredEntry {
  tile: TileCoord;
  key: string;
  baseZoom: number;
}

interface DisplayBuildResult {
  covered: boolean;
  keys: string[];
}

export function createRasterTilesRuntime(options: RasterTilesRuntimeOptions): RasterTilesRuntime {
  const capture = options.performanceCapture;
  let imagerySource = options.source;
  let imageryGeneration = 0;
  const qualityController = createRasterQualityController(resolveRasterQualityState(options.quality));
  let qualityState = qualityController.getState();
  // Tile-record callbacks retain this object, so changing Auto's active profile
  // also affects meshes prepared after the quality change.
  const meshOptions: RasterTilesRuntimeOptions = { ...options, activeQualityProfile: qualityState.activeProfile };
  let terrainSource = options.terrainSource;
  const createTerrainLoader = () => createTerrainTileLoader(terrainSource, options.onDownloadBytes, undefined, Boolean(capture),
    capture ? milliseconds => { capture.counters.preparationCpuMs += milliseconds; } : undefined);
  let terrain = createTerrainLoader();
  let terrainGeneration = 0;
  // Persistent cache: tiles stay alive after they leave the desired set so we
  // can keep showing them (or use them as best-effort fallbacks) without
  // re-downloading. Eviction is LRU and bound by the active quality profile.
  const cache = new Map<string, RasterTileRecord>();
  const lastUsedTick = new Map<string, number>();
  const retryAfter = new Map<string, number>();
  let visibleTileKeys = new Set<string>();
  let tick = 0;
  let lastDesired: DesiredEntry[] = [];
  let loadingCount = 0;
  let loadCycleActive = false;
  let disposed = false;
  let revision = 0;
  const surfaceSampler = createRasterSurfaceSampler(() => revision, capture?.counters);
  let geometryDirty = false;
  const dirtyGeometryKeys = new Set<string>();
  let visibilityDirty = false;
  const meshRebuildQueue = new Set<string>();
  let lastView: Pick<GlobeViewState, "latDeg" | "lonDeg" | "zoomMeters"> | null = null;

  function getMetrics(): RasterTileMetrics {
    let visibleTiles = 0;
    for (const record of cache.values()) {
      if (record.mesh.isEnabled() && record.loaded && !record.failed) visibleTiles += 1;
    }
    return { visibleTiles, activeTiles: cache.size };
  }

  function beginLoad(): void {
    loadingCount += 1;
    if (!loadCycleActive) {
      loadCycleActive = true;
      options.onLoadStart?.();
    }
  }

  function emitLoadEndIfIdle(): void {
    if (!loadCycleActive || loadingCount !== 0) return;
    loadCycleActive = false;
    const metrics = getMetrics();
    options.onLoadEnd?.(metrics.visibleTiles, metrics.activeTiles);
  }

  function finishLoad(record: RasterTileRecord): void {
    if (disposed || record.settled) return;
    record.settled = true;
    loadingCount = Math.max(0, loadingCount - 1);
    if (record.failed) {
      // Drop failed tiles from the cache so we can retry on next request.
      cache.delete(record.key);
      retryAfter.set(record.key, performance.now() + 30000);
      lastUsedTick.delete(record.key);
      disposeTile(record);
    }
    // Adopt loaded coverage at the next update, before simulation and rendering.
    visibilityDirty = true;
    options.requestRender?.();
    emitLoadEndIfIdle();
  }

  function ensureCached(tile: TileCoord): void {
    const key = tileKey(tile);
    const existing = cache.get(key);
    if (existing) {
      if (existing.terrainGeneration !== terrainGeneration) existing.replaceTerrain(loadProgressive, terrainGeneration);
      return;
    }
    if (performance.now() < (retryAfter.get(key) ?? 0)) return;
    beginLoad();
    const record = createTileRecord(meshOptions, imagerySource, tile, finishLoad, loadProgressive, changed => {
      geometryDirty = true;
      dirtyGeometryKeys.add(changed.key);
      visibilityDirty = true;
      options.requestRender?.();
    });
    cache.set(key, record);
  }

  function loadProgressive(requested: TileCoord, progress: (grid: TerrainGrid) => void): Promise<TerrainGrid> {
    const coarseZoom = Math.max(0, Math.min(requested.z, requested.z - 4));
    const loader = terrain;
    return (async () => {
      if (coarseZoom < requested.z) {
        try {
          const scale = 2 ** (requested.z - coarseZoom);
          progress(await loader.loadPatch({ z: coarseZoom, x: Math.floor(requested.x / scale), y: Math.floor(requested.y / scale) }));
        } catch { /* Retain the current displayed surface and still try detail. */ }
      }
      return loader.loadPatch(requested);
    })();
  }

  function touchAncestors(tile: TileCoord, baseZoom: number): void {
    let z = tile.z;
    let x = tile.x;
    let y = tile.y;
    while (z >= baseZoom) {
      const key = `${z}/${x}/${y}`;
      if (cache.has(key)) lastUsedTick.set(key, tick);
      if (z === baseZoom) break;
      z -= 1;
      x >>= 1;
      y >>= 1;
    }
  }

  function isLoadedTile(key: string): boolean {
    const record = cache.get(key);
    return Boolean(record && record.loaded && !record.failed);
  }

  function buildTargetSets(): { leafKeys: Set<string>; internalKeys: Set<string>; baseZoom: number | null } {
    if (lastDesired.length === 0) return { leafKeys: new Set(), internalKeys: new Set(), baseZoom: null };
    const leafKeys = new Set(lastDesired.map((entry) => entry.key));
    const internalKeys = new Set<string>();
    for (const entry of lastDesired) {
      let z = entry.tile.z;
      let x = entry.tile.x;
      let y = entry.tile.y;
      while (z > entry.baseZoom) {
        z -= 1;
        x >>= 1;
        y >>= 1;
        const key = `${z}/${x}/${y}`;
        if (!leafKeys.has(key)) internalKeys.add(key);
      }
    }
    return { leafKeys, internalKeys, baseZoom: lastDesired[0].baseZoom };
  }

  function buildDisplayKeys(
    tile: TileCoord,
    leafKeys: ReadonlySet<string>,
    internalKeys: ReadonlySet<string>,
  ): DisplayBuildResult {
    const key = tileKey(tile);
    const loaded = isLoadedTile(key);
    if (!internalKeys.has(key)) {
      return leafKeys.has(key) && loaded ? { covered: true, keys: [key] } : { covered: false, keys: [] };
    }

    const childZ = tile.z + 1;
    const childX = tile.x * 2;
    const childY = tile.y * 2;
    const children = [
      buildDisplayKeys({ z: childZ, x: childX, y: childY }, leafKeys, internalKeys),
      buildDisplayKeys({ z: childZ, x: childX + 1, y: childY }, leafKeys, internalKeys),
      buildDisplayKeys({ z: childZ, x: childX, y: childY + 1 }, leafKeys, internalKeys),
      buildDisplayKeys({ z: childZ, x: childX + 1, y: childY + 1 }, leafKeys, internalKeys),
    ];
    const childKeys = children.flatMap((child) => child.keys);
    if (children.every((child) => child.covered)) {
      const quality = cache.get(key)?.mesh.metadata.terrainZoom ?? -1;
      // Never replace a known parent with less accurate startup geometry.
      if (!loaded || childKeys.every(child => cache.get(child)!.mesh.metadata.terrainZoom >= quality)) {
        return { covered: true, keys: childKeys };
      }
    }
    return loaded ? { covered: true, keys: [key] } : { covered: false, keys: childKeys };
  }

  function recomputeVisibility(): void {
    visibilityDirty = false;
    const { leafKeys, internalKeys, baseZoom } = buildTargetSets();
    const representatives = new Set<string>();
    if (baseZoom !== null) {
      const rootCount = 2 ** baseZoom;
      for (let y = 0; y < rootCount; y += 1) {
        for (let x = 0; x < rootCount; x += 1) {
          for (const key of buildDisplayKeys({ z: baseZoom, x, y }, leafKeys, internalKeys).keys) {
            representatives.add(key);
          }
        }
      }
    }
    const oldVisible = visibleTileKeys;
    const changed = oldVisible.size !== representatives.size || [...representatives].some(key => !oldVisible.has(key));
    if (changed) {
      for (const key of representatives) if (!oldVisible.has(key)) dirtyGeometryKeys.add(key);
      geometryDirty = true;
    }
    visibleTileKeys = representatives;
    for (const [key, record] of cache) {
      const visible = representatives.has(key) && record.loaded && !record.failed;
      if (visible && !record.mesh.isEnabled()) options.onDebugEvent?.("tile-visible", { key });
      record.mesh.setEnabled(visible);
      if (visible) lastUsedTick.set(key, tick);
    }
    if (changed) surfaceSampler.setCoverage([...representatives].map(key => cache.get(key)!));
  }

  function evictIfNeeded(): void {
    const maxCachedTiles = RASTER_QUALITY_PROFILES[qualityState.activeProfile].maxCachedTiles;
    if (cache.size <= maxCachedTiles) return;
    const desiredKeys = new Set(lastDesired.map((e) => e.key));
    const candidates: Array<{ key: string; tick: number }> = [];
    for (const [key, record] of cache) {
      if (desiredKeys.has(key)) continue; // never evict the current desired set
      if (visibleTileKeys.has(key)) continue;
      if (!record.settled) continue;       // don't evict in-flight loads
      candidates.push({ key, tick: lastUsedTick.get(key) ?? 0 });
    }
    candidates.sort((a, b) => a.tick - b.tick);
    let toEvict = cache.size - maxCachedTiles;
    for (const { key } of candidates) {
      if (toEvict <= 0) break;
      const record = cache.get(key);
      if (!record) continue;
      cache.delete(key);
      lastUsedTick.delete(key);
      disposeTile(record);
      toEvict -= 1;
    }
  }

  function hasMeaningfulCameraChange(view: GlobeViewState): boolean {
    if (!lastView) return true;
    if (Math.abs(view.zoomMeters - lastView.zoomMeters) > TILE_REQUEST_DEBOUNCE_METERS) return true;
    return Math.abs(view.latDeg - lastView.latDeg) > 0.00001 || Math.abs(view.lonDeg - lastView.lonDeg) > 0.00001;
  }

  function commitTerrain(): void {
    const visible = [...visibleTileKeys].map(key => cache.get(key)!);
    const changed = visible.filter(record => dirtyGeometryKeys.has(record.key));
    if (!geometryDirty || changed.length === 0) return;
    for (const record of changed) {
      record.mesh.updateVerticesData(VertexBuffer.PositionKind, record.target, true);
      if (capture) capture.counters.geometryWrites++;
      dirtyGeometryKeys.delete(record.key);
    }
    // A replacement is a discrete commit. The shared seam pass still uses all
    // adopted neighbors, but it runs only on a data/coverage change, never for a
    // 1.2-second morph on every render frame.
    stitchTerrainEdges(visible, capture?.counters);
    revision++;
    geometryDirty = false;
  }

  /**
   * Changing quality replaces a few cached meshes at a time. It never rebuilds
   * the whole globe in one simulation frame, and it retains the elevation grid
   * so collision and rendering keep describing the same surface.
   */
  function processMeshRebuilds(): void {
    if (meshRebuildQueue.size === 0) return;
    const started = performance.now();
    let rebuilt = false;
    for (const key of meshRebuildQueue) {
      meshRebuildQueue.delete(key);
      const record = cache.get(key);
      if (!record || record.mesh.isDisposed()) continue;
      const oldMesh = record.mesh;
      const replacement = createTerrainMesh(meshOptions, record.tile, record.grid);
      replacement.material = record.material;
      replacement.setEnabled(oldMesh.isEnabled());
      record.mesh = replacement;
      record.target = meshPositions(replacement);
      oldMesh.dispose();
      dirtyGeometryKeys.add(key);
      geometryDirty = true;
      rebuilt = true;
      // Cap preparation work so an explicit quality change cannot make the
      // flight hitch in the way the LOD system is meant to prevent.
      if (performance.now() - started >= 2) break;
    }
    if (rebuilt) {
      surfaceSampler.setCoverage([...visibleTileKeys].map(key => cache.get(key)!).filter(Boolean));
    }
    if (meshRebuildQueue.size > 0) options.requestRender?.();
  }

  function selectTiles(view: GlobeViewState): void {
    lastView = { latDeg: view.latDeg, lonDeg: view.lonDeg, zoomMeters: view.zoomMeters };
    tick += 1;

    const profile = RASTER_QUALITY_PROFILES[qualityState.activeProfile];
    const baseZoom = chooseGlobalBaseZoom(imagerySource, chooseTileZoom(view, imagerySource, profile), profile);
    const desiredTiles = getDesiredTiles(view, imagerySource, profile);
    // Load nearby detail first, so a flight doesn't wait behind distant tiles.
    desiredTiles.sort((a, b) => b.z - a.z ||
      Math.hypot(a.x - lonToTileX(view.lonDeg, a.z), a.y - latToTileY(view.latDeg, a.z)) -
      Math.hypot(b.x - lonToTileX(view.lonDeg, b.z), b.y - latToTileY(view.latDeg, b.z)));
    lastDesired = desiredTiles.map((tile) => ({ tile, key: tileKey(tile), baseZoom }));

    // Queue loads for any desired tile not yet cached; touch ancestors so
    // already-loaded coarser tiles survive LRU while we wait for detail.
    // Real coarse parents are useful immediately while finer leaves stream.
    const parents = new Map<string, TileCoord>();
    for (const entry of lastDesired) {
      let { z, x, y } = entry.tile;
      while (z > entry.baseZoom) {
        z--; x = Math.floor(x / 2); y = Math.floor(y / 2);
        parents.set(`${z}/${x}/${y}`, { z, x, y });
      }
    }
    for (const tile of [...parents.values()].sort((a, b) => a.z - b.z)) ensureCached(tile);
    for (const entry of lastDesired) {
      ensureCached(entry.tile);
      touchAncestors(entry.tile, baseZoom);
    }

    visibilityDirty = true;
  }

  function captureResources(now: number): void {
    if (!capture?.needsResources(now)) return;
    let cachedTriangles = 0, adoptedTriangles = 0, meshBytes = 0, textureBytes = 0;
    for (const record of cache.values()) {
      const triangles = record.mesh.getTotalIndices() / 3;
      cachedTriangles += triangles;
      if (visibleTileKeys.has(record.key)) adoptedTriangles += triangles;
      // Conservative CPU + GPU estimate for position/normal/UV/index storage and
      // retained target/morph arrays. Decoder/driver allocations are unavailable.
      meshBytes += record.mesh.getTotalVertices() * 8 * 12 + triangles * 3 * 12 + record.target.length * 8;
      if (record.texture) {
        const size = record.texture.getSize();
        textureBytes += size.width * size.height * 4 * 4 / 3;
      }
    }
    const dem = terrain.getMetrics();
    capture.recordResources({ adoptedTiles: visibleTileKeys.size, cachedTiles: cache.size, adoptedTriangles,
      cachedTriangles, meshBytes, textureBytes, decodedDemBytes: dem.decodedBytes, pendingTiles: loadingCount,
      activeDemRequests: dem.active, queuedDemRequests: dem.queued }, now);
  }

  return {
    get source(): RasterBaseMapSource { return imagerySource; },
    update(): void {
      if (disposed) return;
      const started = capture ? performance.now() : 0, oldRevision = revision;
      const previousPreparation = capture?.counters.preparationCpuMs ?? 0;
      const view = options.getViewState();
      // Simulation ticks still advance active refinement every frame, but a
      // stationary (or sub-threshold) aircraft has no new coverage to select.
      if (view && [view.latDeg, view.lonDeg, view.zoomMeters].every(Number.isFinite)
        && hasMeaningfulCameraChange(view)) selectTiles(view);
      if (visibilityDirty) recomputeVisibility();
      processMeshRebuilds();
      // One atomic terrain replacement after coverage adoption, including
      // stationary/paused frames. There is no continuous CPU morph.
      commitTerrain();
      evictIfNeeded();
      emitLoadEndIfIdle();
      if (capture) {
        // Mesh construction is already recorded as preparation; do not count it twice.
        capture.counters.updateCpuMs += performance.now() - started - (capture.counters.preparationCpuMs - previousPreparation);
        capture.counters.revisionChanges += revision - oldRevision;
        captureResources(performance.now());
      }
    },
    setSource(source): void {
      if (source.id === imagerySource.id) return;
      imagerySource = source;
      imageryGeneration += 1;
      for (const record of cache.values()) record.replaceImagery(source, imageryGeneration);
      // A provider may have different useful bounds/levels. Selection updates
      // independently from the DEM and does not revise the physical surface.
      lastView = null;
      options.requestRender?.();
    },
    setTerrainSource(source): void {
      if (terrainSource?.id === source.id) return;
      terrain.dispose();
      terrainSource = source;
      terrain = createTerrainLoader();
      terrainGeneration += 1;
      // Keep the adopted mesh live until its replacement grid commits. Current
      // desired and visible tiles get priority; cache-only tiles switch lazily
      // if they later become useful again.
      const requested = new Set([...lastDesired.map(entry => entry.key), ...visibleTileKeys]);
      for (const key of requested) {
        const record = cache.get(key);
        if (record) record.replaceTerrain(loadProgressive, terrainGeneration);
      }
      options.requestRender?.();
    },
    getMetrics,
    getRevision: () => revision,
    getQualityState: () => qualityState,
    setQuality(setting): void {
      const next = qualityController.setSetting(setting);
      if (next.activeProfile === qualityState.activeProfile && next.setting === qualityState.setting) return;
      qualityState = next;
      meshOptions.activeQualityProfile = next.activeProfile;
      lastView = null;
      for (const key of cache.keys()) meshRebuildQueue.add(key);
      options.requestRender?.();
    },
    reportFrame(now, frameMs, suspended): void {
      const next = qualityController.observe(now, frameMs, suspended);
      if (next) {
        qualityState = next;
        meshOptions.activeQualityProfile = next.activeProfile;
        lastView = null;
        for (const key of cache.keys()) meshRebuildQueue.add(key);
        options.requestRender?.();
      }
    },
    sample(lat, lon) {
      if (!capture) return surfaceSampler.sample(lat, lon);
      const started = performance.now();
      const hit = surfaceSampler.sample(lat, lon);
      capture.counters.sampleCpuMs += performance.now() - started;
      return hit;
    },
    dispose(): void {
      disposed = true;
      terrain.dispose();
      for (const record of cache.values()) {
        if (!record.settled) {
          record.settled = true;
          loadingCount = Math.max(0, loadingCount - 1);
        }
        disposeTile(record);
      }
      cache.clear();
      surfaceSampler.setCoverage([]);
      lastUsedTick.clear();
      retryAfter.clear();
      dirtyGeometryKeys.clear();
      meshRebuildQueue.clear();
      lastDesired = [];
      loadingCount = 0;
      loadCycleActive = false;
    },
  };
}
