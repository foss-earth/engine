import { useEffect, useState } from "react";
import type { LocationSearchResult } from "../../search/types";

export function LocationSearchResults({ results, onSelect }: {
  results: readonly LocationSearchResult[];
  onSelect(result: LocationSearchResult): void;
}) {
  const firstGroup = results.find(result => result.loadChildren)?.id;
  return <div className="foss-earth-location-results">
    {results.map(result => <SearchResult key={result.id} result={result} initiallyOpen={result.id === firstGroup} onSelect={onSelect} />)}
  </div>;
}

function SearchResult({ result, initiallyOpen, onSelect }: {
  result: LocationSearchResult;
  initiallyOpen: boolean;
  onSelect(result: LocationSearchResult): void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [children, setChildren] = useState<readonly LocationSearchResult[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const load = result.loadChildren;
  useEffect(() => {
    if (!open || !load) return;
    const controller = new AbortController();
    void load(controller.signal).then(found => {
      if (!controller.signal.aborted) { setChildren(found); setError(""); }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load nearby results.");
    });
    return () => controller.abort();
  }, [open, load, retry]);
  return <div className="foss-earth-location-result">
    <button type="button" className="foss-earth-location-result-title" onClick={() => onSelect(result)}>{result.label}{result.subtitle && <small className="foss-earth-location-result-subtitle">{result.subtitle}</small>}{result.kind === "city" && <small className="foss-earth-location-result-kind">City</small>}</button>
    {load && <div className="foss-earth-location-result-group">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {result.childrenLabel ?? "Nearby places"}</button>
      {open && <div className="foss-earth-location-result-children">
        {error ? <p role="status">{error} <button type="button" onClick={() => { setError(""); setRetry(retry + 1); }}>Retry</button></p>
          : children === null ? <p role="status">Loading…</p>
          : children.length === 0 ? <p>No nearby results found.</p>
          : children.map(child => <button type="button" key={child.id} onClick={() => onSelect(child)}>{child.label}{child.subtitle && <small className="foss-earth-location-result-subtitle">{child.subtitle}</small>}</button>)}
      </div>}
    </div>}
  </div>;
}
