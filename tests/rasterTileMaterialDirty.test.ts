import { GeospatialCamera, Material, NullEngine, Scene, Texture, type AbstractMesh, type StandardMaterial } from "@babylonjs/core";
import { createImageSessionBroker } from "@foss-earth/images";
import { createTextureDevicePorts, createTextureTransferTracker } from "@foss-earth/renderer/babylon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostCameraController as CameraController, createEngineSettings, testAfter } from "../fixtures/composition/runtimeHost.js";
import { createRasterTilesRuntime, type RasterTilesRuntimeOptions } from "../src/babylon/createRasterTilesRuntime.js";
import { setTerrainRegionHighlight } from "../src/babylon/terrainRegionHighlight.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";
import type { TerrainGrid, TerrainTile } from "../src/terrain/terrainGrid.js";

// Babylon marks a material dirty by walking every mesh in the scene for the
// submeshes that use it. A tile's material is set up before its mesh takes it
// and disposed with it, so marks made then find nothing to mark.

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const isTileMaterial = (material: Material) => material.name.startsWith("raster-basemap-material-");
const usersOf = (material: Material) => material.getScene().meshes.filter(mesh => mesh.subMeshes?.some(sub => sub.getMaterial() === material));
type DrawWrapper = { defines: { isDirty: boolean; _areTexturesDirty: boolean } | null };
const wrappers = (mesh: AbstractMesh) => mesh.subMeshes.flatMap(sub => (sub as unknown as { _drawWrappers: Array<DrawWrapper | undefined> })._drawWrappers)
  .filter((wrapper): wrapper is DrawWrapper & { defines: NonNullable<DrawWrapper["defines"]> } => !!wrapper?.defines);

/** Counts the dirty marks on tile materials: walks that find no mesh using it, and blocked marks with the meshes they would have reached. */
function watchWalks() {
  const walks = { empty: 0, reaching: 0, blocked: 0 };
  const blockedReached = new Set<AbstractMesh>();
  const see = (material: Material) => {
    if (!isTileMaterial(material)) return;
    const users = usersOf(material);
    if (material.blockDirtyMechanism) { walks.blocked += 1; for (const mesh of users) blockedReached.add(mesh); }
    else if (users.length) walks.reaching += 1;
    else walks.empty += 1;
  };
  // Babylon declares the walk protected.
  const walker = Material.prototype as unknown as { _markAllSubMeshesAsDirty(func: (defines: unknown) => void): void };
  const mark = walker._markAllSubMeshesAsDirty, markDirty = Material.prototype.markDirty, markAsDirty = Material.prototype.markAsDirty;
  vi.spyOn(walker, "_markAllSubMeshesAsDirty").mockImplementation(function (this: Material, func: (defines: unknown) => void) { see(this); return mark.call(this, func); });
  vi.spyOn(Material.prototype, "markDirty").mockImplementation(function (this: Material, force) { see(this); return markDirty.call(this, force); });
  // markAsDirty walks through _markAllSubMeshesAsDirty; a blocked one returns first.
  vi.spyOn(Material.prototype, "markAsDirty").mockImplementation(function (this: Material, flag) { if (this.blockDirtyMechanism) see(this); return markAsDirty.call(this, flag); });
  return { walks, blockedReached };
}

