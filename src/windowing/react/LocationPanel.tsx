import { useEffect, useRef, useState } from "react";

export interface GeodeticLocation { latDeg: number; lonDeg: number }
export interface LocationSearchResult extends GeodeticLocation { id: string; label: string }
export type LocationSearchProvider = (query: string, signal: AbortSignal) => Promise<readonly LocationSearchResult[]>;
export interface LocationPanelProps {
  initialLocation: GeodeticLocation;
  onApply(location: GeodeticLocation): void;
  searchProvider?: LocationSearchProvider;
}

/** Shared location editor; the host owns navigation or simulation commands. */
export function LocationPanel({ initialLocation, onApply, searchProvider }: LocationPanelProps) {
  const [lat, setLat] = useState(String(initialLocation.latDeg));
  const [lon, setLon] = useState(String(initialLocation.lonDeg));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly LocationSearchResult[]>([]);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const search = async () => {
    if (!searchProvider || !query.trim()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResults([]);
    setMessage("Searching…");
    try {
      const found = await searchProvider(query.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setResults(found);
      setMessage(found.length ? "Select a result, then apply." : "No places found.");
    } catch {
      if (!controller.signal.aborted) setMessage("Search failed. You can still enter coordinates.");
    }
  };

  return <div className="foss-earth-location-panel">
    <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <label>Place search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Duluth" disabled={!searchProvider} /></label>
      <button type="submit" disabled={!searchProvider || !query.trim()}>Search</button>
      {!searchProvider && <p>Place search is unavailable. Enter coordinates below.</p>}
      {results.map((result) => <button type="button" key={result.id} onClick={() => {
        setLat(String(result.latDeg)); setLon(String(result.lonDeg));
        onApply({ latDeg: result.latDeg, lonDeg: result.lonDeg });
        setMessage(`Moved to ${result.label}.`);
      }}>{result.label}</button>)}
    </form>
    <form onSubmit={(event) => {
      event.preventDefault();
      const latDeg = Number(lat), lonDeg = Number(lon);
      if (!lat.trim() || !lon.trim() || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) {
        setMessage("Enter latitude from −90 to 90 and longitude from −180 to 180."); return;
      }
      try { onApply({ latDeg, lonDeg }); setMessage("Location applied."); }
      catch (error) { setMessage(error instanceof Error ? error.message : "Unable to apply location."); }
    }}>
      <label>Latitude<input type="number" step="any" min="-90" max="90" required value={lat} onChange={(event) => setLat(event.target.value)} /></label>
      <label>Longitude<input type="number" step="any" min="-180" max="180" required value={lon} onChange={(event) => setLon(event.target.value)} /></label>
      <button type="submit">Apply location</button>
    </form>
    <p role="status">{message}</p>
  </div>;
}
