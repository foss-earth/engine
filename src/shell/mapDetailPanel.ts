import {
  describeDetailValue,
  detailEnvelope,
  detailPosition,
  detailRange,
  detailValueAtPosition,
  editGoogleRange,
  editRasterRange,
  formatDetailValue,
  GOOGLE_DETAIL_STEP,
  RASTER_DETAIL_STEP,
  selectCustomDefault,
  selectGoogleRecommendation,
  selectRasterNormal,
  type DetailPolicy,
  type DetailState,
} from "../terrain/mapDetailPolicy";
import type { MapDetailController } from "./mapDetailController";
import { describeDetailStatus } from "./mapDetailSlider";

export interface MapDetailPanelHandle {
  element: HTMLElement;
  destroy(): void;
}

let panelCount = 0;

// The HUD rail's colours, finer to coarser: the same position is the same colour everywhere.
const DETAIL_COLOURS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [0x46, 0xdb, 0x8f]],
  [0.55, [0xf6, 0xd3, 0x65]],
  [1, [0xff, 0x6b, 0x6b]],
];

function detailColour(fraction: number): string {
  const t = Math.min(1, Math.max(0, fraction));
  let index = 1;
  while (index < DETAIL_COLOURS.length - 1 && t > DETAIL_COLOURS[index][0]) index += 1;
  const [t0, c0] = DETAIL_COLOURS[index - 1];
  const [t1, c1] = DETAIL_COLOURS[index];
  const u = (t - t0) / (t1 - t0);
  return `rgb(${c0.map((value, channel) => Math.round(value + (c1[channel] - value) * u)).join(", ")})`;
}

interface Readout {
  element: HTMLElement;
  output: HTMLOutputElement;
}

function createReadout(label: string, className: string): Readout {
  const element = document.createElement("span");
  element.className = `map-detail-panel__readout ${className}`;
  const text = document.createElement("span");
  text.textContent = label;
  const output = document.createElement("output");
  output.className = "map-detail-panel__value";
  element.append(text, output);
  return { element, output };
}

function createThumb(label: string, className: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "range";
  input.className = `map-detail-panel__thumb ${className}`;
  input.setAttribute("aria-label", label);
  return input;
}

function createChoice(name: string, value: string, label: string): { element: HTMLLabelElement; input: HTMLInputElement; text: HTMLSpanElement } {
  const element = document.createElement("label");
  element.className = "foss-earth-choice";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  const text = document.createElement("span");
  text.textContent = label;
  element.append(input, text);
  return { element, input, text };
}

/**
 * The Detail group of the Map tab: the saved range the HUD rail spans, its
 * default, and the actions that restore the saved detail or reset the source's
 * settings. It edits the active source's policy through the shared controller.
 */
