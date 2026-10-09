/** Actual installed public React/cache host fixture. No source imports or live IO. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import { createMapCache } from "@foss-earth/engine/browser";
import { MapCachePanel } from "@foss-earth/engine/react";
import { createMapCachePresentationPolicy, MAP_CACHE_PRESENTATION_PARAMETERS } from "@foss-earth/engine/settings";
import { createSettingsRegistry } from "@foss-earth/ui/settings";

const dom = new JSDOM("<!doctype html><div id='host'></div>"), globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = Object.entries(globals).map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
let root, mounted = false, visible = true, now = 0;
const pulses = new Set(), visibilityListeners = new Set();
try {
  const stores = new Map(), epoch = 1800000000000;
  const cache = createMapCache({ maxBytes: 65536, maxEntries: 1024, maxTileBytes: 8192, now: () => epoch, Response, Request, Headers,
    storage: () => ({ async open(name) {
      if (!stores.has(name)) {
        const rows = new Map(), key = request => typeof request === "string" ? request : request.url;
        stores.set(name, { async match(request) { return rows.get(key(request))?.clone(); }, async put(request, response) { rows.set(key(request), response.clone()); }, async delete(request) { return rows.delete(key(request)); }, async keys() { return [...rows.keys()].map(url => new Request(url)); } });
      }
      return stores.get(name);
    } }),
    fetcher: async () => new Response(new Uint8Array(1024), { headers: { "cache-control": "public,max-age=3600", date: new Date(epoch).toUTCString(), age: "0" } }) });
  for (const url of ["https://tile.openstreetmap.org/1/0/0.png", "https://tile.openstreetmap.org/1/0/1.png"]) await cache.fetch(url);
  const saved = await cache.inspect();assert.equal(saved.entries.length, 2);
  cache.recordBrowserRequest("https://tile.googleapis.com/v1/3dtiles/root.json?key=not-displayed");
  const settings = createSettingsRegistry({ storage: null });settings.register(MAP_CACHE_PRESENTATION_PARAMETERS);assert.equal(settings.get("map.cache.rowsShown"), 40);settings.setMany({ "map.cache.rowsShown": 1 });
  const policy = createMapCachePresentationPolicy(settings), host = document.getElementById("host");
  let inspections = 0, clearCalls = 0, finishClear, clearCompletion;
  const clearGate = new Promise(resolve => { finishClear = resolve; });
  const access = { inspect: async () => { inspections++;return cache.inspect(); }, clear: () => { clearCalls++;clearCompletion = clearGate.then(() => cache.clear());return clearCompletion; } };
  const { createRoot } = await import("react-dom/client");root = createRoot(host);mounted = true;
  await act(async () => root.render(createElement(MapCachePanel, { cache: access, policy, nowMs: () => now,
    refresh: { subscribe(listener) { pulses.add(listener);return () => pulses.delete(listener); } },
    visibility: { isVisible: () => visible, subscribe(listener) { visibilityListeners.add(listener);return () => visibilityListeners.delete(listener); } } })));
  assert.equal(inspections, 1);assert.equal(host.querySelectorAll("details li").length, 1);assert(host.textContent.includes("OpenStreetMap: 2 tiles"));assert(host.textContent.includes("Saved tiles stay within 64.0 KB"));assert(!host.textContent.includes("not-displayed"));
  await act(async () => { const button = host.querySelector("button");button.click();button.click(); });assert.equal(clearCalls, 1);
  visible = false;now = 10000;await act(async () => { for (const listener of pulses) listener(); });assert.equal(inspections, 1);
  await act(async () => root.unmount());mounted = false;assert.equal(pulses.size, 0);assert.equal(visibilityListeners.size, 0);
  finishClear();await clearCompletion;assert.equal((await cache.inspect()).entries.length, 0);assert.equal(inspections, 1);
  const css = await readFile(new URL(import.meta.resolve("@foss-earth/engine/map-cache.css")), "utf8");assert(css.includes(".foss-earth-map-cache .foss-earth-map-cache__tile"));assert(!css.includes(".foss-earth-map-cache-section"));
  console.log("Installed public React map cache, actual cache/policy and late-clear lifecycle fixture passed; no real provider requests or private clock.");
} finally {
  try { if (root && mounted) await act(async () => root.unmount()); }
  finally { dom.window.close();for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor);else delete globalThis[name]; } }
}
