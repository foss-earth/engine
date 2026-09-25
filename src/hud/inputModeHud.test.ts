// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HudInputMode } from "../input/inputSettings";
import { createInputModeHud, type InputModeHudOptions } from "./inputModeHud";

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

function mount(modes: readonly HudInputMode[], options: InputModeHudOptions = {}) {
  const container = document.createElement("div");
  const anchor = document.createElement("button");
  container.append(anchor);
  document.body.append(container);
  const hud = createInputModeHud(container, anchor, { availableModes: new Set(modes), ...options });
  const section = document.createElement("div");
  const unmount = hud.mountInline(section);
  const headings = () => Array.from(section.querySelectorAll(".input-mode-heading"), (el) => el.textContent);
  const pressed = (mode: string) =>
    section.querySelector(`.input-mode-toggle-option[data-mode="${mode}"]`)?.getAttribute("aria-pressed");
  return { container, hud, section, unmount, headings, pressed };
}

describe("input method section", () => {
  it("shows Touch, then Mouse or trackpad beneath it, on a touch laptop", () => {
    const { section, headings, pressed } = mount(["mouse", "trackpad", "touch"]);

    expect(headings()).toEqual(["Touch", "Mouse or trackpad"]);
    expect(section.querySelector('.input-mode-sensitivity-panel[data-mode="touch"]')).not.toBeNull();
    expect(section.querySelector('.input-mode-toggle-option[data-mode="touch"]')).toBeNull();
    expect(pressed("trackpad")).toBe("true");
  });

  it("shows only Touch on a phone", () => {
    const onModeChange = vi.fn();
    const { section, headings } = mount(["touch"], { onModeChange });

    expect(headings()).toEqual(["Touch"]);
    expect(section.querySelector(".input-mode-toggle-row")).toBeNull();
    expect(onModeChange).toHaveBeenCalledWith("touch");
  });

  it("shows only the pointer part, with the choice, on a desktop", () => {
    const { headings, pressed } = mount(["mouse", "trackpad"]);

    expect(headings()).toEqual(["Mouse or trackpad"]);
    expect(pressed("mouse")).toBe("false");
  });

  it("keeps a touch laptop's saved touch mode from hiding the pointer choice", () => {
    window.localStorage.setItem("foss-earth.inputMode", "touch");
    const onModeChange = vi.fn();
    mount(["mouse", "trackpad", "touch"], { onModeChange });

    expect(onModeChange).toHaveBeenCalledWith("trackpad");
  });

  it("switches the pointer mode and shows it on the toolbar button", () => {
    const onModeChange = vi.fn();
    const { container, section, pressed } = mount(["mouse", "trackpad"], { onModeChange });

    section.querySelector<HTMLButtonElement>('.input-mode-toggle-option[data-mode="mouse"]')!.click();
    expect(onModeChange).toHaveBeenLastCalledWith("mouse");
    expect(pressed("mouse")).toBe("true");
    expect(container.querySelector("#inputModeButton")?.getAttribute("aria-label")).toBe("Mouse mode. Show or hide input settings");
  });

  it("applies touch sensitivity on its own, leaving the pointer's alone", () => {
    const onSensitivityChange = vi.fn();
    const { section } = mount(["mouse", "touch"], { onSensitivityChange, movements: ["zoom"] });

    const field = section.querySelector<HTMLInputElement>('.input-mode-sensitivity-panel[data-mode="touch"] .gesture-value-input')!;
    field.value = "2.5";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(onSensitivityChange).toHaveBeenLastCalledWith(expect.objectContaining({
      touch: expect.objectContaining({ zoom: 2.5 }),
      mouse: expect.objectContaining({ zoom: 1 }),
    }));
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
    const { hud, section, unmount } = mount(["mouse", "trackpad"]);
    const second = document.createElement("div");
    hud.mountInline(second);

    second.querySelector<HTMLButtonElement>('.input-mode-toggle-option[data-mode="mouse"]')!.click();
    expect(section.querySelector('.input-mode-toggle-option[data-mode="mouse"]')?.getAttribute("aria-pressed")).toBe("true");

    unmount();
    expect(section.querySelector(".input-mode-inline")).toBeNull();
    hud.destroy();
    expect(second.querySelector(".input-mode-inline")).toBeNull();
  });
});
