import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";


import { LocationSearchResults } from "./LocationSearchResults.js";
import { type LatitudeHemisphere, type LocationDraftStore, type LongitudeHemisphere } from "../locationDraft.js";
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
export type AltitudeReferenceChoice = "asl" | "agl";

function unsignedDraft<H extends string>(saved: string, stored: string | undefined, live: number, negative: H, positive: H): { text: string; hemisphere: H } {
  if (stored === negative) return { text: saved, hemisphere: negative };
  if (stored === positive) return { text: saved, hemisphere: positive };
  const trimmed = saved.trim();
  if (trimmed.startsWith("-")) return { text: trimmed.slice(1), hemisphere: negative };
  if (trimmed) return { text: saved, hemisphere: positive };
  return { text: "", hemisphere: live < 0 ? negative : positive };
}

/** A leading minus chooses the southern or western side and leaves the field unsigned. */
function stripLeadingMinus(value: string): { value: string; negative: boolean } {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("-")) return { value, negative: false };
  return { value: trimmed.slice(1), negative: true };
}

function signedDegrees(text: string, negative: boolean, fallback: number): number {
  const magnitude = text.trim() ? Math.abs(Number(text)) : Math.abs(fallback);
  if (!Number.isFinite(magnitude)) return Number.NaN;
  return negative && magnitude !== 0 ? -magnitude : magnitude;
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
  /** When false, latitude, longitude and altitude stay on the position readout. */
  showCoordinates?: boolean;
  altitudeReference?: AltitudeReferenceChoice;
  onAltitudeReferenceChange?(reference: AltitudeReferenceChoice): void;
}

/** Shared location editor; the host owns navigation or simulation commands. */
export function LocationPanel({ initialLocation, getCurrentLocation, onApply, searchProvider, observeLocation, searchAttribution, createAbortController, draft, hostDataCodec, contribution, showCoordinates = true, altitudeReference: altitudeReferenceProp, onAltitudeReferenceChange }: LocationPanelProps) {
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
  const initialLat = unsignedDraft(saved.lat, saved.latHemisphere, initialLocation.latDeg, "S", "N");
  const initialLon = unsignedDraft(saved.lon, saved.lonHemisphere, initialLocation.lonDeg, "W", "E");
  const [lat, setLat] = useState(initialLat.text);
  const [lon, setLon] = useState(initialLon.text);
  const [latHemisphere, setLatHemisphere] = useState<LatitudeHemisphere>(initialLat.hemisphere);
  const [lonHemisphere, setLonHemisphere] = useState<LongitudeHemisphere>(initialLon.hemisphere);
  const [altitudeReference, setAltitudeReference] = useState<AltitudeReferenceChoice>(altitudeReferenceProp ?? "asl");
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
    draft.write({ query, lat, lon, altitude, latHemisphere, lonHemisphere, hostData,
      resultQuery, results: snapshotLocationResults(results, hostDataCodec) });
  }, [draft, hostDataCodec, query, lat, lon, altitude, latHemisphere, lonHemisphere, hostData, resultQuery, results]);

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
      setLat(String(Math.abs(result.latDeg))); setLatHemisphere(result.latDeg < 0 ? "S" : "N");
      setLon(String(Math.abs(result.lonDeg))); setLonHemisphere(result.lonDeg < 0 ? "W" : "E");
      setMessage(`Moved to ${result.label}.`);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Unable to load location details.");
    } finally {
      if (request.current === controller) setResolving(false);
    }
  };

  const reference = altitudeReferenceProp ?? altitudeReference;
  const chooseReference = (value: AltitudeReferenceChoice) => {
    setAltitudeReference(value);
    onAltitudeReferenceChange?.(value);
  };
  const latPlaceholder = Math.abs(currentLocation.latDeg).toFixed(4);
  const lonPlaceholder = Math.abs(currentLocation.lonDeg).toFixed(4);
  const altPlaceholder = currentAltitude === undefined ? "" : currentAltitude.toFixed(0);
  const showFields = showCoordinates && !(contribution?.hideCoordinates(hostData) ?? false);
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
      {!searchProvider && showFields && <p>Place search is unavailable. Enter coordinates below.</p>}
      <LocationSearchResults results={results} createAbortController={createAbortController} onSelect={result => { void selectResult(result); }}
        onChange={(result, patch) => setResults(current => updateLocationResult(current, result, patch))} />
      {results.length > 0 && <p className="foss-earth-location-attribution">{searchAttribution}</p>}
    </form>
    {showFields || contribution ? <form className="foss-earth-location-coordinates" onSubmit={(event) => {
      event.preventDefault();
      if (contribution) {
        try { if (contribution.apply(contributionContext())) return; }
        catch (error) { setMessage(error instanceof Error ? error.message : "Unable to apply location."); return; }
      }
      if (!showFields) return;
      const latDeg = signedDegrees(lat, latHemisphere === "S", currentLocation.latDeg);
      const lonDeg = signedDegrees(lon, lonHemisphere === "W", currentLocation.lonDeg);
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
      {showFields ? <div className="foss-earth-location-fields">
      <span className="foss-earth-location-coordinate">
        <input aria-label="Latitude" inputMode="decimal" placeholder={latPlaceholder} style={{ width: `calc(${Math.max(lat.length, latPlaceholder.length)}ch + 18px)` }} value={lat} onChange={(event) => {
          const next = stripLeadingMinus(event.target.value);
          if (next.negative) setLatHemisphere("S");
          setLat(next.value);
        }} />
        <select aria-label="Latitude hemisphere" value={latHemisphere} onChange={(event) => setLatHemisphere(event.target.value === "S" ? "S" : "N")}>
          <option value="N">N</option>
          <option value="S">S</option>
        </select>
      </span>
      <span className="foss-earth-location-coordinate">
        <input aria-label="Longitude" inputMode="decimal" placeholder={lonPlaceholder} style={{ width: `calc(${Math.max(lon.length, lonPlaceholder.length)}ch + 18px)` }} value={lon} onChange={(event) => {
          const next = stripLeadingMinus(event.target.value);
          if (next.negative) setLonHemisphere("W");
          setLon(next.value);
        }} />
        <select aria-label="Longitude hemisphere" value={lonHemisphere} onChange={(event) => setLonHemisphere(event.target.value === "W" ? "W" : "E")}>
          <option value="E">E</option>
          <option value="W">W</option>
        </select>
      </span>
      <span className="foss-earth-location-coordinate">
        <input aria-label="Altitude in meters" inputMode="decimal" style={{ width: `calc(${Math.max(1, altitude.length, altPlaceholder.length)}ch + 18px)` }} value={altitude} onChange={(event) => setAltitude(event.target.value)} placeholder={altPlaceholder} />
        <select aria-label="Altitude reference" value={reference} onChange={(event) => chooseReference(event.target.value === "agl" ? "agl" : "asl")}>
          <option value="asl">ASL</option>
          <option value="agl">AGL</option>
        </select>
      </span>
      </div> : null}
      {showFields || contribution ? <button className="foss-earth-location-play" type="submit" disabled={resolving || (contribution?.blocked(hostData) ?? false)} aria-label="Go to location" title="Go to location">
        Go
      </button> : null}
    </form> : null}
    <p role="status">{message}</p>
  </div>;
}
