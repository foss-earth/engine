// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocationPanel } from "../fixtures/composition/locationPanelHost.js";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function edit(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

it("applies structured coordinates and provider results without interpreting labels", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onApply = vi.fn();
  const provider = vi.fn(async (_query: string, _signal: AbortSignal) => { void _query; void _signal; return [{ id: "duluth", label: "Duluth, Minnesota", latDeg: 46.7867, lonDeg: -92.1005 }]; });
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 45, lonDeg: -93 }} onApply={onApply} searchProvider={provider} />));
  try {
    const forms = host.querySelectorAll("form");
    await act(async () => forms[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onApply).toHaveBeenLastCalledWith({ latDeg: 45, lonDeg: -93 });
    const query = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(query, "Duluth");
      query.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => forms[0].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(provider).toHaveBeenCalledWith("Duluth", expect.any(AbortSignal));
    const result = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Duluth, Minnesota")!;
    await act(async () => result.click());
    await act(async () => forms[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onApply).toHaveBeenLastCalledWith({ latDeg: 46.7867, lonDeg: -92.1005 });
  } finally { await act(async () => root.unmount()); }
  expect(provider.mock.calls[0][1].aborted).toBe(true);
});

it("keeps coordinates usable with no search provider and reports apply errors", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} onApply={() => { throw new Error("Reset failed"); }} />));
  try {
    expect(host.querySelector("input")!.disabled).toBe(true);
    await act(async () => host.querySelectorAll("form")[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Reset failed");
  } finally { await act(async () => root.unmount()); }
});

it("refreshes all placeholders from live location without overwriting edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  let live = { latDeg: 45, lonDeg: -93, altMeters: 1200 };
  await act(async () => root.render(<LocationPanel initialLocation={live} getCurrentLocation={() => live} onApply={() => {}} />));
  try {
    const inputs = host.querySelectorAll<HTMLInputElement>('.foss-earth-location-coordinates input');
    expect(Array.from(inputs, input => input.placeholder)).toEqual(["45.00000000", "-93.00000000", "1200"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[0], "46");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    live = { latDeg: 45.5123456789, lonDeg: -92.5123456789, altMeters: 1300.6 };
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(Array.from(inputs, input => input.placeholder)).toEqual(["45.51234568", "-92.51234568", "1301"]);
    expect(inputs[0].value).toBe("46");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("keeps edited search text and coordinate entries after applying and reopening", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  const apply = vi.fn();
  const provider = vi.fn(async () => []);
  const panel = <LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0, altMeters: 1000 }} onApply={apply} searchProvider={provider} />;
  await act(async () => root.render(panel));
  try {
    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    for (const [index, value] of ["unfinished search", "44.8800", "-93.2200", "1250"].entries()) await edit(inputs[index], value);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to location"]')!.click());
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(panel));
    expect(Array.from(host.querySelectorAll<HTMLInputElement>("input"), input => input.value)).toEqual(["unfinished search", "44.8800", "-93.2200", "1250"]);
    expect(apply).toHaveBeenCalledExactlyOnceWith({ latDeg: 44.88, lonDeg: -93.22, altMeters: 1250 });
    expect(provider).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("keeps Location usable when device storage is denied", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } });
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);
  const apply = vi.fn();
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} onApply={apply} />));
  try {
    await edit(host.querySelector<HTMLInputElement>('[type="number"]')!, "45");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to location"]')!.click());
    expect(apply).toHaveBeenCalledExactlyOnceWith({ latDeg: 45, lonDeg: 0 });
  } finally { await act(async () => root.unmount()); }
});
