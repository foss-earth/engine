import { createTunerActions, type VisualizationTunerPorts, type VisualizationTunerSettings } from "./tunerPorts.js";
import { DEFAULT_POI_SPRITE_SIZE_PARAMS, type PoiSpriteSizeParams } from "../visualization/defaults.js";
export { DEFAULT_POI_SPRITE_SIZE_PARAMS, type PoiSpriteSizeParams } from "../visualization/defaults.js";

const POI_SPRITE_SIZE_PARAM_KEYS = ["maxSize", "minSize", "minRefZoom", "maxRefZoom"] as const;
type PoiSpriteSizeParamKey = typeof POI_SPRITE_SIZE_PARAM_KEYS[number];

function normalizePoiSpriteSizeParams(value: unknown): PoiSpriteSizeParams | null {
  const record = (value || {}) as Partial<Record<PoiSpriteSizeParamKey, unknown>>;
  const params = {} as PoiSpriteSizeParams;

  for (const key of POI_SPRITE_SIZE_PARAM_KEYS) {
    const parsed = Number(record[key]);
    if (!Number.isFinite(parsed)) return null;
    params[key] = parsed;
  }

  return params;
}

/** The `visualization.poiSprite.*` parameters, or null while every one is at its default. */
export function loadSavedPoiSpriteSizeDefaults(settings: VisualizationTunerSettings): PoiSpriteSizeParams | null {
  const ids = POI_SPRITE_SIZE_PARAM_KEYS.map(key => `visualization.poiSprite.${key}`);
  if (ids.every(id => settings.inspect(id).provenance === "default")) return null;
  return normalizePoiSpriteSizeParams(Object.fromEntries(POI_SPRITE_SIZE_PARAM_KEYS.map(key => [key, settings.get(`visualization.poiSprite.${key}`)])));
}

/** Refused, never repaired, when a value is outside its bounds; the panel keeps its values. */
export function savePoiSpriteSizeDefaults(settings: VisualizationTunerSettings, params: PoiSpriteSizeParams): boolean {
  return settings.setMany(Object.fromEntries(POI_SPRITE_SIZE_PARAM_KEYS.map(key => [`visualization.poiSprite.${key}`, params[key]]))).ok;
}

function paramsToCommitted(params: PoiSpriteSizeParams): Record<PoiSpriteSizeParamKey, string> {
  return {
    maxSize: String(params.maxSize),
    minSize: String(params.minSize),
    minRefZoom: String(params.minRefZoom),
    maxRefZoom: String(params.maxRefZoom),
  };
}

function paramsEqual(a: PoiSpriteSizeParams, b: PoiSpriteSizeParams): boolean {
  return POI_SPRITE_SIZE_PARAM_KEYS.every((key) => a[key] === b[key]);
}

export interface PoiSpriteSizeTunerHandle {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createPoiSpriteSizeTuner(
  container: HTMLElement,
  onApply: (params: PoiSpriteSizeParams) => void,
  ports: VisualizationTunerPorts,
): PoiSpriteSizeTunerHandle {
  const { document, settings } = ports; let disposed = false;
  const savedDefaultParams = loadSavedPoiSpriteSizeDefaults(settings);
  let defaultParams = savedDefaultParams ?? DEFAULT_POI_SPRITE_SIZE_PARAMS;
  let appliedParams = defaultParams;

  const panel = document.createElement("div");
  panel.className = "poi-sprite-tuner foss-earth-choices";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="poi-sprite-tuner-title foss-earth-choices__heading foss-earth-choices__heading--inline">Sprite size</div>
    <div class="poi-sprite-tuner-grid">
      <label class="poi-sprite-tuner-field">
        <span>Max size (m)</span>
        <input type="number" data-field="maxSize" value="${defaultParams.maxSize}">
      </label>
      <label class="poi-sprite-tuner-field">
        <span>Min size (m)</span>
        <input type="number" data-field="minSize" value="${defaultParams.minSize}">
      </label>
      <label class="poi-sprite-tuner-field">
        <span>Min zoom (m)</span>
        <input type="number" data-field="minRefZoom" value="${defaultParams.minRefZoom}">
      </label>
      <label class="poi-sprite-tuner-field">
        <span>Max zoom (m)</span>
        <input type="number" data-field="maxRefZoom" value="${defaultParams.maxRefZoom}">
      </label>
    </div>
  `;
  const actions = createTunerActions(ports, "Apply sprite size");
  panel.append(actions.element);
  container.appendChild(panel);

  const inputs = Array.from(panel.querySelectorAll<HTMLInputElement>("input[data-field]"));
  const applyBtn: HTMLButtonElement | null = actions.apply;
  const saveDefaultsBtn: HTMLButtonElement | null = actions.save;

  const committed = paramsToCommitted(appliedParams);

  function isDirty(): boolean {
    return inputs.some((input) => input.value !== committed[input.dataset.field as PoiSpriteSizeParamKey]);
  }

  function readInputParams(): PoiSpriteSizeParams | null {
    const vals: Partial<Record<PoiSpriteSizeParamKey, number>> = {};
    for (const input of inputs) {
      const key = input.dataset.field as PoiSpriteSizeParamKey | undefined;
      if (!key) return null;
      const value = Number(input.value);
      if (!Number.isFinite(value)) return null;
      vals[key] = value;
    }

    return normalizePoiSpriteSizeParams(vals);
  }

  function updateApplyVisibility(): void {
    const dirty = isDirty();
    if (applyBtn) applyBtn.hidden = !dirty;
    if (saveDefaultsBtn) saveDefaultsBtn.hidden = dirty || paramsEqual(appliedParams, defaultParams);
  }

  function onApplyClick(): void {
    if (disposed) return;
    const vals = readInputParams();
    if (!vals) return;

    appliedParams = vals;
    for (const input of inputs) {
      committed[input.dataset.field as PoiSpriteSizeParamKey] = input.value;
    }
    updateApplyVisibility();
    onApply(vals);
  }

  function onSaveDefaultsClick(): void {
    if (disposed || isDirty() || !savePoiSpriteSizeDefaults(settings, appliedParams)) return;
    defaultParams = appliedParams;
    updateApplyVisibility();
  }

  inputs.forEach((input) => input.addEventListener("input", updateApplyVisibility));
  applyBtn?.addEventListener("click", onApplyClick);
  saveDefaultsBtn?.addEventListener("click", onSaveDefaultsClick);
  if (savedDefaultParams) onApply(savedDefaultParams);

  return {
    show(): void { if (!disposed) panel.hidden = false; },
    hide(): void { if (!disposed) panel.hidden = true; },
    destroy(): void {
      if (disposed) return; disposed = true;
      inputs.forEach((input) => input.removeEventListener("input", updateApplyVisibility));
      applyBtn?.removeEventListener("click", onApplyClick);
      saveDefaultsBtn?.removeEventListener("click", onSaveDefaultsClick);
      panel.remove();
    },
  };
}
