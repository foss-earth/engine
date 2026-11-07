// @vitest-environment jsdom
import { Texture } from "@babylonjs/core";
import { expect, it } from "vitest";
import { createGlobeHostFixture } from "../fixtures/composition/globeHost.js";
import { LocalTilesFixture } from "../fixtures/surface-readiness/mapHost.js";
import type { GlobeRuntimeOptions } from "../src/babylon/globeRuntimePorts.js";
import { RASTER_BASE_MAP_SOURCES } from "../src/map/rasterBaseMaps.js";

/** A local globe whose maps count how often their loading diagnostics are read. */
function countingHost() {
  const reads = { raster: 0, google: 0 };
  let tiles: LocalTilesFixture;
  const images: Array<() => void> = [];
  const host = createGlobeHostFixture(document, defaults => ({
    googleApiKey: "fixture-only", preferGoogleTiles: true, rasterImagery: "legacy",
    getSurfaceHeightMeters: () => 100,
    mapPorts: { ...defaults.mapPorts,
      google: { ...defaults.mapPorts.google,
        createTilesRenderer(_url, scene) {
          tiles = new LocalTilesFixture(scene);
          // The Google runtime's loading state reads stats.queued once.
          Object.defineProperty(tiles, "stats", { value: { get queued() { reads.google += 1; return 0; } } });
          return tiles as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createTilesRenderer"]>;
        },
        createAuthPlugin: () => ({ fetchData: async () => { throw new Error("No fixture network"); } }) as unknown as ReturnType<GlobeRuntimeOptions["mapPorts"]["google"]["createAuthPlugin"]>,
      },
      raster: { ...defaults.mapPorts.raster,
        loadMapTexture: (_url, scene, onLoad) => { images.push(onLoad); return new Texture(null, scene); },
        attachTerrainLighting: () => ({}) as ReturnType<GlobeRuntimeOptions["mapPorts"]["raster"]["attachTerrainLighting"]>,
        // The raster runtime's loading diagnostics read the loader's metrics once.
        createTerrainLoader: () => ({ dispose() {}, setPaused() {},
          getMetrics: () => { reads.raster += 1; return { active: 0, decoding: 0, queued: 0, decodedBytes: 0 }; },
          load: () => new Promise(() => {}), loadPatch: () => new Promise(() => {}) }),
      },
    },
  }));
  return { ...host, reads, tiles: () => tiles!, images,
    frame(now: number) { host.runtime.prepareFrame(now); host.runtime.afterFrame(now, true); } };
}

it("reads the surface's revision and source generation without the maps' loading diagnostics", async () => {
  const host = countingHost();
  try {
    const ground = host.tiles().addGround(100);
    Object.assign(ground.tile, { internal: { hasRenderableContent: true, loadingState: 4 } });
    Object.assign(ground.tile.engineData, { boundingVolume: { distanceToPoint: () => 0 } });
    Object.assign(host.tiles(), { root: ground.tile });
    host.frame(100);
    const lease = host.runtime.prepareTerrainRegion({ region: { center: { latDeg: 0, lonDeg: 0, altitudeMeters: 100.5 }, radiusMeters: 15 },
      minimum: { googleErrorMeters: 32, rasterZoom: 12 }, final: { googleErrorMeters: 16, rasterZoom: 14 } });
    const revision = host.runtime.surface.revision!();
    const generation = lease.read().sourceGeneration;
    host.reads.raster = host.reads.google = 0;
    for (let index = 0; index < 5; index += 1) {
      expect(host.runtime.surface.revision!()).toBe(revision);
      expect(host.runtime.surface.sample(0, 0)).toMatchObject({ revision });
    }
    expect(host.reads).toEqual({ raster: 0, google: 0 });

    // Nothing observes the surface: the counters still move on with the maps.
    host.tiles().addGround(250);
    expect(host.runtime.surface.revision!()).toBe(revision + 1);
    const raster = { ...RASTER_BASE_MAP_SOURCES[0], minZoom: 2, maxZoom: 2 };
    host.runtime.setMapSource(raster);
    host.images.splice(0).forEach(done => done());
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    host.frame(300);
    expect(lease.read().sourceGeneration).toBe(generation + 1);
    const rasterRevision = host.runtime.surface.revision!();
    expect(rasterRevision).toBeGreaterThan(revision + 1);
    host.reads.raster = host.reads.google = 0;
    expect(host.runtime.surface.sample(0, 0)).toMatchObject({ revision: rasterRevision });
    expect(host.runtime.surface.revision!()).toBe(rasterRevision);
    expect(host.reads).toEqual({ raster: 0, google: 0 });

    // An imagery-only version is a new source generation, not a new revision.
    host.runtime.setMapSource({ ...raster, version: "2" });
    host.images.splice(0).forEach(done => done());
    host.frame(500);
    expect(lease.read().sourceGeneration).toBe(generation + 2);
    expect(host.runtime.surface.revision!()).toBe(rasterRevision);

    // An observation still sees the loading state.
    const observation = host.runtime.displayedSurface.observe({ samples: [{ latDeg: 0, lonDeg: 0 }] });
    host.reads.raster = 0;
    observation.read();
    host.tiles().emit("load-content");
    expect(observation.read()).toMatchObject({ revision: rasterRevision, sourceGeneration: generation + 2 });
    expect(host.reads.raster).toBeGreaterThan(0);
    lease.release();
  } finally { host.disposeHost(); }
});
