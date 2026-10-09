import { expect, it, vi } from "vitest";
import type { LocationSearchResult as GenericResult } from "../src/location/contracts.js";
type LocationSearchResult = GenericResult<AbortSignal>;
import {
  createLocationResults, isLocationResultSnapshots, restoreLocationResults, snapshotLocationResults, updateLocationResult,
  type LocationResultSnapshot,
} from "../src/location/locationResults.js";

const point: LocationSearchResult = { id: "opaque:place/1", label: "A place", latDeg: 45, lonDeg: -93 };
const signal = () => new AbortController().signal;
const saved = (results: readonly LocationSearchResult[]): readonly LocationResultSnapshot[] =>
  JSON.parse(JSON.stringify(snapshotLocationResults(createLocationResults(results)))) as readonly LocationResultSnapshot[];

it("keeps fresh callbacks and expands only the first group", () => {
  const first: LocationSearchResult = { ...point, id: "first", loadChildren: vi.fn(async () => []) };
  const second: LocationSearchResult = { ...point, id: "second", loadChildren: vi.fn(async () => []) };
  const nodes = createLocationResults([point, first, second]);
  expect(nodes.map(node => node.expanded)).toEqual([false, true, false]);
  expect(nodes.map(node => node.autoLoad)).toEqual([true, true, true]);
  expect(nodes.every(node => node.children === null)).toBe(true);
  expect(nodes[0].result).toBe(point);
  expect(nodes[1].result).toBe(first);
  expect(first.loadChildren).not.toHaveBeenCalled();
  expect(second.loadChildren).not.toHaveBeenCalled();
});

it("round trips flat results offline and keeps only known location data", () => {
  const result = { ...point, subtitle: "Saved place", kind: "place" as const, altMeters: 256, zoomMeters: 1000, extra: "discard" };
  const snapshots = saved([result]);
  expect(isLocationResultSnapshots(snapshots)).toBe(true);
  expect(snapshots[0].result).not.toHaveProperty("extra");
  const [restored] = restoreLocationResults<AbortSignal>(snapshots, "old search");
  expect(restored).toMatchObject({ result: { id: point.id, label: point.label, altMeters: 256, zoomMeters: 1000 }, autoLoad: false, expanded: false, children: null });
  expect(restored.result.loadChildren).toBeUndefined();
  expect(restored.result.resolve).toBeUndefined();
});

it("retains expanded state and distinguishes unloaded groups from completed empty groups", () => {
  const first = { ...point, id: "unloaded", loadChildren: vi.fn(async () => []) };
  const second = { ...point, id: "empty", loadChildren: vi.fn(async () => []) };
  let nodes = createLocationResults([first, second]);
  nodes = updateLocationResult(nodes, second, { expanded: true, children: [] });
  const provider = vi.fn(async () => [first, second]);
  const restored = restoreLocationResults<AbortSignal>(snapshotLocationResults(nodes), "groups", provider);
  expect(restored.map(node => node.expanded)).toEqual([true, true]);
  expect(restored.map(node => node.children)).toEqual([null, []]);
  expect(restored.every(node => !node.autoLoad)).toBe(true);
  expect(provider).not.toHaveBeenCalled();
  expect(first.loadChildren).not.toHaveBeenCalled();
  expect(second.loadChildren).not.toHaveBeenCalled();
});

it("rehydrates nested callbacks lazily through the original query and opaque ID path", async () => {
  const resolved = { ...point, id: "complete", label: "Complete detail", altMeters: 300 };
  const resolve = vi.fn(async () => resolved);
  const leaf = { ...point, id: "custom:leaf/with|separators", resolve };
  const middleLoad = vi.fn(async () => [leaf]);
  const middle = { ...point, id: "middle/opaque:2", loadChildren: middleLoad };
  const rootLoad = vi.fn(async () => [middle]);
  const group = { ...point, id: "root:opaque/3", loadChildren: rootLoad };
  let nodes = createLocationResults([group]);
  nodes = updateLocationResult(nodes, group, { children: createLocationResults([middle]) });
  nodes = updateLocationResult(nodes, middle, { children: createLocationResults([leaf]) });
  const provider = vi.fn(async () => [{ ...point, id: "unrelated" }, group]);
  const restored = restoreLocationResults<AbortSignal>(snapshotLocationResults(nodes), "MSP departure", provider);
  const restoredLeaf = restored[0].children![0].children![0];
  expect(restoredLeaf.autoLoad).toBe(false);
  expect(provider).not.toHaveBeenCalled();
  expect(rootLoad).not.toHaveBeenCalled();
  expect(middleLoad).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  const controller = new AbortController();
  expect(await restoredLeaf.result.resolve!(controller.signal)).toBe(resolved);
  expect(provider).toHaveBeenCalledWith("MSP departure", controller.signal);
  expect(rootLoad).toHaveBeenCalledWith(controller.signal);
  expect(middleLoad).toHaveBeenCalledWith(controller.signal);
  expect(resolve).toHaveBeenCalledWith(controller.signal);
  expect(await restored[0].result.loadChildren!(signal())).toEqual([middle]);
  expect(provider).toHaveBeenCalledOnce();
  expect(rootLoad).toHaveBeenCalledOnce();
});

