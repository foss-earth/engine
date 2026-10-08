import { GeospatialCamera, NullEngine, Scene, StandardMaterial, type InternalTexture, type Texture, type UniformBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../../../camera/cameraState";
import { getAppSettings } from "../../../settings/appSettings";
import { childTiles, lonLatToTileXY, outcode, sampleTileSurface, tileContains, tileKey, toClip, type TileId } from "../../../terrain/imagery/imageryGeometry";
import { imageKey, type ImagerySelector } from "../../../terrain/imagery/imagerySelector";
import { imagerySourceSupport } from "../../../terrain/imagery/imagerySources";
import { RASTER_BASE_MAP_SOURCES } from "../rasterBaseMaps";
import { createImageryRuntime } from "./createImageryRuntime";
import { IMAGERY_TABLE_BLOCK } from "./imageryAtlasLayout";
import { ImageryAtlasMaterialPlugin } from "./imageryMaterialPlugin";
import { imageryLimitsFrom, imageryTuningFrom } from "./imageryParameters";
import { ImageryMissingError, type PreparedImage } from "./imageryResidency";
import { readImageryView } from "./imageryView";

const VIEW = { latDeg: 36.1, lonDeg: -112.14, zoomMeters: 3000, pitchDeg: 0, headingDeg: 0 };
const SOURCE = RASTER_BASE_MAP_SOURCES.find(source => source.id === "usgs-imagery")!;
const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
const ancestorOf = (tile: TileId, levels: number): TileId => ({ z: tile.z - levels, x: tile.x >> levels, y: tile.y >> levels });

/**
 * The runtime's own selector, observed: a test can end every update's slice
 * at its first clock check, and count the images selection asked about.
 */
const selection = vi.hoisted(() => ({ sliced: false, asked: new Map<string, number>(), afterStep: null as ((running: boolean) => void) | null }));
vi.mock("../../../terrain/imagery/imagerySelector", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../terrain/imagery/imagerySelector")>();
  return {
    ...actual,
    createImagerySelector(): ImagerySelector {
      const selector = actual.createImagerySelector();
      return {
        ...selector,
        step(input, deadline, clock, restart) {
          const { isMissing } = input.availability;
          const availability = { ...input.availability, isMissing(key: string) {
            selection.asked.set(key, (selection.asked.get(key) ?? 0) + 1);
            return isMissing(key);
          } };
          const step = selector.step({ ...input, availability }, selection.sliced ? -Infinity : deadline, clock, restart);
          selection.afterStep?.(step.running);
          return step;
        },
      };
    },
  };
});

interface Setup {
  /** The probed leaf, from the first plan's on-screen leaves at level 14 or finer, most screen area first. */
  probe?(candidates: readonly TileId[], fallbackStep: number): TileId | undefined;
  /** Downloads held in flight until the test finishes them; by default the probe's stand-in. */
  holds?(tile: TileId, probe: TileId, standIn: TileId): boolean;
}

/**
 * FOSS Earth's real selector, residency, atlas allocator and material binding.
 * Only downloads and GPU writes are replaced. Read the published texture table
 * and material uniforms: selected/resident levels alone cannot detect a loss
 * caused by binding. Nothing is sent to the provider.
 */
