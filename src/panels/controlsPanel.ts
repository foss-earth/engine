import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { createParameterSection, createSectionsElement, appendHostSections, ParameterSectionOptions, SectionsElementEntry } from "@foss-earth/ui/browser";
import { INPUT_SENSITIVITY_IDS } from "../settings/catalogue/controls.js";
import type { InputModeHudHandle } from "./inputModeHud.js";

export interface ControlsPanelPorts {
  document: Document;
  settings: SettingsRegistry;
  inputMethod?: InputModeHudHandle;
  /** Existing gamepad-tools editor contribution; engine never creates or polls it. */
  controller?: HTMLElement;
  ui: {
    createParameterSection: typeof createParameterSection;
    createSectionsElement: typeof createSectionsElement;
    appendHostSections: typeof appendHostSections;
  };
  /** Same host presentation refresh authority used by the other settings sections. */
  refresh: NonNullable<ParameterSectionOptions["refresh"]>;
  panelStorage: ParameterSectionOptions["panelStorage"];
}

/** Source Controls homes; the button opens this one tab. */
export const ENGINE_CONTROLS_SECTIONS = ["input-method", "camera", "orbit", "mouse", "touch", "controller"] as const;

export function createControlsPanel(ports: ControlsPanelPorts) {
  const { document, settings } = ports;
  const handles: ReturnType<typeof createParameterSection>[] = [];
  const sectionOf = (section: string, extra: Omit<ParameterSectionOptions, "tab" | "section" | "refresh" | "document"> = {}): HTMLElement => {
    const handle = ports.ui.createParameterSection(settings, { document, tab: "controls", section, panelStorage: ports.panelStorage, refresh: ports.refresh, ...extra });
    handles.push(handle);
    return handle.element;
  };
  const inputMethod = document.createElement("div");
  const unmountInput = ports.inputMethod?.mountInline(inputMethod);
  const tiltNote = document.createElement("p");
  tiltNote.className = "settings-line";
  tiltNote.textContent = "Tilt: 0° looks at the horizon, 90° straight down.";
  const entries: SectionsElementEntry[] = [
    ...(ports.inputMethod ? [{ id: "controls.input-method", title: "Input method", element: sectionOf("input-method", { main: inputMethod, covers: ["input.mode", ...INPUT_SENSITIVITY_IDS] }), defaultOpen: true }] : []),
    { id: "controls.camera", title: settings.getSectionTitle("controls", "camera"), element: sectionOf("camera", { footer: tiltNote }), defaultOpen: false },
    { id: "controls.orbit", title: settings.getSectionTitle("controls", "orbit"), element: sectionOf("orbit"), defaultOpen: false },
    { id: "controls.mouse", title: settings.getSectionTitle("controls", "mouse"), element: sectionOf("mouse"), defaultOpen: false },
    { id: "controls.touch", title: settings.getSectionTitle("controls", "touch"), element: sectionOf("touch"), defaultOpen: false },
    { id: "controls.controller", title: settings.getSectionTitle("controls", "controller"), element: sectionOf("controller", { main: ports.controller }), defaultOpen: false },
  ];
  const sections = ports.ui.createSectionsElement(entries, { document, storage: ports.panelStorage });
  const hostSections = ports.ui.appendHostSections(settings, "controls", sections, ENGINE_CONTROLS_SECTIONS, { document, panelStorage: ports.panelStorage, refresh: ports.refresh });
  return {
    element: sections.element,
    destroy(): void {
      unmountInput?.();
      for (const handle of handles) handle.destroy();
      hostSections.destroy();
      sections.destroy();
    },
  };
}
