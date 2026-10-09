// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { MapCachePanel, type MapCachePanelProps } from "../src/react.js";
import type { MapCacheSnapshot } from "../src/browser/mapCache.js";
import { createMapCachePresentationPolicy, MAP_CACHE_PRESENTATION_PARAMETERS } from "../src/settings/index.js";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { createManagedMapCacheFixture, createMapCachePresentationHost } from "../fixtures/composition/mapCacheHost.js";

const empty: MapCacheSnapshot = { available: true, entries: [], bytes: 0, maxBytes: 65536, hits: 0, browserRequests: [] };
const populated = (path: string): MapCacheSnapshot => ({ ...empty, bytes: 1024,
  entries: [{ url: `https://tile.openstreetmap.org/${path}.png`, provider: "OpenStreetMap", bytes: 1024, storedAt: 0, expiresAt: 1800000000000 }] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; }
const policy = { rowLimit: () => 40, refreshIntervalMs: () => 2000 };
async function mount(props: MapCachePanelProps) {
  const element = document.createElement("div");document.body.append(element);
  const root = createRoot(element);let disposed = false;
  await act(async () => { root.render(createElement(MapCachePanel, props)); });
  return { element, async replace(next: MapCachePanelProps) { await act(async () => { root.render(createElement(MapCachePanel, next)); }); },
    async unmount() { if (disposed) return;disposed = true;try { await act(async () => { root.unmount(); }); } finally { element.remove(); } } };
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => { vi.unstubAllGlobals();document.body.replaceChildren(); });

it("presents the actual public cache provider totals, dynamic budget, browser requests and shared registry policy", async () => {
  const settings = createSettingsRegistry({ storage: null });settings.register(MAP_CACHE_PRESENTATION_PARAMETERS);
  expect(settings.get("map.cache.rowsShown")).toBe(40);expect(settings.get("map.cache.inspectInterval")).toBe(2000);
  expect(MAP_CACHE_PRESENTATION_PARAMETERS.every(spec => spec.home.tab === "map" && spec.home.section === "loading")).toBe(true);
  settings.setMany({ "map.cache.rowsShown": 2 });
  const cache = await createManagedMapCacheFixture(["https://tile.openstreetmap.org/1/0/0.png", "https://tile.openstreetmap.org/1/0/1.png", "https://tile.openstreetmap.org/1/1/0.png", "https://tiles.mapterhorn.com/1/0/0.png"]);
  cache.recordBrowserRequest("https://tile.googleapis.com/v1/3dtiles/root.json?key=not-managed");
  const host = createMapCachePresentationHost(), inspect = vi.fn(() => cache.inspect());
  const panel = await mount({ cache: { inspect, clear: cache.clear }, ...host, policy: createMapCachePresentationPolicy(settings) });
  try {
    expect(panel.element.textContent).toContain("4 tiles · 4.0 KB / 64.0 KB");
    expect(panel.element.textContent).toContain("OpenStreetMap: 3 tiles · 3.0 KB");
    expect(panel.element.textContent).toContain("Mapterhorn elevation: 1 tiles · 1.0 KB");
    expect(panel.element.querySelectorAll("details li")).toHaveLength(3);expect(panel.element.textContent).toContain("Showing the first 2 tiles.");
    expect(panel.element.textContent).toContain("Saved tiles stay within 64.0 KB");expect(panel.element.textContent).not.toContain("128 MB");
    expect(panel.element.textContent).toContain("Google 3D Tiles: 1");expect(panel.element.textContent).not.toContain("not-managed");
    settings.setMany({ "map.cache.rowsShown": 1 });await act(async () => host.pulse(1));
    expect(panel.element.querySelectorAll("details li")).toHaveLength(2);expect(inspect).toHaveBeenCalledOnce();
  } finally { await panel.unmount(); }
  expect(host.refreshListeners.size).toBe(0);expect(host.visibilityListeners.size).toBe(0);
});

it("shares the visible host pulse, deduplicates inspection and refreshes on reopening without a private timer", async () => {
  const host = createMapCachePresentationHost(false), first = deferred<MapCacheSnapshot>(), second = deferred<MapCacheSnapshot>();
  const inspect = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const panel = await mount({ cache: { inspect, clear: async () => {} }, ...host, policy });
  try {
    await act(async () => host.pulse(3000));expect(inspect).not.toHaveBeenCalled();
    await act(async () => host.setVisible(true));expect(inspect).toHaveBeenCalledOnce();
    await act(async () => host.pulse(6000));expect(inspect).toHaveBeenCalledOnce();
    await act(async () => { host.setVisible(false);first.resolve(populated("first")); });
    await act(async () => host.pulse(9000));expect(inspect).toHaveBeenCalledOnce();
    await act(async () => host.setVisible(true));expect(inspect).toHaveBeenCalledTimes(2);
    const latePulse = [...host.refreshListeners][0];await panel.unmount();
    await act(async () => { second.resolve(populated("late"));latePulse(); });expect(inspect).toHaveBeenCalledTimes(2);
  } finally { await panel.unmount(); }
});

it("locks repeated clear clicks and prevents an older inspection from replacing the post-clear answer", async () => {
  const host = createMapCachePresentationHost(), old = deferred<MapCacheSnapshot>(), fresh = deferred<MapCacheSnapshot>(), cleared = deferred<void>();
  const inspect = vi.fn().mockResolvedValueOnce(populated("initial")).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise), clear = vi.fn(() => cleared.promise);
  const panel = await mount({ cache: { inspect, clear }, ...host, policy });
  try {
    await act(async () => host.pulse(2000));expect(inspect).toHaveBeenCalledTimes(2);
    const button = panel.element.querySelector("button")!;
    await act(async () => { button.click();button.click(); });expect(clear).toHaveBeenCalledOnce();expect(button.textContent).toBe("Clearing…");
    await act(async () => { cleared.resolve(); });expect(inspect).toHaveBeenCalledTimes(3);
    await act(async () => { fresh.resolve(populated("fresh")); });
    await act(async () => { old.resolve(populated("obsolete")); });
    expect(panel.element.textContent).toContain("/fresh.png");expect(panel.element.textContent).not.toContain("obsolete");
    expect(panel.element.querySelector('[role="status"]')?.textContent).toContain("Tiles already in the scene remain visible");expect(button.disabled).toBe(false);
  } finally { await panel.unmount(); }
});

