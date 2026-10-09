import type { NavigationAbortSignal } from "../navigation/navigationLease.js";

/** Structural cancellation for provider reattachment; native browser signals satisfy it. */
export interface LocationSignal extends NavigationAbortSignal { throwIfAborted(): void }
export interface GeodeticLocation {
  latDeg: number;
  lonDeg: number;
  zoomMeters?: number;
  altMeters?: number;
  /** Host-owned preset data; the globe applies no aircraft or tour policy to it. */
  hostData?: unknown;
}
export interface LocationSearchResult<TSignal extends LocationSignal = LocationSignal> extends GeodeticLocation {
  id: string;
  label: string;
  subtitle?: string;
  kind?: "place" | "city" | "airport";
  childrenLabel?: string;
  loadChildren?: (signal: TSignal) => Promise<readonly LocationSearchResult<TSignal>[]>;
  resolve?: (signal: TSignal) => Promise<LocationSearchResult<TSignal>>;
}
export type LocationSearchProvider<TSignal extends LocationSignal = LocationSignal> =
  (query: string, signal: TSignal) => Promise<readonly LocationSearchResult<TSignal>[]>;
/** A host explicitly copies and validates its own serializable contribution. */
export interface LocationHostDataCodec { copy(value: unknown): unknown; valid(value: unknown): boolean }
