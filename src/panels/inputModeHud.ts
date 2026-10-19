import { oneFingerClickSvgRaw, mouseLeftButtonSvgRaw, mouseRightButtonSvgRaw, mouseScrollWheelSvgRaw, trackpadPinchSvgRaw, trackpadSwipeSvgRaw, trackpadTouchSvgRaw } from "./gestureArtwork.js";
import type { GlobeInputSensitivitySettings } from "../view.js";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { checkChoice, createChoiceGroup } from "@foss-earth/ui/browser";
import {
  loadInputModePreference,
  loadInputSensitivityPreference,
  saveInputModePreference,
  saveInputSensitivityPreference,
} from "../settings/inputPreferences.js";
import type { HudInputMode } from "../input/inputSettings.js";

export type MovementKind = "pan" | "orbit" | "zoom";

export interface InputModeHudHandle {
  /**
   * Draws the Input method section into `container`: a Touch part on a device
   * with a touchscreen, then a Mouse or trackpad part on one with a pointer.
   * Every mounted view shares one state. Returns an unmount.
   */
  mountInline(container: HTMLElement): () => void;
  setAutoBadgeActive(active: boolean): void;
  setOnAutoModeExit(handler: (() => void) | null): void;
  destroy(): void;
}

export interface InputModeDeviceHints {
  platform: string;
  maxTouchPoints: number;
  coarsePointer: boolean;
  finePointer: boolean;
}
export interface InputModeHudOptions {
  document: Document;
  settings: SettingsRegistry;
  /** UI's compact segmented choice, for the pointer mode. */
  ui: { createChoiceGroup: typeof createChoiceGroup; checkChoice: typeof checkChoice };
  /** Offer "Debug wheel events", which logs each wheel event's reading; for a host's developer pages. */
  showDebug?: boolean;
  deviceHints: InputModeDeviceHints;
  log: { info(...values: unknown[]): void };
  availableModes?: ReadonlySet<HudInputMode>;
  movements?: readonly MovementKind[];
  trackpadOrbitGesture?: "touch" | "swipe";
  gestureDescription?: (mode: HudInputMode, movement: MovementKind) => string;
  onModeChange?: (mode: HudInputMode) => void;
  onSensitivityChange?: (settings: GlobeInputSensitivitySettings) => void;
  /** The HUD button shows or hides the host's Controls tab, where the section lives. */
  onToggle?: () => void;
}

const DELTA_EPSILON = 0.001;
const HUD_ACCENT = "#0284c7";

const MODE_LABELS: Record<HudInputMode, string> = {
  mouse: "Mouse mode",
  trackpad: "Trackpad mode",
  touch: "Touch mode",
};

const MOVEMENT_LABELS: Record<MovementKind, string> = {
  pan: "Pan",
  orbit: "Orbit",
  zoom: "Zoom",
};

function hasFractionalDelta(value: number): boolean {
  return Math.abs(value - Math.round(value)) > DELTA_EPSILON;
}

function isLikelyMouseWheel(e: WheelEvent): boolean {
  const absDeltaX = Math.abs(e.deltaX);
  const absDeltaY = Math.abs(e.deltaY);
  const hasHorizontal = absDeltaX > DELTA_EPSILON;
  const hasFine = hasFractionalDelta(e.deltaX) || hasFractionalDelta(e.deltaY);

  if (e.deltaMode !== 0) return absDeltaY > DELTA_EPSILON;
  return !hasHorizontal && !hasFine && absDeltaY > DELTA_EPSILON;
}

function clampSensitivity(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.max(0.1, Math.min(10, Math.round(num * 100) / 100));
}

function cloneSensitivity(settings: GlobeInputSensitivitySettings): GlobeInputSensitivitySettings {
  return {
    mouse: { ...settings.mouse },
    trackpad: { ...settings.trackpad },
    touch: { ...settings.touch },
  };
}

