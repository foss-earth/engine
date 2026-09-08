import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Airport, AirportMode } from "../../airports/types";
import { airportSpawn } from "../../airports/geometry";

import { LocationSearchResults } from "./LocationSearchResults";
import type { GeodeticLocation, LocationSearchResult, LocationSearchProvider } from "../../search/types";
export type { GeodeticLocation, LocationSearchResult, LocationSearchProvider } from "../../search/types";

export interface LocationPanelProps {
  initialLocation: GeodeticLocation;
  getCurrentLocation?: () => GeodeticLocation | null;
  onApply(location: GeodeticLocation): void;
  searchProvider?: LocationSearchProvider;
  enableAirportPresets?: boolean;
}

/** Shared location editor; the host owns navigation or simulation commands. */
export function LocationPanel({ initialLocation, getCurrentLocation, onApply, searchProvider, enableAirportPresets = false }: LocationPanelProps) {
  const [currentLocation, setCurrentLocation] = useState(initialLocation);
  const refreshLocation = useEffectEvent(() => {
    const next = getCurrentLocation?.() ?? initialLocation;
    setCurrentLocation((current) => current.latDeg === next.latDeg && current.lonDeg === next.lonDeg
      && current.altMeters === next.altMeters && current.zoomMeters === next.zoomMeters ? current : next);
  });
  useEffect(() => {
    const timer = window.setInterval(() => refreshLocation(), 100);
    return () => window.clearInterval(timer);
  }, []);
  const currentAltitude = currentLocation.altMeters ?? currentLocation.zoomMeters;
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [altitude, setAltitude] = useState("");
  const [airport, setAirport] = useState<Airport | null>(null);
  const [airportMode, setAirportMode] = useState<AirportMode>("departure");
  const [runwayId, setRunwayId] = useState("");
  const runway = airport?.runways.find(item => item.id === runwayId);
  const [resolving, setResolving] = useState(false);
  const [searching, setSearching] = useState(false);
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
    setAirport(null);
    setResolving(false);
    setSearching(true);
    setMessage("Searching…");
    try {
      const found = await searchProvider(query.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setResults(found);
      setMessage(found.length ? "Select a result, then apply." : "No places found.");
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Search failed. You can still enter coordinates.");
    } finally {
      if (request.current === controller) setSearching(false);
    }
  };

  const selectResult = async (selection: LocationSearchResult) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAirport(null);
    setResolving(true);
    try {
      if (selection.resolve && enableAirportPresets) setMessage("Loading runway details…");
      const result = selection.resolve && enableAirportPresets ? await selection.resolve(controller.signal) : selection;
      if (controller.signal.aborted) return;
      if (result.airport && enableAirportPresets) {
        setAirport(result.airport);
        setAirportMode(result.airportMode ?? "departure");
        setRunwayId(result.airport.runways[0]?.id ?? "");
        setLat(""); setLon(""); setAltitude("");
        setMessage(result.airport.runways.length ? "Choose departure or arrival and a runway, then Go." : "No usable runway data found. Enter coordinates manually instead.");
        return;
      }
      onApply({ latDeg: result.latDeg, lonDeg: result.lonDeg });
      setCurrentLocation((current) => ({ ...current, latDeg: result.latDeg, lonDeg: result.lonDeg }));
      setLat(""); setLon("");
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
          request.current?.abort(); setResolving(false); setSearching(false); setResults([]); setAirport(null); setMessage(""); setQuery(event.target.value);
        }} placeholder="location search" disabled={!searchProvider} />
        <button type="submit" aria-label="Search" title="Search" disabled={!searchProvider || !query.trim() || searching}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
          </svg>
        </button>
      </div>
      {!searchProvider && <p>Place search is unavailable. Enter coordinates below.</p>}
      <LocationSearchResults results={results} onSelect={result => { void selectResult(result); }} />
      {results.length > 0 && <p className="foss-earth-location-attribution">Search © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · <a href="https://freeairportdb.com" target="_blank" rel="noreferrer">FreeAirportDB</a></p>}
    </form>
    <form className="foss-earth-location-coordinates" onSubmit={(event) => {
      event.preventDefault();
      if (airport) {
        if (!runway) { setMessage("Choose a runway first."); return; }
        try { onApply(airportSpawn(runway, airportMode)); setMessage(`Moved to ${airport.code}, runway ${runway.label} ${airportMode}.`); }
        catch (error) { setMessage(error instanceof Error ? error.message : "Unable to apply airport location."); }
        return;
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
        setLat(""); setLon(""); setAltitude("");
        setMessage("Location applied.");
      }
      catch (error) { setMessage(error instanceof Error ? error.message : "Unable to apply location."); }
    }}>
      {airport && <div className="foss-earth-airport-controls">
        <strong>{airport.code} · {airport.name}</strong>
        <label>Position<select aria-label="Airport position" value={airportMode} onChange={event => setAirportMode(event.target.value as AirportMode)}>
          <option value="departure">Departure</option><option value="arrival">Arrival</option>
        </select></label>
        <label>Runway<select aria-label="Runway" value={runwayId} onChange={event => setRunwayId(event.target.value)}>
          {airport.runways.map(item => <option key={item.id} value={item.id}>{item.label} · {Math.round(item.lengthMeters)} m</option>)}
        </select></label>
        <p>{airportMode === "departure" ? "On runway, paused. Resume when ready for takeoff." : "5 NM final · 3° approach."}</p>
        {runway && runway.elevationMeters === undefined && <p>Runway elevation unavailable.</p>}
        <button type="button" onClick={() => { setAirport(null); setMessage(""); }}>Enter coordinates instead</button>
        <p>Airport data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · <a href="https://freeairportdb.com" target="_blank" rel="noreferrer">FreeAirportDB</a></p>
      </div>}
      <div className="foss-earth-location-fields" hidden={airport !== null}>
      <label>Lat<input type="number" step="any" min="-90" max="90" placeholder={currentLocation.latDeg.toFixed(8)} style={{ width: `calc(${Math.max(lat.length, currentLocation.latDeg.toFixed(8).length)}ch + 18px)` }} value={lat} onChange={(event) => setLat(event.target.value)} /></label>
      <label>Lon<input type="number" step="any" min="-180" max="180" placeholder={currentLocation.lonDeg.toFixed(8)} style={{ width: `calc(${Math.max(lon.length, currentLocation.lonDeg.toFixed(8).length)}ch + 18px)` }} value={lon} onChange={(event) => setLon(event.target.value)} /></label>
      <label>Alt<input aria-label="Altitude in meters" type="number" step="any" style={{ width: `calc(${Math.max(1, altitude.length, currentAltitude?.toFixed(0).length ?? 0)}ch + 18px)` }} value={altitude} onChange={(event) => setAltitude(event.target.value)} placeholder={currentAltitude === undefined ? "" : currentAltitude.toFixed(0)} /></label>
      </div>
      <button className="foss-earth-location-play" type="submit" disabled={resolving || (airport !== null && (!runway || runway.elevationMeters === undefined))} aria-label="Go to location" title="Go to location">
        Go
      </button>
    </form>
    <p role="status">{message}</p>
  </div>;
}
