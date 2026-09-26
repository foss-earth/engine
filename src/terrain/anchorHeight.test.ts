import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { DEG_TO_RAD, ecefToGeodetic, geodeticToEcef } from "../camera/cameraMath";
import { createAnchorHeightResolver, sampleToAnchor } from "./anchorHeight";

function anchorAt(latDeg: number, lonDeg: number, heightMeters: number): Vector3 {
  const position = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, heightMeters);
  return new Vector3(position.x, position.y, position.z);
}

describe("createAnchorHeightResolver", () => {
  it("moves an anchor to a cached local height sample", () => {
    const resolver = createAnchorHeightResolver({
      samples: [{ latDeg: 44.977753, lonDeg: -93.265011, heightMeters: 264 }],
    });

    const resolved = resolver.resolve(anchorAt(44.977753, -93.265011, 0));
    const geodetic = ecefToGeodetic(resolved?.x ?? 0, resolved?.y ?? 0, resolved?.z ?? 0);

    expect(geodetic.altMeters).toBeCloseTo(264, 1);
  });

  it("caches provider results by quantized cell", () => {
    const provider = vi.fn(() => 123);
    const resolver = createAnchorHeightResolver({ provider, cellSizeDeg: 0.01 });

    resolver.resolve(anchorAt(10.001, 20.001, 0));
    resolver.resolve(anchorAt(10.002, 20.002, 0));

    expect(provider).toHaveBeenCalledTimes(1);
    expect(resolver.getCachedHeight(10.002, 20.002)).toBe(123);
  });

  it("does not cache provider misses and retries them after the retry window", () => {
    let nowMs = 0;
    const provider = vi.fn(() => null as number | null);
    const resolver = createAnchorHeightResolver({
      provider,
      nowMs: () => nowMs,
      providerMissRetryMs: 1000,
    });

    resolver.resolve(anchorAt(10, 20, 0));
    resolver.resolve(anchorAt(10, 20, 0));
    nowMs = 1001;
    provider.mockReturnValue(456);
    resolver.resolve(anchorAt(10, 20, 0));

    expect(provider).toHaveBeenCalledTimes(2);
    expect(resolver.getCachedHeight(10, 20)).toBe(456);
  });

  it("slews between cached height targets instead of jumping vertically", () => {
    let nowMs = 0;
    const resolver = createAnchorHeightResolver({
      nowMs: () => nowMs,
      maxVerticalSpeedMetersPerSecond: 100,
      samples: [
        { latDeg: 10, lonDeg: 20, heightMeters: 0 },
        { latDeg: 10, lonDeg: 20.01, heightMeters: 300 },
      ],
      cellSizeDeg: 0.001,
    });

    resolver.resolve(anchorAt(10, 20, 0));
    nowMs = 100;
    const resolved = resolver.resolve(anchorAt(10, 20.01, 0));
    const geodetic = ecefToGeodetic(resolved?.x ?? 0, resolved?.y ?? 0, resolved?.z ?? 0);

    expect(geodetic.altMeters).toBeCloseTo(10, 1);
  });

  it("takes a new follow speed and retry time from the next lookup", () => {
    let nowMs = 0;
    const provider = vi.fn(() => null as number | null);
    const resolver = createAnchorHeightResolver({ provider, nowMs: () => nowMs, providerMissRetryMs: 1000, maxVerticalSpeedMetersPerSecond: 100 });
    resolver.resolve(anchorAt(10, 20, 0));
    resolver.setTuning({ providerMissRetryMs: 10_000, maxVerticalSpeedMetersPerSecond: 1000 });
    // The miss already waiting keeps its time; the next one waits the new one.
    nowMs = 1001;
    resolver.resolve(anchorAt(10, 20, 0));
    expect(provider).toHaveBeenCalledTimes(2);
    nowMs = 5000;
    resolver.resolve(anchorAt(10, 20, 0));
    expect(provider).toHaveBeenCalledTimes(2);

    provider.mockReturnValue(300);
    nowMs = 11_002;
    const resolved = resolver.resolve(anchorAt(10, 20, 0));
    // 100 ms (the stall cap) at 1000 m/s.
    expect(ecefToGeodetic(resolved!.x, resolved!.y, resolved!.z).altMeters).toBeCloseTo(100, 1);
  });

  it("uses fallback height when no provider data exists", () => {
    const resolver = createAnchorHeightResolver({ fallbackHeightMeters: 42 });
    const resolved = resolver.resolve(anchorAt(0, 0, 0));
    const geodetic = ecefToGeodetic(resolved?.x ?? 0, resolved?.y ?? 0, resolved?.z ?? 0);

    expect(geodetic.altMeters).toBeCloseTo(42, 1);
  });

  it("adds a configured height offset to the resolved anchor height", () => {
    const resolver = createAnchorHeightResolver({
      samples: [{ latDeg: 44.977753, lonDeg: -93.265011, heightMeters: 264 }],
      heightOffsetMeters: 1_000,
    });

    const resolved = resolver.resolve(anchorAt(44.977753, -93.265011, 0));
    const geodetic = ecefToGeodetic(resolved?.x ?? 0, resolved?.y ?? 0, resolved?.z ?? 0);

    expect(geodetic.altMeters).toBeCloseTo(1_264, 1);
  });

  it("creates an ECEF anchor directly from a sample", () => {
    const anchor = sampleToAnchor({ latDeg: 1, lonDeg: 2, heightMeters: 300 });
    const geodetic = ecefToGeodetic(anchor.x, anchor.y, anchor.z);

    expect(geodetic.altMeters).toBeCloseTo(300, 1);
  });
});