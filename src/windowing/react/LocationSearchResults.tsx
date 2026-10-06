import { useEffect, useEffectEvent, useState } from "react";
import type { LocationSearchResult } from "../../search/types";
import { createLocationResults, type LocationResultNode } from "./locationResults";

export function LocationSearchResults({ results, onSelect, onChange }: {
  results: readonly LocationResultNode[];
  onSelect(node: LocationResultNode): void;
  onChange(result: LocationSearchResult, patch: Partial<Omit<LocationResultNode, "result">>): void;
}) {
  return <div className="foss-earth-location-results">
    {results.map(node => <SearchResult key={node.result.id} node={node} onSelect={onSelect} onChange={onChange} />)}
  </div>;
}

function SearchResult({ node, onSelect, onChange }: {
  node: LocationResultNode;
  onSelect(node: LocationResultNode): void;
  onChange(result: LocationSearchResult, patch: Partial<Omit<LocationResultNode, "result">>): void;
}) {
  const { result, expanded, children, autoLoad } = node;
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const load = result.loadChildren;
  const storeChildren = useEffectEvent((target: LocationSearchResult, found: readonly LocationSearchResult[]) => {
    onChange(target, { children: createLocationResults(found), autoLoad: false });
  });
  useEffect(() => {
    if (!expanded || children !== null || !autoLoad || !load) return;
    const controller = new AbortController();
    void load(controller.signal).then(found => {
      if (!controller.signal.aborted) { storeChildren(result, found); setError(""); }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load nearby results.");
    });
    return () => controller.abort();
  }, [expanded, children, autoLoad, load, retry, result]);
  return <div className="foss-earth-location-result">
    <button type="button" className="foss-earth-location-result-title" onClick={() => onSelect(node)}>{result.label}{result.subtitle && <small className="foss-earth-location-result-subtitle">{result.subtitle}</small>}{result.kind === "city" && <small className="foss-earth-location-result-kind">City</small>}</button>
    {(load || children !== null) && <div className="foss-earth-location-result-group">
      <button type="button" aria-expanded={expanded} onClick={() => {
        setError("");
        onChange(result, { expanded: !expanded, ...(!expanded ? { autoLoad: true } : {}) });
      }}>{expanded ? "▾" : "▸"} {result.childrenLabel ?? "Nearby places"}</button>
      {expanded && <div className="foss-earth-location-result-children">
        {children === null ? error ? <p role="status">{error} <button type="button" onClick={() => { setError(""); setRetry(retry + 1); }}>Retry</button></p>
          : autoLoad ? <p role="status">Loading…</p>
          : <button type="button" onClick={() => onChange(result, { autoLoad: true })}>Load nearby results</button>
          : children.length === 0 ? <p>No nearby results found.</p>
          : children.map(child => <button type="button" key={child.result.id} onClick={() => onSelect(child)}>{child.result.label}{child.result.subtitle && <small className="foss-earth-location-result-subtitle">{child.result.subtitle}</small>}</button>)}
      </div>}
    </div>}
  </div>;
}
