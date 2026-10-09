import { isLocationResultSnapshots, type LocationResultSnapshot } from "./locationResults.js";
import type { LocationHostDataCodec } from "./contracts.js";

/** Preference draft is separate from expiring service responses. */
export interface LocationDraft {
  query: string; lat: string; lon: string; altitude: string;
  hostData?: unknown;
  resultQuery?: string;
  results?: readonly LocationResultSnapshot[];
}
export const LOCATION_PLACE_DRAFT_KEY = "foss-earth.location-draft.v1.place";
export interface LocationDraftStorePorts {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  /** Hosts keep their existing separate contribution namespace. */
  key: string;
  hostDataCodec?: LocationHostDataCodec;
  /** Optional legacy validation/decoding belongs to the contribution owner. */
  legacy?: { valid(value: Record<string, unknown>): boolean; hostData(value: Record<string, unknown>): unknown };
}

export function createLocationDraftStore(ports: LocationDraftStorePorts) {
  const empty = (): LocationDraft => ({ query: "", lat: "", lon: "", altitude: "" });
  return {
    read(): LocationDraft {
      try {
        const value: unknown = JSON.parse(ports.storage?.getItem(ports.key) ?? "null");
        if (!value || typeof value !== "object" || Array.isArray(value)) return empty();
        const record = value as Record<string, unknown>;
        if (![record.query, record.lat, record.lon, record.altitude].every(item => typeof item === "string")) return empty();
        if (ports.legacy && !ports.legacy.valid(record)) return empty();
        const hostData = record.hostData ?? ports.legacy?.hostData(record);
        if (hostData !== undefined && !ports.hostDataCodec?.valid(hostData)) return empty();
        return {
          query: record.query as string, lat: record.lat as string, lon: record.lon as string, altitude: record.altitude as string,
          ...(hostData === undefined ? {} : { hostData: ports.hostDataCodec!.copy(hostData) }),
          resultQuery: typeof record.resultQuery === "string" ? record.resultQuery : record.query as string,
          results: isLocationResultSnapshots(record.results, ports.hostDataCodec) ? record.results : [],
        };
      } catch { return empty(); }
    },
    write(draft: LocationDraft): void {
      try {
        const hostData = draft.hostData === undefined ? undefined : ports.hostDataCodec?.valid(draft.hostData) ? ports.hostDataCodec.copy(draft.hostData) : undefined;
        if (draft.hostData !== undefined && hostData === undefined) return;
        // Existing place-draft readers require these empty legacy fields. They carry no aircraft behavior.
        ports.storage?.setItem(ports.key, JSON.stringify({ airport: null, airportMode: "departure", runwayId: "", ...draft, hostData }));
      } catch { /* Editing and applying still work when browser storage is unavailable. */ }
    },
  };
}
export type LocationDraftStore = ReturnType<typeof createLocationDraftStore>;