function harness(setup: Setup = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 8192, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engine.useReverseDepthBuffer = true;
  const uploads = new Map<InternalTexture, Map<string, Uint8Array>>();
  Object.assign(engine, { updateTextureData(texture: InternalTexture, data: Uint8Array, x: number, y: number, width: number) {
    if (width !== IMAGERY_TABLE_BLOCK) return;
    let blocks = uploads.get(texture);
    if (!blocks) { blocks = new Map(); uploads.set(texture, blocks); }
    // Publication reuses its buffer; retain the bytes that were actually uploaded.
    blocks.set(`${x}/${y}`, data.slice());
  } });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("imagery-continuity", scene, { planetRadius: 6378137 });
  const controller = new CameraController(camera);
  controller.applyViewState(VIEW);
  const settings = getAppSettings();
  const tuning = imageryTuningFrom(settings);
  expect(settings.get("map.auto.imageryDetail")).toBe(false);
  expect(settings.get("map.auto.terrainDetail")).toBe(false);
  let time = 0;
  let frameRequested = true;
  let feedbackChanges = 0;
  let holds: (tile: TileId) => boolean = () => false;
  const held = new Map<string, { resolve(image: PreparedImage): void; reject(error: Error): void; image: PreparedImage }>();
  const runtime = createImageryRuntime({
    scene,
    source: SOURCE,
    capabilities: { backend: "webgl2", maxTextureSize: 8192, explicitGradients: true },
    surface: { heightAt: () => 0, boundsFor: () => ({ min: 0, max: 0 }), maxLevelFor: () => 16, getRevision: () => 0 },
    limits: imageryLimitsFrom(settings), tuning, now: () => time,
    requestRender: () => { frameRequested = true; },
    onFeedback: () => { feedbackChanges += 1; },
    loader: { load(url, { width, height }) {
      const [z, y, x] = new URL(url).pathname.split("/").slice(-3).map(Number);
      const tile = { z, x, y };
      const image = { width, height, compressedBytes: 1, pages: [[new Uint8Array(4)]] };
      if (!holds(tile)) return Promise.resolve(image);
      return new Promise<PreparedImage>((resolve, reject) => { held.set(tileKey(tile), { resolve, reject, image }); });
    } },
  });
  const at = lonLatToTileXY(VIEW.lonDeg, VIEW.latDeg, 10);
  const patch = { z: 10, x: Math.floor(at.x), y: Math.floor(at.y) };
  const material = new StandardMaterial("continuity-ground", scene);
  runtime.attachPatch("ground", patch, material);
  runtime.setPatchVisible("ground", true);
  const plugin = material.pluginManager!.getPlugin("ImageryAtlas") as ImageryAtlasMaterialPlugin;
  expect(plugin).toBeInstanceOf(ImageryAtlasMaterialPlugin);

  /** Delivered level at a fixed geographic point, from what the shader reads. */
  const boundLevel = (tile: TileId): number | null => {
    const values = new Map<string, number[]>();
    const textures = new Map<string, Texture>();
    plugin.bindForSubMesh({
      updateFloat4: (name: string, ...value: number[]) => { values.set(name, value); },
      setTexture: (name: string, texture: Texture) => { textures.set(name, texture); },
    } as unknown as UniformBuffer);
    const [originX, originY, depth] = values.get("imageryTable")!;
    if (depth < 0) {
      const [, level, valid] = values.get("imageryFallback")!;
      return valid ? level : null;
    }
    const data = uploads.get(textures.get("imageryPageTable")!.getInternalTexture()!)!.get(`${originX}/${originY}`)!;
    const scale = 2 ** (patch.z + depth - tile.z);
    const x = Math.floor((tile.x + 0.5) * scale) - patch.x * 2 ** depth;
    const y = Math.floor((tile.y + 0.5) * scale) - patch.y * 2 ** depth;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(2 ** depth);
    expect(y).toBeLessThan(2 ** depth);
    const index = (y * IMAGERY_TABLE_BLOCK + x) * 4;
    return data[index + 3] === 255 ? data[index + 2] : null;
  };
  const snapshots: Array<{ level: number | null; active: number | null; limits: string[]; selections: number }> = [];
  let probe: TileId | null = null;
  const settle = async () => {
    for (let round = 0; frameRequested && round < 200; round++) {
      frameRequested = false;
      runtime.update();
      if (probe) snapshots.push({ level: boundLevel(probe), active: runtime.getFeedback().activeTarget, limits: runtime.getFeedback().limits, selections: runtime.getDiagnostics().counters.selections });
      await flush();
    }
    expect(frameRequested, "streaming must settle on requested frames").toBe(false);
  };
  /** Finishes a held download, then follows the reselection it causes. */
  const finish = async (tile: TileId, error?: Error) => {
    const request = held.get(tileKey(tile));
    expect(request, `${tileKey(tile)} must be in flight`).toBeDefined();
    held.delete(tileKey(tile));
    if (error) request!.reject(error); else request!.resolve(request!.image);
    await flush();
    await settle();
    // Availability changes are subject to the same reselection throttle as
    // motion. Follow the runtime's timer, without forcing an extra frame.
    time += tuning.reselectWhileMovingMs;
    await vi.advanceTimersByTimeAsync(tuning.reselectWhileMovingMs);
    await settle();
  };
  // The first traversal admits root downloads. Pick a real selected leaf before
  // their promises finish and before its stand-in can be admitted.
  runtime.update();
  const candidates = runtime.getDiagnostics().plan!.regions.filter(region => {
    const [z, x, y] = region.key.split("/").map(Number);
    return z >= 14 && x >> (z - patch.z) === patch.x && y >> (z - patch.z) === patch.y && region.screenArea > 0;
  }).sort((a, b) => b.screenArea - a.screenArea).map(region => {
    const [z, x, y] = region.key.split("/").map(Number);
    return { z, x, y };
  });
  expect(candidates.length, "the fixed close view must request fine imagery").toBeGreaterThan(0);
  const step = tuning.fallbackStep;
  const picked = setup.probe ? setup.probe(candidates, step) : candidates[0];
  expect(picked, "the view must have the leaf the test needs").toBeDefined();
  probe = picked!;
  const view = readImageryView(scene, null)!;
  expect(outcode(view, toClip(view.ecefToClip, sampleTileSurface(probe, 0.5, 0.5, 0).position)), "the sampled tile centre must be on screen").toBe(0);
  const chosen = probe;
  const standIn = ancestorOf(chosen, step);
  const holding = setup.holds ?? ((tile: TileId) => tileKey(tile) === tileKey(standIn));
  const released: Array<(tile: TileId) => boolean> = [];
  holds = tile => holding(tile, chosen, standIn) && !released.some(match => match(tile));
  return {
    runtime, probe: chosen, standIn, heldKey: tileKey(standIn), snapshots, settle, boundLevel, finish,
    finishFallback: (error?: Error) => finish(standIn, error),
    /** Lets matching downloads finish: those in flight now and any asked for later. */
    release(match: (tile: TileId) => boolean) {
      released.push(match);
      for (const [key, request] of [...held]) {
        const [z, x, y] = key.split("/").map(Number);
        if (!match({ z, x, y })) continue;
        held.delete(key);
        request.resolve(request.image);
      }
    },
    /** Stops holding new downloads; those in flight stay held. */
    holdNoMore() { released.push(() => true); },
    /**
     * Unchanged updates do no selection, upload or table work, ask for no
     * frame and report no new feedback, which is all the log follows.
     */
    expectIdle() {
      const before = runtime.getDiagnostics().counters;
      const feedbackBefore = feedbackChanges;
      frameRequested = false;
      for (let update = 0; update < 3; update++) runtime.update();
      const after = runtime.getDiagnostics().counters;
      expect({ selections: after.selections, uploads: after.uploads, tableWrites: after.tableWrites, feedback: feedbackChanges, frameRequested })
        .toEqual({ selections: before.selections, uploads: before.uploads, tableWrites: before.tableWrites, feedback: feedbackBefore, frameRequested: false });
    },
    dispose() { runtime.dispose(); scene.dispose(); engine.dispose(); },
  };
}

