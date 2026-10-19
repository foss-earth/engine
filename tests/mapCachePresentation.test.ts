// @vitest-environment jsdom
import { describe,expect,it,vi } from "vitest";
import { createHelpTooltip, createIconButton } from "@foss-earth/ui/browser";
import { createMapCacheSection as createInjectedMapCacheSection } from "../src/map/mapCacheSection.js";
const createMapCacheSection = (ports: Omit<Parameters<typeof createInjectedMapCacheSection>[0], "createHelpTooltip" | "createIconButton">) => createInjectedMapCacheSection({ ...ports, createHelpTooltip, createIconButton });
import type { MapCacheSnapshot } from "../src/browser/mapCache.js";
const snapshot: MapCacheSnapshot = { available: true,entries: [],bytes: 0,maxBytes: 100,hits: 0,browserRequests: [] };
const flush = async () => { for (let n=0;n<5;n++) await Promise.resolve(); };
describe("Map cache on shared host presentation pulse", () => {
  it("deduplicates pending inspections, skips closed sections and stops its shared subscription", async () => {
    let now = 0,pulse: (() => void) | undefined,finish: (value: MapCacheSnapshot) => void = () => {};const stop = vi.fn();
    const inspect = vi.fn(() => new Promise<MapCacheSnapshot>(resolve => { finish = resolve; }));
    const panel = createMapCacheSection({ document,inspect,clear: async () => {},nowMs: () => now,refreshIntervalMs: () => 2000,rowLimit: () => 40,refresh: { subscribe(listener) { pulse = listener;return stop; } } });
    const details = document.createElement("details");details.open = true;details.append(panel.element);document.body.append(details);
    try { now = 3000;pulse?.();expect(inspect).toHaveBeenCalledOnce();finish(snapshot);await flush();details.open = false;now = 6000;pulse?.();expect(inspect).toHaveBeenCalledOnce();
      details.open = true;pulse?.();expect(inspect).toHaveBeenCalledTimes(2);panel.destroy();finish(snapshot);await flush();now = 9000;pulse?.();expect(inspect).toHaveBeenCalledTimes(2);expect(stop).toHaveBeenCalledOnce();
    } finally { panel.destroy();details.remove(); }
  });
  it("does not inspect or publish a clear completion after disposal", async () => {
    const populated = { ...snapshot,entries: [{ url: "https://tile.openstreetmap.org/0/0/0.png",provider: "OpenStreetMap",bytes: 1,storedAt: 0,expiresAt: 100 }] };
    let finish: () => void = () => {};const clear = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));const inspect = vi.fn(async () => populated);
    const panel = createMapCacheSection({ document,inspect,clear,nowMs: () => 0,refreshIntervalMs: () => 2000,rowLimit: () => 40,refresh: { subscribe: () => () => {} } });
    await flush();(panel.element.querySelector("button") as HTMLButtonElement).click();expect(clear).toHaveBeenCalledOnce();panel.destroy();finish();await flush();expect(inspect).toHaveBeenCalledOnce();
  });
  it("reports a rejected post-clear inspection and releases the clearing state", async () => {
    const populated = { ...snapshot,entries: [{ url: "https://tile.openstreetmap.org/0/0/0.png",provider: "OpenStreetMap",bytes: 1,storedAt: 0,expiresAt: 100 }] };
    const inspect = vi.fn().mockResolvedValueOnce(populated).mockRejectedValueOnce(new Error("storage unavailable"));
    const panel = createMapCacheSection({ document,inspect,clear: async () => {},nowMs: () => 0,refreshIntervalMs: () => 2000,rowLimit: () => 40,refresh: { subscribe: () => () => {} } });
    try { await flush();(panel.element.querySelector("button") as HTMLButtonElement).click();await flush();
      expect(panel.element.querySelector('[role="status"]')?.textContent).toContain("Could not clear saved tiles");expect((panel.element.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
    } finally { panel.destroy(); }
  });
  it("shares the live per-provider row policy without changing totals or adding an inspection", async () => {
    const populated = { ...snapshot, bytes: 3, entries: [0,1,2].map(index => ({ url: `https://tile.openstreetmap.org/1/0/${index}.png`, provider: "OpenStreetMap", bytes: 1, storedAt: 0, expiresAt: 100 })) };
    let rows = 2, pulse: (() => void) | undefined;const inspect = vi.fn(async () => populated);
    const panel = createMapCacheSection({ document, inspect, clear: async () => {}, nowMs: () => 1, refreshIntervalMs: () => 2000, rowLimit: () => rows,
      refresh: { subscribe(listener) { pulse = listener;return () => {}; } } });document.body.append(panel.element);
    try {
      await flush();expect(panel.element.querySelectorAll("details li")).toHaveLength(2);expect(panel.element.textContent).toContain("OpenStreetMap: 3 tiles");
      rows = 1;pulse?.();expect(panel.element.querySelectorAll("details li")).toHaveLength(1);expect(panel.element.textContent).toContain("Showing the first 1 tiles.");expect(inspect).toHaveBeenCalledOnce();
    } finally { panel.destroy(); }
  });
  it("keeps the title, summary, usage, Clear and ? in one row, with what the caches are behind ?", async () => {
    const populated = { ...snapshot, bytes: 1, browserRequests: [{ provider: "OpenStreetMap", requests: 4 }], entries: [{ url: "https://tile.openstreetmap.org/0/0/0.png", provider: "OpenStreetMap", bytes: 1, storedAt: 0, expiresAt: 100 }] };
    const panel = createMapCacheSection({ document, inspect: async () => populated, clear: async () => {}, nowMs: () => 0, refreshIntervalMs: () => 2000, rowLimit: () => 40, refresh: { subscribe: () => () => {} } });
    document.body.append(panel.element);
    try {
      await flush();
      const row = panel.element.firstElementChild!;
      expect(row.firstElementChild!.textContent).toBe("Saved tiles");
      expect(row.querySelector("progress")).not.toBeNull();
      const clear = row.querySelector<HTMLButtonElement>('button[aria-label="Clear saved tiles"]')!;
      expect(clear.textContent).toBe("");
      expect(clear.disabled).toBe(false);
      const help = row.lastElementChild!.querySelector<HTMLButtonElement>("button")!;
      expect(help.getAttribute("aria-label")).toBe("Explain saved tiles");
      help.click();
      const about = document.getElementById(help.getAttribute("aria-controls")!)!;
      expect(about.textContent).toContain("API keys and session URLs are never kept");
      expect(about.textContent).toContain("browser's HTTP cache");
      expect(panel.element.textContent).toContain("Requests this visit, cache hits included: OpenStreetMap 4");
      expect(panel.element.querySelectorAll(".foss-earth-choices__heading")).toHaveLength(1);
    } finally { panel.destroy(); }
  });
});
