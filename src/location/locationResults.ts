import type { LocationHostDataCodec, LocationSearchProvider, LocationSearchResult, LocationSignal } from "./contracts.js";

function copyHostData(value: unknown, codec?: LocationHostDataCodec): unknown {
  if (!codec || !codec.valid(value)) throw new Error("The host must supply a codec for its location contribution.");
  return codec.copy(value);
}

export interface LocationResultNode<TSignal extends LocationSignal = LocationSignal> {
  result: LocationSearchResult<TSignal>;
  expanded: boolean;
  children: readonly LocationResultNode<TSignal>[] | null;
  autoLoad: boolean;
  resolved?: LocationSearchResult<TSignal>;
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

/** Copy only the public location data, never provider functions or extra properties. */
function resultData(result: LocationResultData, codec?: LocationHostDataCodec): LocationResultData {
  return {
    id: result.id, label: result.label, subtitle: result.subtitle, kind: result.kind,
    latDeg: result.latDeg, lonDeg: result.lonDeg, zoomMeters: result.zoomMeters, altMeters: result.altMeters,
    childrenLabel: result.childrenLabel,
    hostData: result.hostData === undefined ? undefined : copyHostData(result.hostData, codec),
  };
}

export function createLocationResults<TSignal extends LocationSignal>(results: readonly LocationSearchResult<TSignal>[]): readonly LocationResultNode<TSignal>[] {
  const firstGroup = results.findIndex(result => result.loadChildren);
  return results.map((result, index) => ({ result, expanded: index === firstGroup, children: null, autoLoad: true }));
}

export function snapshotLocationResults<TSignal extends LocationSignal>(nodes: readonly LocationResultNode<TSignal>[], codec?: LocationHostDataCodec): readonly LocationResultSnapshot[] {
  return nodes.map(node => ({
    result: resultData(node.result, codec), canLoadChildren: !!node.result.loadChildren, canResolve: !!node.result.resolve,
    expanded: node.expanded, children: node.children === null ? null : snapshotLocationResults(node.children, codec),
    ...(node.resolved ? { resolved: resultData(node.resolved, codec) } : {}),
  }));
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalNumber = (value: unknown) => value === undefined || finite(value);

function isResultData(value: unknown, codec?: LocationHostDataCodec): value is LocationResultData {
  return record(value) && typeof value.id === "string" && typeof value.label === "string"
    && finite(value.latDeg) && Math.abs(value.latDeg) <= 90 && finite(value.lonDeg) && Math.abs(value.lonDeg) <= 180
    && optionalString(value.subtitle) && optionalString(value.childrenLabel)
    && optionalNumber(value.altMeters) && optionalNumber(value.zoomMeters)
    && (value.kind === undefined || value.kind === "place" || value.kind === "city" || value.kind === "airport")
    && (value.hostData === undefined || Boolean(codec?.valid(value.hostData)));
}

export function isLocationResultSnapshots(value: unknown, codec?: LocationHostDataCodec): value is readonly LocationResultSnapshot[] {
  const ancestors = new WeakSet<object>();
  const snapshots = (items: unknown): items is readonly LocationResultSnapshot[] => {
    if (!Array.isArray(items)) return false;
    return items.every(item => {
      if (!record(item) || ancestors.has(item) || !isResultData(item.result, codec)
        || typeof item.canLoadChildren !== "boolean" || typeof item.canResolve !== "boolean" || typeof item.expanded !== "boolean"
        || (item.resolved !== undefined && !isResultData(item.resolved, codec))) return false;
      ancestors.add(item);
      const valid = item.children === null || snapshots(item.children);
      ancestors.delete(item);
      return valid;
    });
  };
  return snapshots(value);
}

/** Reattach provider capabilities only when a person explicitly requests them. */
export function restoreLocationResults<TSignal extends LocationSignal>(
  snapshots: readonly LocationResultSnapshot[], query: string, provider?: LocationSearchProvider<TSignal>, codec?: LocationHostDataCodec,
): readonly LocationResultNode<TSignal>[] {
  let currentResults: readonly LocationSearchResult<TSignal>[] | undefined;
  const currentChildren = new Map<LocationSearchResult<TSignal>, readonly LocationSearchResult<TSignal>[]>();
  const missing = () => new Error("This saved search result is no longer available. Search again.");
  const locate = async (path: readonly string[], signal: TSignal): Promise<LocationSearchResult<TSignal>> => {
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
  const restore = (items: readonly LocationResultSnapshot[], parents: readonly string[]): readonly LocationResultNode<TSignal>[] => items.map(item => {
    const path = [...parents, item.result.id];
    const result: LocationSearchResult<TSignal> = resultData(item.result, codec);
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
      ...(item.resolved ? { resolved: resultData(item.resolved, codec) } : {}),
    };
  });
  return restore(snapshots, []);
}

export function updateLocationResult<TSignal extends LocationSignal>(
  nodes: readonly LocationResultNode<TSignal>[], target: LocationSearchResult<TSignal>, patch: Partial<Omit<LocationResultNode<TSignal>, "result">>,
): readonly LocationResultNode<TSignal>[] {
  let changed = false;
  const updated = nodes.map(node => {
    const children = node.children === null ? null : updateLocationResult(node.children, target, patch);
    if (node.result === target) { changed = true; return { ...node, children, ...patch }; }
    if (children !== node.children) { changed = true; return { ...node, children }; }
    return node;
  });
  return changed ? updated : nodes;
}
