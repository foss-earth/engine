import { createTunerActions, type VisualizationTunerPorts, type VisualizationTunerSettings } from "./tunerPorts.js";
import { COMPASS_SCALE_SETTING_IDS, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS, orbitCompassScaleFromSettings } from "../visualization/defaults.js";
import type { OrbitCompassScaleParams } from "../visualization/defaults.js";

const RADIUS_BOUNDS = { min: 1, max: 10_000_000 };
const DISTANCE_BOUNDS = { min: 1, max: 100_000_000 };

function rangeOf(params: OrbitCompassScaleParams, kind: "radius" | "distance"): { min: number; max: number } {
  if (kind === "radius") return { min: params.minRadius, max: params.maxRadius };
  return { min: params.minDistance ?? params.minRadius / params.radiusScale, max: params.maxDistance ?? params.maxRadius / params.radiusScale };
}

/** The compass size parameters, or null while every one is at its default. */
export function loadSavedCompassScaleDefaults(settings: VisualizationTunerSettings): OrbitCompassScaleParams | null {
  if (COMPASS_SCALE_SETTING_IDS.every(id => settings.inspect(id).provenance === "default")) return null;
  return orbitCompassScaleFromSettings(id => settings.get(id));
}

export function saveCompassScaleDefaults(settings: VisualizationTunerSettings, params: OrbitCompassScaleParams): boolean {
  const radius = rangeOf(params, "radius");
  const distance = rangeOf(params, "distance");
  return settings.setMany({
    "visualization.compass.radius": radius,
    "visualization.compass.distance": distance,
    "visualization.compass.labelSizeScale": params.labelSizeScale,
  }).ok;
}

function paramsEqual(a: OrbitCompassScaleParams, b: OrbitCompassScaleParams): boolean {
  const keys = ["radiusScale", "minRadius", "maxRadius", "minDistance", "maxDistance", "labelSizeScale"] as const;
  return keys.every(key => a[key] === b[key]);
}

export interface CompassScaleTunerHandle {
  show(): void;
  hide(): void;
  destroy(): void;
}

interface RangeSpec {
  kind: "radius" | "distance";
  label: string;
  bounds: { min: number; max: number };
}

const RANGES: readonly RangeSpec[] = [
  { kind: "radius", label: "Radius (m)", bounds: RADIUS_BOUNDS },
  { kind: "distance", label: "Distance (m)", bounds: DISTANCE_BOUNDS },
];

function thumb(kind: string, end: "min" | "max", value: number, bounds: { min: number; max: number }): string {
  return `<input type="range" data-range="${kind}" data-end="${end}" min="${bounds.min}" max="${bounds.max}" step="1" value="${value}" aria-label="${kind} ${end}">`;
}

