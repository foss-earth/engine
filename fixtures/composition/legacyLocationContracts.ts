/** Legacy mixed test ports only. Flight must bind its own production implementation. */
import type { ComponentType } from "react";
import type { GeodeticLocation } from "../../src/location/contracts.js";
export type AirportMode = "departure" | "arrival";
export interface AirportPoint { latDeg: number; lonDeg: number }
export interface AirportRunway { id: string; label: string; start: AirportPoint; end: AirportPoint; headingDeg: number; lengthMeters: number; elevationMeters?: number }
export interface Airport { code: string; name: string; latDeg: number; lonDeg: number; elevationMeters?: number; runways: AirportRunway[] }
export interface AirportFlightPreset { mode: AirportMode; headingDeg: number; groundElevationMeters: number; flightPathDeg: number }
export interface LegacyLocation extends GeodeticLocation { flightPreset?: AirportFlightPreset }
export interface LocationSearchResult extends LegacyLocation {
  id: string; label: string; subtitle?: string; kind?: "place" | "city" | "airport"; childrenLabel?: string;
  airport?: Airport; airportMode?: AirportMode;
  loadChildren?(signal: AbortSignal): Promise<readonly LocationSearchResult[]>;
  resolve?(signal: AbortSignal): Promise<LocationSearchResult>;
}
export interface LocationResultNode { result: LocationSearchResult; expanded: boolean; children: readonly LocationResultNode[] | null; autoLoad: boolean; resolved?: LocationSearchResult }
export interface LocationResultSnapshot { result: Omit<LocationSearchResult, "loadChildren" | "resolve">; canLoadChildren: boolean; canResolve: boolean; expanded: boolean; children: readonly LocationResultSnapshot[] | null; resolved?: Omit<LocationSearchResult, "loadChildren" | "resolve"> }
export interface LegacyLocationDraft { query: string; lat: string; lon: string; altitude: string; airport: Airport | null; airportMode: AirportMode; runwayId: string; resultQuery?: string; results?: readonly LocationResultSnapshot[] }
export interface LegacyLocationPanelPorts {
  LocationPanel: ComponentType<{ initialLocation: LegacyLocation; getCurrentLocation?(): LegacyLocation | null; onApply(location: LegacyLocation): void; enableAirportPresets?: boolean; searchProvider?(query: string, signal: AbortSignal): Promise<readonly LocationSearchResult[]> }>;
  readLocationDraft(airportPresets: boolean): LegacyLocationDraft;
  writeLocationDraft(airportPresets: boolean, draft: LegacyLocationDraft): void;
  airportSpawn(runway: AirportRunway, mode: AirportMode): LegacyLocation & { altMeters: number; flightPreset: AirportFlightPreset };
}
export interface LegacyLocationResultsPorts {
  createLocationResults(results: readonly LocationSearchResult[]): readonly LocationResultNode[];
  updateLocationResult(nodes: readonly LocationResultNode[], target: LocationSearchResult, patch: Partial<Omit<LocationResultNode, "result">>): readonly LocationResultNode[];
  snapshotLocationResults(nodes: readonly LocationResultNode[]): readonly LocationResultSnapshot[];
  isLocationResultSnapshots(value: unknown): value is readonly LocationResultSnapshot[];
  restoreLocationResults(snapshots: readonly LocationResultSnapshot[], query: string, provider?: (query: string, signal: AbortSignal) => Promise<readonly LocationSearchResult[]>): readonly LocationResultNode[];
}
