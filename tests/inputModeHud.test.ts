// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { checkChoice, createChoiceGroup } from "@foss-earth/ui/browser";
import { CONTROLS_PARAMETERS } from "../src/settings/catalogue/controls.js";
import { createEngineMigrations } from "../src/settings/migrations.js";
import type { HudInputMode } from "../src/input/inputSettings.js";
import { createInputModeHud, type InputModeHudOptions } from "../src/panels/inputModeHud.js";

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

function mount(modes: readonly HudInputMode[], options: Partial<InputModeHudOptions> = {}) {
  const container = document.createElement("div");
  const anchor = document.createElement("button");
  container.append(anchor);
  document.body.append(container);
  const settings = createSettingsRegistry({ storage: window.localStorage });
  settings.register(CONTROLS_PARAMETERS);
  settings.migrateLegacy(createEngineMigrations(window.localStorage));
  const hud = createInputModeHud(container, anchor, { document, settings, ui: { checkChoice, createChoiceGroup },
    deviceHints: { platform: "Mac", maxTouchPoints: 0, finePointer: true, coarsePointer: false },
    log: console, availableModes: new Set(modes), ...options });
  const section = document.createElement("div");
  // A radio fires change only once it is in the document.
  document.body.append(section);
  const unmount = hud.mountInline(section);
  const headings = () => Array.from(section.querySelectorAll(".input-mode-heading, .foss-earth-choices__heading"), (el) => el.textContent);
  const pointer = (mode: string, root: ParentNode = section) =>
    root.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`);
  const checked = (mode: string) => pointer(mode)?.checked;
  return { container, hud, settings, section, unmount, headings, pointer, checked };
}

describe("input method section", () => {
  it("shows Touch, then Pointer [Mouse / Trackpad] beneath it, on a touch laptop", () => {
    const { section, headings, pointer, checked } = mount(["mouse", "trackpad", "touch"]);

    expect(headings()).toEqual(["Touch", "Pointer"]);
    const touch = section.querySelector('.input-mode-sensitivity-panel[data-mode="touch"]')!;
    expect(touch.firstElementChild?.textContent).toBe("Touch");
    expect(pointer("touch")).toBeNull();
    expect(checked("trackpad")).toBe(true);
  });

  it("puts the pointer choice in one segmented track with ? after it, and no per-card buttons", () => {
    const { section } = mount(["mouse", "trackpad"]);

    const group = section.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Pointer"]')!;
    expect(group.querySelectorAll(".foss-earth-parameter__pills")).toHaveLength(1);
    expect(group.lastElementChild!.querySelector("button")!.getAttribute("aria-label")).toBe("Explain the pointer mode");
    expect(section.querySelectorAll(".gesture-card button")).toHaveLength(0);
  });

  it("offers Debug wheel events only on a developer page", () => {
    expect(mount(["mouse", "trackpad"]).section.textContent).not.toContain("Debug wheel events");
    document.body.replaceChildren();
    const { section } = mount(["mouse", "trackpad"], { showDebug: true });
    expect(section.querySelector(".input-mode-debug-toggle input[type=checkbox]")).not.toBeNull();
    expect(section.querySelector(".input-mode-debug-toggle")?.firstElementChild?.textContent).toBe("Debug wheel events");
  });

  it("shows only Touch on a phone", () => {
    const onModeChange = vi.fn();
    const { section, headings } = mount(["touch"], { onModeChange });

    expect(headings()).toEqual(["Touch"]);
    expect(section.querySelector('[role="radiogroup"]')).toBeNull();
    expect(onModeChange).toHaveBeenCalledWith("touch");
  });

  it("shows only the pointer part, with the choice, on a desktop", () => {
    const { headings, checked } = mount(["mouse", "trackpad"]);

    expect(headings()).toEqual(["Pointer"]);
    expect(checked("mouse")).toBe(false);
  });

  it("keeps a touch laptop's saved touch mode from hiding the pointer choice", () => {
    window.localStorage.setItem("foss-earth.inputMode", "touch");
    const onModeChange = vi.fn();
    mount(["mouse", "trackpad", "touch"], { onModeChange });

    expect(onModeChange).toHaveBeenCalledWith("trackpad");
  });

  it("switches the pointer mode and shows it on the toolbar button", () => {
    const onModeChange = vi.fn();
    const { container, section, pointer, checked } = mount(["mouse", "trackpad"], { onModeChange });

    pointer("mouse")!.click();
    expect(onModeChange).toHaveBeenLastCalledWith("mouse");
    expect(checked("mouse")).toBe(true);
    expect(document.activeElement === pointer("mouse") || document.activeElement === document.body).toBe(true);
    expect(section.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
    expect(container.querySelector("#inputModeButton")?.getAttribute("aria-label")).toBe("Mouse mode. Show or hide input settings");
  });

  it("applies touch sensitivity on its own, leaving the pointer's alone", () => {
    const onSensitivityChange = vi.fn();
    const { section } = mount(["mouse", "touch"], { onSensitivityChange, movements: ["zoom"] });

    const field = section.querySelector<HTMLInputElement>('.input-mode-sensitivity-panel[data-mode="touch"] .gesture-value-input')!;
    field.value = "2.5";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const applied = onSensitivityChange.mock.calls.length;
    field.dispatchEvent(new Event("change"));
    expect(onSensitivityChange).toHaveBeenCalledTimes(applied);

    expect(onSensitivityChange).toHaveBeenLastCalledWith(expect.objectContaining({
      touch: expect.objectContaining({ zoom: 2.5 }),
      mouse: expect.objectContaining({ zoom: 1 }),
    }));
  });
});

/** Stands in for @foss-earth/ui's attachParameterReset: a reset button in the widget's anchor, a span around a field. */
function fakeResets() {
  const attached: { id: string; name?: string; widget: HTMLElement; button: HTMLButtonElement; destroyed: boolean }[] = [];
  const attachParameterReset = (_settings: unknown, document: Document, widget: HTMLElement, id: string, options: { name?: string } = {}) => {
    let anchor = widget;
    if (widget.tagName === "INPUT") { anchor = document.createElement("span"); widget.replaceWith(anchor); anchor.append(widget); }
    anchor.classList.add("foss-earth-parameter__reset-anchor");
    const button = document.createElement("button");
    button.className = "foss-earth-parameter__reset";
    anchor.append(button);
    const entry = { id, name: options.name, widget, button, destroyed: false };
    attached.push(entry);
    return { destroy() { entry.destroyed = true; } };
  };
  return { attached, ui: { checkChoice, createChoiceGroup, attachParameterReset } };
}

describe("input method resets", () => {
  it("puts one on the pointer choice and each sensitivity field, and drops those a redraw replaces", () => {
    const { attached, ui } = fakeResets();
    const { pointer, unmount } = mount(["mouse", "trackpad"], { ui, movements: ["orbit", "zoom"] });

    expect(attached.map(entry => [entry.id, entry.name])).toEqual([
      ["input.mode", "Pointer"],
      ["input.sensitivity.trackpad.orbit", "Trackpad orbit sensitivity"],
      ["input.sensitivity.trackpad.zoom", "Trackpad zoom sensitivity"],
    ]);
    expect(attached[0].widget.classList.contains("foss-earth-parameter__pills")).toBe(true);
    expect(attached[1].widget.classList.contains("gesture-value-input")).toBe(true);

    pointer("mouse")!.click();
    expect(attached.map(entry => [entry.id, entry.destroyed])).toEqual([
      ["input.mode", false],
      ["input.sensitivity.trackpad.orbit", true],
      ["input.sensitivity.trackpad.zoom", true],
      ["input.sensitivity.mouse.orbit", false],
      ["input.sensitivity.mouse.zoom", false],
    ]);

    unmount();
    expect(attached.every(entry => entry.destroyed)).toBe(true);
  });

  it("hands the focus from a reset pressed from the keyboard to its field, drawn again with the default", () => {
    const { attached, ui } = fakeResets();
    const { section, settings } = mount(["mouse", "trackpad"], { ui, movements: ["orbit", "zoom"] });
    const zoom = () => section.querySelector<HTMLInputElement>('[aria-label="Trackpad zoom sensitivity"]')!;
    zoom().value = "2.5";
    zoom().dispatchEvent(new Event("change"));

    attached.find(entry => entry.id === "input.sensitivity.trackpad.zoom")!.button.focus();
    settings.reset("input.sensitivity.trackpad.zoom");

    expect(zoom().value).toBe("1.00");
    expect(document.activeElement).toBe(zoom());
  });
});

describe("input method toolbar button", () => {
  it("toggles the host's Controls tab instead of a popup", () => {
    const onToggle = vi.fn();
    const { container } = mount(["mouse", "trackpad"], { onToggle });

    container.querySelector<HTMLButtonElement>("#inputModeButton")!.click();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector("#inputModeButton")?.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("exits auto camera mode rather than opening Controls while it is active", () => {
    const onToggle = vi.fn();
    const onExit = vi.fn();
    const { container, hud } = mount(["mouse"], { onToggle });
    hud.setOnAutoModeExit(onExit);
    hud.setAutoBadgeActive(true);

    container.querySelector<HTMLButtonElement>("#inputModeButton")!.click();
    expect(onExit).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("keeps two mounted sections in step, and drops one when unmounted", () => {
    const { hud, section, unmount, pointer, checked } = mount(["mouse", "trackpad"]);
    const second = document.createElement("div");
    document.body.append(second);
    hud.mountInline(second);

    pointer("mouse", second)!.click();
    expect(checked("mouse")).toBe(true);
    expect(section.querySelector('input[type="radio"]')?.getAttribute("name")).not.toBe(second.querySelector('input[type="radio"]')?.getAttribute("name"));

    unmount();
    expect(section.querySelector(".input-mode-inline")).toBeNull();
    hud.destroy();
    expect(second.querySelector(".input-mode-inline")).toBeNull();
  });
});