export function detectAvailableModes(hints: InputModeDeviceHints): Set<HudInputMode> {
  const modes = new Set<HudInputMode>();
  const isMac = /mac/i.test(hints.platform);
  const hasTouch = hints.maxTouchPoints > 0 || hints.coarsePointer;
  const hasFinePointer = hints.finePointer;

  if (hasFinePointer || !hasTouch) modes.add("mouse");
  if (isMac || hasFinePointer) modes.add("trackpad");
  if (hasTouch) modes.add("touch");
  if (modes.size === 0) modes.add("mouse");

  return modes;
}

const SVG_ICON_ATTRS = `xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${HUD_ACCENT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const SVG_ACTION_ATTRS = `xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${HUD_ACCENT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
function sanitizeGestureSvg(svgRaw: string): string {
  return svgRaw
    .replace(/<\?xml[^>]*>/i, "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/i, "")
    .replace(/fill="#000000"/gi, 'fill="currentColor"')
    .replace(/width="800px"/i, 'width="14"')
    .replace(/height="800px"/i, 'height="14"')
    .trim();
}
const MOUSE_LEFT_BUTTON_SVG = sanitizeGestureSvg(mouseLeftButtonSvgRaw);
const MOUSE_RIGHT_BUTTON_SVG = sanitizeGestureSvg(mouseRightButtonSvgRaw);
const MOUSE_SCROLL_WHEEL_SVG = sanitizeGestureSvg(mouseScrollWheelSvgRaw);
const ONE_FINGER_CLICK_SVG = sanitizeGestureSvg(oneFingerClickSvgRaw);
const TRACKPAD_PINCH_SVG = sanitizeGestureSvg(trackpadPinchSvgRaw);
const TRACKPAD_SWIPE_SVG = sanitizeGestureSvg(trackpadSwipeSvgRaw);
const TRACKPAD_TOUCH_SVG = sanitizeGestureSvg(trackpadTouchSvgRaw);

function gestureIconSvg(mode: HudInputMode, movement: MovementKind): string {
  const a = SVG_ICON_ATTRS;
  if (mode === "mouse") {
    if (movement === "pan") return MOUSE_LEFT_BUTTON_SVG;
    if (movement === "zoom") return MOUSE_SCROLL_WHEEL_SVG;
    if (movement === "orbit") return MOUSE_RIGHT_BUTTON_SVG;
  }
  if (mode === "trackpad") {
    if (movement === "pan") {
      return `<div class="gesture-card-bg-stack" aria-hidden="true">${TRACKPAD_SWIPE_SVG}${ONE_FINGER_CLICK_SVG}</div>`;
    }
    if (movement === "zoom") return TRACKPAD_PINCH_SVG;
    if (movement === "orbit") return TRACKPAD_TOUCH_SVG;
  }
  if (movement === "pan") return `<svg ${a}><line x1="12" y1="3" x2="12" y2="15"/><path d="M9 18l3 4 3-4" stroke-width="1.5"/></svg>`;
  if (movement === "zoom") return `<svg ${a}><path d="M7 4L3 8"/><path d="M17 4l4 4"/><path d="M7 20L3 16"/><path d="M17 20l4-4"/><circle cx="12" cy="12" r="2" fill="currentColor" fill-opacity=".3"/></svg>`;
  return `<svg ${a}><line x1="9" y1="5" x2="9" y2="15"/><line x1="15" y1="5" x2="15" y2="15"/><path d="M6 18l6 4 6-4" stroke-width="1.5"/></svg>`;
}

function actionIconSvg(movement: MovementKind): string {
  const a = SVG_ACTION_ATTRS;
  if (movement === "pan") return `<svg ${a}><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;
  if (movement === "zoom") return `<svg ${a}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
  if (movement === "orbit") return `<svg ${a}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
  return "";
}

function svgForMode(mode: HudInputMode): string {
  const common = `xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${HUD_ACCENT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  if (mode === "mouse") {
    return `<svg ${common}><rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/></svg>`;
  }
  if (mode === "trackpad") {
    return `<svg ${common}><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M2 14h20"/><path d="M12 20v-6"/></svg>`;
  }
  return `<svg ${common}><path d="M22 14a8 8 0 0 1-8 8"/><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"/><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
}

/** The modes that read wheel and gesture events; touch is handled on its own. */
const POINTER_MODES: readonly HudInputMode[] = ["mouse", "trackpad"];

const POINTER_HELP = "How wheel and gesture events are read: a mouse wheel zooms in steps, a trackpad pans and pinches. Touch gestures work in either mode. Each card's number is that movement's sensitivity, a multiple of the standard rate, applied on Enter or when you leave the field; Show all parameters lists them, and Reset all returns them to 1.";

let pointerChoiceCount = 0;

/**
 * The input-method button in the HUD bar, and the Input method section a host
 * puts in its Controls tab.
 *
 * The settings have one home, the section. The button shows the pointer mode
 * and opens that tab; it never pops up a copy of the settings.
 *
 * Touch is not a mode. Touch gestures are handled whatever the pointer mode is,
 * with their own sensitivity, so a device with a touchscreen gets a Touch part,
 * and one with a mouse or trackpad gets a Mouse or trackpad part beneath it. A
 * touch laptop, or an iPad with a keyboard and trackpad, gets both. The pointer
 * mode only decides how wheel and gesture events are read.
 */
export function createInputModeHud(
  container: HTMLElement,
  anchorAfter: HTMLElement,
  options: InputModeHudOptions,
): InputModeHudHandle {
  const document = options.document;
  const settings = options.settings;
  const availableModes = options.availableModes ?? detectAvailableModes(options.deviceHints);
  const pointerModes = POINTER_MODES.filter((mode) => availableModes.has(mode));
  const hasTouch = availableModes.has("touch");
  const movements = options.movements ?? ["pan", "orbit", "zoom"] as const;
  // With no mouse or trackpad the mode stays "touch", which reads no wheel.
  const modeChoices = new Set<HudInputMode>(pointerModes.length > 0 ? pointerModes : ["touch"]);
  let activeMode = loadInputModePreference(settings, modeChoices);
  let sensitivity = loadInputSensitivityPreference(settings);
  let debugMode = false;
  let autoModeActive = false;
  let onAutoModeExit: (() => void) | null = null;
  const inlineViews = new Set<HTMLElement>();

  const control = document.createElement("div");
  control.className = "input-mode-control";

  const anchor = document.createElement("div");
  anchor.className = "input-mode-anchor";

  const button = document.createElement("button");
  button.id = "inputModeButton";
  button.className = "hud-circle-button input-mode-button";
  button.type = "button";

  const modeIcon = document.createElement("span");
  modeIcon.className = "input-mode-button-icon";

  const autoBadge = document.createElement("span");
  autoBadge.className = "input-mode-auto-badge";
  autoBadge.textContent = "AUTO";
  autoBadge.hidden = true;
  autoBadge.setAttribute("aria-hidden", "true");

  function syncButtonA11y(): void {
    const label = autoModeActive ? "Exit auto camera mode" : `${MODE_LABELS[activeMode]}. Show or hide input settings`;
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  const setAutoBadgeActive = (active: boolean): void => {
    autoModeActive = active;
    autoBadge.hidden = !active;
    button.classList.toggle("input-mode-button--auto", active);
    syncButtonA11y();
  };

  function renderButton(): void {
    modeIcon.innerHTML = svgForMode(activeMode);
    button.classList.toggle("input-mode-button--debug", debugMode);
    syncButtonA11y();
  }

  /** Redraws every view but `except`, which holds the field being typed in. */
  function renderAll(except?: HTMLElement): void {
    for (const view of inlineViews) if (view !== except) renderInto(view);
  }

  function heading(text: string): HTMLElement {
    const element = document.createElement("div");
    element.className = "input-mode-heading";
    element.textContent = text;
    return element;
  }

  function renderInto(target: HTMLElement): void {
    target.replaceChildren();
    // Each part's title is the first item of its row of cards.
    if (hasTouch) target.append(renderCards(target, "touch", heading("Touch")));
    if (pointerModes.length === 0) return;

    if (pointerModes.length === 1) {
      target.append(renderCards(target, activeMode, heading(MODE_LABELS[pointerModes[0]].replace(" mode", ""))));
    } else {
      // "Pointer [Mouse / Trackpad] ?": a choice of one, with arrow keys, in the shared track.
      const name = `foss-earth-pointer-mode-${++pointerChoiceCount}`;
      const group = options.ui.createChoiceGroup(name, "Pointer", pointerModes.map(mode => ({ id: mode, label: MODE_LABELS[mode].replace(" mode", "") })), document, { help: POINTER_HELP, helpLabel: "Explain the pointer mode" });
      for (const input of group.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
        const icon = document.createElement("span");
        icon.className = "input-mode-toggle-icon";
        icon.innerHTML = svgForMode(input.value as HudInputMode);
        input.after(icon);
      }
      options.ui.checkChoice(group, name, activeMode);
      let cards = renderCards(target, activeMode);
      group.addEventListener("change", event => {
        const mode = (event.target as HTMLInputElement).value as HudInputMode;
        if (!pointerModes.includes(mode)) return;
        activeMode = mode;
        saveInputModePreference(settings, mode);
        options.onModeChange?.(mode);
        renderButton();
        // Redraw only the cards here, so the focused choice keeps its focus.
        const next = renderCards(target, activeMode);
        cards.replaceWith(next);
        cards = next;
        renderAll(target);
      });
      target.append(group, cards);
    }

    if (!options.showDebug) return;
    const debugRow = document.createElement("label");
    debugRow.className = "input-mode-debug-toggle";
    debugRow.innerHTML = `<span>Debug wheel events</span><span class="foss-earth-choice foss-earth-switch"><input type="checkbox" ${debugMode ? "checked" : ""}><span class="foss-earth-switch__knob" aria-hidden="true"></span></span>`;
    const input = debugRow.querySelector("input");
    input?.addEventListener("change", () => {
      debugMode = Boolean(input.checked);
      renderButton();
      renderAll(target);
      options.log.info(debugMode ? "[InputMode] Debug ON" : "[InputMode] Debug OFF");
    });
    target.appendChild(debugRow);
  }

  function renderCards(target: HTMLElement, mode: HudInputMode, title?: HTMLElement): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "input-mode-sensitivity-panel";
    panel.dataset.mode = mode;
    if (title) panel.append(title);

    for (const movement of movements) {
      const card = document.createElement("div");
      card.className = "gesture-card";

      const backgroundEl = document.createElement("div");
      backgroundEl.className = "gesture-card-bg";
      backgroundEl.classList.add(`gesture-card-bg--${movement}`);
      backgroundEl.setAttribute("aria-hidden", "true");
      backgroundEl.innerHTML = mode === "trackpad" && movement === "orbit" && options.trackpadOrbitGesture === "swipe"
        ? TRACKPAD_SWIPE_SVG : gestureIconSvg(mode, movement);
      const description = options.gestureDescription?.(mode, movement);
      if (description) {
        card.title = description;
        card.setAttribute("aria-label", description);
      }

      const topRowEl = document.createElement("div");
      topRowEl.className = "gesture-top-row";

      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.className = "gesture-value-input";
      numInput.min = "0.1";
      numInput.max = "10";
      numInput.step = "0.1";
      numInput.value = sensitivity[mode][movement].toFixed(2);
      numInput.setAttribute("aria-label", `${MODE_LABELS[mode].replace(" mode", "")} ${MOVEMENT_LABELS[movement].toLowerCase()} sensitivity`);

      const getVal = (): number => clampSensitivity(parseFloat(numInput.value) || 1);

      // Applied on Enter or when the field is left; Reset all returns every card to 1.
      const applyVal = (v: number): void => {
        const clamped = clampSensitivity(v);
        numInput.value = clamped.toFixed(2);
        if (Math.abs(clamped - sensitivity[mode][movement]) <= 0.005) return;
        const next = cloneSensitivity(sensitivity);
        next[mode][movement] = clamped;
        sensitivity = next;
        saveInputSensitivityPreference(settings, next);
        options.onSensitivityChange?.(next);
        renderAll(target);
      };

      numInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") applyVal(getVal()); });
      numInput.addEventListener("change", () => applyVal(getVal()));

      const inputWrapEl = document.createElement("div");
      inputWrapEl.className = "gesture-input-wrap";
      inputWrapEl.appendChild(numInput);

      topRowEl.append(inputWrapEl);

      const movementMetaEl = document.createElement("div");
      movementMetaEl.className = "gesture-meta-row";

      const actionLabelEl = document.createElement("span");
      actionLabelEl.className = "gesture-action-label";
      actionLabelEl.textContent = MOVEMENT_LABELS[movement];

      const actionIconEl = document.createElement("span");
      actionIconEl.className = "gesture-action-icon";
      actionIconEl.innerHTML = actionIconSvg(movement);

      movementMetaEl.append(actionLabelEl, actionIconEl);
      const contentEl = document.createElement("div");
      contentEl.className = "gesture-card-content";
      contentEl.append(topRowEl, movementMetaEl);

      card.append(backgroundEl, contentEl);
      panel.appendChild(card);
    }
    return panel;
  }

  function onButtonClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (autoModeActive) {
      onAutoModeExit?.();
      return;
    }
    options.onToggle?.();
  }

  function onWheel(e: WheelEvent): void {
    if (!debugMode) return;
    const likelyMouse = isLikelyMouseWheel(e);
    const hasHorizontal = Math.abs(e.deltaX) > DELTA_EPSILON;
    const hasFine = hasFractionalDelta(e.deltaX) || hasFractionalDelta(e.deltaY);
    options.log.info(
      "[InputMode] wheel selected=%s classifier=%s mode=%d ctrl=%s dx=%.4f dy=%.4f horizontal=%s fine=%s likelyMouse=%s",
      activeMode,
      e.ctrlKey || !likelyMouse ? "trackpad" : "mouse",
      e.deltaMode,
      e.ctrlKey,
      e.deltaX,
      e.deltaY,
      hasHorizontal,
      hasFine,
      likelyMouse,
    );
  }

  renderButton();
  button.append(modeIcon, autoBadge);
  anchor.append(button);
  control.append(anchor);
  anchorAfter.insertAdjacentElement("afterend", control);
  options.onModeChange?.(activeMode);
  options.onSensitivityChange?.(sensitivity);

  button.addEventListener("click", onButtonClick);
  container.addEventListener("wheel", onWheel, { passive: true });

  // A change made elsewhere, such as under Show all parameters or by an
  // import, reaches this section and the camera. The section's own edits are
  // already drawn, and redrawing would take the field being typed in.
  const offSettings = settings.subscribe(changed => {
    if (![...changed].some(id => id === "input.mode" || id.startsWith("input.sensitivity."))) return;
    const nextMode = loadInputModePreference(settings, modeChoices);
    const nextSensitivity = loadInputSensitivityPreference(settings);
    const modeChanged = nextMode !== activeMode;
    const sensitivityChanged = JSON.stringify(nextSensitivity) !== JSON.stringify(sensitivity);
    if (!modeChanged && !sensitivityChanged) return;
    activeMode = nextMode;
    sensitivity = nextSensitivity;
    if (modeChanged) options.onModeChange?.(activeMode);
    if (sensitivityChanged) options.onSensitivityChange?.(sensitivity);
    renderButton();
    const typing = document.activeElement?.closest<HTMLElement>(".input-mode-inline") ?? null;
    renderAll(typing ?? undefined);
  });

  return {
    mountInline(target: HTMLElement): () => void {
      const view = document.createElement("div");
      view.className = "input-mode-inline";
      target.append(view);
      inlineViews.add(view);
      renderInto(view);
      return () => {
        inlineViews.delete(view);
        view.remove();
      };
    },
    setAutoBadgeActive,
    setOnAutoModeExit(handler: (() => void) | null): void {
      onAutoModeExit = handler;
    },
    destroy(): void {
      offSettings();
      button.removeEventListener("click", onButtonClick);
      container.removeEventListener("wheel", onWheel);
      for (const view of inlineViews) view.remove();
      inlineViews.clear();
      control.remove();
    },
  };
}
