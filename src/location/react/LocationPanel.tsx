import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";


import { LocationSearchResults } from "./LocationSearchResults.js";
import type { LocationDraftStore } from "../locationDraft.js";
import { createLocationResults, restoreLocationResults, snapshotLocationResults, updateLocationResult, type LocationResultNode } from "../locationResults.js";
import type { GeodeticLocation, LocationHostDataCodec, LocationSearchProvider } from "../contracts.js";
export type { GeodeticLocation, LocationSearchResult, LocationSearchProvider } from "../contracts.js";

export interface LocationContributionContext {
  hostData: unknown;
  setHostData(value: unknown): void;
  currentLocation: GeodeticLocation;
  onApply(location: GeodeticLocation): void;
  setMessage(message: string): void;
  cancelResolution(): void;
}
/** Domain presets are rendered/applied by their host, never by the globe. */
export interface LocationPanelContribution {
  resolveSelected?: boolean;
  resolvingMessage?: string;
  select(result: LocationResultNode<AbortSignal>["result"], context: LocationContributionContext): boolean;
  apply(context: LocationContributionContext): boolean;
  render(context: LocationContributionContext): ReactNode;
  hideCoordinates(hostData: unknown): boolean;
  blocked(hostData: unknown): boolean;
}
export interface LocationPanelProps {
  initialLocation: GeodeticLocation;
  getCurrentLocation?: () => GeodeticLocation | null;
  /** Host subscribes to its existing current-view authority; original refresh cadence was 100 ms. */
  observeLocation(listener: () => void): () => void;
  onApply(location: GeodeticLocation): void;
  searchProvider?: LocationSearchProvider<AbortSignal>;
  searchAttribution: ReactNode;
  createAbortController(): AbortController;
  draft: LocationDraftStore;
  hostDataCodec?: LocationHostDataCodec;
  contribution?: LocationPanelContribution;
}