it("reconstructs an unloaded group's custom loader only after its explicit invocation", async () => {
  const load = vi.fn(async () => [point]);
  const group = { ...point, id: "custom opaque group", loadChildren: load };
  const provider = vi.fn(async () => [group]);
  const [restored] = restoreLocationResults<AbortSignal>(saved([group]), "custom query", provider);
  expect(provider).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(await restored.result.loadChildren!(signal())).toEqual([point]);
  expect(provider).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
});

it("keeps callback capability visible when the provider or original result is unavailable", async () => {
  const original = { ...point, loadChildren: vi.fn(async () => []), resolve: vi.fn(async () => point) };
  const snapshots = saved([original]);
  const [offline] = restoreLocationResults<AbortSignal>(snapshots, "old query");
  expect(offline.result.loadChildren).toBeTypeOf("function");
  expect(offline.result.resolve).toBeTypeOf("function");
  await expect(offline.result.loadChildren!(signal())).rejects.toThrow("search provider");
  await expect(offline.result.resolve!(signal())).rejects.toThrow("search provider");
  const [missing] = restoreLocationResults<AbortSignal>(snapshots, "old query", async () => [{ ...point, id: "different" }]);
  await expect(missing.result.resolve!(signal())).rejects.toThrow("no longer available");
  const [missingCallback] = restoreLocationResults<AbortSignal>(snapshots, "old query", async () => [point]);
  await expect(missingCallback.result.resolve!(signal())).rejects.toThrow("no longer available");
  await expect(missingCallback.result.loadChildren!(signal())).rejects.toThrow("no longer available");
});

it("honors cancellation without retaining an aborted provider result", async () => {
  const resolve = vi.fn(async () => point);
  const original = { ...point, resolve };
  const controller = new AbortController();
  const provider = vi.fn(async () => [original]).mockImplementationOnce(async () => {
    controller.abort();
    return [original];
  });
  const [restored] = restoreLocationResults<AbortSignal>(saved([original]), "query", provider);
  await expect(restored.result.resolve!(controller.signal)).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  expect(await restored.result.resolve!(signal())).toBe(point);
  expect(provider).toHaveBeenCalledTimes(2);
  const cancelled = new AbortController(); cancelled.abort();
  await expect(restored.result.resolve!(cancelled.signal)).rejects.toThrow();
  expect(resolve).toHaveBeenCalledOnce();
});

it("updates nested results by object identity and preserves untouched references", () => {
  const parent = { ...point, id: "parent" };
  const sibling = { ...point, id: "sibling" };
  const children = createLocationResults([point, sibling]);
  const nodes = updateLocationResult(createLocationResults([parent, sibling]), parent, { children });
  expect(updateLocationResult(nodes, { ...point }, { expanded: true })).toBe(nodes);
  const updated = updateLocationResult(nodes, point, { expanded: true, resolved: point });
  expect(updated).not.toBe(nodes);
  expect(updated[0]).not.toBe(nodes[0]);
  expect(updated[1]).toBe(nodes[1]);
  expect(updated[0].children![1]).toBe(children[1]);
  expect(updated[0].children![0]).toMatchObject({ expanded: true, resolved: point });
  expect(updated[0].children![0].result).toBe(point);
});

const corruptions: [string, (entry: Record<string, unknown>) => void][] = [
  ["missing result", entry => { delete entry.result; }],
  ["invalid coordinates", entry => { (entry.result as Record<string, unknown>).latDeg = 200; }],
  ["invalid altitude", entry => { (entry.result as Record<string, unknown>).altMeters = "high"; }],
  ["invalid result kind", entry => { (entry.result as Record<string, unknown>).kind = "other"; }],
  ["invalid callback capability", entry => { entry.canResolve = "yes"; }],
  ["invalid expanded state", entry => { entry.expanded = 1; }],
  ["missing children state", entry => { delete entry.children; }],
  ["invalid child", entry => { entry.children = [null]; }],
  ["invalid resolved detail", entry => { entry.resolved = { label: "broken" }; }],
];
it.each(corruptions)("rejects snapshot corruption: %s", (_name, corrupt) => {
  const snapshots = JSON.parse(JSON.stringify(saved([point]))) as Record<string, unknown>[];
  corrupt(snapshots[0]);
  expect(isLocationResultSnapshots(snapshots)).toBe(false);
});

it("rejects non-arrays and cyclic result trees", () => {
  expect(isLocationResultSnapshots(null)).toBe(false);
  expect(isLocationResultSnapshots({})).toBe(false);
  expect(isLocationResultSnapshots([null])).toBe(false);
  expect(isLocationResultSnapshots([])).toBe(true);
  const cyclic = [...saved([point])];
  cyclic[0].children = cyclic;
  expect(isLocationResultSnapshots(cyclic)).toBe(false);
});