it("does not inspect after a clear completes on an unmounted or hidden panel", async () => {
  const host = createMapCachePresentationHost(), cleared = deferred<void>(), inspect = vi.fn(async () => populated("initial"));
  const panel = await mount({ cache: { inspect, clear: () => cleared.promise }, ...host, policy });
  await act(async () => panel.element.querySelector("button")!.click());await panel.unmount();
  await act(async () => { cleared.resolve(); });expect(inspect).toHaveBeenCalledOnce();expect(host.refreshListeners.size).toBe(0);expect(host.visibilityListeners.size).toBe(0);
  const hiddenClear = deferred<void>(), other = createMapCachePresentationHost(), hiddenInspect = vi.fn(async () => populated("hidden"));
  const hidden = await mount({ cache: { inspect: hiddenInspect, clear: () => hiddenClear.promise }, ...other, policy });
  try {
    await act(async () => { hidden.element.querySelector("button")!.click();other.setVisible(false);hiddenClear.resolve(); });
    expect(hiddenInspect).toHaveBeenCalledOnce();await act(async () => other.setVisible(true));expect(hiddenInspect).toHaveBeenCalledTimes(2);
  } finally { await hidden.unmount(); }
});

it("retires an old cache binding before accepting a replacement cache's inspection", async () => {
  const old = deferred<MapCacheSnapshot>(), firstHost = createMapCachePresentationHost(), nextHost = createMapCachePresentationHost();
  const panel = await mount({ cache: { inspect: () => old.promise, clear: async () => {} }, ...firstHost, policy });
  try {
    await panel.replace({ cache: { inspect: async () => populated("replacement"), clear: async () => {} }, ...nextHost, policy });
    await act(async () => { old.resolve(populated("old-binding")); });
    expect(panel.element.textContent).toContain("replacement");expect(panel.element.textContent).not.toContain("old-binding");
    expect(firstHost.refreshListeners.size).toBe(0);expect(firstHost.visibilityListeners.size).toBe(0);
  } finally { await panel.unmount(); }
});

