// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { appendHostSections, createParameterSection, createSectionsElement } from "@foss-earth/ui/browser";
import { CONTROLS_PARAMETERS } from "../src/settings/catalogue/controls.js";
import { createControlsPanel } from "../src/panels/controlsPanel.js";
import { createNavigationAnchorPinSection, formatPinnedPoint, navigationAnchorPinMessage } from "../src/panels/navigationAnchorPinSection.js";
import type { GlobeNavigationAnchors, NavigationAnchorStatus, PinnedPoint } from "../src/input/navigationAnchors.js";

const ARMED = "Click or tap a place on the map to pin it. Esc cancels.";
const MISSED = "No map surface there. Click or tap another place, or press Esc to cancel.";
const BLOCKED = "A panorama holds navigation.";
const GRAND_CANYON: PinnedPoint = Object.freeze({ point: Object.freeze({ x: -1, y: -2, z: 3 }), latDeg: 36.1, lonDeg: -112.14, heightMeters: 812.4, source: "surface", surfaceRevision: 4 });

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A runtime's anchors, with what the section reads set directly. */
function fakeAnchors(initial: Partial<NavigationAnchorStatus> = {}) {
  let status: NavigationAnchorStatus = { pin: null, selection: "off", pinningBlocked: null, tracking: false,
    last: { mouse: {}, trackpad: {}, touch: {}, nonPointer: {} }, ...initial };
  const listeners = new Set<() => void>();
  const set = (next: Partial<NavigationAnchorStatus>): void => {
    status = { ...status, ...next };
    for (const listener of [...listeners]) listener();
  };
  const anchors = {
    status: () => status,
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    togglePick: vi.fn(() => { set({ selection: status.selection === "off" ? "armed" : "off" }); return status.selection !== "off"; }),
    armPick: vi.fn(() => { set({ selection: "armed" }); return true; }),
    cancelPick: vi.fn(() => { set({ selection: "off" }); }),
    pinTarget: vi.fn(() => { set({ pin: { ...GRAND_CANYON, source: "target" }, selection: "off" }); return true; }),
    clearPin: vi.fn(() => { set({ pin: null }); }),
  } satisfies GlobeNavigationAnchors;
  return { anchors, set, listeners };
}

function mount(initial: Partial<NavigationAnchorStatus> = {}) {
  const fake = fakeAnchors(initial);
  const section = createNavigationAnchorPinSection({ document, anchors: fake.anchors });
  document.body.append(section.element);
  const button = (text: string): HTMLButtonElement =>
    Array.from(section.element.querySelectorAll("button")).find(element => element.textContent === text)!;
  const note = section.element.querySelector<HTMLElement>("[role=status]")!;
  const where = section.element.querySelectorAll("p")[0]!;
  return { ...fake, section, pick: button("Pick point"), pinTarget: button("Pin compass target"), clear: button("Clear pin"), note, where };
}

describe("formatPinnedPoint", () => {
  it("writes latitude and longitude with hemispheres, and the height in whole metres", () => {
    expect(formatPinnedPoint({ latDeg: 36.1, lonDeg: -112.14, heightMeters: 812.4 })).toBe("36.1000°N 112.1400°W, 812m above the ellipsoid");
    expect(formatPinnedPoint({ latDeg: -33.85678, lonDeg: 151.21534, heightMeters: -3.6 })).toBe("33.8568°S 151.2153°E, -4m above the ellipsoid");
    expect(formatPinnedPoint({ latDeg: 0, lonDeg: 0, heightMeters: 0 })).toBe("0.0000°N 0.0000°E, 0m above the ellipsoid");
  });
});

describe("navigationAnchorPinMessage", () => {
  const base: NavigationAnchorStatus = { pin: null, selection: "off", pinningBlocked: null, tracking: false, last: { mouse: {}, trackpad: {}, touch: {}, nonPointer: {} } };
  it("says what Pick point waits for, why pinning is unavailable, and what tracking does", () => {
    expect(navigationAnchorPinMessage(base)).toBe("");
    expect(navigationAnchorPinMessage({ ...base, selection: "armed" })).toBe(ARMED);
    expect(navigationAnchorPinMessage({ ...base, selection: "missed" })).toBe(MISSED);
    expect(navigationAnchorPinMessage({ ...base, tracking: true })).toBe("While a point is tracked, zoom and rotation act about it. The pin is used again when tracking ends.");
    expect(navigationAnchorPinMessage({ ...base, pinningBlocked: BLOCKED, selection: "armed" })).toBe(BLOCKED);
    expect(navigationAnchorPinMessage({ ...base, pinningBlocked: BLOCKED, pin: GRAND_CANYON })).toBe(`${BLOCKED} The pin stays, and Clear pin still works.`);
  });
});