function host(mode: "managed" | "legacy", extra: Partial<RasterTilesRuntimeOptions> = {}) {
  const settings = createEngineSettings();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 });
  Object.assign(engine, { updateTextureData: vi.fn() });
  engine.getCaps().maxTextureSize = 8192;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("camera", scene, { planetRadius: 6378137 });
  const controller = new CameraController(camera);
  let view = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 30_000, pitchDeg: 30, headingDeg: 0 };
  controller.applyViewState(view);
  const gpuBytes = 512 * 2 ** 20;
  const broker = createImageSessionBroker({ requests: 4, decodes: 2,
    pools: { sourceGpu: gpuBytes, decoded: 32 * 2 ** 20, encoded: 1024, uploadOutstanding: 8 * 2 ** 20, overlap: gpuBytes } });
  const grant = (pool: Parameters<typeof broker.pools.reserve>[0], bytes: number, label: string, flags = {}) => {
    const result = broker.pools.reserve(pool, bytes, label, flags);
    return result.ok ? result.reservation : null;
  };
  const tracker = createTextureTransferTracker({ scene, admit: (bytes, label) => grant("uploadOutstanding", bytes, label), requestRender() {} });
  const device = createTextureDevicePorts({ scene, transfer: tracker.transfer, tryAdmit: tracker.tryAdmit });
  const terrain: Array<{ tile: TerrainTile; resolve(grid: TerrainGrid): void }> = [];
  const textures: Array<() => void> = [];
  const runtime = createRasterTilesRuntime({
    scene, source: RASTER_BASE_MAP_SOURCES[0], settings, nowMs: () => clock, after: testAfter, requestRender: () => {},
    meshRebuildCpuMs: () => settings.get<number>("map.terrain.meshRebuildTimePerFrame"),
    attachTerrainLighting: () => ({}) as ReturnType<RasterTilesRuntimeOptions["attachTerrainLighting"]>,
    createTerrainLoader: () => ({ dispose: () => {}, getMetrics: () => ({ active: 0, decoding: 0, queued: 0, decodedBytes: 0 }), setPaused: () => {},
      load: (tile: TerrainTile) => new Promise<TerrainGrid>(resolve => terrain.push({ tile, resolve })),
      loadPatch: (tile: TerrainTile) => new Promise<TerrainGrid>(resolve => terrain.push({ tile, resolve })) }),
    imageryPorts: { device, releaseOwnedLoader: () => {},
      managedAtlas: {
        generation: () => broker.generation(), reserveGpu: (bytes, label, flags) => grant("sourceGpu", bytes, label, flags),
        reserveTable: (bytes, label) => grant("decoded", bytes, label),
        reserveCopy(bytes, label) { const result = grant("decoded", bytes, label); if (!result) throw new Error("Fixture copy budget denied."); return result; },
        canUpload: (bytes, more = 0) => broker.pools.fits("uploadOutstanding", bytes) && broker.pools.fits("decoded", bytes + more),
        subscribeAvailable: listener => broker.pools.subscribeAvailable(listener),
        capacityKey: () => JSON.stringify(broker.pools.stats()),
      },
      capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
      loader: { async load(_url, expected) {
        const pages = (expected.width / 256) * (expected.height / 256);
        return { ...expected, compressedBytes: 10, pages: Array.from({ length: pages }, () => [new Uint8Array(4)]) };
      } },
      createAbortController: () => new AbortController() },
    ...(mode === "managed" ? { imagery: "atlas" as const }
      : { loadMapTexture: (_url, s, loaded) => { textures.push(loaded); return new Texture(null, s); } }),
    getViewState: () => view,
    log: { warn: () => {} },
    ...extra,
  });
  const frame = async () => {
    clock += 50;
    runtime.update();
    scene.render();
    await flush();
    for (const loaded of textures.splice(0)) loaded();
    for (const item of terrain.splice(0)) item.resolve({ ...item.tile, size: 2, heights: new Float32Array([100 + item.tile.z, 100, 120, 100]) });
    await flush();
  };
  const goTo = (next: typeof view) => { view = next; controller.applyViewState(view); };
  const tiles = () => scene.meshes.filter(mesh => mesh.name.startsWith("raster") && !mesh.isDisposed() && mesh.material && isTileMaterial(mesh.material));
  return { scene, runtime, frame, goTo, tiles,
    dispose() { runtime.dispose(); tracker.dispose(); broker.dispose(); scene.dispose(); engine.dispose(); } };
}

const TOUR = [
  { latDeg: 36.2, lonDeg: -112.0, zoomMeters: 12_000, pitchDeg: 60, headingDeg: 40 },
  { latDeg: 47.7, lonDeg: -122.1, zoomMeters: 3_000, pitchDeg: 75, headingDeg: 300 },
  { latDeg: 0, lonDeg: 0, zoomMeters: 8_000_000, pitchDeg: 0, headingDeg: 0 },
];

afterEach(() => { vi.restoreAllMocks(); });