it("retains unavailable and empty storage messages and never displays credentials or query/fragment secrets", async () => {
  const host = createMapCachePresentationHost(), inspect = vi.fn().mockResolvedValueOnce({ ...empty, available: false }).mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...populated("public"),
    entries: [{ ...populated("public").entries[0], url: "https://private:password@tile.openstreetmap.org/public.png?key=secret#session" }] });
  const panel = await mount({ cache: { inspect, clear: async () => {} }, ...host, policy });
  try {
    expect(panel.element.textContent).toContain("Managed storage is unavailable");expect(panel.element.querySelector("button")!.disabled).toBe(true);
    await act(async () => host.pulse(2000));expect(panel.element.textContent).toContain("No app-managed tiles saved yet");
    await act(async () => host.pulse(4000));expect(panel.element.textContent).toContain("/public.png");
    for (const value of ["private", "password", "secret", "session"]) expect(panel.element.querySelector("details")!.textContent).not.toContain(value);
  } finally { await panel.unmount(); }
});

it("reports inspection/post-clear failure while releasing the clear lock for retry", async () => {
  const host = createMapCachePresentationHost(), inspect = vi.fn().mockRejectedValueOnce(new Error("private storage detail")).mockResolvedValueOnce(populated("retry")).mockRejectedValueOnce(new Error("cannot inspect"));
  const clear = vi.fn(async () => {}), panel = await mount({ cache: { inspect, clear }, ...host, policy });
  try {
    expect(panel.element.querySelector('[role="status"]')?.textContent).toContain("Could not inspect map storage");expect(panel.element.textContent).not.toContain("private storage detail");
    await act(async () => host.pulse(2000));await act(async () => panel.element.querySelector("button")!.click());
    expect(panel.element.querySelector('[role="status"]')?.textContent).toContain("Could not clear saved tiles");expect(panel.element.querySelector("button")!.disabled).toBe(false);expect(clear).toHaveBeenCalledOnce();
  } finally { await panel.unmount(); }
});

it("releases a rejected cache-clear action for retry without displaying its private error", async () => {
  const host = createMapCachePresentationHost(), inspect = vi.fn().mockResolvedValueOnce(populated("retry")).mockResolvedValueOnce(empty);
  const clear = vi.fn().mockRejectedValueOnce(new Error("private cache path")).mockResolvedValueOnce(undefined);
  const panel = await mount({ cache: { inspect, clear }, ...host, policy });
  try {
    await act(async () => panel.element.querySelector("button")!.click());
    expect(panel.element.querySelector('[role="status"]')?.textContent).toContain("Could not clear saved tiles");
    expect(panel.element.textContent).not.toContain("private cache path");expect(panel.element.querySelector("button")!.disabled).toBe(false);
    await act(async () => panel.element.querySelector("button")!.click());expect(clear).toHaveBeenCalledTimes(2);
    expect(panel.element.textContent).toContain("No app-managed tiles saved yet");expect(panel.element.querySelector("button")!.disabled).toBe(true);
  } finally { await panel.unmount(); }
});

it("releases an acquired refresh subscription if visibility setup fails before returning a stop handle", async () => {
  const setupFailure = new Error("visibility setup failed"), stop = vi.fn(), element = document.createElement("div"), root = createRoot(element);
  let failure: unknown;
  try {
    await act(async () => root.render(createElement(MapCachePanel, { cache: { inspect: async () => empty, clear: async () => {} }, nowMs: () => 0, policy,
      refresh: { subscribe: () => stop }, visibility: { isVisible: () => true, subscribe: () => { throw setupFailure; } } })));
  } catch (error) { failure = error; }
  finally { await act(async () => root.unmount()); }
  expect(failure).toBe(setupFailure);expect(stop).toHaveBeenCalledOnce();
});

it("detaches both acquired subscriptions when the first supplied stop throws", async () => {
  const host = createMapCachePresentationHost(), stopFailure = new Error("refresh detach failed"), stopVisibility = vi.fn();
  const panel = await mount({ cache: { inspect: async () => empty, clear: async () => {} }, nowMs: host.nowMs, policy,
    refresh: { subscribe(listener) { const stop = host.refresh.subscribe(listener);return () => { stop();throw stopFailure; }; } },
    visibility: { isVisible: host.visibility.isVisible, subscribe(listener) { const stop = host.visibility.subscribe(listener);return () => { stop();stopVisibility(); }; } } });
  const failure = await panel.unmount().catch(error => error);
  expect(failure).toBe(stopFailure);expect(stopVisibility).toHaveBeenCalledOnce();expect(host.refreshListeners.size).toBe(0);expect(host.visibilityListeners.size).toBe(0);
});
