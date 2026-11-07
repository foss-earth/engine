// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHelpTooltip, createIconButton } from "@foss-earth/ui/browser";
import { createEarthAreaPanel } from "../src/area/earthAreaPanel.js";
import { createEarthAreaStore } from "../src/area/earthAreaStore.js";
import type { GlobeNavigationAnchors, NavigationAnchorStatus } from "../src/input/navigationAnchors.js";

afterEach(() => { document.body.replaceChildren(); });

function open() {
  const store = createEarthAreaStore({ groundAt: client => client.x < 0 ? null : { latDeg: 45, lonDeg: -93 } });
  const panel = createEarthAreaPanel({ document, store, createIconButton, createHelpTooltip });
  document.body.append(panel.element);
  const button = (name: string) => panel.element.querySelector<HTMLButtonElement>(`[data-earth-area="${name}"]`)!;
  const input = (name: string) => panel.element.querySelector<HTMLInputElement>(`[data-earth-area="${name}"]`)!;
  const status = () => panel.element.querySelector("[data-earth-area=status]")!.textContent;
  return { store, panel, button, input, status };
}

describe("the Select area tab", () => {
  it("adds corners by typing or by a click, and one height for the whole area", () => {
    const { store, panel, button, input, status } = open();
    expect(status()).toBe("Add at least three corners. Height is optional.");
    input("lat").value = "44.5";
    input("lon").value = "-93.25";
    button("add-typed").click();
    expect(panel.element.textContent).toContain("44.50000°N 93.25000°W");
    expect(input("lat").value).toBe("");
    input("lat").value = "nope";
    button("add-typed").click();
    expect(status()).toBe("A corner needs a latitude from -90 to 90 and a longitude from -180 to 180.");
    button("add-corner").click();
    expect(button("add-corner").getAttribute("aria-pressed")).toBe("true");
    expect(status()).toBe("Click or tap the map to add a corner. Esc cancels.");
    expect(store.picker.pickAt({ x: -1, y: 0 })).toBe(false);
    expect(status()).toContain("No ground there");
    store.picker.pickAt({ x: 4, y: 4 });
    expect(store.snapshot().areas[0]!.points).toEqual([{ latDeg: 44.5, lonDeg: -93.25 }, { latDeg: 45, lonDeg: -93 }]);
    button("undo").click();
    expect(store.snapshot().areas[0]!.points).toHaveLength(1);
    button("add-corner").click();
    expect(button("add-corner").getAttribute("aria-pressed")).toBe("false");
    input("height").value = "1500";
    input("height").dispatchEvent(new Event("change"));
    expect(store.snapshot().areas[0]!.heightMeters).toBe(1500);
    expect(status()).toBe("Add at least three corners. Height is optional.");
    input("height").value = "-4";
    input("height").dispatchEvent(new Event("change"));
    expect(store.snapshot().areas[0]!.heightMeters).toBe(1500);
    expect(status()).toContain("100 km");
    input("height").value = "";
    input("height").dispatchEvent(new Event("change"));
    expect(store.snapshot().areas[0]!.heightMeters).toBeUndefined();
    button("new").click();
    expect(store.snapshot().areas).toHaveLength(2);
    expect(store.snapshot().active).toBe(1);
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="Area 2"]')!.checked).toBe(true);
    button("delete").click();
    expect(store.snapshot().areas).toHaveLength(1);
    expect(store.snapshot().active).toBe(0);
    panel.destroy();
    expect(store.snapshot().placing).toBe(false);
  });

  it("steps aside while Pick point is armed", () => {
    let status: NavigationAnchorStatus = { pin: null, selection: "off", pinningBlocked: null, tracking: false, last: { mouse: {}, trackpad: {}, touch: {}, nonPointer: {} } };
    const listeners = new Set<() => void>();
    const anchors = {
      status: () => status,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      cancelPick: vi.fn(() => { status = { ...status, selection: "off" }; for (const listener of listeners) listener(); }),
    } as unknown as Pick<GlobeNavigationAnchors, "cancelPick" | "subscribe" | "status">;
    const store = createEarthAreaStore();
    const panel = createEarthAreaPanel({ document, store, anchors, createIconButton, createHelpTooltip });
    const add = panel.element.querySelector<HTMLButtonElement>("[data-earth-area=add-corner]")!;
    add.click();
    expect(anchors.cancelPick).toHaveBeenCalled();
    expect(store.snapshot().placing).toBe(true);
    status = { ...status, selection: "armed" };
    for (const listener of listeners) listener();
    expect(store.snapshot().placing).toBe(false);
    status = { ...status, selection: "off", pinningBlocked: "A 360° image holds the camera." };
    for (const listener of listeners) listener();
    expect(add.disabled).toBe(true);
    panel.destroy();
  });
});
