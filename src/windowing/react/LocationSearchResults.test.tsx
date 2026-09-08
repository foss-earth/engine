// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LocationSearchResults } from "./LocationSearchResults";
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

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
  await act(async () => root.render(<LocationSearchResults results={[city, second]} onSelect={select} />));
  try {
    expect(loadChildren).toHaveBeenCalledOnce();
    expect(second.loadChildren).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(select).toHaveBeenLastCalledWith(city);
    await act(async () => { finish([airport]); });
    expect(host.querySelector(".foss-earth-location-result-subtitle")?.textContent).toBe(airport.subtitle);
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.startsWith("JFK"))!.click());
    expect(select).toHaveBeenLastCalledWith(airport);
  } finally { await act(async () => root.unmount()); }
});

it("preserves the city and offers retry when nearby lookup fails, aborting on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host);
  let signal!: AbortSignal;
  const loadChildren = vi.fn(async (s: AbortSignal) => { signal = s; throw new Error("Unavailable"); });
  const select = vi.fn();
  await act(async () => root.render(<LocationSearchResults results={[{ id: "city", label: "City", latDeg: 1, lonDeg: 2, loadChildren }]} onSelect={select} />));
  expect(host.textContent).toContain("Unavailable");
  expect(host.textContent).toContain("Retry");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(select).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
});