export function createCompassScaleTuner(
  container: HTMLElement,
  onApply: (params: OrbitCompassScaleParams) => void,
  ports: VisualizationTunerPorts,
): CompassScaleTunerHandle {
  const { document, settings } = ports; let disposed = false;
  const savedDefaultParams = loadSavedCompassScaleDefaults(settings);
  let defaultParams = savedDefaultParams ?? DEFAULT_ORBIT_COMPASS_SCALE_PARAMS;
  let appliedParams = defaultParams;

  const panel = document.createElement("div");
  panel.className = "poi-sprite-tuner compass-scale-tuner foss-earth-choices";
  panel.hidden = true;
  const radius = rangeOf(defaultParams, "radius");
  const distance = rangeOf(defaultParams, "distance");
  panel.innerHTML = `
    <div class="poi-sprite-tuner-title foss-earth-choices__heading foss-earth-choices__heading--inline">Compass scale</div>
    <div class="poi-sprite-tuner-grid">
      ${RANGES.map(spec => {
        const value = spec.kind === "radius" ? radius : distance;
        return `<label class="poi-sprite-tuner-field compass-scale-field">
          <span>${spec.label}</span>
          <span class="compass-scale-range">
            ${thumb(spec.kind, "min", value.min, spec.bounds)}
            ${thumb(spec.kind, "max", value.max, spec.bounds)}
          </span>
        </label>`;
      }).join("")}
      <label class="poi-sprite-tuner-field">
        <span>Label size</span>
        <input type="number" data-field="labelSizeScale" step="0.01" value="${defaultParams.labelSizeScale}">
      </label>
    </div>
  `;
  const actions = createTunerActions(ports, "Apply compass scale");
  panel.append(actions.element);
  container.appendChild(panel);

  const thumbs = Array.from(panel.querySelectorAll<HTMLInputElement>("input[data-range]"));
  const labelInput = panel.querySelector<HTMLInputElement>('input[data-field="labelSizeScale"]');
  const applyBtn: HTMLButtonElement | null = actions.apply;
  const saveDefaultsBtn: HTMLButtonElement | null = actions.save;
  const committed = {
    radius: { ...radius },
    distance: { ...distance },
    labelSizeScale: String(appliedParams.labelSizeScale),
  };

  function thumbValue(kind: "radius" | "distance", end: "min" | "max"): number {
    const input = thumbs.find(candidate => candidate.dataset.range === kind && candidate.dataset.end === end);
    return Number(input?.value);
  }

  function isDirty(): boolean {
    const labelDirty = labelInput !== null && labelInput.value !== committed.labelSizeScale;
    const rangeDirty = RANGES.some(spec => thumbValue(spec.kind, "min") !== committed[spec.kind].min || thumbValue(spec.kind, "max") !== committed[spec.kind].max);
    return labelDirty || rangeDirty;
  }

  function readInputParams(): OrbitCompassScaleParams | null {
    const nextRadius = { min: thumbValue("radius", "min"), max: thumbValue("radius", "max") };
    const nextDistance = { min: thumbValue("distance", "min"), max: thumbValue("distance", "max") };
    const labelSizeScale = Number(labelInput?.value);
    if (![nextRadius.min, nextRadius.max, nextDistance.min, nextDistance.max, labelSizeScale].every(Number.isFinite)) return null;
    if (nextRadius.min <= 0 || nextRadius.max < nextRadius.min || nextDistance.min <= 0 || nextDistance.max < nextDistance.min || labelSizeScale <= 0) return null;
    return {
      radiusScale: nextRadius.min / nextDistance.min,
      minRadius: nextRadius.min,
      maxRadius: nextRadius.max,
      minDistance: nextDistance.min,
      maxDistance: nextDistance.max,
      labelSizeScale,
    };
  }

  function updateApplyVisibility(): void {
    const dirty = isDirty();
    if (applyBtn) applyBtn.hidden = !dirty;
    if (saveDefaultsBtn) saveDefaultsBtn.hidden = dirty || paramsEqual(appliedParams, defaultParams);
  }

  function keepEndsApart(input: HTMLInputElement): void {
    const kind = input.dataset.range as "radius" | "distance" | undefined;
    const end = input.dataset.end as "min" | "max" | undefined;
    if (!kind || !end) return;
    const other = thumbs.find(candidate => candidate.dataset.range === kind && candidate.dataset.end !== end);
    if (!other) return;
    const value = Number(input.value);
    const limit = Number(other.value);
    if (!Number.isFinite(value) || !Number.isFinite(limit)) return;
    if (end === "min" && value > limit) input.value = other.value;
    if (end === "max" && value < limit) input.value = other.value;
  }

  function onThumbInput(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) keepEndsApart(input);
    updateApplyVisibility();
  }

  function onApplyClick(): void {
    if (disposed) return;
    const vals = readInputParams();
    if (!vals) return;
    appliedParams = vals;
    committed.radius = rangeOf(vals, "radius");
    committed.distance = rangeOf(vals, "distance");
    committed.labelSizeScale = labelInput?.value ?? committed.labelSizeScale;
    updateApplyVisibility();
    onApply(vals);
  }

  function onSaveDefaultsClick(): void {
    if (disposed || isDirty() || !saveCompassScaleDefaults(settings, appliedParams)) return;
    defaultParams = appliedParams;
    updateApplyVisibility();
  }

  thumbs.forEach(input => input.addEventListener("input", onThumbInput));
  labelInput?.addEventListener("input", updateApplyVisibility);
  applyBtn?.addEventListener("click", onApplyClick);
  saveDefaultsBtn?.addEventListener("click", onSaveDefaultsClick);
  if (savedDefaultParams) onApply(savedDefaultParams);

  return {
    show(): void { if (!disposed) panel.hidden = false; },
    hide(): void { if (!disposed) panel.hidden = true; },
    destroy(): void {
      if (disposed) return; disposed = true;
      thumbs.forEach(input => input.removeEventListener("input", onThumbInput));
      labelInput?.removeEventListener("input", updateApplyVisibility);
      applyBtn?.removeEventListener("click", onApplyClick);
      saveDefaultsBtn?.removeEventListener("click", onSaveDefaultsClick);
      panel.remove();
    },
  };
}
