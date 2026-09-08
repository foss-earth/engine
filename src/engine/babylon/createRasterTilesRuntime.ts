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
import { advanceRefinement, inheritParent, meshPositions, refineMesh, stitchTerrainEdges, type MeshRefinement } from "../../terrain/meshRefinement";
import type { GlobeViewState } from "../types";
import type { RasterBaseMapSource } from "./rasterBaseMaps";

const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * WGS84_A;
const MIN_TILE_PATCH_SEGMENTS = 12;
const MAX_TILE_PATCH_SEGMENTS = 96;
const TILE_REQUEST_DEBOUNCE_METERS = 5;
const GLOBAL_BASE_ZOOM = 2;

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
  requestRender?: () => void;
  onLoadStart?: () => void;
  onDownloadBytes?: (bytes: number) => void;
  onLoadEnd?: (visibleTiles: number, activeTiles: number) => void;
  onLoadError?: (error: Error, url: string) => void;
}

export interface RasterTilesRuntime {
  readonly source: RasterBaseMapSource;
  update(): void;
  getMetrics(): RasterTileMetrics;
  getRevision(): number;
  sample(latDeg: number, lonDeg: number): SurfaceHit | null;
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
  texture: Texture;
  loaded: boolean;
  failed: boolean;
  settled: boolean;
  refinement: MeshRefinement | null;
  target: number[];
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

function chooseTileZoom(view: GlobeViewState, source: RasterBaseMapSource): number {
  const minZoom = source.minZoom ?? 0;
  const maxZoom = source.maxZoom ?? 18;
  const targetTileMeters = clamp(view.zoomMeters * 0.65, 250, 8_000_000);
  const zoom = Math.round(Math.log2(EARTH_CIRCUMFERENCE_METERS / targetTileMeters));
  return clamp(zoom, minZoom, maxZoom);
}

function chooseGlobalBaseZoom(source: RasterBaseMapSource, focusZoom: number): number {
  const minZoom = source.minZoom ?? 0;
  const maxZoom = source.maxZoom ?? 18;
  return clamp(Math.min(GLOBAL_BASE_ZOOM, focusZoom), minZoom, maxZoom);
}

function chooseTileRingRadius(zoom: number): number {
  if (zoom <= 4) return Number.POSITIVE_INFINITY;
  if (zoom <= 6) return 6;
  if (zoom <= 8) return 5;
  return 4;
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

function getDesiredTiles(view: GlobeViewState, source: RasterBaseMapSource, minimumZoom = 0): TileCoord[] {
  const z = Math.max(minimumZoom, chooseTileZoom(view, source));
  const baseZoom = chooseGlobalBaseZoom(source, z);
  const n = 2 ** z;
  const centerX = lonToTileX(view.lonDeg, z);
  const centerY = clamp(latToTileY(view.latDeg, z), 0, n - 1);
  const radius = chooseTileRingRadius(z);
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
    if (!Number.isFinite(radius)) {
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          markHighLod(x, y);
        }
      }
    } else {
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
        for (let step = 1; step <= 3; step++) for (let offset = -2; offset <= 2; offset++) {
          const x = wrapTileX(centerX + Math.round(Math.sin(heading) * (radius + step) + Math.cos(heading) * offset), z);
          const y = centerY + Math.round(-Math.cos(heading) * (radius + step) + Math.sin(heading) * offset);
          if (y >= 0 && y < n && !highLodTiles.some(tile => tile.x === x && tile.y === y)) markHighLod(x, y);
        }
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

function chooseTilePatchSegments(tile: TileCoord): number {
  const west = tileXToLon(tile.x, tile.z);
  const east = tileXToLon(tile.x + 1, tile.z);
  const north = tileYToLat(tile.y, tile.z);
  const south = tileYToLat(tile.y + 1, tile.z);
  const angularSpanDeg = Math.max(Math.abs(east - west), Math.abs(north - south));
  return clamp(Math.ceil(angularSpanDeg), MIN_TILE_PATCH_SEGMENTS, MAX_TILE_PATCH_SEGMENTS);
}

export function createTerrainMesh(options: RasterTilesRuntimeOptions, tile: TileCoord, grid?: TerrainGrid): Mesh {
  const started = options.performanceCapture ? performance.now() : 0;
  const { scene, source } = options;
  const mesh = new Mesh(`raster-basemap-tile-${source.id}-${tileKey(tile)}`, scene);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const segments = grid ? Math.max(chooseTilePatchSegments(tile), tile.z >= 14 ? 128 : 64) : chooseTilePatchSegments(tile);
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
  tile: TileCoord,
  onSettled: (record: RasterTileRecord) => void,
  loadTerrain: (tile: TileCoord, progress: (grid: TerrainGrid) => void) => Promise<TerrainGrid>,
  onChanged: () => void,
): RasterTileRecord {
  const { scene, source } = options;
  const key = tileKey(tile);
  const url = buildTileUrl(source, tile);
  const mesh = createTerrainMesh(options, tile, options.getSurfaceHeightMeters ? undefined : GLOBAL_TERRAIN);
  const material = new StandardMaterial(`raster-basemap-material-${source.id}-${key}`, scene);
  const record: RasterTileRecord = {
    key,
    tile,
    mesh,
    material,
    texture: null as unknown as Texture,
    loaded: false,
    failed: false,
    settled: false,
    refinement: null,
    target: meshPositions(mesh),
  };

  let imageryReady = false;
  let terrainReady = false;
  const finish = () => {
    if (record.settled) return;
    if (imageryReady) { record.loaded = true; onChanged(); }
    if (imageryReady && terrainReady) onSettled(record);
  };
  const applyGrid = (grid?: TerrainGrid) => {
    if (record.settled || record.mesh.isDisposed()) return;
    if (grid && grid.z <= record.mesh.metadata.terrainZoom) return;
    const readyMesh = createTerrainMesh(options, tile, grid);
    const started = options.performanceCapture ? performance.now() : 0;
    record.target = meshPositions(readyMesh);
    record.refinement = refineMesh(record.mesh, record.target, performance.now());
    record.mesh.metadata.terrainZoom = grid?.z ?? -1;
    readyMesh.dispose();
    if (options.performanceCapture) options.performanceCapture.counters.preparationCpuMs += performance.now() - started;
    onChanged();
  };
  const terrain = options.getSurfaceHeightMeters ? Promise.resolve(undefined) : loadTerrain(tile, applyGrid);
  void terrain.then(grid => {
    applyGrid(grid);
    if (record.settled || record.mesh.isDisposed()) return;
    terrainReady = true;
    finish();
  }).catch(error => {
    if (record.settled || record.mesh.isDisposed()) return;
    options.onLoadError?.(error instanceof Error ? error : new Error(String(error)), `terrain:${key}`);
    // Keep the best geometry already available when detail fails.
    terrainReady = true;
    finish();
  });
  const texture = loadMapTexture(url, scene,
    () => {
      imageryReady = true;
      finish();
    },
    (message, exception) => {
      record.failed = true;
      const detail = exception instanceof Error ? exception.message : String(message ?? "unknown texture load error");
      options.onLoadError?.(new Error(detail), url);
      onSettled(record);
    },
    (bytes) => options.onDownloadBytes?.(bytes),
  );
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 4;
  record.texture = texture;

  material.diffuseTexture = texture;
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.White();
  material.disableLighting = true;
  material.backFaceCulling = false;
  mesh.material = material;

  return record;
}

function disposeTile(record: RasterTileRecord): void {
  record.texture.dispose();
  record.material.dispose();
  record.mesh.dispose();
}

const MAX_CACHED_TILES = 512;

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
  const terrain = createTerrainTileLoader(options.terrainSource, options.onDownloadBytes, undefined, Boolean(capture),
    capture ? milliseconds => { capture.counters.preparationCpuMs += milliseconds; } : undefined);
  // Persistent cache: tiles stay alive after they leave the desired set so we
  // can keep showing them (or use them as best-effort fallbacks) without
  // re-downloading. Eviction is LRU and only kicks in over MAX_CACHED_TILES.
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
  let retainedFocusZoom = 0;
  let geometryDirty = false;
  let visibilityDirty = false;
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
    if (existing || performance.now() < (retryAfter.get(key) ?? 0)) return;
    beginLoad();
    const loadProgressive = async (requested: TileCoord, progress: (grid: TerrainGrid) => void) => {
      const coarseZoom = Math.max(0, Math.min(requested.z, requested.z - 4));
      if (coarseZoom < requested.z) {
        try {
          const scale = 2 ** (requested.z - coarseZoom);
          progress(await terrain.loadPatch({ z: coarseZoom, x: Math.floor(requested.x / scale), y: Math.floor(requested.y / scale) }));
        } catch { /* Retain bundled terrain and still try the detail source. */ }
      }
      return terrain.loadPatch(requested);
    };
    const record = createTileRecord(options, tile, finishLoad, loadProgressive, () => {
      geometryDirty = true;
      visibilityDirty = true;
      options.requestRender?.();
    });
    cache.set(key, record);
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
      for (const key of representatives) {
        if (oldVisible.has(key)) continue;
        const record = cache.get(key)!;
        let { z, x, y } = record.tile;
        while (z > 0) {
          z--; x = Math.floor(x / 2); y = Math.floor(y / 2);
          const parent = cache.get(`${z}/${x}/${y}`);
          if (parent && oldVisible.has(parent.key)) {
            const from = inheritParent(record, parent);
            record.mesh.updateVerticesData(VertexBuffer.PositionKind, from, true);
            if (capture) capture.counters.geometryWrites++;
            record.refinement = refineMesh(record.mesh, record.target, performance.now());
            break;
          }
        }
      }
      revision++;
      geometryDirty = true;
    }
    visibleTileKeys = representatives;
    for (const [key, record] of cache) {
      const visible = representatives.has(key) && record.loaded && !record.failed;
      record.mesh.setEnabled(visible);
      if (visible) lastUsedTick.set(key, tick);
    }
    if (changed) surfaceSampler.setCoverage([...representatives].map(key => cache.get(key)!));
  }

  function evictIfNeeded(): void {
    if (cache.size <= MAX_CACHED_TILES) return;
    const desiredKeys = new Set(lastDesired.map((e) => e.key));
    const candidates: Array<{ key: string; tick: number }> = [];
    for (const [key, record] of cache) {
      if (desiredKeys.has(key)) continue; // never evict the current desired set
      if (visibleTileKeys.has(key)) continue;
      if (!record.settled) continue;       // don't evict in-flight loads
      candidates.push({ key, tick: lastUsedTick.get(key) ?? 0 });
    }
    candidates.sort((a, b) => a.tick - b.tick);
    let toEvict = cache.size - MAX_CACHED_TILES;
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

  function animateTerrain(): void {
    const visible = [...visibleTileKeys].map(key => cache.get(key)!);
    const now = performance.now();
    const moving = visible.some(record => record.refinement !== null);
    if (!geometryDirty && !moving) return;
    for (const record of visible) {
      if (record.refinement) {
        if (!advanceRefinement(record.mesh, record.refinement, now, capture?.counters)) record.refinement = null;
      } else {
        record.mesh.updateVerticesData(VertexBuffer.PositionKind, record.target, true);
        if (capture) capture.counters.geometryWrites++;
      }
    }
    stitchTerrainEdges(visible, capture?.counters);
    revision++;
    geometryDirty = false;
    if (visible.some(record => record.refinement !== null)) options.requestRender?.();
  }

  function selectTiles(view: GlobeViewState): void {
    if (lastView && (Math.abs(lastView.latDeg - view.latDeg) > 1 || Math.abs(lastView.lonDeg - view.lonDeg) > 1)) retainedFocusZoom = 0;
    lastView = { latDeg: view.latDeg, lonDeg: view.lonDeg, zoomMeters: view.zoomMeters };
    tick += 1;

    if (options.alwaysRefresh) retainedFocusZoom = Math.max(retainedFocusZoom, chooseTileZoom(view, options.source));
    const baseZoom = chooseGlobalBaseZoom(options.source, Math.max(retainedFocusZoom, chooseTileZoom(view, options.source)));
    const desiredTiles = getDesiredTiles(view, options.source, retainedFocusZoom);
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
      if (record.refinement) meshBytes += record.refinement.from.length * 8;
      const size = record.texture.getSize();
      textureBytes += size.width * size.height * 4 * 4 / 3;
    }
    const dem = terrain.getMetrics();
    capture.recordResources({ adoptedTiles: visibleTileKeys.size, cachedTiles: cache.size, adoptedTriangles,
      cachedTriangles, meshBytes, textureBytes, decodedDemBytes: dem.decodedBytes, pendingTiles: loadingCount,
      activeDemRequests: dem.active, queuedDemRequests: dem.queued }, now);
  }

  return {
    source: options.source,
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
      // One pass after coverage adoption, including stationary/paused frames.
      animateTerrain();
      evictIfNeeded();
      emitLoadEndIfIdle();
      if (capture) {
        // Mesh construction is already recorded as preparation; do not count it twice.
        capture.counters.updateCpuMs += performance.now() - started - (capture.counters.preparationCpuMs - previousPreparation);
        capture.counters.revisionChanges += revision - oldRevision;
        captureResources(performance.now());
      }
    },
    getMetrics,
    getRevision: () => revision,
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
      lastDesired = [];
      loadingCount = 0;
      loadCycleActive = false;
    },
  };
}
