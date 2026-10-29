import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerrainWasmDecoder, type WasmTierPreference, type TerrainWasmModule } from "../src/browser/terrainWasmDecoder.js";
import { decodeTerrarium } from "../src/terrain/terrainGrid.js";

const timers = { setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
function rgba(size = 1) {
  const bytes = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index++) bytes.set([index * 37 % 256, index * 91 % 256, index * 53 % 256, 255], index * 4);
  return bytes;
}
function fixture(requestedTier: WasmTierPreference = "single", decode = vi.fn(decodeTerrarium)) {
  const start = vi.fn(async (): Promise<TerrainWasmModule> => ({ decodeTerrarium: decode }));
  return { ...createTerrainWasmDecoder({ workerId: "worker-1", requestedTier, start, timers }), start, wasm: decode };
}
afterEach(() => vi.useRealTimers());

describe("worker-only Terrarium WASM admission", () => {
  it("starts lazily and returns reference heights on the first exact parity input, then WASM-owned copies", async () => {
    const f = fixture(), data = rgba(64), expected = decodeTerrarium(data, 64);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.status()).toMatchObject({ actualTier: "typescript", state: "typescript", parity: "unchecked" });
    const first = await f.decode(data, 64);
    expect(first).toEqual(expected); expect(first).not.toBe(f.wasm.mock.results[0].value);
    expect(f.status()).toMatchObject({ actualTier: "single", state: "ready", parity: "same", wasmAttempts: 1, wasmDecodes: 0, typescriptDecodes: 1 });
    const next = await f.decode(data, 64), raw = f.wasm.mock.results[1].value;
    expect(next).toEqual(expected); expect(next.buffer).not.toBe(raw.buffer);
    expect(f.wasm.mock.calls[0][0].buffer).not.toBe(data.buffer);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.status()).toMatchObject({ wasmDecodes: 1, typescriptDecodes: 1 });
  });
  it("keeps TypeScript by default and rejects unsupported threaded without importing or starting", async () => {
    for (const tier of ["typescript", "threaded"] as const) {
      const f = fixture(tier), data = rgba();
      expect(await f.decode(data, 1)).toEqual(decodeTerrarium(data, 1));
      expect(f.start).not.toHaveBeenCalled(); expect(f.wasm).not.toHaveBeenCalled();
      expect(f.status()).toMatchObject({ requestedTier: tier, actualTier: "typescript", fallbackReason: tier === "threaded" ? "threaded-unsupported" : null });
    }
    const auto = fixture("auto"); await auto.decode(rgba(), 1);
    expect(auto.status()).toMatchObject({ requestedTier: "auto", actualTier: "single", parity: "same" });
  });
  it("compares Float32 bits including zero sign and permanently rejects a mismatching worker", async () => {
    const wasm = vi.fn(() => new Float32Array([-0])), f = fixture("single", wasm), data = new Uint8ClampedArray([128, 0, 0, 255]);
    expect(Object.is((await f.decode(data, 1))[0], 0)).toBe(true);
    expect(f.status()).toMatchObject({ actualTier: "typescript", state: "fallback", parity: "different", fallbackReason: "parity-mismatch" });
    await f.decode(data, 1); expect(wasm).toHaveBeenCalledOnce();
  });
  it("preserves reference invalid-image errors before importing WASM code", async () => {
    const f = fixture(), data = rgba(); data[3] = 254;
    await expect(f.decode(data, 1)).rejects.toThrow("Terrain image contains missing samples");
    await expect(f.decode(data, 2)).rejects.toThrow("Invalid terrain image dimensions");
    expect(f.start).not.toHaveBeenCalled(); expect(f.status().parity).toBe("unchecked");
    await f.decode(rgba(), 1); expect(f.status().actualTier).toBe("single");
  });
  it("bounds startup, ignores a late module, and never attempts WASM again after timeout", async () => {
    vi.useFakeTimers(); let resolve!: (module: TerrainWasmModule) => void;
    const wasm = vi.fn(decodeTerrarium), start = vi.fn(() => new Promise<TerrainWasmModule>(yes => { resolve = yes; }));
    const f = createTerrainWasmDecoder({ workerId: "slow-start", requestedTier: "single", start, timers, startTimeoutMs: 12 });
    const data = rgba(), decoding = f.decode(data, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status()).toMatchObject({ actualTier: "typescript", state: "starting" });
    await vi.advanceTimersByTimeAsync(12);
    expect(await decoding).toEqual(decodeTerrarium(data, 1));
    resolve({ decodeTerrarium: wasm }); await Promise.resolve();
    await f.decode(data, 1);
    expect(f.status()).toMatchObject({ actualTier: "typescript", fallbackReason: "startup-timeout" });
    expect(start).toHaveBeenCalledOnce(); expect(wasm).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds unresolved WASM async work and permanently falls back with the unmodified input", async () => {
    vi.useFakeTimers(); const data = rgba(), expected = decodeTerrarium(data, 1);
    const wasm = vi.fn((bytes: Uint8ClampedArray, size: number): Float32Array | Promise<Float32Array> => decodeTerrarium(bytes, size));
    const f = createTerrainWasmDecoder({ workerId: "slow-decode", requestedTier: "auto", start: async () => ({ decodeTerrarium: wasm }), timers, decodeTimeoutMs: 9 });
    await f.decode(data, 1);
    wasm.mockImplementationOnce(bytes => { bytes.fill(0); return new Promise(() => {}); });
    const decoding = f.decode(data, 1); await vi.advanceTimersByTimeAsync(9);
    expect(await decoding).toEqual(expected); expect(data).toEqual(rgba());
    expect(f.status()).toMatchObject({ actualTier: "typescript", fallbackReason: "decode-timeout", parity: "same" });
    await f.decode(data, 1); expect(wasm).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("falls back on compile failures, invalid outputs, parity differences and later traps", async () => {
    const data = rgba();
    const failed = createTerrainWasmDecoder({ workerId: "compile-fails", requestedTier: "single", start: async () => { throw new Error("compile"); }, timers });
    expect(await failed.decode(data, 1)).toEqual(decodeTerrarium(data, 1)); expect(failed.status().fallbackReason).toBe("startup-failed");
    for (const output of [new Float32Array(2), new Float32Array([NaN]), new Float32Array([Infinity])]) {
      const f = fixture("single", vi.fn(() => output));
      expect(await f.decode(data, 1)).toEqual(decodeTerrarium(data, 1)); expect(f.status().fallbackReason).toBe("invalid-wasm-result");
    }
    const trapped = fixture(); await trapped.decode(data, 1);
    trapped.wasm.mockImplementationOnce(() => { throw new Error("WASM trap"); });
    expect(await trapped.decode(data, 1)).toEqual(decodeTerrarium(data, 1));
    expect(trapped.status()).toMatchObject({ actualTier: "typescript", fallbackReason: "decode-failed" });
    await trapped.decode(data, 1); expect(trapped.wasm).toHaveBeenCalledTimes(2);
  });
  it("serializes concurrent admission and keeps each worker's verdict and snapshots independent", async () => {
    const good = fixture(), bad = fixture("single", vi.fn(() => new Float32Array([7])));
    const results = await Promise.all([good.decode(rgba(), 1), good.decode(rgba(), 1), bad.decode(rgba(), 1)]);
    for (const result of results) expect(result).toEqual(decodeTerrarium(rgba(), 1));
    expect(good.start).toHaveBeenCalledOnce(); expect(good.status()).toMatchObject({ wasmDecodes: 1, typescriptDecodes: 1, actualTier: "single" });
    expect(bad.status().actualTier).toBe("typescript");
    const snapshot = good.status(); snapshot.actualTier = "typescript";
    expect(good.status().actualTier).toBe("single");
  });
});
