export interface PoiSpriteSizeParams {
  maxSize: number;
  minSize: number;
  minRefZoom: number;
  maxRefZoom: number;
}

export const DEFAULT_POI_SPRITE_SIZE_PARAMS: PoiSpriteSizeParams = {
  maxSize: 40_000,
  minSize: 200,
  minRefZoom: 100,
  maxRefZoom: 1_000_000,
};

export interface PoiSpriteSizeTunerHandle {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createPoiSpriteSizeTuner(
  container: HTMLElement,
  onApply: (params: PoiSpriteSizeParams) => void,
): PoiSpriteSizeTunerHandle {
  const panel = document.createElement("div");
  panel.className = "poi-sprite-tuner";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="poi-sprite-tuner-title">Sprite Size</div>
    <div class="poi-sprite-tuner-grid">
      <label class="poi-sprite-tuner-field">
        <span>Max size (m)</span>
        <input type="number" data-field="maxSize" value="${DEFAULT_POI_SPRITE_SIZE_PARAMS.maxSize}">
      </label>
      <label class="poi-sprite-tuner-field">
        <span>Min size (m)</span>
        <input type="number" data-field="minSize" value="${DEFAULT_POI_SPRITE_SIZE_PARAMS.minSize}">
      </label>
      <label class="poi-sprite-tuner-field">
        <span>Min zoom (m)</span>
        <input type="number" data-field="minRefZoom" value="${DEFAULT_POI_SPRITE_SIZE_PARAMS.minRefZoom}">
      </label>
      <label class="poi-sprite-tuner-field">
        <span>Max zoom (m)</span>
        <input type="number" data-field="maxRefZoom" value="${DEFAULT_POI_SPRITE_SIZE_PARAMS.maxRefZoom}">
      </label>
    </div>
    <button class="poi-sprite-tuner-apply" type="button" hidden>Apply</button>
  `;
  container.appendChild(panel);

  const inputs = Array.from(panel.querySelectorAll<HTMLInputElement>("input[data-field]"));
  const applyBtn = panel.querySelector<HTMLButtonElement>(".poi-sprite-tuner-apply");

  const committed: Record<string, string> = {
    maxSize: String(DEFAULT_POI_SPRITE_SIZE_PARAMS.maxSize),
    minSize: String(DEFAULT_POI_SPRITE_SIZE_PARAMS.minSize),
    minRefZoom: String(DEFAULT_POI_SPRITE_SIZE_PARAMS.minRefZoom),
    maxRefZoom: String(DEFAULT_POI_SPRITE_SIZE_PARAMS.maxRefZoom),
  };

  function updateApplyVisibility(): void {
    if (!applyBtn) return;
    const dirty = inputs.some((input) => input.value !== committed[input.dataset.field ?? ""]);
    applyBtn.hidden = !dirty;
  }

  function onApplyClick(): void {
    const vals: Record<string, number> = {};
    for (const input of inputs) {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      vals[input.dataset.field ?? ""] = v;
    }
    for (const input of inputs) {
      committed[input.dataset.field ?? ""] = input.value;
    }
    updateApplyVisibility();
    onApply({
      maxSize: vals.maxSize,
      minSize: vals.minSize,
      minRefZoom: vals.minRefZoom,
      maxRefZoom: vals.maxRefZoom,
    });
  }

  inputs.forEach((input) => input.addEventListener("input", updateApplyVisibility));
  applyBtn?.addEventListener("click", onApplyClick);

  return {
    show(): void { panel.hidden = false; },
    hide(): void { panel.hidden = true; },
    destroy(): void {
      inputs.forEach((input) => input.removeEventListener("input", updateApplyVisibility));
      applyBtn?.removeEventListener("click", onApplyClick);
      panel.remove();
    },
  };
}
