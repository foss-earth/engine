import { describe, expect, it } from "vitest";
import {
  copyDetailDistribution,
  createDetailDistribution,
  createGoogleDetailDistribution,
  deliveryDistribution,
  describeLoadedTiles,
  detailBinCount,
  layoutDetailDistribution,
} from "../../src/terrain/detailDistribution.js";
import { GOOGLE_ERROR_TARGET_BOUNDS, RASTER_DETAIL_ENVELOPE } from "../../src/terrain/mapDetailPolicy.js";

const raster = (samples: Array<{ value: number; count: number }>, status: "measured" | "empty" | "unavailable" = "measured") => createDetailDistribution({
  status, kind: "raster", sourceKey: "raster:test", generation: 1, samples, tileCount: samples.reduce((sum, sample) => sum + sample.count, 0),
});

describe("detail distribution", () => {
  it("uses 13 bars on the compact rail and never more than 64", () => {
    expect(detailBinCount(41)).toBe(13);
    expect(detailBinCount(0)).toBe(13);
    expect(detailBinCount(2)).toBe(1);
    expect(detailBinCount(10_000)).toBe(64);
  });

  it("gives equal values one sample and a revision that follows the population", () => {
    const spread = raster([{ value: 1, count: 1 }, { value: -1, count: 1 }]);
    const piled = raster([{ value: 0, count: 2 }]);
    expect(raster([{ value: 0, count: 1 }, { value: 0, count: 1 }]).samples).toEqual([{ value: 0, count: 2 }]);
    expect(spread.revision).not.toBe(piled.revision);
    const input = [{ value: -1, count: 1 }, { value: 1, count: 1 }];
    const made = raster(input);
    input.push({ value: 4, count: 8 });
    input[0].count = 9;
    expect(made.samples).toEqual([{ value: -1, count: 1 }, { value: 1, count: 1 }]);
    const copy = copyDetailDistribution(made);
    (made.samples as Array<{ value: number; count: number }>).push({ value: 4, count: 8 });
    expect(copy?.samples).toEqual([{ value: -1, count: 1 }, { value: 1, count: 1 }]);
    expect(copy?.revision).toBe(spread.revision);
  });

  it("places overflow on the edge bars without calling it the endpoint", () => {
    const distribution = raster([{ value: 2, count: 1 }, { value: 0, count: 2 }, { value: -4, count: 3 }]);
    const layout = layoutDetailDistribution({
      kind: "raster", finer: RASTER_DETAIL_ENVELOPE.finest, coarser: RASTER_DETAIL_ENVELOPE.coarsest,
      widthPx: 41, distribution,
    });
    expect(layout.binCount).toBe(13);
    expect(layout.finerOverflow).toBe(1);
    expect(layout.coarserOverflow).toBe(3);
    expect(layout.bars[0]).toMatchObject({ count: 1, overflow: 1, overflowSide: "finer" });
    expect(layout.bars[12]).toMatchObject({ count: 3, overflow: 3, overflowSide: "coarser" });
    expect(layout.bars.filter(bar => bar.overflow === 0 && bar.count > 0).map(bar => bar.count)).toEqual([2]);
    const full = layout.bars.find(bar => bar.count === 3)!;
    expect(layout.ceiling).toBe(3);
    expect(full.height).toBe(28);
    expect(full.y).toBe(0);
    expect(layout.bars.find(bar => bar.count === 0)?.height).toBe(0);
    expect(describeLoadedTiles("raster", distribution, layout)).toContain("6 visible imagery tiles");
    expect(describeLoadedTiles("raster", distribution, layout)).toContain("1 finer than the selectable range");
    expect(describeLoadedTiles("raster", distribution, layout)).toContain("3 coarser than the selectable range");
    expect(describeLoadedTiles("raster", distribution, layout)).toContain("Bar scale: 3 tiles");
  });

  it("centres one value when the rail has no range, and keeps overflow on the edges", () => {
    const distribution = raster([{ value: 1, count: 1 }, { value: 0, count: 4 }, { value: -1, count: 1 }]);
    const layout = layoutDetailDistribution({
      kind: "raster", finer: 0, coarser: 0, widthPx: 41, distribution,
    });
    expect(layout.bars[0].overflowSide).toBe("finer");
    expect(layout.bars[6]).toMatchObject({ count: 4, overflow: 0 });
    expect(layout.bars[12].overflowSide).toBe("coarser");
  });

  it("includes the coarse endpoint and keeps zero and subpixel Google errors at the fine end", () => {
    const endpoint = createDetailDistribution({
      status: "measured", kind: "google", sourceKey: "google", generation: 1,
      samples: [{ value: GOOGLE_ERROR_TARGET_BOUNDS.coarsest, count: 1 }], tileCount: 1,
    });
    const atEnd = layoutDetailDistribution({
      kind: "google", finer: GOOGLE_ERROR_TARGET_BOUNDS.finest, coarser: GOOGLE_ERROR_TARGET_BOUNDS.coarsest,
      widthPx: 41, distribution: endpoint,
    });
    expect(atEnd.coarserOverflow).toBe(0);
    expect(atEnd.bars[12].count).toBe(1);
    const fine = createGoogleDetailDistribution(1, [
      { inView: true, drawable: true, error: 0 },
      { inView: true, drawable: true, error: 0.25 },
      { inView: true, drawable: true, error: Infinity },
      { inView: true, drawable: true, error: Number.NaN },
      { inView: true, drawable: false, error: 32 },
      { inView: false, drawable: true, error: 8 },
    ]);
    expect(fine.samples.map(sample => sample.value)).toEqual([0, 0.25, Infinity]);
    expect(fine).toMatchObject({ unknownCount: 1, tileCount: 4 });
    const laid = layoutDetailDistribution({
      kind: "google", finer: GOOGLE_ERROR_TARGET_BOUNDS.finest, coarser: GOOGLE_ERROR_TARGET_BOUNDS.coarsest,
      widthPx: 41, distribution: fine, previousCeiling: null, resetCeiling: true,
    });
    expect(laid.finerOverflow).toBe(0);
    expect(laid.bars[0].count).toBe(2);
    expect(describeLoadedTiles("google", fine, laid)).toContain("screen-space error per tile");
  });

  it("reports a missing distribution as unavailable instead of a bar", () => {
    const missing = deliveryDistribution("google", "google", null);
    expect(missing).toMatchObject({ status: "unavailable", samples: [], tileCount: 0 });
    const foreign = deliveryDistribution("raster:here", "raster", raster([{ value: 0, count: 2 }]));
    expect(foreign.status).toBe("unavailable");
    expect(foreign.samples).toEqual([]);
    expect(describeLoadedTiles("raster", createDetailDistribution({ status: "empty", kind: "raster", sourceKey: "raster:test", generation: 1 }), { ceiling: 1, finerOverflow: 0, coarserOverflow: 0 })).toBe("No visible imagery tiles.");
  });
});