afterEach(() => {
  selection.sliced = false;
  selection.asked.clear();
  selection.afterStep = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("USGS imagery detail continuity", () => {
  it.each(["success", "transient error", "missing"] as const)("keeps already displayed detail when a delayed coarse stand-in finishes with %s", async outcome => {
    const test = harness();
    try {
      await test.settle();
      // Check every publication during loading, not only the settled result.
      let best = 0;
      for (const { level } of test.snapshots) {
        if (level === null) { expect(best).toBe(0); continue; }
        expect(level, "successful downloads must not discard already displayed detail").toBeGreaterThanOrEqual(best);
        best = level;
      }
      const before = test.boundLevel(test.probe);
      expect(before, "the fine image must be displayed before the coarse response arrives").toBe(test.probe.z);
      const resources = test.runtime.getDiagnostics();
      expect(resources.atlas!.freeSlots).toBeGreaterThan(0);
      expect(resources.residency.evictions).toBe(0);
      expect(resources.plan!.limits).not.toContain("memory");
      test.snapshots.length = 0;
      await test.finishFallback(outcome === "missing" ? new ImageryMissingError("Map tile not available (404)")
        : outcome === "transient error" ? new Error("Map tile request failed (503)") : undefined);
      const after = test.runtime.getDiagnostics();
      if (outcome === "missing") {
        expect(after.residency.missing).toBe(1);
        expect(after.counters.selections, "the missing response must have triggered reselection").toBeGreaterThan(resources.counters.selections);
        // The stand-in was optional: its absence limits nothing the view is
        // served, and only the plan's own record mentions it.
        expect(after.plan!.refinedPastMissing).toBe(1);
        expect(after.constraints.find(constraint => constraint.cause === "source")).toMatchObject({ missingRegions: 0 });
        expect(after.constraints.map(constraint => constraint.cause)).toEqual(resources.constraints.map(constraint => constraint.cause));
      }
      expect(after.atlas!.freeSlots).toBeGreaterThan(0);
      expect(after.residency.evictions).toBe(0);
      expect(test.snapshots.length).toBeGreaterThan(0);
      expect(test.snapshots.map(snapshot => snapshot.active)).toEqual(test.snapshots.map(() => 0));
      expect(test.snapshots.map(snapshot => snapshot.level), `published levels after ${test.heldKey}: ${JSON.stringify(test.snapshots)}`)
        .toEqual(test.snapshots.map(() => before));
      test.expectIdle();
    } finally { test.dispose(); }
  });

  it("keeps imagery that arrives while a sliced reselection runs after the stand-in was missing", async () => {
    // The stand-in and everything below it is still loading.
    const test = harness({ holds: (tile, _probe, standIn) => tileContains(standIn, tile) });
    try {
      await test.settle();
      const coarse = test.boundLevel(test.probe);
      expect(coarse, "a coarser ancestor shows meanwhile").not.toBeNull();
      expect(coarse!).toBeLessThan(test.standIn.z);
      const selections = test.runtime.getDiagnostics().counters.selections;
      // From now on every update's selection decides only a few nodes. Once
      // the reselection has decided the missing stand-in, with nothing
      // resident below it, the imagery below arrives.
      const standInKey = imageKey(imagerySourceSupport(SOURCE).capabilities!, test.standIn, null);
      // The parent's four-children check asks first when it is the first child.
      const asksBeforeDecision = tileKey(childTiles(ancestorOf(test.standIn, 1))[0]) === test.heldKey ? 1 : 0;
      let releasedWhileRunning = false;
      selection.sliced = true;
      selection.asked.clear();
      selection.afterStep = running => {
        if (releasedWhileRunning || !running || (selection.asked.get(standInKey) ?? 0) <= asksBeforeDecision) return;
        releasedWhileRunning = true;
        test.release(tile => tile.z > test.standIn.z && tileContains(test.standIn, tile));
      };
      test.snapshots.length = 0;
      await test.finishFallback(new ImageryMissingError("Map tile not available (404)"));
      expect(releasedWhileRunning, "the imagery must arrive while the reselection runs").toBe(true);
      const levels = test.snapshots.map(snapshot => snapshot.level);
      const shown = levels.indexOf(test.probe.z);
      expect(shown, `published levels: ${JSON.stringify(test.snapshots)}`).toBeGreaterThanOrEqual(0);
      // It was shown under the previous plan, before the reselection finished,
      expect(test.snapshots[shown].selections).toBe(selections);
      // and every later publication, the reselection's own included, keeps it.
      expect(levels.slice(shown), JSON.stringify(test.snapshots)).toEqual(levels.slice(shown).map(() => test.probe.z));
      const after = test.runtime.getDiagnostics();
      expect(after.counters.selections).toBeGreaterThan(selections);
      expect(after.residency.missing).toBe(1);
      test.expectIdle();
    } finally { test.dispose(); }
  });

  it("keeps a resident stand-in while an ancestor above it is missing and its leaf still loads", async () => {
    // A leaf whose stand-in's parent is the stand-in of a coarser leaf: both
    // are asked for. The probe's stand-in arrives; everything else below that
    // parent is still loading when the parent turns out to be missing.
    const test = harness({
      probe: (candidates, step) => candidates.find(tile => candidates.some(other => other.z === tile.z - 1
        && tileKey(ancestorOf(other, step)) === tileKey(ancestorOf(tile, step + 1)))),
      holds: (tile, _probe, standIn) => tileContains(ancestorOf(standIn, 1), tile) && tileKey(tile) !== tileKey(standIn),
    });
    try {
      await test.settle();
      const parent = ancestorOf(test.standIn, 1);
      expect(test.boundLevel(test.probe), "the stand-in shows while the leaf loads").toBe(test.standIn.z);
      const selections = test.runtime.getDiagnostics().counters.selections;
      test.snapshots.length = 0;
      await test.finish(parent, new ImageryMissingError("Map tile not available (404)"));
      const after = test.runtime.getDiagnostics();
      expect(after.residency.missing).toBe(1);
      expect(after.counters.selections, "the missing response must have triggered reselection").toBeGreaterThan(selections);
      expect(test.snapshots.map(snapshot => snapshot.level), JSON.stringify(test.snapshots)).toEqual(test.snapshots.map(() => test.standIn.z));
      // The probe's leaf is still wanted, and shows once it arrives.
      test.release(tile => tileContains(test.standIn, tile));
      await flush();
      await test.settle();
      expect(test.boundLevel(test.probe)).toBe(test.probe.z);
      // Below the missing parent, branches with nothing resident show a
      // coarser ancestor, with no empty cells and nothing more asked for.
      expect(after.binding.emptyCells).toBe(0);
      expect(test.runtime.getDiagnostics().binding.emptyCells).toBe(0);
      test.expectIdle();
    } finally { test.dispose(); }
  });

  it("shows the best resident ancestor of a leaf the source does not have, and says the source limits it", async () => {
    const test = harness({ holds: (tile, probe) => tileKey(tile) === tileKey(probe) });
    try {
      await test.settle();
      expect(test.boundLevel(test.probe)).toBe(test.standIn.z);
      test.snapshots.length = 0;
      await test.finish(test.probe, new ImageryMissingError("Map tile not available (404)"));
      expect(test.snapshots.map(snapshot => snapshot.level)).toEqual(test.snapshots.map(() => test.standIn.z));
      const after = test.runtime.getDiagnostics();
      expect(after.residency.missing).toBe(1);
      expect(after.plan!.regions.find(region => region.key === tileKey(test.probe))).toMatchObject({ delivered: test.standIn.z, limit: "source" });
      expect(test.runtime.getFeedback().limits).toContain("source");
      expect(test.runtime.getFeedback().source).toEqual({ id: "usgs-imagery", version: "1", label: "USGS Imagery" });
      expect(test.runtime.getFeedback().constraints.find(constraint => constraint.cause === "source")).toMatchObject({ missingRegions: 1 });
      test.expectIdle();
    } finally { test.dispose(); }
  });

  it("ignores a late missing response for the previous source version", async () => {
    const test = harness();
    try {
      await test.settle();
      test.holdNoMore();
      test.runtime.setSource({ ...SOURCE, version: "continuity-2" });
      await test.settle();
      expect(test.boundLevel(test.probe)).toBe(test.probe.z);
      const before = test.runtime.getDiagnostics();
      test.snapshots.length = 0;
      await test.finishFallback(new ImageryMissingError("Map tile not available (404)"));
      const after = test.runtime.getDiagnostics();
      expect(after.residency.missing).toBe(0);
      expect(after.counters.selections).toBe(before.counters.selections);
      expect(test.snapshots.every(snapshot => snapshot.level === test.probe.z)).toBe(true);
      test.expectIdle();
    } finally { test.dispose(); }
  });
});
