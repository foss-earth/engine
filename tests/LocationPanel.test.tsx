// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocationPanel } from "../fixtures/composition/locationPanelHost.js";
import type { DeviceLocationFix, DeviceLocationPort } from "../src/location/deviceLocation.js";

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
    expect(Array.from(inputs, input => input.placeholder)).toEqual(["45.0000", "93.0000", "1200"]);
    expect(Array.from(host.querySelectorAll<HTMLSelectElement>(".foss-earth-location-coordinates select"), select => select.value)).toEqual(["N", "W", "asl"]);
    expect(host.querySelector(".foss-earth-location-fields")!.textContent?.replace(/\s/g, "")).toBe("NSEWASLAGL");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[0], "46");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    live = { latDeg: 45.5123456789, lonDeg: -92.5123456789, altMeters: 1300.6 };
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(Array.from(inputs, input => input.placeholder)).toEqual(["45.5123", "92.5123", "1301"]);
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
    expect(Array.from(host.querySelectorAll<HTMLInputElement>("input"), input => input.value)).toEqual(["unfinished search", "44.8800", "93.2200", "1250"]);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Longitude hemisphere"]')!.value).toBe("W");
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
    await edit(host.querySelector<HTMLInputElement>('[aria-label="Latitude"]')!, "45");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to location"]')!.click());
    expect(apply).toHaveBeenCalledExactlyOnceWith({ latDeg: 45, lonDeg: 0 });
  } finally { await act(async () => root.unmount()); }
});

function devicePort(): { port: DeviceLocationPort; emit(fix: DeviceLocationFix): void; fail(message: string): void; stop: ReturnType<typeof vi.fn> } {
  let onFix: (fix: DeviceLocationFix) => void = () => {};
  let onError: (message: string) => void = () => {};
  const stop = vi.fn();
  return {
    stop,
    port: { watch(fix, error) { onFix = fix; onError = error; return stop; } },
    emit(fix) { onFix(fix); },
    fail(message) { onError(message); },
  };
}

it("uses a device fix once, keeps following it, and stops", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const gps = devicePort();
  const onApply = vi.fn();
  const onDeviceLocation = vi.fn();
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0, zoomMeters: 400 }} onApply={onApply}
    deviceLocation={gps.port} onDeviceLocation={onDeviceLocation} />));
  try {
    const button = () => host.querySelector<HTMLButtonElement>(".foss-earth-location-gps")!;
    expect(button().getAttribute("aria-label")).toBe("Use device location");
    await act(async () => button().click());
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Waiting for device location…");
    const fix = { latDeg: 44.97, lonDeg: -93.23, accuracyMeters: 12.2 };
    await act(async () => gps.emit(fix));
    expect(onDeviceLocation).toHaveBeenLastCalledWith(fix);
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ latDeg: 44.97, lonDeg: -93.23 });
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Showing your position, ±12 m.");
    await act(async () => gps.emit({ latDeg: 44.98, lonDeg: -93.22, accuracyMeters: 9 }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onDeviceLocation).toHaveBeenLastCalledWith({ latDeg: 44.98, lonDeg: -93.22, accuracyMeters: 9 });
    await act(async () => button().click());
    expect(gps.stop).toHaveBeenCalledOnce();
    expect(onDeviceLocation).toHaveBeenLastCalledWith(null);
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
  } finally { await act(async () => root.unmount()); }
});

it("brings a distant view to the device and reports a denied reading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const gps = devicePort();
  const onApply = vi.fn();
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} onApply={onApply} deviceLocation={gps.port} />));
  try {
    await act(async () => host.querySelector<HTMLButtonElement>(".foss-earth-location-gps")!.click());
    await act(async () => gps.emit({ latDeg: 45, lonDeg: -93, accuracyMeters: 20_400 }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ latDeg: 45, lonDeg: -93, zoomMeters: 1500 });
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Showing your position, ±20 km.");
    await act(async () => gps.fail("Location permission was denied."));
    expect(gps.stop).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Location permission was denied.");
    expect(host.querySelector(".foss-earth-location-gps")!.getAttribute("aria-pressed")).toBe("false");
  } finally { await act(async () => root.unmount()); }
});

it("says device location is unavailable until a source is supplied, and stops on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  let root = createRoot(host);
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} onApply={() => {}} />));
  try {
    await act(async () => host.querySelector<HTMLButtonElement>(".foss-earth-location-gps")!.click());
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Device location is unavailable.");
  } finally { await act(async () => root.unmount()); }
  const gps = devicePort();
  const onDeviceLocation = vi.fn();
  root = createRoot(host);
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} onApply={() => {}} deviceLocation={gps.port} onDeviceLocation={onDeviceLocation} />));
  try {
    await act(async () => host.querySelector<HTMLButtonElement>(".foss-earth-location-gps")!.click());
    await act(async () => root.unmount());
    expect(gps.stop).toHaveBeenCalledOnce();
    expect(onDeviceLocation).toHaveBeenLastCalledWith(null);
  } finally { host.replaceChildren(); }
});

it("keeps coordinates off the Location tab while the readout is showing them", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<LocationPanel initialLocation={{ latDeg: 45, lonDeg: -93 }} showCoordinates={false} onApply={() => {}} />));
  try {
    expect(host.querySelector(".foss-earth-location-fields")).toBeNull();
    expect(host.querySelector('[aria-label="Go to location"]')).toBeNull();
    expect(host.querySelector('[aria-label="Location search"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});
