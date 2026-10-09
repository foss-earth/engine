import type { MapCacheSnapshot } from "../browser/mapCache.js";
import { mapCacheRowLimit } from "./mapCachePresentation.js";
export interface MapCacheSectionPorts { document: Document; inspect(): Promise<MapCacheSnapshot>; clear(): Promise<void>;
  refreshIntervalMs(): number; nowMs(): number; rowLimit(): number;
  /** The existing host presentation pulse; no private timer is constructed. */
  refresh: { subscribe(listener: () => void): () => void } }

export interface MapCacheSectionHandle {
  element: HTMLElement;
  destroy(): void;
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function makeParagraph(document: Document, text: string, className = "foss-earth-choices__note"): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

/**
 * The map's HTTP tile cache in Map → Loading and memory: what the app keeps,
 * by provider, and a way to clear it. Managed storage and the browser's own
 * HTTP cache are separate, and the section says which is which.
 */
export function createMapCacheSection(ports: MapCacheSectionPorts): MapCacheSectionHandle {
  const document = ports.document;
  const paragraph = (text: string, className?: string) => makeParagraph(document, text, className);
  const element = document.createElement("div");
  element.className = "foss-earth-map-cache-section";
  element.setAttribute("aria-label", "Map cache");
  const heading = document.createElement("div");
  heading.className = "foss-earth-choices__heading";
  heading.textContent = "Saved tiles";
  const summary = paragraph("Reading cache…");
  const usage = document.createElement("progress");
  usage.setAttribute("aria-label", "Saved tile cache usage");
  usage.max = 1;
  usage.value = 0;
  const availability = paragraph("");
  availability.hidden = true;
  const providers = document.createElement("div");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "foss-earth-choice foss-earth-parameter__action";
  clear.textContent = "Clear saved tiles";
  const limit = paragraph("");
  const browserHeading = document.createElement("div");
  browserHeading.className = "foss-earth-choices__heading";
  browserHeading.textContent = "Browser cache";
  const browser = paragraph("Maps reuse the browser's HTTP cache when the provider permits it. Google 3D Tiles use it under Google's caching rules. Its contents and size cannot be listed or cleared by this page: use the browser's control for cached images and files.");
  const requests = document.createElement("div");
  const privacy = paragraph("Saved tiles contain public map requests only. API keys and session URLs are never kept in managed storage.");
  const status = paragraph("");
  status.setAttribute("role", "status");
  element.append(heading, summary, usage, availability, providers, clear, limit, browserHeading, browser, requests, privacy, status);

  let snapshot: MapCacheSnapshot | null = null;
  let disposed = false;
  let clearing = false;
  let shownRowLimit = NaN;

  const render = (): void => {
    const rowLimit = mapCacheRowLimit(ports.rowLimit());
    shownRowLimit = rowLimit;
    summary.textContent = snapshot ? `${snapshot.entries.length} tiles · ${size(snapshot.bytes)} of ${size(snapshot.maxBytes)}` : "Reading cache…";
    usage.max = snapshot?.maxBytes || 1;
    usage.value = snapshot?.bytes ?? 0;
    availability.hidden = !snapshot || (snapshot.available && snapshot.entries.length > 0);
    availability.textContent = !snapshot ? "" : !snapshot.available
      ? "Managed storage is unavailable in this browser session."
      : "No app-managed tiles saved yet. Providers that hide freshness headers use the browser cache.";
    limit.textContent = snapshot
      ? `Saved tiles stay within ${size(snapshot.maxBytes)} and expire as the provider's headers say. The oldest unused tiles go first.`
      : "";
    const groups = new Map<string, { bytes: number; count: number }>();
    for (const entry of snapshot?.entries ?? []) {
      const group = groups.get(entry.provider) ?? { bytes: 0, count: 0 };
      group.bytes += entry.bytes;
      group.count += 1;
      groups.set(entry.provider, group);
    }
    providers.replaceChildren(...[...groups].map(([provider, group]) => {
      const details = document.createElement("details");
      const title = document.createElement("summary");
      title.textContent = `${provider}: ${group.count} tiles · ${size(group.bytes)}`;
      const list = document.createElement("ul");
      for (const entry of (snapshot?.entries ?? []).filter(item => item.provider === provider).slice(0, rowLimit)) {
        const item = document.createElement("li");
        const path = document.createElement("span");
        path.className = "foss-earth-map-cache__tile";
        path.textContent = new URL(entry.url).pathname;
        const meta = document.createElement("small");
        meta.textContent = `${size(entry.bytes)} · expires ${new Date(entry.expiresAt).toLocaleString()}`;
        item.append(path, meta);
        list.append(item);
      }
      details.append(title, list);
      if (group.count > rowLimit) details.append(paragraph(`Showing the first ${rowLimit} tiles.`));
      return details;
    }));
    clear.disabled = clearing || !snapshot?.available || snapshot.entries.length === 0;
    clear.textContent = clearing ? "Clearing…" : "Clear saved tiles";
    requests.replaceChildren(...(snapshot && snapshot.browserRequests.length > 0 ? [
      paragraph("Provider requests this visit, browser cache hits included:"),
      ...snapshot.browserRequests.map(({ provider, requests: count }) => paragraph(`${provider}: ${count}`)),
    ] : []));
  };

  let pending = false, lastRefresh = -Infinity, inspectionGeneration = 0;
  const refresh = (): void => {
    if (disposed || pending || clearing) return;
    const generation = inspectionGeneration;
    pending = true; lastRefresh = ports.nowMs();
    void ports.inspect().then(value => {
      if (disposed || generation !== inspectionGeneration) return;
      snapshot = value;
      render();
    }, () => {
      if (disposed || generation !== inspectionGeneration) return;
      status.textContent = "Could not inspect map storage. Map loading can continue.";
    }).finally(() => { pending = false; });
  };
  const onClear = (): void => {
    if (disposed || clearing) return;
    inspectionGeneration += 1;
    clearing = true;
    render();
    void ports.clear().then(async () => {
      if (disposed) return;
      const next = await ports.inspect();
      if (disposed) return;
      snapshot = next;
      status.textContent = "Saved tile cache cleared. Tiles already in the scene remain visible.";
    }).catch(() => {
      if (disposed) return;
      status.textContent = "Could not clear saved tiles. Check the browser's site storage settings.";
    }).finally(() => {
      clearing = false;
      if (!disposed) render();
    });
  };
  clear.addEventListener("click", onClear);
  render();
  refresh();
  // The host pulse reads only open sections at the explicitly supplied cadence.
  const stopRefresh = ports.refresh.subscribe(() => {
    if (!disposed && element.isConnected && element.closest("details")?.open !== false) {
      if (shownRowLimit !== mapCacheRowLimit(ports.rowLimit())) render();
      if (ports.nowMs() - lastRefresh >= ports.refreshIntervalMs()) refresh();
    }
  });

  return {
    element,
    destroy() {
      if (disposed) return;
      disposed = true;
      stopRefresh();
      clear.removeEventListener("click", onClear);
      element.remove();
    },
  };
}
