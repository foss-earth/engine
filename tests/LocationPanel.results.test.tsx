// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocationPanel, readLocationDraft } from "../fixtures/composition/locationPanelHost.js";
import type { LocationSearchResult as GenericResult } from "../src/location/contracts.js";
type LocationSearchResult = GenericResult<AbortSignal>;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function edit(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Location search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function search(host: HTMLElement, query: string) {
  await edit(host, query);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function click(host: HTMLElement, text: string) {
  const button = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes(text));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("restores the results list from storage and applies a plain result offline", async () => {
  const host = document.createElement("div"); document.body.append(host);
  let root = createRoot(host);
  const provider = vi.fn(async () => [
    { id: "a", label: "Minneapolis", subtitle: "Minnesota", latDeg: 44.98, lonDeg: -93.26 },
    { id: "b", label: "Saint Paul", latDeg: 44.95, lonDeg: -93.09 },
  ]);
  const apply = vi.fn();
  const panel = <LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} searchProvider={provider} onApply={apply} />;
  await act(async () => root.render(panel));
  try {
    await search(host, "Twin Cities");
    expect(provider).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    provider.mockClear();
    provider.mockRejectedValue(new Error("Offline"));
    root = createRoot(host);
    await act(async () => root.render(panel));
    expect(host.querySelector(".foss-earth-location-results")?.textContent).toContain("MinneapolisMinnesota");
    expect(host.querySelector(".foss-earth-location-results")?.textContent).toContain("Saint Paul");
    expect(provider).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    await click(host, "Saint Paul");
    expect(apply).toHaveBeenCalledExactlyOnceWith({ latDeg: 44.95, lonDeg: -93.09 });
    expect(provider).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("does not resurrect old nearby results after the search text changes", async () => {
  const host = document.createElement("div"); document.body.append(host);
  let root = createRoot(host);
  let finish!: (children: readonly LocationSearchResult[]) => void;
  const loadChildren = vi.fn<(signal: AbortSignal) => Promise<readonly LocationSearchResult[]>>(() => new Promise(done => { finish = done; }));
  const provider = vi.fn(async () => [{ id: "city", label: "Old city", latDeg: 45, lonDeg: -93, loadChildren }]);
  const panel = <LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} searchProvider={provider} onApply={() => {}} />;
  await act(async () => root.render(panel));
  try {
    await search(host, "old query");
    await edit(host, "new query");
    expect(loadChildren.mock.calls[0][0].aborted).toBe(true);
    await act(async () => finish([{ id: "late", label: "Old airport", latDeg: 45, lonDeg: -93 }]));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(panel));
    expect(host.querySelector<HTMLInputElement>('[aria-label="Location search"]')!.value).toBe("new query");
    expect(host.querySelector(".foss-earth-location-results")!.textContent).toBe("");
    expect(provider).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

it("ignores damaged result snapshots while keeping the saved search text", () => {
  localStorage.setItem("foss-earth.location-draft.v1.place", JSON.stringify({
    query: "msp", lat: "", lon: "", altitude: "", airport: null, airportMode: "departure", runwayId: "",
    results: [{ result: { id: "bad", label: "Broken" }, children: "invalid" }],
  }));
  expect(readLocationDraft(false)).toMatchObject({ query: "msp", results: [] });
});
