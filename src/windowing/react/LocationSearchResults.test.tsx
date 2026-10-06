// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LocationSearchResult } from "../../search/types";
import { LocationSearchResults } from "./LocationSearchResults";
import { createLocationResults, updateLocationResult, type LocationResultNode } from "./locationResults";
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function ResultsHarness({ initialResults, onSelect, onChange }: {
  initialResults: readonly LocationResultNode[];
  onSelect(node: LocationResultNode): void;
  onChange?(result: LocationSearchResult, patch: Partial<Omit<LocationResultNode, "result">>): void;
}) {
  const [results, setResults] = useState(initialResults);
  return <LocationSearchResults results={results} onSelect={onSelect} onChange={(result, patch) => {
    onChange?.(result, patch);
    setResults(current => updateLocationResult(current, result, patch));
  }} />;
}

it("keeps the city clickable while airports load and selects nested airports independently", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const airport = { id: "jfk", label: "JFK", subtitle: "New York, United States · 20 km from city", latDeg: 40.64, lonDeg: -73.78 };
  let finish!: (results: typeof airport[]) => void;
  const loadChildren = vi.fn(() => new Promise<typeof airport[]>(resolve => { finish = resolve; }));
  const city = { id: "nyc", label: "New York City", latDeg: 40.71, lonDeg: -74, loadChildren };
  const second = { ...city, id: "other", label: "Other city", loadChildren: vi.fn(async () => []) };
  const select = vi.fn();
  const initialResults = createLocationResults([city, second]);
  await act(async () => root.render(<ResultsHarness initialResults={initialResults} onSelect={select} />));
  try {
    expect(loadChildren).toHaveBeenCalledOnce();
    expect(second.loadChildren).not.toHaveBeenCalled();
    // Parent callbacks can change while a request is in flight without restarting it.
    await act(async () => root.render(<ResultsHarness initialResults={initialResults} onSelect={select} />));
    expect(loadChildren).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(select).toHaveBeenLastCalledWith(initialResults[0]);
    await act(async () => { finish([airport]); });
    expect(host.querySelector(".foss-earth-location-result-subtitle")?.textContent).toBe(airport.subtitle);
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.startsWith("JFK"))!.click());
    expect(select.mock.lastCall?.[0].result).toBe(airport);
  } finally { await act(async () => root.unmount()); }
});

it("preserves the city and offers retry when nearby lookup fails, aborting on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host);
  let signal!: AbortSignal;
  const loadChildren = vi.fn(async (s: AbortSignal) => { signal = s; throw new Error("Unavailable"); });
  const select = vi.fn();
  const initialResults = createLocationResults([{ id: "city", label: "City", latDeg: 1, lonDeg: 2, loadChildren }]);
  await act(async () => root.render(<ResultsHarness initialResults={initialResults} onSelect={select} />));
  try {
    expect(host.textContent).toContain("Unavailable");
    expect(host.textContent).toContain("Retry");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(select).toHaveBeenCalledOnce();
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Retry")!.click());
    expect(loadChildren).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); }
  expect(signal.aborted).toBe(true);
});

it.each([true, false])("restores loaded children and expanded=%s without reloading them on toggles", async expanded => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host);
  const airport = { id: "jfk", label: "JFK", latDeg: 40.64, lonDeg: -73.78 };
  const loadChildren = vi.fn(async () => [airport]);
  const city = { id: "nyc", label: "New York City", latDeg: 40.71, lonDeg: -74, loadChildren };
  const initialResults = [{ ...createLocationResults([city])[0], expanded, autoLoad: false, children: createLocationResults([airport]) }];
  const select = vi.fn();
  await act(async () => root.render(<ResultsHarness initialResults={initialResults} onSelect={select} />));
  try {
    expect(host.textContent?.includes("JFK")).toBe(expanded);
    const toggle = host.querySelector<HTMLButtonElement>("[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe(String(expanded));
    for (let count = 0; count < 2; count++) await act(async () => toggle.click());
    if (!expanded) await act(async () => toggle.click());
    expect(host.textContent).toContain("JFK");
    expect(loadChildren).not.toHaveBeenCalled();
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "JFK")!.click());
    expect(select.mock.lastCall?.[0].result).toBe(airport);
  } finally { await act(async () => root.unmount()); }
});

it("waits for an explicit request to load an unfinished restored group", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host);
  const loadChildren = vi.fn(async () => []);
  const city = { id: "city", label: "City", latDeg: 1, lonDeg: 2, loadChildren };
  const initialResults = [{ ...createLocationResults([city])[0], expanded: true, autoLoad: false }];
  await act(async () => root.render(<ResultsHarness initialResults={initialResults} onSelect={() => {}} />));
  try {
    expect(loadChildren).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Loading…");
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Load nearby results")!.click());
    expect(loadChildren).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("No nearby results found.");
    const toggle = host.querySelector<HTMLButtonElement>("[aria-expanded]")!;
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    expect(loadChildren).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

it("does not save children from a request cancelled by collapsing its group", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host);
  const airport = { id: "jfk", label: "JFK", latDeg: 40.64, lonDeg: -73.78 };
  let finish!: (results: typeof airport[]) => void;
  let signal!: AbortSignal;
  const loadChildren = vi.fn((s: AbortSignal) => {
    signal = s;
    return new Promise<typeof airport[]>(resolve => { finish = resolve; });
  });
  const city = { id: "nyc", label: "New York City", latDeg: 40.71, lonDeg: -74, loadChildren };
  const changes = vi.fn();
  await act(async () => root.render(<ResultsHarness initialResults={createLocationResults([city])} onSelect={() => {}} onChange={changes} />));
  try {
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-expanded]")!.click());
    expect(signal.aborted).toBe(true);
    changes.mockClear();
    await act(async () => { finish([airport]); });
    expect(changes).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("JFK");
  } finally { await act(async () => root.unmount()); }
});
