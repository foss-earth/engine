import type { Airport } from "../../airports/types";
import { isAirport } from "../../airports/validateAirport";
import type { LocationSearchProvider, LocationSearchResult } from "../../search/types";

export interface LocationResultNode {
  result: LocationSearchResult;
  expanded: boolean;
  children: readonly LocationResultNode[] | null;
  autoLoad: boolean;
  resolved?: LocationSearchResult;
}

export type LocationResultData = Omit<LocationSearchResult, "loadChildren" | "resolve">;
export interface LocationResultSnapshot {
  result: LocationResultData;
  canLoadChildren: boolean;
  canResolve: boolean;
  expanded: boolean;
  children: readonly LocationResultSnapshot[] | null;
  resolved?: LocationResultData;
}

function airportData(airport: Airport): Airport {
  return {
    code: airport.code, name: airport.name, latDeg: airport.latDeg, lonDeg: airport.lonDeg,
    elevationMeters: airport.elevationMeters,
    runways: airport.runways.map(runway => ({
      id: runway.id, label: runway.label,
      start: { latDeg: runway.start.latDeg, lonDeg: runway.start.lonDeg },
      end: { latDeg: runway.end.latDeg, lonDeg: runway.end.lonDeg },
      headingDeg: runway.headingDeg, lengthMeters: runway.lengthMeters, elevationMeters: runway.elevationMeters,
    })),
  };
}

/** Copy only the public location data, never provider functions or extra properties. */
function resultData(result: LocationResultData): LocationResultData {
  return {
    id: result.id, label: result.label, subtitle: result.subtitle, kind: result.kind,
    latDeg: result.latDeg, lonDeg: result.lonDeg, zoomMeters: result.zoomMeters, altMeters: result.altMeters,
    childrenLabel: result.childrenLabel, airportMode: result.airportMode,
    airport: result.airport ? airportData(result.airport) : undefined,
    flightPreset: result.flightPreset ? {
      mode: result.flightPreset.mode, headingDeg: result.flightPreset.headingDeg,
      groundElevationMeters: result.flightPreset.groundElevationMeters, flightPathDeg: result.flightPreset.flightPathDeg,
    } : undefined,
  };
}

export function createLocationResults(results: readonly LocationSearchResult[]): readonly LocationResultNode[] {
  const firstGroup = results.findIndex(result => result.loadChildren);
  return results.map((result, index) => ({ result, expanded: index === firstGroup, children: null, autoLoad: true }));
}

export function snapshotLocationResults(nodes: readonly LocationResultNode[]): readonly LocationResultSnapshot[] {
  return nodes.map(node => ({
    result: resultData(node.result), canLoadChildren: !!node.result.loadChildren, canResolve: !!node.result.resolve,
    expanded: node.expanded, children: node.children === null ? null : snapshotLocationResults(node.children),
    ...(node.resolved ? { resolved: resultData(node.resolved) } : {}),
  }));
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const mode = (value: unknown) => value === "departure" || value === "arrival";
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalNumber = (value: unknown) => value === undefined || finite(value);

function isResultData(value: unknown): value is LocationResultData {
  return record(value) && typeof value.id === "string" && typeof value.label === "string"
    && finite(value.latDeg) && Math.abs(value.latDeg) <= 90 && finite(value.lonDeg) && Math.abs(value.lonDeg) <= 180
    && optionalString(value.subtitle) && optionalString(value.childrenLabel)
    && optionalNumber(value.altMeters) && optionalNumber(value.zoomMeters)
    && (value.kind === undefined || value.kind === "place" || value.kind === "city" || value.kind === "airport")
    && (value.airportMode === undefined || mode(value.airportMode))
    && (value.airport === undefined || isAirport(value.airport))
    && (value.flightPreset === undefined || (record(value.flightPreset) && mode(value.flightPreset.mode)
      && finite(value.flightPreset.headingDeg) && finite(value.flightPreset.groundElevationMeters) && finite(value.flightPreset.flightPathDeg)));
}

export function isLocationResultSnapshots(value: unknown): value is readonly LocationResultSnapshot[] {
  const ancestors = new WeakSet<object>();
  const snapshots = (items: unknown): items is readonly LocationResultSnapshot[] => {
    if (!Array.isArray(items)) return false;
    return items.every(item => {
      if (!record(item) || ancestors.has(item) || !isResultData(item.result)
        || typeof item.canLoadChildren !== "boolean" || typeof item.canResolve !== "boolean" || typeof item.expanded !== "boolean"
        || (item.resolved !== undefined && !isResultData(item.resolved))) return false;
      ancestors.add(item);
      const valid = item.children === null || snapshots(item.children);
      ancestors.delete(item);
      return valid;
    });
  };
  return snapshots(value);
}

/** Reattach provider capabilities only when a person explicitly requests them. */
export function restoreLocationResults(
  snapshots: readonly LocationResultSnapshot[], query: string, provider?: LocationSearchProvider,
): readonly LocationResultNode[] {
  let currentResults: readonly LocationSearchResult[] | undefined;
  const currentChildren = new Map<LocationSearchResult, readonly LocationSearchResult[]>();
  const missing = () => new Error("This saved search result is no longer available. Search again.");
  const locate = async (path: readonly string[], signal: AbortSignal): Promise<LocationSearchResult> => {
    signal.throwIfAborted();
    if (!provider) throw new Error("This saved result needs its search provider to load details.");
    if (!currentResults) {
      const found = await provider(query, signal);
      signal.throwIfAborted();
      currentResults = found;
    }
    let candidates = currentResults;
    for (let index = 0; index < path.length; index++) {
      const result = candidates.find(candidate => candidate.id === path[index]);
      if (!result) throw missing();
      if (index === path.length - 1) return result;
      let children = currentChildren.get(result);
      if (!children) {
        if (!result.loadChildren) throw missing();
        children = await result.loadChildren(signal);
        signal.throwIfAborted();
        currentChildren.set(result, children);
      }
      candidates = children;
    }
    throw missing();
  };
  const restore = (items: readonly LocationResultSnapshot[], parents: readonly string[]): readonly LocationResultNode[] => items.map(item => {
    const path = [...parents, item.result.id];
    const result: LocationSearchResult = resultData(item.result);
    if (item.canLoadChildren) result.loadChildren = async signal => {
      const current = await locate(path, signal);
      signal.throwIfAborted();
      const cached = currentChildren.get(current);
      if (cached) return cached;
      if (!current.loadChildren) throw missing();
      const children = await current.loadChildren(signal);
      signal.throwIfAborted();
      currentChildren.set(current, children);
      return children;
    };
    if (item.canResolve) result.resolve = async signal => {
      const current = await locate(path, signal);
      signal.throwIfAborted();
      if (!current.resolve) throw missing();
      const resolved = await current.resolve(signal);
      signal.throwIfAborted();
      return resolved;
    };
    return {
      result, expanded: item.expanded, autoLoad: false,
      children: item.children === null ? null : restore(item.children, path),
      ...(item.resolved ? { resolved: resultData(item.resolved) } : {}),
    };
  });
  return restore(snapshots, []);
}

export function updateLocationResult(
  nodes: readonly LocationResultNode[], target: LocationSearchResult, patch: Partial<Omit<LocationResultNode, "result">>,
): readonly LocationResultNode[] {
  let changed = false;
  const updated = nodes.map(node => {
    const children = node.children === null ? null : updateLocationResult(node.children, target, patch);
    if (node.result === target) { changed = true; return { ...node, children, ...patch }; }
    if (children !== node.children) { changed = true; return { ...node, children }; }
    return node;
  });
  return changed ? updated : nodes;
}
