import { describe, expect, it } from "vitest";
import {
  chooseDeviceHintErrorTarget,
  DEFAULT_GOOGLE_DETAIL_POLICY,
  DEFAULT_RASTER_DETAIL_POLICY,
  describeDetailValue,
  detailPosition,
  detailValueAtPosition,
  editGoogleRange,
  editRasterRange,
  isValidDetailPolicy,
  rasterImagePixelTarget,
  resolveDetailDefault,
  selectCustomDefault,
  selectRasterNormal,
  type GoogleDetailPolicy,
  type RasterDetailPolicy,
} from "./mapDetailPolicy";

const context = { rendererDefaultErrorPx: 20, rendererMode: "webgl2", deviceHints: { hardwareConcurrency: 8, deviceMemory: 8 } };

describe("map detail policy validation", () => {
  it("accepts the registered defaults", () => {
    expect(isValidDetailPolicy(DEFAULT_RASTER_DETAIL_POLICY, "raster")).toBe(true);
    expect(isValidDetailPolicy(DEFAULT_GOOGLE_DETAIL_POLICY, "google")).toBe(true);
  });

  it("rejects values instead of repairing them", () => {
    const bad: unknown[] = [
      null, "raster", [],
      { kind: "raster", coarseOffset: 1, fineOffset: -1, defaultValue: 0 },
      { kind: "raster", coarseOffset: -4, fineOffset: 1, defaultValue: 0 },
      { kind: "raster", coarseOffset: -1, fineOffset: 2, defaultValue: 0 },
      { kind: "raster", coarseOffset: -2, fineOffset: -1, defaultValue: "normal" },
      { kind: "raster", coarseOffset: -2, fineOffset: 0, defaultValue: 0.5 },
      { kind: "raster", coarseOffset: Number.NaN, fineOffset: 0, defaultValue: 0 },
      { kind: "google", finestErrorPx: 0, coarsestErrorPx: 20, defaultValue: 8 },
      { kind: "google", finestErrorPx: 4, coarsestErrorPx: 2, defaultValue: 3 },
      { kind: "google", finestErrorPx: 4, coarsestErrorPx: 64, defaultValue: 128 },
      { kind: "google", finestErrorPx: 4, coarsestErrorPx: 64, defaultValue: { mode: "recommended", policy: "gpu-benchmark" } },
      { kind: "google", finestErrorPx: 4, coarsestErrorPx: 1_000_000, defaultValue: 8 },
      { kind: "vector", coarseOffset: 0, fineOffset: 0, defaultValue: 0 },
    ];
    for (const value of bad) expect(isValidDetailPolicy(value), JSON.stringify(value)).toBe(false);
  });

  it("does not accept one kind's policy as the other's", () => {
    expect(isValidDetailPolicy(DEFAULT_RASTER_DETAIL_POLICY, "google")).toBe(false);
    expect(isValidDetailPolicy(DEFAULT_GOOGLE_DETAIL_POLICY, "raster")).toBe(false);
  });

  it("allows Custom raster ranges that exclude Normal", () => {
    expect(isValidDetailPolicy({ kind: "raster", coarseOffset: -3, fineOffset: -1, defaultValue: -2 }, "raster")).toBe(true);
  });
});

