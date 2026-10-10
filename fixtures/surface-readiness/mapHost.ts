import { Mesh, MeshBuilder, Texture, TransformNode, type Scene } from "@babylonjs/core";
import type { GlobeRuntimeOptions } from "../../src/babylon/globeRuntimePorts.js";
import { WGS84_A } from "../../src/camera/cameraMath.js";
import type { TerrainGrid, TerrainTile } from "../../src/terrain/terrainGrid.js";
import { createGlobeHostFixture } from "../composition/globeHost.js";

/** A source fixture for the real public GlobeRuntime and actual triangle query.
 * Only traversal/transport leaves are synthetic; no server/provider/GPU needed. */
export class LocalTilesFixture {
  readonly group: TransformNode;
  fetchOptions = {}; errorTarget = 20; checkCollisions = true;
  visibleTiles = new Set<object>(); activeTiles = new Set<object>();
  lruCache = { minSize: 0, maxSize: 0, minBytesSize: 0, maxBytesSize: 0, itemSet: new Set(), cachedBytes: 0 };
  downloadQueue = { maxJobs: 0, currJobs: 0, items: [] as object[] };
  parseQueue = { maxJobs: 0, currJobs: 0, items: [] as object[] };
  processNodeQueue = { currJobs: 0, items: [] as object[] };
  stats = { queued: 0 };
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  private models = new Set<TransformNode>();
  constructor(readonly scene: Scene) { this.group = new TransformNode("local-fixture-google", scene); }
  registerPlugin() {}
  calculateTileViewError(_tile: unknown, target: { inView: boolean; error: number; distanceFromCamera: number }) {
    void _tile; target.inView = false; target.error = 1; target.distanceFromCamera = 1;
  }
  update() {}
  async parseTile() {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    let listeners = this.listeners.get(type); if (!listeners) this.listeners.set(type, listeners = new Set()); listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, values: Record<string, unknown> = {}) { for (const listener of [...this.listeners.get(type) ?? []]) listener({ type, ...values }); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
  addGround(heightMeters: number) {
    const model = new TransformNode(`local-ground-${heightMeters}`, this.scene); model.parent = this.group;
    const mesh = MeshBuilder.CreatePlane(`local-plane-${heightMeters}`, { size: 4000, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    mesh.rotation.y = Math.PI / 2; mesh.position.x = WGS84_A + heightMeters; mesh.parent = model; mesh.computeWorldMatrix(true);
    const tile = { geometricError: 10, engineData: { scene: model } }; this.models.add(model);
    this.visibleTiles.add(tile); this.activeTiles.add(tile);
    this.emit("load-model", { scene: model, tile }); this.emit("tile-visibility-change", { scene: model, tile, visible: true });
    return { model, mesh, tile };
  }
  removeGround(ground: ReturnType<LocalTilesFixture["addGround"]>) {
    ground.model.setEnabled(false); ground.model.parent = null; this.visibleTiles.delete(ground.tile); this.activeTiles.delete(ground.tile);
    this.emit("tile-visibility-change", { scene: ground.model, tile: ground.tile, visible: false });
    ground.model.dispose(); this.models.delete(ground.model); this.emit("dispose-model", { scene: ground.model, tile: ground.tile });
  }
  dispose() { this.listeners.clear(); for (const model of this.models) model.dispose(); this.models.clear(); this.group.dispose(); this.visibleTiles.clear(); this.activeTiles.clear(); }
}

export function createLocalSurfaceHost(document: Document, synchronousSettlement = false) {
  let tiles: LocalTilesFixture;
  let settlementCancels = 0;
  const images: Array<() => void> = [];
  const imageFailures: Array<(error: Error) => void> = [];
  const elevation: Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void; reject(error: Error): void }> = [];
  const host = createGlobeHostFixture(document, defaults => ({
    googleApiKey: "fixture-only", preferGoogleTiles: true, rasterImagery: "legacy",
    clock: { ...defaults.clock, after(callback, ms) {
      if (synchronousSettlement && ms === 0) { callback(); return () => { settlementCancels += 1; }; }
      return defaults.clock.after(callback, ms);
    } },
    getSurfaceHeightMeters: () => 100,
    mapPorts: { ...defaults.mapPorts,
      google: { ...defaults.mapPorts.google,
        createTilesRenderer(_url, scene) {
          tiles = new LocalTilesFixture(scene);
          return tiles as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createTilesRenderer"]>;
        },
        createAuthPlugin: () => ({ fetchData: async () => { throw new Error("No fixture network"); } }) as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createAuthPlugin"]>,
      },
      raster: { ...defaults.mapPorts.raster,
        loadMapTexture: (_url, scene, onLoad, onError) => {
          images.push(onLoad); imageFailures.push(error => onError(error.message, error));
          return new Texture(null, scene);
        },
        attachTerrainLighting: () => ({}) as ReturnType<GlobeRuntimeOptions["mapPorts"]["raster"]["attachTerrainLighting"]>,
        createTerrainLoader: () => ({ dispose() {}, getMetrics: () => ({ active: 0, queued: 0, decodedBytes: 0 }), setPaused() {},
          load: tile => new Promise<TerrainGrid>((resolve, reject) => elevation.push({ tile, resolve, reject })),
          loadPatch: tile => new Promise<TerrainGrid>((resolve, reject) => elevation.push({ tile, resolve, reject })),
        }),
      },
    },
  }));
  return { ...host, tiles: () => tiles!, images, imageFailures, elevation,
    settlementCancels: () => settlementCancels,
    frame(now = 1) { host.runtime.prepareFrame(now); host.runtime.afterFrame(now, false); },
    flushTimers() {
      // The fixture clock does not run implicitly. A single known callback
      // drain models post-promise settlement; no loop or readiness polling.
      const callbacks = [...host.timers.values()]; host.timers.clear(); callbacks.forEach(callback => callback());
    },
  };
}
