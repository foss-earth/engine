import { expect, it, vi } from "vitest";
import { createLocationResults, snapshotLocationResults, restoreLocationResults, isLocationResultSnapshots } from "../src/location/locationResults.js";
import { createLocationDraftStore } from "../src/location/locationDraft.js";
import type { LocationHostDataCodec } from "../src/location/contracts.js";
const codec: LocationHostDataCodec = { valid: value => !!value && typeof value === "object" && typeof (value as { selection?: unknown }).selection === "string",
  copy: value => ({ selection: (value as { selection: string }).selection }) };
it("keeps resolved owner data available offline through the required host codec without storing its callbacks", () => {
  const hostData = { selection: "host-preset", extra: "discard" }; const resolve = vi.fn();
  const nodes = [{ ...createLocationResults([{ id: "opaque", label: "Saved", latDeg: 45, lonDeg: -93, resolve }])[0],
    resolved: { id: "opaque", label: "Saved", latDeg: 45, lonDeg: -93, hostData } }];
  const saved = snapshotLocationResults(nodes, codec); expect(saved[0].resolved?.hostData).toEqual({ selection: "host-preset" });
  const [restored] = restoreLocationResults<AbortSignal>(saved, "original query", undefined, codec);
  expect(restored.resolved?.hostData).toEqual({ selection: "host-preset" }); expect(restored.resolved?.hostData).not.toBe(hostData);
  expect(resolve).not.toHaveBeenCalled();
  expect(() => snapshotLocationResults(nodes)).toThrow("host must supply a codec");
  expect(isLocationResultSnapshots(saved)).toBe(false);
});
it("keeps each contribution draft namespace separate and delegates legacy validation and decoding", () => {
  const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const place = createLocationDraftStore({ storage, key: "place" });
  const host = createLocationDraftStore({ storage, key: "host", hostDataCodec: codec,
    legacy: { valid: value => typeof value.selection === "string", hostData: value => ({ selection: value.selection }) } });
  storage.setItem("host", JSON.stringify({ query: "saved", lat: "", lon: "", altitude: "", selection: "chosen" }));
  expect(host.read()).toMatchObject({ query: "saved", hostData: { selection: "chosen" } }); expect(place.read().query).toBe("");
  place.write({ query: "place query", lat: "1", lon: "2", altitude: "" }); expect(host.read().query).toBe("saved");
});
