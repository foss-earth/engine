import { describe, expect, it } from "vitest";
import type { GameLogEntry } from "@foss-earth/ui/browser";
import { connectMapDetailLog } from "../src/map/mapDetailLog.js";
import type { RasterDetailFeedback } from "../src/map/runtimeContracts.js";
import type { ImageryConstraint } from "../src/terrain/imagery/imageryConstraints.js";

function connect() {
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
  });
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

describe("the map detail log", () => {
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
