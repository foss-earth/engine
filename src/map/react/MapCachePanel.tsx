import { useEffect, useRef, useState } from "react";
import type { MapCacheSnapshot } from "../../browser/mapCache.js";
import { mapCacheRowLimit, mapCacheRefreshInterval, type MapCacheAccess, type MapCachePresentationPolicy,
  type MapCachePresentationRefresh, type MapCachePresentationVisibility } from "../mapCachePresentation.js";

export interface MapCachePanelProps {
  cache: MapCacheAccess;
  refresh: MapCachePresentationRefresh;
  visibility: MapCachePresentationVisibility;
  nowMs(): number;
  policy: MapCachePresentationPolicy;
}
interface View { snapshot: MapCacheSnapshot | null; clearing: boolean; message: string; rowLimit: number }
interface Session {
  disposed: boolean;
  pending: object | null;
  clearing: boolean;
  lastRefresh: number;
  view: View;
  clear(): Promise<void>;
}
function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** Show paths only: query strings, credentials, sessions and fragments never enter text. */
function pathOnly(url: string): string {
  try { return new URL(url).pathname; } catch { return "Unavailable tile path"; }
}

/** Existing cache presentation, borrowing the host cache, pulse and visibility. */
export function MapCachePanel({ cache, refresh, visibility, nowMs, policy }: MapCachePanelProps) {
  const [view, setView] = useState<View>(() => ({ snapshot: null, clearing: false, message: "", rowLimit: mapCacheRowLimit(policy.rowLimit()) }));
  const active = useRef<Session | null>(null);
  useEffect(() => {
    const session: Session = { disposed: false, pending: null, clearing: false, lastRefresh: -Infinity,
      view: { snapshot: null, clearing: false, message: "", rowLimit: mapCacheRowLimit(policy.rowLimit()) }, clear: async () => {} };
    active.current = session;
    const live = () => !session.disposed && active.current === session;
    const publish = (patch: Partial<View>) => {
      if (!live()) return;
      session.view = { ...session.view, ...patch };
      setView(session.view);
    };
    publish({});
    const inspect = async () => {
      if (!live() || session.pending || session.clearing || !visibility.isVisible()) return;
      const token = {}; session.pending = token; session.lastRefresh = nowMs();
      try {
        const snapshot = await cache.inspect();
        if (live() && session.pending === token) publish({ snapshot });
      } catch {
        if (live() && session.pending === token) publish({ message: "Could not inspect map storage. Map loading can continue." });
      } finally { if (session.pending === token) session.pending = null; }
    };
    session.clear = async () => {
      if (!live() || session.clearing || !visibility.isVisible() || !session.view.snapshot?.available || !session.view.snapshot.entries.length) return;
      session.clearing = true;
      // The older inspection may be unabortable. It no longer owns publication.
      session.pending = null;
      publish({ clearing: true });
      try {
        await cache.clear();
        if (!live()) return;
        if (visibility.isVisible()) {
          const snapshot = await cache.inspect();
          if (!live()) return;
          if (visibility.isVisible()) {
            session.lastRefresh = nowMs();
            publish({ snapshot });
          } else {
            session.lastRefresh = -Infinity;
            publish({ snapshot: null });
          }
        } else {
          session.lastRefresh = -Infinity;
          publish({ snapshot: null });
        }
        publish({ message: "Saved tile cache cleared. Tiles already in the scene remain visible." });
      } catch {
        if (live()) publish({ message: "Could not clear saved tiles. Check your browser's site storage settings." });
      } finally {
        session.clearing = false;
        if (live()) publish({ clearing: false });
      }
    };
    let wasVisible = visibility.isVisible();
    const pulse = (visibilityChanged: boolean) => {
      if (!live()) return;
      const visible = visibility.isVisible(), reopened = visible && !wasVisible;
      wasVisible = visible;
      if (!visible) return;
      const rowLimit = mapCacheRowLimit(policy.rowLimit());
      if (rowLimit !== session.view.rowLimit) publish({ rowLimit });
      if ((visibilityChanged && reopened) || nowMs() - session.lastRefresh >= mapCacheRefreshInterval(policy.refreshIntervalMs())) void inspect();
    };
    const stops: Array<() => void> = [];
    const dispose = () => {
      if (session.disposed) return;
      session.disposed = true; session.pending = null;
      if (active.current === session) active.current = null;
      const failures: unknown[] = [];
      for (const stop of stops.splice(0)) try { stop(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Map cache presentation subscriptions failed to detach.");
    };
    try {
      stops.push(refresh.subscribe(() => pulse(false)));
      stops.push(visibility.subscribe(() => pulse(true)));
      void inspect();
    } catch (error) {
      try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Map cache presentation setup and cleanup failed."); }
      throw error;
    }
    return dispose;
  }, [cache, refresh, visibility, nowMs, policy]);

  const { snapshot, clearing, message, rowLimit } = view;
  const groups = new Map<string, { bytes: number; count: number }>();
  for (const entry of snapshot?.entries ?? []) {
    const group = groups.get(entry.provider) ?? { bytes: 0, count: 0 };
    group.bytes += entry.bytes; group.count++; groups.set(entry.provider, group);
  }
  return <section className="foss-earth-map-cache" aria-label="Map cache settings">
    <h3>Map &amp; terrain cache</h3>
    <p>Maps reuse your browser's HTTP cache automatically when the provider permits it.</p>
    <h4>Saved tiles</h4>
    <p>{snapshot ? `${snapshot.entries.length} tiles · ${size(snapshot.bytes)} / ${size(snapshot.maxBytes)}` : "Reading cache…"}</p>
    <progress aria-label="Saved tile cache usage" value={snapshot?.bytes ?? 0} max={snapshot?.maxBytes || 1} />
    {snapshot && !snapshot.available && <p>Managed storage is unavailable in this browser session.</p>}
    {snapshot?.available && snapshot.entries.length === 0 && <p>No app-managed tiles saved yet. Providers that hide freshness headers use the browser cache.</p>}
    {[...groups].map(([provider, group]) => <details key={provider}>
      <summary>{provider}: {group.count} tiles · {size(group.bytes)}</summary>
      <ul>{snapshot?.entries.filter(entry => entry.provider === provider).slice(0, rowLimit).map(entry => <li key={entry.url}>
        <span className="foss-earth-map-cache__tile">{pathOnly(entry.url)}</span>
        <small>{size(entry.bytes)} · expires {new Date(entry.expiresAt).toLocaleString()}</small>
      </li>)}</ul>
      {group.count > rowLimit && <p>Showing the first {rowLimit} tiles.</p>}
    </details>)}
    <button type="button" disabled={clearing || !snapshot?.available || snapshot.entries.length === 0} onClick={() => { void active.current?.clear(); }}>
      {clearing ? "Clearing…" : "Clear saved tiles"}
    </button>
    <p className="foss-earth-map-cache__note">{snapshot
      ? `Saved tiles stay within ${size(snapshot.maxBytes)} and expire according to provider headers. Oldest unused tiles are removed first.`
      : "Saved tiles expire according to provider headers. Oldest unused tiles are removed first."}</p>
    <h4>Browser-managed cache</h4>
    <p>Google 3D Tiles use the browser cache under Google's caching rules. Browser cache contents and size cannot be listed or cleared by this page. Use your browser's clear cached images and files control to flush them.</p>
    {snapshot && snapshot.browserRequests.length > 0 && <>
      <p>Provider requests this session (includes browser cache hits):</p>
      <ul>{snapshot.browserRequests.map(({ provider, requests }) => <li key={provider}>{provider}: {requests}</li>)}</ul>
    </>}
    <p className="foss-earth-map-cache__note">Saved tiles contain public map requests only. API keys and session URLs are never added to managed storage.</p>
    <p role="status">{message}</p>
  </section>;
}
