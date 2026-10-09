/** Plain globe host fixture, preserving the source observer cadence through an explicit subscription. */
import { useMemo } from "react";
import { LocationPanel as CorePanel, type LocationPanelProps } from "../../src/location/react/LocationPanel.js";
import { createLocationDraftStore, LOCATION_PLACE_DRAFT_KEY } from "../../src/location/locationDraft.js";
const observeLocation = (listener: () => void) => { const timer = setInterval(listener, 100); return () => clearInterval(timer); };
const createAbortController = () => new AbortController();
export function LocationPanel(props: Omit<LocationPanelProps, "observeLocation" | "createAbortController" | "searchAttribution" | "draft">) {
  const draft = useMemo(() => createLocationDraftStore({ storage: localStorage, key: LOCATION_PLACE_DRAFT_KEY }), []);
  return <CorePanel observeLocation={observeLocation} createAbortController={createAbortController} searchAttribution="Host search attribution" draft={draft} {...props} />;
}
export const readLocationDraft = (airportPresets: false) => { void airportPresets; return createLocationDraftStore({ storage: localStorage, key: LOCATION_PLACE_DRAFT_KEY }).read(); };
