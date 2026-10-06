// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocationPanel } from "./LocationPanel";
import { airportSpawn } from "../../airports/geometry";
import { readLocationDraft, writeLocationDraft } from "./locationDraft";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
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

async function edit(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const msp = { code: "KMSP", name: "Minneapolis-Saint Paul International Airport", latDeg: 44.88, lonDeg: -93.22, elevationMeters: 256,
  runways: [
    { id: "12L", label: "12L", start: { latDeg: 44.89, lonDeg: -93.23 }, end: { latDeg: 44.87, lonDeg: -93.19 }, headingDeg: 120, lengthMeters: 3000, elevationMeters: 256 },
    { id: "35", label: "35", start: { latDeg: 44.86, lonDeg: -93.22 }, end: { latDeg: 44.89, lonDeg: -93.23 }, headingDeg: 350, lengthMeters: 2500, elevationMeters: 256 },
  ] };

it.each(["departure", "arrival"] as const)("restores MSP %s runway 35 from device storage with no lookup or automatic move", async mode => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  const apply = vi.fn();
  const resolve = vi.fn(async () => ({ id: "msp", label: "MSP", latDeg: msp.latDeg, lonDeg: msp.lonDeg, airport: msp, airportMode: mode }));
  const provider = vi.fn(async () => [{ id: "msp", label: "MSP", latDeg: msp.latDeg, lonDeg: msp.lonDeg, resolve }]);
  const panel = <LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} enableAirportPresets onApply={apply} searchProvider={provider} />;
  await act(async () => root.render(panel));
  try {
    await edit(host.querySelector<HTMLInputElement>('[aria-label="Location search"]')!, `msp ${mode}`);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "MSP")!.click());
    await edit(host.querySelector<HTMLSelectElement>('[aria-label="Airport position"]')!, mode);
    await edit(host.querySelector<HTMLSelectElement>('[aria-label="Runway"]')!, "35");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to location"]')!.click());
    expect(apply).toHaveBeenLastCalledWith(airportSpawn(msp.runways[1], mode));
    await act(async () => root.unmount());
    expect(readLocationDraft(true)).toMatchObject({ query: `msp ${mode}`, airport: msp, airportMode: mode, runwayId: "35" });
    provider.mockClear(); resolve.mockClear(); apply.mockClear();
    root = createRoot(host);
    await act(async () => root.render(panel));
    expect(host.querySelector<HTMLInputElement>('[aria-label="Location search"]')!.value).toBe(`msp ${mode}`);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Airport position"]')!.value).toBe(mode);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Runway"]')!.value).toBe("35");
    expect(provider).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    // Searching again for this airport must not reset its chosen direction.
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "MSP")!.click());
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Runway"]')!.value).toBe("35");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to location"]')!.click());
    expect(apply).toHaveBeenCalledExactlyOnceWith(airportSpawn(msp.runways[1], mode));
  } finally { await act(async () => root.unmount()); }
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

it("does not let a late airport lookup overwrite a switch to coordinates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeLocationDraft(true, { query: "msp", lat: "45", lon: "-93", altitude: "", airport: msp, airportMode: "departure", runwayId: "35" });
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  let finish!: (result: { id: string; label: string; latDeg: number; lonDeg: number; airport: typeof msp }) => void;
  const resolve = vi.fn<(signal: AbortSignal) => Promise<Parameters<typeof finish>[0]>>(() => new Promise(done => { finish = done; }));
  const provider = async () => [{ id: "msp", label: "MSP", latDeg: msp.latDeg, lonDeg: msp.lonDeg, resolve }];
  const apply = vi.fn();
  const panel = <LocationPanel initialLocation={{ latDeg: 0, lonDeg: 0 }} enableAirportPresets onApply={apply} searchProvider={provider} />;
  await act(async () => root.render(panel));
  try {
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "MSP")!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Enter coordinates instead")!.click());
    expect(resolve.mock.calls[0][0].aborted).toBe(true);
    await act(async () => finish({ id: "msp", label: "MSP", latDeg: msp.latDeg, lonDeg: msp.lonDeg, airport: msp }));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(panel));
    expect(host.querySelector('[aria-label="Runway"]')).toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('[type="number"]'), input => input.value)).toEqual(["45", "-93", ""]);
    expect(apply).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("keeps flight selections separate from ordinary globe location drafts", () => {
  writeLocationDraft(true, { query: "msp", lat: "", lon: "", altitude: "", airport: msp, airportMode: "departure", runwayId: "35" });
  expect(readLocationDraft(false)).toMatchObject({ query: "", airport: null });
  writeLocationDraft(false, { ...readLocationDraft(false), query: "Minneapolis" });
  expect(readLocationDraft(true)).toMatchObject({ query: "msp", airport: msp, runwayId: "35" });
});

it.each(["{broken", "[]", '{"airport":{"runways":null}}'])("ignores malformed stored drafts: %s", value => {
  localStorage.setItem("foss-earth.location-draft.v1.airport", value);
  expect(readLocationDraft(true)).toMatchObject({ query: "", airport: null });
});

it("rejects a saved runway that is absent from its airport", () => {
  writeLocationDraft(true, { query: "msp", lat: "", lon: "", altitude: "", airport: msp, airportMode: "departure", runwayId: "missing" });
  expect(readLocationDraft(true).airport).toBeNull();
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
