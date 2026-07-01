import type { GlobeInputSensitivitySettings } from "../engine/types";
import {
  loadInputModePreference,
  loadInputSensitivityPreference,
  saveInputModePreference,
  saveInputSensitivityPreference,
  type HudInputMode,
} from "../input/inputSettings";

type MovementKind = "pan" | "orbit" | "zoom";

export interface InputModeHudHandle {
  setAutoBadgeActive(active: boolean): void;
  setOnAutoModeExit(handler: (() => void) | null): void;
  destroy(): void;
}

export interface InputModeHudOptions {
  onModeChange?: (mode: HudInputMode) => void;
  onSensitivityChange?: (settings: GlobeInputSensitivitySettings) => void;
}

const DELTA_EPSILON = 0.001;
const MENU_VIEWPORT_GUTTER_PX = 8;

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

function detectAvailableModes(): Set<HudInputMode> {
  const modes = new Set<HudInputMode>();
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = userAgentData?.platform ?? navigator.platform ?? "";
  const isMac = /mac/i.test(platform);
  const hasTouch = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)").matches;
  const hasFinePointer = window.matchMedia?.("(pointer: fine)").matches ?? true;

  if (hasFinePointer || !hasTouch) modes.add("mouse");
  if (isMac || hasFinePointer) modes.add("trackpad");
  if (hasTouch) modes.add("touch");
  if (modes.size === 0) modes.add("mouse");

  return modes;
}

const SVG_ICON_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const SVG_ACTION_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

function gestureIconSvg(mode: HudInputMode, movement: MovementKind): string {
  const a = SVG_ICON_ATTRS;
  if (mode === "mouse") {
    if (movement === "pan") return `<svg ${a}><rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 2v8"/><path d="M5 5.5Q5 2 8.5 2H12v8H5V9" fill="currentColor" fill-opacity=".22" stroke="none"/><path d="M9 15l3 4 3-4" stroke-width="1.5"/></svg>`;
    if (movement === "zoom") return `<svg ${a}><rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 2v8"/><path d="M10 8l2-2 2 2"/><path d="M10 13l2 2 2-2"/></svg>`;
    if (movement === "orbit") return `<svg ${a}><rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 2v8"/><path d="M12 2Q19 2 19 5.5V10H12V2z" fill="currentColor" fill-opacity=".22" stroke="none"/><path d="M9 15l3 4 3-4" stroke-width="1.5"/></svg>`;
  }
  if (mode === "trackpad") {
    if (movement === "pan") return `<svg ${a}><line x1="9" y1="3" x2="9" y2="15"/><line x1="15" y1="3" x2="15" y2="15"/><path d="M6 18l6 4 6-4" stroke-width="1.5"/></svg>`;
    if (movement === "zoom") return `<svg ${a}><path d="M7 4L3 8"/><path d="M17 4l4 4"/><path d="M7 20L3 16"/><path d="M17 20l4-4"/><circle cx="12" cy="12" r="2" fill="currentColor" fill-opacity=".3"/></svg>`;
    if (movement === "orbit") return `<svg ${a}><line x1="9" y1="5" x2="9" y2="15"/><line x1="15" y1="5" x2="15" y2="15"/><path d="M6 18l6 4 6-4" stroke-width="1.5"/><rect x="3" y="2" width="7" height="5" rx="1" fill="currentColor" fill-opacity=".15" stroke="rgba(255,255,255,.3)" stroke-width="1"/><path d="M4 5V3.5h2" stroke="rgba(255,255,255,.6)" stroke-width="1.2"/></svg>`;
  }
  if (movement === "pan") return `<svg ${a}><line x1="12" y1="3" x2="12" y2="15"/><path d="M9 18l3 4 3-4" stroke-width="1.5"/></svg>`;
  if (movement === "zoom") return `<svg ${a}><path d="M7 4L3 8"/><path d="M17 4l4 4"/><path d="M7 20L3 16"/><path d="M17 20l4-4"/><circle cx="12" cy="12" r="2" fill="currentColor" fill-opacity=".3"/></svg>`;
  return `<svg ${a}><line x1="9" y1="5" x2="9" y2="15"/><line x1="15" y1="5" x2="15" y2="15"/><path d="M6 18l6 4 6-4" stroke-width="1.5"/></svg>`;
}

function gestureTextLabel(mode: HudInputMode, movement: MovementKind): string {
  if (mode === "mouse") {
    if (movement === "pan") return "L drag";
    if (movement === "zoom") return "Scroll";
    if (movement === "orbit") return "R drag";
  }
  if (mode === "trackpad") {
    if (movement === "pan") return "2-finger";
    if (movement === "zoom") return "Pinch";
    if (movement === "orbit") return "⇧ Swipe";
  }
  if (movement === "pan") return "1-finger";
  if (movement === "zoom") return "Pinch";
  return "2-finger";
}

