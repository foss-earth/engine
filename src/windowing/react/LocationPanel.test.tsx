// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LocationPanel } from "./LocationPanel";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("applies structured coordinates and provider results without interpreting labels", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onApply = vi.fn();
  const provider = vi.fn(async () => [{ id: "duluth", label: "Duluth, Minnesota", latDeg: 46.7867, lonDeg: -92.1005 }]);
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

it("selects an airport without teleporting, then applies the chosen arrival runway", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);
  const apply = vi.fn();
  const airport = { code: "KTST", name: "Test Airport", latDeg: 45, lonDeg: -93, elevationMeters: 300,
    runways: [{ id: "09", label: "09", start: { latDeg: 45, lonDeg: -93 }, end: { latDeg: 45, lonDeg: -92.98 }, headingDeg: 90, lengthMeters: 1500, elevationMeters: 300 }] };
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} onApply={apply} enableAirportPresets
    searchProvider={async () => [{ id: "KTST", label: "KTST · Test Airport", latDeg: 45, lonDeg: -93, airport }]} />));
  try {
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "KTST");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "KTST · Test Airport")!.click());
    expect(apply).not.toHaveBeenCalled();
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Airport position"]')!;
    await act(async () => { select.value = "arrival"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to location"]')!.click());
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0][0]).toMatchObject({ flightPreset: { mode: "arrival", headingDeg: 90, groundElevationMeters: 300 } });
    expect(apply.mock.calls[0][0].lonDeg).toBeLessThan(-93);
  } finally { await act(async () => root.unmount()); }
});