export function createMapDetailPanel(controller: MapDetailController): MapDetailPanelHandle {
  const choiceName = `foss-earth-map-detail-default-${++panelCount}`;
  const element = document.createElement("div");
  element.className = "foss-earth-choices map-detail-panel";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Detail");
  const heading = document.createElement("div");
  heading.className = "foss-earth-choices__heading";
  heading.textContent = "Detail";
  const note = document.createElement("p");
  note.className = "foss-earth-choices__note map-detail-panel__note";
  // One track across every value the source allows. The two ends of the range
  // the HUD rail spans are its two thumbs; the saved default sits between them.
  const range = document.createElement("div");
  range.className = "map-detail-panel__range";
  range.setAttribute("role", "group");
  range.setAttribute("aria-label", "Detail range");
  const readouts = document.createElement("div");
  readouts.className = "map-detail-panel__readouts";
  const finerReadout = createReadout("Finest", "map-detail-panel__readout--finer");
  const defaultReadout = createReadout("Default", "map-detail-panel__readout--default");
  const coarserReadout = createReadout("Coarsest", "map-detail-panel__readout--coarser");
  readouts.append(finerReadout.element, defaultReadout.element, coarserReadout.element);
  const track = document.createElement("div");
  track.className = "map-detail-panel__track";
  const colours = document.createElement("span");
  colours.className = "map-detail-panel__colours";
  colours.setAttribute("aria-hidden", "true");
  const shadeFiner = document.createElement("span");
  shadeFiner.className = "map-detail-panel__shade map-detail-panel__shade--finer";
  shadeFiner.setAttribute("aria-hidden", "true");
  const shadeCoarser = document.createElement("span");
  shadeCoarser.className = "map-detail-panel__shade map-detail-panel__shade--coarser";
  shadeCoarser.setAttribute("aria-hidden", "true");
  const defaultTick = document.createElement("span");
  defaultTick.className = "map-detail-panel__default-tick";
  defaultTick.setAttribute("aria-hidden", "true");
  const finerThumb = createThumb("Finest end of the detail range", "map-detail-panel__thumb--end");
  const coarserThumb = createThumb("Coarsest end of the detail range", "map-detail-panel__thumb--end");
  const defaultThumb = createThumb("Saved default detail", "map-detail-panel__thumb--default");
  track.append(colours, shadeFiner, shadeCoarser, defaultTick, finerThumb, coarserThumb, defaultThumb);
  const scale = document.createElement("div");
  scale.className = "map-detail-panel__scale";
  scale.setAttribute("aria-hidden", "true");
  const scaleFiner = document.createElement("span");
  const scaleCoarser = document.createElement("span");
  scale.append(scaleFiner, scaleCoarser);
  range.append(readouts, track, scale);
  const defaultHeading = document.createElement("div");
  defaultHeading.className = "foss-earth-choices__heading map-detail-panel__subheading";
  defaultHeading.textContent = "Saved default";
  const recommended = createChoice(choiceName, "recommended", "Normal");
  const custom = createChoice(choiceName, "custom", "Custom");
  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "foss-earth-choice map-detail-panel__action";
  restore.textContent = "Restore saved detail";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "foss-earth-choice map-detail-panel__action";
  reset.textContent = "Reset detail settings";
  const status = document.createElement("p");
  status.className = "foss-earth-choices__note map-detail-panel__status";
  status.setAttribute("role", "status");
  const storage = document.createElement("p");
  storage.className = "foss-earth-choices__note map-detail-panel__storage";
  element.append(heading, note, range, defaultHeading, recommended.element, custom.element, restore, reset, status, storage);

  let shown: DetailState | null | undefined;
  let editing = false;
  let lastMoved: HTMLInputElement | null = null;

  // Where a thumb's centre sits, as a CSS length along the track.
  const along = (fraction: number): string => `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${fraction})`;

  const update = (): void => {
    const state = controller.getState();
    if (state === shown && !editing) return;
    shown = state;
    const ready = state?.availability === "ready";
    element.classList.toggle("is-unavailable", !ready);
    const controls = [finerThumb, coarserThumb, defaultThumb, recommended.input, custom.input, restore, reset];
    if (!state) {
      for (const control of controls) control.disabled = true;
      note.textContent = "This map has no detail setting.";
      for (const part of [range, defaultHeading, recommended.element, custom.element, restore, reset]) part.hidden = true;
      status.hidden = true;
      storage.hidden = true;
      return;
    }
    for (const part of [range, defaultHeading, recommended.element, custom.element, restore, reset]) part.hidden = false;
    const kind = state.policy.kind;
    const envelope = detailEnvelope(kind);
    const span = detailRange(state.policy);
    const step = String(kind === "raster" ? RASTER_DETAIL_STEP : GOOGLE_DETAIL_STEP);
    const min = detailPosition(kind, envelope.finer);
    const max = detailPosition(kind, envelope.coarser);
    const fraction = (value: number): number => (detailPosition(kind, value) - min) / (max - min);
    for (const thumb of [finerThumb, coarserThumb, defaultThumb]) {
      thumb.min = String(min);
      thumb.max = String(max);
      thumb.step = step;
    }
    if (!editing) {
      finerThumb.value = String(detailPosition(kind, span.finer));
      coarserThumb.value = String(detailPosition(kind, span.coarser));
      defaultThumb.value = String(detailPosition(kind, state.resolvedDefault));
    }
    const finerAt = fraction(span.finer);
    const coarserAt = fraction(span.coarser);
    const defaultAt = fraction(state.resolvedDefault);
    shadeFiner.style.right = `calc(100% - ${along(finerAt)})`;
    shadeCoarser.style.left = along(coarserAt);
    defaultTick.style.left = along(defaultAt);
    finerThumb.style.setProperty("--thumb-colour", detailColour(finerAt));
    coarserThumb.style.setProperty("--thumb-colour", detailColour(coarserAt));
    defaultThumb.style.setProperty("--thumb-colour", detailColour(defaultAt));
    // Stacked thumbs: at equal ends, keep on top the one that can still move.
    const equal = Math.abs(finerAt - coarserAt) < 1e-9;
    const finerOnTop = equal ? finerAt > 0.5 : lastMoved === finerThumb;
    finerThumb.style.zIndex = finerOnTop ? "3" : "2";
    coarserThumb.style.zIndex = finerOnTop ? "2" : "3";
    finerReadout.output.textContent = formatDetailValue(kind, span.finer);
    coarserReadout.output.textContent = formatDetailValue(kind, span.coarser);
    defaultReadout.output.textContent = formatDetailValue(kind, state.resolvedDefault);
    finerThumb.setAttribute("aria-valuetext", describeDetailValue(kind, span.finer));
    coarserThumb.setAttribute("aria-valuetext", describeDetailValue(kind, span.coarser));
    defaultThumb.setAttribute("aria-valuetext", describeDetailValue(kind, state.resolvedDefault));
    scaleFiner.textContent = `Finer · ${formatDetailValue(kind, envelope.finer)}`;
    scaleCoarser.textContent = `Coarser · ${formatDetailValue(kind, envelope.coarser)}`;

    const isRecommended = kind === "raster" ? state.policy.defaultValue === "normal" : typeof state.policy.defaultValue === "object";
    recommended.input.checked = isRecommended;
    custom.input.checked = !isRecommended;
    recommended.text.textContent = kind === "raster"
      ? "Normal"
      : `Recommended (${formatDetailValue(kind, state.resolvedDefault)}${state.defaultLimitedByRange ? ", limited by the range" : ""})`;
    // A Custom default is a third thumb on the same track; Normal or a
    // recommendation is only marked there.
    defaultThumb.hidden = isRecommended;
    defaultTick.classList.toggle("is-draggable", !isRecommended);

    for (const control of controls) control.disabled = !ready;
    restore.disabled = !ready || state.sessionOverride === null;
    defaultThumb.disabled = !ready || equal;

    note.textContent = !ready
      ? state.availability === "initializing"
        ? "Detail becomes adjustable once the map has started."
        : state.reason ?? (kind === "raster" ? "Detail for 2D basemaps is not available yet." : "Detail is not available for this map.")
      : kind === "raster"
        ? "Sharper or softer imagery than Normal, which shows each image pixel at about one screen pixel. Elevation is not affected."
        : "The screen-space error Google 3D Tiles may leave, in pixels. Smaller is finer and loads more.";
    const sentence = ready ? describeDetailStatus(state) : null;
    status.hidden = sentence === null;
    status.textContent = sentence ?? "";
    const storageError = controller.getStorageError();
    storage.hidden = storageError === null;
    storage.textContent = storageError ?? "";
  };

  const withPolicy = (edit: (policy: DetailPolicy) => DetailPolicy): void => {
    const state = controller.getState();
    if (!state || state.availability !== "ready") return;
    controller.updatePolicy(edit(state.policy));
  };

  const onRangeInput = (event: Event): void => {
    const state = controller.getState();
    if (!state) return;
    const kind = state.policy.kind;
    const thumb = event.target as HTMLInputElement;
    lastMoved = thumb;
    // A thumb stops at the other end rather than passing it.
    let position = Number(thumb.value);
    if (thumb === finerThumb) position = Math.min(position, Number(coarserThumb.value));
    else position = Math.max(position, Number(finerThumb.value));
    thumb.value = String(position);
    const value = detailValueAtPosition(kind, position);
    const end = thumb === finerThumb ? "finer" : "coarser";
    withPolicy(policy => policy.kind === "raster"
      ? editRasterRange(policy, end === "finer" ? { fineOffset: value } : { coarseOffset: value })
      : editGoogleRange(policy, end === "finer" ? { finestErrorPx: value } : { coarsestErrorPx: value }));
  };
  const onDefaultChoice = (): void => {
    withPolicy(policy => {
      if (recommended.input.checked) {
        if (policy.kind === "raster") return selectRasterNormal(policy);
        const previous = typeof policy.defaultValue === "object" ? policy.defaultValue.policy : controller.getGoogleRecommendation();
        return selectGoogleRecommendation(policy, previous);
      }
      return selectCustomDefault(policy, controller.getState()?.resolvedDefault ?? 0);
    });
  };
  const onCustomInput = (): void => {
    const state = controller.getState();
    if (!state) return;
    const position = Math.min(Number(coarserThumb.value), Math.max(Number(finerThumb.value), Number(defaultThumb.value)));
    defaultThumb.value = String(position);
    const value = detailValueAtPosition(state.policy.kind, position);
    withPolicy(policy => selectCustomDefault(policy, value));
  };
  const beginEdit = (): void => { editing = true; };
  const endEdit = (): void => {
    editing = false;
    shown = undefined;
    update();
  };
  const onRestore = (): void => controller.clearSessionOverride();
  const onReset = (): void => controller.resetPolicy();

  for (const input of [finerThumb, coarserThumb]) input.addEventListener("input", onRangeInput);
  defaultThumb.addEventListener("input", onCustomInput);
  for (const input of [finerThumb, coarserThumb, defaultThumb]) {
    input.addEventListener("pointerdown", beginEdit);
    input.addEventListener("pointerup", endEdit);
    input.addEventListener("pointercancel", endEdit);
  }
  recommended.input.addEventListener("change", onDefaultChoice);
  custom.input.addEventListener("change", onDefaultChoice);
  restore.addEventListener("click", onRestore);
  reset.addEventListener("click", onReset);
  const unsubscribe = controller.subscribe(() => update());
  update();

  return {
    element,
    destroy(): void {
      unsubscribe();
      for (const input of [finerThumb, coarserThumb]) input.removeEventListener("input", onRangeInput);
      defaultThumb.removeEventListener("input", onCustomInput);
      recommended.input.removeEventListener("change", onDefaultChoice);
      custom.input.removeEventListener("change", onDefaultChoice);
      restore.removeEventListener("click", onRestore);
      reset.removeEventListener("click", onReset);
      element.remove();
    },
  };
}
