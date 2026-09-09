import { useEffect, useState } from "react";
import { clearMapCache, inspectMapCache, type MapCacheSnapshot } from "../terrain/mapCache";

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Shared settings surface: managed storage and browser HTTP caching are separate. */
export function MapCachePanel() {
  const [snapshot, setSnapshot] = useState<MapCacheSnapshot | null>(null);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void inspectMapCache().then(value => { if (!disposed) setSnapshot(value); }, () => {
      if (!disposed) setMessage("Could not inspect map storage. Map loading can continue.");
    }); };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const clear = async () => {
    setClearing(true);
    try {
      await clearMapCache();
      setSnapshot(await inspectMapCache());
      setMessage("Saved tile cache cleared. Tiles already in the scene remain visible.");
    } catch { setMessage("Could not clear saved tiles. Check your browser's site storage settings."); }
    finally { setClearing(false); }
  };
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
    <progress aria-label="Saved tile cache usage" value={snapshot?.bytes ?? 0} max={snapshot?.maxBytes ?? 1} />
    {snapshot && !snapshot.available && <p>Managed storage is unavailable in this browser session.</p>}
    {snapshot?.available && snapshot.entries.length === 0 && <p>No app-managed tiles saved yet. Providers that hide freshness headers use the browser cache.</p>}
    {[...groups].map(([provider, group]) => <details key={provider}>
      <summary>{provider}: {group.count} tiles · {size(group.bytes)}</summary>
      <ul>{snapshot?.entries.filter(entry => entry.provider === provider).slice(0, 40).map(entry => <li key={entry.url}>
        <span className="foss-earth-map-cache__tile">{new URL(entry.url).pathname}</span>
        <small>{size(entry.bytes)} · expires {new Date(entry.expiresAt).toLocaleString()}</small>
      </li>)}</ul>
      {group.count > 40 && <p>Showing the first 40 tiles.</p>}
    </details>)}
    <button type="button" disabled={clearing || !snapshot?.available || snapshot.entries.length === 0} onClick={() => { void clear(); }}>
      {clearing ? "Clearing…" : "Clear saved tiles"}
    </button>
    <p className="foss-earth-map-cache__note">Saved tiles stay within 128 MB and expire according to provider headers. Oldest unused tiles are removed first.</p>
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