describe("raster tile materials and Babylon's dirty marks", () => {
  it.each(["managed", "legacy"] as const)("%s: sets a tile's material up and lets it go without walking the scene for it", async mode => {
    const { walks, blockedReached } = watchWalks();
    const created = vi.fn();
    const f = host(mode, { attachTerrainLighting: material => { created(material); return {} as ReturnType<RasterTilesRuntimeOptions["attachTerrainLighting"]>; } });
    try {
      for (let i = 0; i < 12; i++) await f.frame();
      for (const view of TOUR) { f.goTo(view); for (let i = 0; i < 12; i++) await f.frame(); }
      const materials = created.mock.calls.map(([material]) => material as StandardMaterial);
      expect(materials.length).toBeGreaterThan(40);
      const disposed = materials.filter(material => !material.getScene().materials.includes(material)).length;
      expect(disposed).toBeGreaterThan(20);
      // Every walk on a tile material found a mesh to mark, and a blocked mark
      // would have reached only meshes disposed with their material.
      expect(walks.empty).toBe(0);
      expect([...blockedReached].filter(mesh => !mesh.isDisposed())).toEqual([]);
      // Each material had its setup's marks blocked, and (managed) its detach's.
      expect(walks.blocked).toBe(materials.length * 3 + (mode === "managed" ? disposed : 0));
      for (const mesh of f.tiles()) expect(mesh.material!.blockDirtyMechanism, mesh.name).toBe(false);
    } finally { f.dispose(); }
  });

  it("marks a shown tile's shader dirty when its imagery or a region tint changes it", async () => {
    const f = host("managed");
    try {
      for (let i = 0; i < 24; i++) await f.frame();
      const shown = f.tiles().filter(mesh => mesh.isEnabled() && wrappers(mesh).length);
      expect(shown.length).toBeGreaterThan(4);
      for (const mesh of shown) for (const wrapper of wrappers(mesh)) expect(wrapper.defines.isDirty, mesh.name).toBe(false);
      // The first region a scene is given recompiles its map materials.
      setTerrainRegionHighlight(f.scene, { center: { x: 0, y: 0, z: 0 }, radiusMeters: 1000 });
      for (const mesh of shown) expect(wrappers(mesh).every(wrapper => wrapper.defines.isDirty), mesh.name).toBe(true);
    } finally { f.dispose(); }
  });

  it("legacy: marks a shown tile's textures dirty when its material changes", async () => {
    const f = host("legacy");
    try {
      for (let i = 0; i < 12; i++) await f.frame();
      const shown = f.tiles().filter(mesh => mesh.isEnabled() && wrappers(mesh).length);
      expect(shown.length).toBeGreaterThan(4);
      for (const mesh of shown) {
        // A fixture texture never becomes ready, so its defines stay dirty: clear them first.
        for (const wrapper of wrappers(mesh)) (wrapper.defines as unknown as { markAsProcessed(): void }).markAsProcessed();
        expect(wrappers(mesh).every(wrapper => !wrapper.defines._areTexturesDirty), mesh.name).toBe(true);
        (mesh.material as StandardMaterial).backFaceCulling = true;
        expect(wrappers(mesh).every(wrapper => wrapper.defines._areTexturesDirty), mesh.name).toBe(true);
      }
    } finally { f.dispose(); }
  });

  it("unblocks through Babylon's setter when the material keeps its flag elsewhere", async () => {
    // As a Babylon that renamed its private field would be.
    const renamed: Array<{ material: StandardMaterial; flag: { value: boolean }; sets: boolean[] }> = [];
    const f = host("managed", { attachTerrainLighting: material => {
      const internal = material as unknown as Record<string, unknown>;
      const flag = { value: internal._blockDirtyMechanism as boolean }, sets: boolean[] = [];
      delete internal._blockDirtyMechanism;
      Object.defineProperty(material, "blockDirtyMechanism", { configurable: true, get: () => flag.value, set: (value: boolean) => { sets.push(value); flag.value = value; } });
      renamed.push({ material: material as StandardMaterial, flag, sets });
      return {} as ReturnType<RasterTilesRuntimeOptions["attachTerrainLighting"]>;
    } });
    try {
      await f.frame();
      expect(renamed.length).toBeGreaterThan(0);
      for (const { material, flag, sets } of renamed) {
        expect(sets[0]).toBe(false);
        expect("_blockDirtyMechanism" in material).toBe(false);
        // Disposal blocks it again through the same setter.
        if (material.getScene().materials.includes(material)) expect(flag.value).toBe(false);
      }
    } finally { f.dispose(); }
  });
});