/** Shared location editor; the host owns navigation or simulation commands. */
export function LocationPanel({ initialLocation, getCurrentLocation, onApply, searchProvider, observeLocation, searchAttribution, createAbortController, draft, hostDataCodec, contribution }: LocationPanelProps) {
  const [currentLocation, setCurrentLocation] = useState(initialLocation);
  const refreshLocation = useEffectEvent(() => {
    const next = getCurrentLocation?.() ?? initialLocation;
    setCurrentLocation((current) => current.latDeg === next.latDeg && current.lonDeg === next.lonDeg
      && current.altMeters === next.altMeters && current.zoomMeters === next.zoomMeters ? current : next);
  });
  useEffect(() => {
    return observeLocation(() => refreshLocation());
  }, [observeLocation]);
  const currentAltitude = currentLocation.altMeters ?? currentLocation.zoomMeters;
  const [saved] = useState(() => draft.read());
  const [lat, setLat] = useState(saved.lat);
  const [lon, setLon] = useState(saved.lon);
  const [altitude, setAltitude] = useState(saved.altitude);
  const [hostData, setHostData] = useState<unknown>(saved.hostData);
  const [resolving, setResolving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState(saved.query);
  const [resultQuery, setResultQuery] = useState(saved.resultQuery ?? "");
  const [results, setResults] = useState(() => restoreLocationResults<AbortSignal>(saved.results ?? [], saved.resultQuery ?? saved.query, searchProvider, hostDataCodec));
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    draft.write({ query, lat, lon, altitude, hostData,
      resultQuery, results: snapshotLocationResults(results, hostDataCodec) });
  }, [draft, hostDataCodec, query, lat, lon, altitude, hostData, resultQuery, results]);

  const cancelResolution = () => {
    if (!resolving) return;
    request.current?.abort();
    setResolving(false);
    setMessage("");
  };

  const contributionContext = (): LocationContributionContext => ({
    hostData, setHostData, currentLocation, onApply, setMessage, cancelResolution,
  });

  const search = async () => {
    if (!searchProvider || !query.trim()) return;
    request.current?.abort();
    const controller = createAbortController();
    request.current = controller;
    setResults([]);
    setResultQuery(query.trim());
    setResolving(false);
    setSearching(true);
    setMessage("Searching…");
    try {
      const found = await searchProvider(query.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setResults(createLocationResults(found));
      setMessage(found.length ? "Select a result, then apply." : "No places found.");
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Search failed. You can still enter coordinates.");
    } finally {
      if (request.current === controller) setSearching(false);
    }
  };

  const selectResult = async (node: LocationResultNode<AbortSignal>) => {
    const selection = node.result;
    request.current?.abort();
    const controller = createAbortController();
    request.current = controller;
    setResolving(true);
    try {
      if (!node.resolved && selection.resolve && contribution?.resolveSelected) setMessage(contribution.resolvingMessage ?? "Loading location details…");
      const result = contribution?.resolveSelected ? node.resolved ?? (selection.resolve ? await selection.resolve(controller.signal) : selection) : selection;
      if (controller.signal.aborted) return;
      if (result !== selection) setResults(current => updateLocationResult(current, selection, { resolved: result }));
      if (contribution?.select(result, contributionContext())) return;
      onApply({ latDeg: result.latDeg, lonDeg: result.lonDeg });
      setHostData(undefined);
      setCurrentLocation((current) => ({ ...current, latDeg: result.latDeg, lonDeg: result.lonDeg }));
      setLat(String(result.latDeg)); setLon(String(result.lonDeg));
      setMessage(`Moved to ${result.label}.`);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Unable to load location details.");
    } finally {
      if (request.current === controller) setResolving(false);
    }
  };

  return <div className="foss-earth-location-panel">
    <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <div className="foss-earth-location-search-row">
        <input aria-label="Location search" value={query} onChange={(event) => {
          request.current?.abort(); setResolving(false); setSearching(false); setResults([]); setResultQuery(""); setMessage(""); setQuery(event.target.value);
        }} placeholder="location search" disabled={!searchProvider} />
        <button type="submit" aria-label="Search" title="Search" disabled={!searchProvider || !query.trim() || searching}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
          </svg>
        </button>
      </div>
      {!searchProvider && <p>Place search is unavailable. Enter coordinates below.</p>}
      <LocationSearchResults results={results} createAbortController={createAbortController} onSelect={result => { void selectResult(result); }}
        onChange={(result, patch) => setResults(current => updateLocationResult(current, result, patch))} />
      {results.length > 0 && <p className="foss-earth-location-attribution">{searchAttribution}</p>}
    </form>
    <form className="foss-earth-location-coordinates" onSubmit={(event) => {
      event.preventDefault();
      if (contribution) {
        try { if (contribution.apply(contributionContext())) return; }
        catch (error) { setMessage(error instanceof Error ? error.message : "Unable to apply location."); return; }
      }
      const latDeg = lat.trim() ? Number(lat) : currentLocation.latDeg;
      const lonDeg = lon.trim() ? Number(lon) : currentLocation.lonDeg;
      if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) {
        setMessage("Enter latitude from −90 to 90 and longitude from −180 to 180."); return;
      }
      const altitudeMeters = altitude.trim() ? Number(altitude) : currentAltitude;
      if (altitudeMeters !== undefined && !Number.isFinite(altitudeMeters)) {
        setMessage("Enter a valid altitude in meters."); return;
      }
      try {
        const location = { latDeg, lonDeg, ...(altitudeMeters === undefined ? {} : currentLocation.altMeters !== undefined ? { altMeters: altitudeMeters } : { zoomMeters: altitudeMeters }) };
        onApply(location);
        setCurrentLocation(location);
        setMessage("Location applied.");
      }
      catch (error) { setMessage(error instanceof Error ? error.message : "Unable to apply location."); }
    }}>
      {contribution?.render(contributionContext())}
      <div className="foss-earth-location-fields" hidden={contribution?.hideCoordinates(hostData) ?? false}>
      <label>Lat<input type="number" step="any" min="-90" max="90" placeholder={currentLocation.latDeg.toFixed(8)} style={{ width: `calc(${Math.max(lat.length, currentLocation.latDeg.toFixed(8).length)}ch + 18px)` }} value={lat} onChange={(event) => setLat(event.target.value)} /></label>
      <label>Lon<input type="number" step="any" min="-180" max="180" placeholder={currentLocation.lonDeg.toFixed(8)} style={{ width: `calc(${Math.max(lon.length, currentLocation.lonDeg.toFixed(8).length)}ch + 18px)` }} value={lon} onChange={(event) => setLon(event.target.value)} /></label>
      <label>Alt<input aria-label="Altitude in meters" type="number" step="any" style={{ width: `calc(${Math.max(1, altitude.length, currentAltitude?.toFixed(0).length ?? 0)}ch + 18px)` }} value={altitude} onChange={(event) => setAltitude(event.target.value)} placeholder={currentAltitude === undefined ? "" : currentAltitude.toFixed(0)} /></label>
      </div>
      <button className="foss-earth-location-play" type="submit" disabled={resolving || (contribution?.blocked(hostData) ?? false)} aria-label="Go to location" title="Go to location">
        Go
      </button>
    </form>
    <p role="status">{message}</p>
  </div>;
}
