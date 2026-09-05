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
