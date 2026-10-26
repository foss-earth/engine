import { describe, expect, it } from "vitest";
import type { GameLogEntry } from "@foss-earth/ui/browser";
import { connectMapDetailLog } from "../src/map/mapDetailLog.js";
import type { RasterDetailFeedback } from "../src/map/runtimeContracts.js";
import type { ImageryConstraint } from "../src/terrain/imagery/imageryConstraints.js";
import { createSettingsRegistry, type SettingsRegistry } from "@foss-earth/ui/settings";
import { MAP_LOADING_PARAMETERS } from "../src/settings/catalogue/loading.js";

function connect(settings?: SettingsRegistry) {
  let feedback: RasterDetailFeedback | null = null;
  let notify = (): void => {};
  /** Each printed line: what it says now, and whether it was removed. */
  const lines: Array<{ entry: GameLogEntry; removed: boolean }> = [];
  const stop = connectMapDetailLog({
    onDetailAdjusted: () => () => {},
    onRasterDetailFeedback: listener => { notify = listener; return () => {}; },
    getRasterDetailFeedback: () => feedback,
  }, {
    print: entry => {
      const line = { entry, removed: false };
      lines.push(line);
      return { update(next) { line.entry = next; }, focusAction() {}, remove() { line.removed = true; } };
    },
  }, settings);
  const report = (constraints: ImageryConstraint[], pending = false, id = "opentopomap"): void => {
    feedback = { support: "ready", pending, limits: [], effectiveTarget: null, source: { id, version: "1", label: id }, constraints };
    notify();
  };
  return { lines, report, stop };
}

const source = (overrides: Partial<Extract<ImageryConstraint, { cause: "source" }>>): ImageryConstraint => ({
  cause: "source", missingRegions: 0, finestLevelRegions: 0, finestLevel: 17, outsideRegions: 0, scaleRegions: 0, ...overrides,
});
const tables = (configured: number): ImageryConstraint => ({ cause: "page-tables", parameter: "map.imagery.pageTablePatches", configured, effective: configured, needed: 20, patches: 4 });
const budget = (configuredMiB = 128): ImageryConstraint => ({
  cause: "gpu-budget", parameter: "map.imagery.gpuBudget", configuredMiB,
  atlasMiB: configuredMiB, atlasPages: 256, rendererCapped: false,
  selectablePages: 201, selectedPages: 201, morePagesAtLeast: 166, regions: 63, reducedRegions: 54,
});
function budgetSettings(options: Parameters<typeof createSettingsRegistry>[0] = {}) {
  const settings = createSettingsRegistry(options);
  settings.register(MAP_LOADING_PARAMETERS);
  return settings;
}

