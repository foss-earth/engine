import { describe, expect, it } from "vitest";
import { createTerrainPerformanceCapture } from "./terrainPerformanceCapture";

describe("opt-in terrain capture", () => {
  it("keeps a bounded window and includes preparation between frames", () => {
    const capture = createTerrainPerformanceCapture(2);
    for (let i = 0; i < 3; i++) {
      capture.counters.preparationCpuMs += i + 1;
      capture.beginFrame(i * 16);
      capture.counters.samples = 4 + i;
      capture.endFrame();
    }
    const snapshot = capture.snapshot();
    expect(snapshot.frames).toBe(2);
    expect(snapshot.metrics.preparationCpuMs.mean).toBe(2.5);
    expect(snapshot.metrics.samples.p95).toBe(6);
    expect(snapshot.metrics.frameIntervalMs.mean).toBe(16);
    expect(capture.counters.samples).toBe(0);
    expect(capture.counters.preparationCpuMs).toBe(0);
    expect(snapshot.gpuTimeMs).toBeNull();
    expect(() => createTerrainPerformanceCapture(Infinity)).toThrow();
  });
});