describe("range editing", () => {
  it("keeps a raster range ordered and inside the envelope", () => {
    const custom: RasterDetailPolicy = { kind: "raster", coarseOffset: -2, fineOffset: 0.5, defaultValue: 0.25 };
    expect(editRasterRange(custom, { fineOffset: -2.5 })).toMatchObject({ coarseOffset: -2, fineOffset: -2 });
    expect(editRasterRange(custom, { coarseOffset: 5 })).toMatchObject({ coarseOffset: 0.5, fineOffset: 0.5 });
    expect(editRasterRange(custom, { fineOffset: 9 }).fineOffset).toBe(1);
    expect(editRasterRange(custom, { coarseOffset: -9 }).coarseOffset).toBe(-3);
  });

  it("clamps a Custom default once when the range moves past it", () => {
    const custom: RasterDetailPolicy = { kind: "raster", coarseOffset: -2, fineOffset: 1, defaultValue: 0.75 };
    const edited = editRasterRange(custom, { fineOffset: 0.25 });
    expect(edited.defaultValue).toBe(0.25);
    // Widening again does not bring the old default back.
    expect(editRasterRange(edited, { fineOffset: 1 }).defaultValue).toBe(0.25);
  });

  it("keeps 0 in the range while Normal is selected and never turns Normal into Custom", () => {
    const normal = DEFAULT_RASTER_DETAIL_POLICY;
    const narrowed = editRasterRange(normal, { fineOffset: -1, coarseOffset: 0.5 });
    expect(narrowed).toMatchObject({ coarseOffset: 0, fineOffset: 0, defaultValue: "normal" });
    expect(isValidDetailPolicy(narrowed, "raster")).toBe(true);
  });

  it("widens a Custom range to include 0 when Normal is selected", () => {
    const custom: RasterDetailPolicy = { kind: "raster", coarseOffset: -3, fineOffset: -1, defaultValue: -2 };
    expect(selectRasterNormal(custom)).toEqual({ kind: "raster", coarseOffset: -3, fineOffset: 0, defaultValue: "normal" });
  });

  it("keeps a Google range ordered and clamps a manual default without replacing a recommendation", () => {
    const manual: GoogleDetailPolicy = { ...DEFAULT_GOOGLE_DETAIL_POLICY, defaultValue: 32 };
    expect(editGoogleRange(manual, { coarsestErrorPx: 16 })).toMatchObject({ finestErrorPx: 4, coarsestErrorPx: 16, defaultValue: 16 });
    expect(editGoogleRange(manual, { finestErrorPx: 1000 })).toMatchObject({ finestErrorPx: 64, coarsestErrorPx: 64 });
    const recommended = editGoogleRange(DEFAULT_GOOGLE_DETAIL_POLICY, { coarsestErrorPx: 8 });
    expect(recommended.defaultValue).toEqual({ mode: "recommended", policy: "renderer-default" });
  });

  it("clamps a Custom default into the range", () => {
    expect(selectCustomDefault(DEFAULT_RASTER_DETAIL_POLICY, 3).defaultValue).toBe(1);
    expect(selectCustomDefault(DEFAULT_GOOGLE_DETAIL_POLICY, 2).defaultValue).toBe(4);
  });
});

describe("default resolution", () => {
  it("resolves Normal to offset 0", () => {
    expect(resolveDetailDefault(DEFAULT_RASTER_DETAIL_POLICY, context)).toEqual({ value: 0, limitedByRange: false });
  });

  it("resolves the renderer default only once it is known", () => {
    expect(resolveDetailDefault(DEFAULT_GOOGLE_DETAIL_POLICY, { ...context, rendererDefaultErrorPx: null })).toBeNull();
    expect(resolveDetailDefault(DEFAULT_GOOGLE_DETAIL_POLICY, context)).toEqual({ value: 20, limitedByRange: false });
  });

  it("labels a recommendation clamped by the range", () => {
    const narrow: GoogleDetailPolicy = { ...DEFAULT_GOOGLE_DETAIL_POLICY, coarsestErrorPx: 8 };
    expect(resolveDetailDefault(narrow, context)).toEqual({ value: 8, limitedByRange: true });
  });

  it("chooses device-hint targets as the flight app did", () => {
    expect(chooseDeviceHintErrorTarget("webgpu", { hardwareConcurrency: 12, deviceMemory: 8 })).toBe(16);
    expect(chooseDeviceHintErrorTarget("webgl2", { hardwareConcurrency: 12, deviceMemory: 8 })).toBe(32);
    expect(chooseDeviceHintErrorTarget("webgpu", { hardwareConcurrency: 12, deviceMemory: 4 })).toBe(64);
    expect(chooseDeviceHintErrorTarget("webgl", { hardwareConcurrency: 2 })).toBe(128);
  });
});

describe("positions and descriptions", () => {
  it("puts coarser detail to the right for both kinds", () => {
    expect(detailPosition("raster", 1)).toBeLessThan(detailPosition("raster", -1));
    expect(detailPosition("google", 4)).toBeLessThan(detailPosition("google", 64));
  });

  it("round-trips values through slider positions", () => {
    for (const value of [-3, -0.75, 0, 0.25, 1]) expect(detailValueAtPosition("raster", detailPosition("raster", value))).toBe(value);
    for (const value of [1, 4, 20, 32, 4096]) expect(detailValueAtPosition("google", detailPosition("google", value))).toBe(value);
  });

  it("describes values for assistive technology", () => {
    expect(describeDetailValue("raster", 0)).toBe("Normal");
    expect(describeDetailValue("raster", 1)).toBe("one level finer than Normal");
    expect(describeDetailValue("raster", -2)).toBe("two levels coarser than Normal");
    expect(describeDetailValue("raster", 0.25)).toBe("0.25 levels finer than Normal");
    expect(describeDetailValue("google", 32)).toBe("Google error target 32 pixels");
  });

  it("halves the allowed image-pixel size per finer step", () => {
    expect(rasterImagePixelTarget(0)).toBe(1);
    expect(rasterImagePixelTarget(1)).toBe(0.5);
    expect(rasterImagePixelTarget(-3)).toBe(8);
  });
});