function actionIconSvg(movement: MovementKind): string {
  const a = SVG_ACTION_ATTRS;
  if (movement === "pan") return `<svg ${a}><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;
  if (movement === "zoom") return `<svg ${a}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
  if (movement === "orbit") return `<svg ${a}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
  return "";
}

const RESET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M5 3l14 9-14 9V3z"/></svg>';

function svgForMode(mode: HudInputMode): string {
  const common = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (mode === "mouse") {
    return `<svg ${common}><rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/></svg>`;
  }
  if (mode === "trackpad") {
    return `<svg ${common}><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M2 14h20"/><path d="M12 20v-6"/></svg>`;
  }
  return `<svg ${common}><path d="M22 14a8 8 0 0 1-8 8"/><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"/><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
}

/**
 * Mount the input-mode selector beside the theme button in the globe HUD bar.
 */
export function createInputModeHud(
  container: HTMLElement,
  anchorAfter: HTMLElement,
  options: InputModeHudOptions = {},
): InputModeHudHandle {
  const availableModes = detectAvailableModes();
  let activeMode = loadInputModePreference(availableModes);
  let sensitivity = loadInputSensitivityPreference();
  let debugMode = false;
  let menuOpen = false;
  let autoModeActive = false;
  let onAutoModeExit: (() => void) | null = null;

  const control = document.createElement("div");
  control.className = "input-mode-control";

  const anchor = document.createElement("div");
  anchor.className = "input-mode-anchor";

  const button = document.createElement("button");
  button.id = "inputModeButton";
  button.className = "hud-circle-button input-mode-button";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const modeIcon = document.createElement("span");
  modeIcon.className = "input-mode-button-icon";

  const autoBadge = document.createElement("span");
  autoBadge.className = "input-mode-auto-badge";
  autoBadge.textContent = "AUTO";
  autoBadge.hidden = true;
  autoBadge.setAttribute("aria-hidden", "true");

  function syncButtonA11y(): void {
    if (autoModeActive) {
      button.title = "Exit auto camera mode";
      button.setAttribute("aria-label", "Exit auto camera mode");
      button.setAttribute("aria-haspopup", "false");
      button.setAttribute("aria-expanded", "false");
      return;
    }

    button.title = MODE_LABELS[activeMode];
    button.setAttribute("aria-label", MODE_LABELS[activeMode]);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", String(menuOpen));
  }

  const setAutoBadgeActive = (active: boolean): void => {
    autoModeActive = active;
    autoBadge.hidden = !active;
    button.classList.toggle("input-mode-button--auto", active);
    if (active) setMenuOpen(false);
    syncButtonA11y();
  };

  const menu = document.createElement("div");
  menu.id = "inputModeMenu";
  menu.className = "input-mode-menu";
  menu.role = "menu";
  menu.hidden = true;

  function setMenuOpen(nextOpen: boolean): void {
    if (autoModeActive && nextOpen) return;
    menuOpen = nextOpen;
    menu.hidden = !menuOpen;
    syncButtonA11y();
    if (menuOpen) requestAnimationFrame(positionMenuWithinViewport);
  }

  setAutoBadgeActive(false);

  function positionMenuWithinViewport(): void {
    if (!menuOpen) return;
    menu.style.transform = "";
    const rect = menu.getBoundingClientRect();
    let translateX = 0;

    if (rect.left < MENU_VIEWPORT_GUTTER_PX) {
      translateX = MENU_VIEWPORT_GUTTER_PX - rect.left;
    } else if (rect.right > window.innerWidth - MENU_VIEWPORT_GUTTER_PX) {
      translateX = window.innerWidth - MENU_VIEWPORT_GUTTER_PX - rect.right;
    }

    menu.style.transform = translateX === 0 ? "" : `translateX(${translateX}px)`;
  }

  function renderButton(): void {
    modeIcon.innerHTML = svgForMode(activeMode);
    button.classList.toggle("input-mode-button--debug", debugMode);
    syncButtonA11y();
  }

  function renderMenu(): void {
    menu.replaceChildren();

    const toggleRow = document.createElement("div");
    toggleRow.className = "input-mode-toggle-row";
    for (const mode of availableModes) {
      const btn = document.createElement("button");
      btn.className = "input-mode-toggle-option";
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(activeMode === mode));
      btn.dataset.mode = mode;
      if (activeMode === mode) btn.classList.add("is-active");
      btn.innerHTML = `<span class="input-mode-toggle-icon">${svgForMode(mode)}</span><span>${MODE_LABELS[mode].replace(" mode", "")}</span>`;
      btn.addEventListener("click", () => {
        activeMode = mode;
        saveInputModePreference(mode);
        options.onModeChange?.(mode);
        renderButton();
        renderMenu();
      });
      toggleRow.appendChild(btn);
    }
    menu.appendChild(toggleRow);

    const panel = document.createElement("div");
    panel.className = "input-mode-sensitivity-panel";

    for (const movement of ["pan", "orbit", "zoom"] as const) {
      const row = document.createElement("div");
      row.className = "gesture-row";

      const sourceEl = document.createElement("div");
      sourceEl.className = "gesture-source";
      sourceEl.innerHTML = `<span class="gesture-icon">${gestureIconSvg(activeMode, movement)}</span><span class="gesture-label">${gestureTextLabel(activeMode, movement)}</span>`;

      const ctrlEl = document.createElement("div");
      ctrlEl.className = "gesture-controls";

      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.className = "gesture-value-input";
      numInput.min = "0.1";
      numInput.max = "10";
      numInput.step = "0.1";
      numInput.value = sensitivity[activeMode][movement].toFixed(2);

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "gesture-reset-btn";
      resetBtn.title = "Reset to default";
      resetBtn.innerHTML = RESET_SVG;

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "gesture-play-btn";
      playBtn.title = "Apply";
      playBtn.hidden = true;
      playBtn.innerHTML = PLAY_SVG;

      const getVal = (): number => clampSensitivity(parseFloat(numInput.value) || 1);

      const syncPlay = (): void => {
        playBtn.hidden = Math.abs(getVal() - sensitivity[activeMode][movement]) <= 0.005;
      };

      const applyVal = (v: number): void => {
        const clamped = clampSensitivity(v);
        numInput.value = clamped.toFixed(2);
        const next = cloneSensitivity(sensitivity);
        next[activeMode][movement] = clamped;
        sensitivity = next;
        saveInputSensitivityPreference(next);
        options.onSensitivityChange?.(next);
        syncPlay();
      };

      numInput.addEventListener("input", syncPlay);
      numInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") applyVal(getVal()); });
      numInput.addEventListener("blur", () => { numInput.value = getVal().toFixed(1); syncPlay(); });
      playBtn.addEventListener("click", () => applyVal(getVal()));
      resetBtn.addEventListener("click", () => applyVal(1.0));

      ctrlEl.append(numInput, resetBtn, playBtn);

      const arrowEl = document.createElement("span");
      arrowEl.className = "gesture-arrow";
      arrowEl.setAttribute("aria-hidden", "true");
      arrowEl.textContent = "→";

      const actionEl = document.createElement("div");
      actionEl.className = "gesture-action";
      actionEl.innerHTML = `<span class="gesture-action-icon">${actionIconSvg(movement)}</span><span class="gesture-action-label">${MOVEMENT_LABELS[movement]}</span>`;

      row.append(sourceEl, ctrlEl, arrowEl, actionEl);
      panel.appendChild(row);
    }

    menu.appendChild(panel);

    const debugRow = document.createElement("label");
    debugRow.className = "input-mode-debug-toggle";
    debugRow.innerHTML = `<span>Debug wheel events</span><input type="checkbox" ${debugMode ? "checked" : ""}>`;
    const input = debugRow.querySelector("input");
    input?.addEventListener("change", () => {
      debugMode = Boolean(input.checked);
      renderButton();
      console.info(debugMode ? "[InputMode] Debug ON" : "[InputMode] Debug OFF");
    });
    menu.appendChild(debugRow);
    if (menuOpen) requestAnimationFrame(positionMenuWithinViewport);
  }

  function onButtonClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (autoModeActive) {
      setMenuOpen(false);
      onAutoModeExit?.();
      return;
    }
    setMenuOpen(!menuOpen);
  }

  function onDocumentPointerDown(e: PointerEvent): void {
    if (!control.contains(e.target as Node)) setMenuOpen(false);
  }

  function onWheel(e: WheelEvent): void {
    if (!debugMode) return;
    const likelyMouse = isLikelyMouseWheel(e);
    const hasHorizontal = Math.abs(e.deltaX) > DELTA_EPSILON;
    const hasFine = hasFractionalDelta(e.deltaX) || hasFractionalDelta(e.deltaY);
    console.info(
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

  function onWindowResize(): void {
    positionMenuWithinViewport();
  }

  renderButton();
  button.append(modeIcon, autoBadge);
  renderMenu();
  anchor.append(button, menu);
  control.append(anchor);
  anchorAfter.insertAdjacentElement("afterend", control);
  options.onModeChange?.(activeMode);
  options.onSensitivityChange?.(sensitivity);

  button.addEventListener("click", onButtonClick);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  window.addEventListener("resize", onWindowResize);
  container.addEventListener("wheel", onWheel, { passive: true });

  return {
    setAutoBadgeActive,
    setOnAutoModeExit(handler: (() => void) | null): void {
      onAutoModeExit = handler;
    },
    destroy(): void {
      button.removeEventListener("click", onButtonClick);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      window.removeEventListener("resize", onWindowResize);
      container.removeEventListener("wheel", onWheel);
      control.remove();
    },
  };
}
