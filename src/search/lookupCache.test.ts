import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tuning = vi.hoisted(() => ({ cacheMs: 1000, cacheEntries: 2, timeoutMs: 1000 }));
vi.mock("./searchTuning", () => ({ searchTuning: () => tuning }));
const valid = (value: unknown): value is number[] => Array.isArray(value) && value.every(item => typeof item === "number");
const signal = () => new AbortController().signal;
let storage: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  Object.assign(tuning, { cacheMs: 1000, cacheEntries: 2, timeoutMs: 1000 });
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("restores successful and empty answers across module reloads", async () => {
  const first = await import("./lookupCache");
  const lookup = vi.fn(async () => [35]);
  const empty = vi.fn(async () => []);
  await first.cachedLookup("runway", signal(), valid, lookup);
  await first.cachedLookup("empty", signal(), valid, empty);
  vi.resetModules();
  const reloaded = await import("./lookupCache");
  expect(await reloaded.cachedLookup("runway", signal(), valid, lookup)).toEqual([35]);
  expect(await reloaded.cachedLookup("empty", signal(), valid, empty)).toEqual([]);
  expect(lookup).toHaveBeenCalledOnce();
  expect(empty).toHaveBeenCalledOnce();
});

it("expires answers using current settings and bounds the least recently used entries", async () => {
  const cache = await import("./lookupCache");
  const lookup = vi.fn(async () => [1]);
  await cache.cachedLookup("a", signal(), valid, lookup);
  await cache.cachedLookup("b", signal(), valid, lookup);
  await cache.cachedLookup("a", signal(), valid, lookup);
  await cache.cachedLookup("c", signal(), valid, lookup);
  vi.resetModules();
  const reloaded = await import("./lookupCache");
  await reloaded.cachedLookup("a", signal(), valid, lookup);
  expect(lookup).toHaveBeenCalledTimes(3);
  await reloaded.cachedLookup("b", signal(), valid, lookup);
  expect(lookup).toHaveBeenCalledTimes(4);
  tuning.cacheMs = 100;
  vi.setSystemTime(Date.now() + 100);
  await reloaded.cachedLookup("b", signal(), valid, lookup);
  expect(lookup).toHaveBeenCalledTimes(5);
});

it("retains aliases across reloads without spending another entry or renewing expiry", async () => {
  tuning.cacheEntries = 1;
  const cache = await import("./lookupCache");
  const lookup = vi.fn(async () => [35]);
  await cache.cachedLookup("MSP", signal(), valid, lookup);
  vi.setSystemTime(Date.now() + 500);
  cache.aliasLookup("MSP", ["KMSP"]);
  vi.resetModules();
  const reloaded = await import("./lookupCache");
  await reloaded.cachedLookup("MSP", signal(), valid, lookup);
  await reloaded.cachedLookup("KMSP", signal(), valid, lookup);
  expect(lookup).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 500);
  await reloaded.cachedLookup("KMSP", signal(), valid, lookup);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("persists lowered storage limits and recency on cache hits", async () => {
  const { cachedLookup } = await import("./lookupCache");
  const lookup = vi.fn(async () => [1]);
  await cachedLookup("a", signal(), valid, lookup);
  await cachedLookup("b", signal(), valid, lookup);
  await cachedLookup("a", signal(), valid, lookup);
  expect(JSON.parse(storage.get("foss-earth.location-lookups.v1")!).map((entry: { keys: string[] }) => entry.keys[0])).toEqual(["b", "a"]);
  tuning.cacheEntries = 1;
  await cachedLookup("a", signal(), valid, lookup);
  expect(JSON.parse(storage.get("foss-earth.location-lookups.v1")!)).toHaveLength(1);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("shares concurrent work while a cancelled caller leaves other callers running", async () => {
  const { cachedLookup } = await import("./lookupCache");
  let complete!: (value: number[]) => void;
  let upstream!: AbortSignal;
  const lookup = vi.fn((requestSignal: AbortSignal) => {
    upstream = requestSignal;
    return new Promise<number[]>(resolve => { complete = resolve; });
  });
  const controller = new AbortController();
  const first = cachedLookup("same", controller.signal, valid, lookup);
  const second = cachedLookup("same", signal(), valid, lookup);
  await Promise.resolve();
  const cancellation = expect(first).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await cancellation;
  expect(upstream.aborted).toBe(false);
  complete([35]);
  expect(await second).toEqual([35]);
  await cachedLookup("same", signal(), valid, lookup);
  expect(lookup).toHaveBeenCalledOnce();
});

it("aborts unneeded work and never caches its late answer", async () => {
  const { cachedLookup } = await import("./lookupCache");
  let complete!: (value: number[]) => void;
  let upstream!: AbortSignal;
  const controller = new AbortController();
  const old = cachedLookup("same", controller.signal, valid, requestSignal => {
    upstream = requestSignal;
    return new Promise<number[]>(resolve => { complete = resolve; });
  });
  await Promise.resolve();
  const cancellation = expect(old).rejects.toThrow();
  controller.abort();
  await cancellation;
  expect(upstream.aborted).toBe(true);
  const fresh = vi.fn(async () => [2]);
  expect(await cachedLookup("same", signal(), valid, fresh)).toEqual([2]);
  complete([1]);
  await Promise.resolve();
  expect(await cachedLookup("same", signal(), valid, fresh)).toEqual([2]);
  expect(fresh).toHaveBeenCalledOnce();
});

it("does not cache failed or invalid answers and checks cancellation before cache hits", async () => {
  const { cachedLookup } = await import("./lookupCache");
  const lookup = vi.fn<() => Promise<number[]>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("invalid" as unknown as number[])
    .mockResolvedValue([1]);
  await expect(cachedLookup("same", signal(), valid, lookup)).rejects.toThrow("offline");
  await expect(cachedLookup("same", signal(), valid, lookup)).rejects.toThrow("Invalid");
  await cachedLookup("same", signal(), valid, lookup);
  const controller = new AbortController(); controller.abort();
  await expect(cachedLookup("same", controller.signal, valid, lookup)).rejects.toThrow();
  expect(lookup).toHaveBeenCalledTimes(3);
});

it.each(["unavailable", "quota", "corrupt", "wrong shape", "wrong value"])("falls back safely with %s storage", async mode => {
  if (mode === "unavailable") vi.stubGlobal("localStorage", undefined);
  if (mode === "quota") vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
  if (mode === "corrupt") storage.set("foss-earth.location-lookups.v1", "{broken");
  if (mode === "wrong shape") storage.set("foss-earth.location-lookups.v1", '[null,{"keys":35}]');
  if (mode === "wrong value") storage.set("foss-earth.location-lookups.v1", JSON.stringify([{ keys: ["same"], storedAt: Date.now(), value: "bad" }]));
  const { cachedLookup } = await import("./lookupCache");
  const lookup = vi.fn(async () => [35]);
  expect(await cachedLookup("same", signal(), valid, lookup)).toEqual([35]);
  expect(await cachedLookup("same", signal(), valid, lookup)).toEqual([35]);
  expect(lookup).toHaveBeenCalledOnce();
});