describe("the map detail log", () => {
  it("explains the conservative fallback and where to change the budget in the actual warning", () => {
    const { lines, report, stop } = connect(budgetSettings());
    report([budget()]);
    expect(lines[0].entry.text).toContain("54 regions shown finer before are coarser now.");
    expect(lines[0].entry.text).toContain("The default budget is 128 MiB, because this browser does not say how much memory the device has.");
    expect(lines[0].entry.text).toContain("Change it in Map → Loading and memory → 2D imagery GPU memory.");
    expect(lines[0].entry.text.indexOf("The default budget")).toBeLessThan(lines[0].entry.text.indexOf("Selection uses"));
    stop();
  });

  it("explains a memory-derived default using the RAM the browser actually reports", () => {
    const { lines, report, stop } = connect(budgetSettings({ deviceContext: { deviceMemoryGiB: 8 } }));
    report([budget(256)]);
    expect(lines[0].entry.text).toContain("The default budget is 1/32 of the 8 GiB the browser reports.");
    expect(lines[0].entry.text).not.toContain("does not say how much memory");
    stop();
  });

  it("attributes saved, preset and app defaults rather than blaming missing RAM information", () => {
    const settings = budgetSettings();
    const { lines, report, stop } = connect(settings);
    settings.set("map.imagery.gpuBudget", 96);
    report([budget(96)]);
    expect(lines[0].entry.text).toContain("The budget is your saved setting.");
    settings.applyPreset({ id: "save", name: "Save battery and data", description: "Use less memory", values: { "map.imagery.gpuBudget": 64 } });
    report([budget(64)]);
    expect(lines[0].entry.text).toContain("The “Save battery and data” preset set this budget.");
    settings.reset("map.imagery.gpuBudget");
    settings.setHostDefault("map.imagery.gpuBudget", 128, "keep room for aircraft textures");
    report([budget()]);
    expect(lines[0].entry.text).toContain("The app chose this default budget: keep room for aircraft textures.");
    expect(lines[0].entry.text).not.toContain("does not say how much memory");
    expect(lines).toHaveLength(1);
    stop();
  });

  it("identifies a budget supplied in the URL even when it equals the fallback", () => {
    const settings = budgetSettings({ searchParams: new URLSearchParams("set.map.imagery.gpuBudget=128") });
    const { lines, report, stop } = connect(settings);
    report([budget()]);
    expect(lines[0].entry.text).toContain("The URL sets this budget for this visit.");
    expect(lines[0].entry.text).not.toContain("does not say how much memory");
    stop();
  });

  it("updates the existing warning when the budget's origin changes without changing its value", () => {
    const settings = budgetSettings();
    const { lines, report, stop } = connect(settings);
    report([budget()]);
    const release = settings.force("map.imagery.gpuBudget", 128, "reserve memory for the rest of the scene");
    expect(lines).toHaveLength(1);
    expect(lines[0].entry.text).toContain("The app sets this budget: reserve memory for the rest of the scene.");
    expect(lines[0].entry.text).not.toContain("Change it in");
    release();
    expect(lines[0].entry.text).toContain("does not say how much memory");
    stop();
    settings.force("map.imagery.gpuBudget", 128, "a later requirement");
    expect(lines[0].entry.text).not.toContain("a later requirement");
  });

  it("explains the renderer cap even when the browser does not report RAM", () => {
    const settings = budgetSettings({ deviceContext: { rendererMode: "webgl2", maxTextureSize: 4096 } });
    const { lines, report, stop } = connect(settings);
    const configured = settings.get<number>("map.imagery.gpuBudget");
    expect(configured).toBeLessThan(128);
    report([budget(configured)]);
    expect(lines[0].entry.text).toContain(`limited to ${configured} MiB by the largest atlas a 4096 px texture holds`);
    stop();
  });

  it("does not attribute feedback from an outgoing atlas to a newly selected budget", () => {
    const settings = budgetSettings();
    const { lines, report, stop } = connect(settings);
    report([budget()]);
    settings.set("map.imagery.gpuBudget", 512);
    expect(lines[0].entry.text).not.toContain("The budget is your saved setting.");
    report([budget(512)]);
    expect(lines[0].entry.text).toContain("The budget is your saved setting.");
    stop();
  });

  it("does not report a map source at its finest level or its readable scale, which is how it is meant to be drawn", () => {
    const { lines, report, stop } = connect();
    report([source({ scaleRegions: 9 })]);
    report([source({ finestLevelRegions: 2 })]);
    report([]);
    report([source({ scaleRegions: 4, finestLevelRegions: 3 })]);
    expect(lines).toEqual([]);
    stop();
  });

  it("keeps one line for a limit: it changes in place, and when the limit ends says so and goes", () => {
    const { lines, report, stop } = connect();
    report([source({ missingRegions: 3, finestLevelRegions: 2 })]);
    expect(lines.map(line => line.entry)).toEqual([
      { text: "2D imagery is limited by the map source: it has no imagery for 3 visible regions. Where it has no image, the nearest coarser one it has is shown.", tone: "warning" },
    ]);
    report([tables(16), source({ missingRegions: 5 })]);
    report([tables(32), source({ missingRegions: 5 })]);
    expect(lines).toHaveLength(2);
    expect(lines[1].entry.text).toBe("2D imagery is still limited by the page tables: 32 available, 20 needed by visible patches. 4 patches draw one coarser page instead.");
    // Still loading: nothing is said to have ended yet.
    report([], true);
    expect(lines.map(line => line.entry.tone)).toEqual(["warning", "warning"]);
    report([]);
    expect(lines.map(line => line.entry)).toEqual([
      { text: "2D imagery is no longer limited by the map source.", tone: "info", keepInHistory: false },
      { text: "2D imagery is no longer limited by the page tables.", tone: "info", keepInHistory: false },
    ]);
    stop();
  });

  it("removes another source's lines", () => {
    const { lines, report, stop } = connect();
    report([tables(16)]);
    report([], false, "usgs-imagery");
    expect(lines).toEqual([{ entry: expect.objectContaining({ tone: "warning" }), removed: true }]);
    stop();
  });
});
