/** Bound to the one host settings registry; no singleton or implicit document. */
export interface VisualizationTunerSettings {
  get(id: string): unknown;
  inspect(id: string): { provenance: string };
  setMany(values: Record<string, number | { min: number; max: number }>): { ok: boolean };
}
export interface VisualizationTunerPorts {
  document: Document;
  settings: VisualizationTunerSettings;
  /** UI's compact icon action; with it, Apply is a ✓ with its full name, without it the word. */
  createIconButton?: (document: Document, options: { icon: "check"; label: string }) => HTMLButtonElement;
}

/** "Sprite size [fields…] [✓] [Save as default]": the title first in the row, shared action classes. */
export function createTunerActions(ports: VisualizationTunerPorts, applyLabel: string): { apply: HTMLButtonElement; save: HTMLButtonElement; element: HTMLElement } {
  const { document } = ports;
  const apply = ports.createIconButton?.(document, { icon: "check", label: applyLabel }) ?? document.createElement("button");
  if (!ports.createIconButton) {
    apply.type = "button";
    apply.className = "foss-earth-choice foss-earth-parameter__action";
    apply.textContent = "Apply";
    apply.setAttribute("aria-label", applyLabel);
  }
  apply.classList.add("poi-sprite-tuner-apply");
  apply.hidden = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "foss-earth-choice foss-earth-parameter__action poi-sprite-tuner-save-defaults";
  save.textContent = "Save as default";
  save.hidden = true;
  const element = document.createElement("div");
  element.className = "poi-sprite-tuner-actions";
  element.append(apply, save);
  return { apply, save, element };
}