describe("pinned point section", () => {
  it("offers three keyboard-focusable buttons in a labelled group", () => {
    const { section, pick, pinTarget, clear } = mount();
    expect(section.element.getAttribute("role")).toBe("group");
    expect(section.element.getAttribute("aria-label")).toBe("Pinned point");
    for (const button of [pick, pinTarget, clear]) {
      expect(button.type).toBe("button");
      expect(button.tabIndex).toBe(0);
    }
    pick.focus();
    expect(document.activeElement).toBe(pick);
    pinTarget.focus();
    expect(document.activeElement).toBe(pinTarget);
  });

  it("says no point is pinned, with Clear pin disabled and no note", () => {
    const { where, clear, pick, pinTarget, note } = mount();
    expect(where.textContent).toBe("No point is pinned. Choices set to Pinned point use the compass target.");
    expect(clear.disabled).toBe(true);
    expect(pick.disabled).toBe(false);
    expect(pinTarget.disabled).toBe(false);
    expect(note.hidden).toBe(true);
  });

  it("toggles Pick point, pressed while armed, with the instruction in the status note", () => {
    const { pick, note, anchors } = mount();
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    pick.click();
    expect(anchors.togglePick).toHaveBeenCalledTimes(1);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    expect(note.textContent).toBe(ARMED);
    expect(note.hidden).toBe(false);
    pick.click();
    expect(anchors.togglePick).toHaveBeenCalledTimes(2);
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    expect(note.hidden).toBe(true);
  });

  it("says when a pick found no surface, still pressed", () => {
    const { pick, note, set } = mount({ selection: "armed" });
    set({ selection: "missed" });
    expect(note.textContent).toBe(MISSED);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the pin's place and source, and clears it", () => {
    const { where, clear, anchors, set } = mount({ pin: GRAND_CANYON });
    expect(where.textContent).toBe("36.1000°N 112.1400°W, 812m above the ellipsoid, on the map surface.");
    set({ pin: { ...GRAND_CANYON, source: "ellipsoid" } });
    expect(where.textContent).toBe("36.1000°N 112.1400°W, 812m above the ellipsoid, on the ellipsoid: no map surface was there.");
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(anchors.clearPin).toHaveBeenCalledTimes(1);
    expect(clear.disabled).toBe(true);
    expect(where.textContent).toBe("No point is pinned. Choices set to Pinned point use the compass target.");
  });

  it("pins the compass target", () => {
    const { where, pinTarget, anchors } = mount();
    pinTarget.click();
    expect(anchors.pinTarget).toHaveBeenCalledTimes(1);
    expect(where.textContent).toBe("36.1000°N 112.1400°W, 812m above the ellipsoid, the compass target when pinned.");
  });

  it("disables picking and pinning while blocked, keeping Clear pin and explaining", () => {
    const { pick, pinTarget, clear, note, set } = mount({ pin: GRAND_CANYON });
    set({ pinningBlocked: BLOCKED });
    expect(pick.disabled).toBe(true);
    expect(pinTarget.disabled).toBe(true);
    expect(clear.disabled).toBe(false);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(`${BLOCKED} The pin stays, and Clear pin still works.`);
    set({ pinningBlocked: null });
    expect(pick.disabled).toBe(false);
    expect(note.hidden).toBe(true);
  });

  it("explains tracking", () => {
    const { note, set } = mount();
    set({ tracking: true });
    expect(note.textContent).toBe("While a point is tracked, zoom and rotation act about it. The pin is used again when tracking ends.");
  });

  it("unsubscribes and cancels an armed pick on destroy", () => {
    const { section, anchors, listeners, set, pick } = mount();
    pick.click();
    expect(listeners.size).toBe(1);
    section.destroy();
    expect(listeners.size).toBe(0);
    expect(anchors.cancelPick).toHaveBeenCalledTimes(1);
    set({ pin: GRAND_CANYON });
    expect(section.element.querySelectorAll("p")[0]!.textContent).toBe("No point is pinned. Choices set to Pinned point use the compass target.");
  });

  it("leaves Pick point alone on destroy when it is off", () => {
    const { section, anchors } = mount();
    section.destroy();
    expect(anchors.cancelPick).not.toHaveBeenCalled();
  });
});

describe("Controls panel", () => {
  function panel(navigationAnchors?: GlobeNavigationAnchors) {
    const settings = createSettingsRegistry({ storage: window.localStorage });
    settings.register(CONTROLS_PARAMETERS);
    return createControlsPanel({ document, settings, navigationAnchors,
      ui: { createParameterSection, createSectionsElement, appendHostSections },
      refresh: { subscribe: () => () => {} }, panelStorage: null });
  }

  it("puts the pinned point section in Orbit, after its controls, and cancels Pick point with the panel", () => {
    const { anchors } = fakeAnchors({ selection: "armed" });
    const controls = panel(anchors);
    const orbit = controls.element.querySelector('[data-section="controls.orbit"]')!;
    const pinSection = orbit.querySelector(".foss-earth-navigation-pin-section")!;
    expect(pinSection).not.toBeNull();
    expect(controls.element.querySelectorAll(".foss-earth-navigation-pin-section")).toHaveLength(1);
    const after = pinSection.nextElementSibling;
    expect(after === null || after.classList.contains("foss-earth-parameter-section__footer")).toBe(true);
    controls.destroy();
    expect(anchors.cancelPick).toHaveBeenCalledTimes(1);
  });

  it("has no pinned point section without the runtime's anchors", () => {
    const controls = panel();
    expect(controls.element.querySelector(".foss-earth-navigation-pin-section")).toBeNull();
    controls.destroy();
  });
});
