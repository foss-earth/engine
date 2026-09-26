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
import { createTrack, type TrackThumb } from "./settings/track";

export interface MapDetailPanelHandle {
  element: HTMLElement;
  destroy(): void;
}

export interface MapDetailPanelOptions {
  /** Draws the "Detail" heading; leave it out inside a section that has the title. Defaults to true. */
  heading?: boolean;
}

let panelCount = 0;

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

const FINER = "finer";
const COARSER = "coarser";
const DEFAULT = "default";
const MARKER_PREFIX = "marker:";

/**
 * The Detail group of the Map tab: the saved range the HUD rail spans, its
 * default, hosts' markers such as a flight's minimum, and the actions that
 * restore the saved detail or reset the source's settings. It edits the active
 * source's policy through the shared controller.
 */
export function createMapDetailPanel(controller: MapDetailController, options: MapDetailPanelOptions = {}): MapDetailPanelHandle {
  const choiceName = `foss-earth-map-detail-default-${++panelCount}`;
  const element = document.createElement("div");
  element.className = "foss-earth-choices map-detail-panel";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Detail");
  const heading = document.createElement("div");
  heading.className = "foss-earth-choices__heading";
  heading.textContent = "Detail";
  heading.hidden = options.heading === false;
  const note = document.createElement("p");
  note.className = "foss-earth-choices__note map-detail-panel__note";
  // One track across every value the source allows. The two ends of the range
  // the HUD rail spans are its two thumbs; the saved default and hosts'
  // markers sit on it too.
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
  let editing = false;
  const track = createTrack({
    ariaLabel: "Detail range",
    ramp: "detail",
    className: "map-detail-panel__track",
    onInput: (id, position) => onTrackInput(id, position),
    onCommit: () => endEdit(),
  });
  const scale = document.createElement("div");
  scale.className = "map-detail-panel__scale";
  scale.setAttribute("aria-hidden", "true");
  const scaleFiner = document.createElement("span");
  const scaleCoarser = document.createElement("span");
  scale.append(scaleFiner, scaleCoarser);
  const markerNotes = document.createElement("div");
  markerNotes.className = "map-detail-panel__markers";
  range.append(readouts, track.element, scale, markerNotes);
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
  // The positions the thumbs showed last, so a thumb stops at the other end.
  let positions = { finer: 0, coarser: 0 };

  const update = (): void => {
    const state = controller.getState();
    if (state === shown && !editing) return;
    shown = state;
    const ready = state?.availability === "ready";
    element.classList.toggle("is-unavailable", !ready);
    const pills = [recommended.input, custom.input, restore, reset];
    if (!state) {
      for (const control of pills) control.disabled = true;
      track.render({ min: 0, max: 1, step: 1, thumbs: [], disabled: true });
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
    const step = kind === "raster" ? RASTER_DETAIL_STEP : GOOGLE_DETAIL_STEP;
    const min = detailPosition(kind, envelope.finer);
    const max = detailPosition(kind, envelope.coarser);
    positions = { finer: detailPosition(kind, span.finer), coarser: detailPosition(kind, span.coarser) };
    const defaultAt = detailPosition(kind, state.resolvedDefault);
    const isRecommended = kind === "raster" ? state.policy.defaultValue === "normal" : typeof state.policy.defaultValue === "object";
    const equal = Math.abs(positions.finer - positions.coarser) < 1e-9;
    // A requirement finer than the range's coarse end stripes what it refuses.
    const requirement = state.markers.find(marker => marker.requirement && !marker.hollow);
    const requirementAt = requirement ? detailPosition(kind, requirement.value) : null;
    const thumbs: TrackThumb[] = [
      { id: FINER, role: "end", position: positions.finer, ariaLabel: "Finest end of the detail range", ariaValueText: describeDetailValue(kind, span.finer) },
      { id: COARSER, role: "end", position: positions.coarser, ariaLabel: "Coarsest end of the detail range", ariaValueText: describeDetailValue(kind, span.coarser) },
      // A Custom default is a third thumb on the same track; Normal or a
      // recommendation is only marked there.
      { id: DEFAULT, role: "default", position: defaultAt, ariaLabel: "Saved default detail", ariaValueText: describeDetailValue(kind, state.resolvedDefault), hidden: isRecommended, disabled: !ready || equal },
      ...state.markers.map((marker): TrackThumb => ({
        id: `${MARKER_PREFIX}${marker.id}`,
        role: "marker",
        position: detailPosition(kind, marker.value),
        ariaLabel: marker.ariaLabel,
        ariaValueText: formatDetailValue(kind, marker.value),
        colour: marker.colour,
        hollow: marker.hollow,
        fixed: !marker.draggable,
        label: marker.label,
      })),
    ];
    track.render({
      min,
      max,
      step,
      thumbs,
      range: { low: positions.finer, high: positions.coarser },
      tick: defaultAt,
      stripe: requirementAt !== null && requirementAt < positions.coarser
        ? { low: Math.max(requirementAt, positions.finer), high: positions.coarser }
        : null,
      disabled: !ready,
    });
    finerReadout.output.textContent = formatDetailValue(kind, span.finer);
    coarserReadout.output.textContent = formatDetailValue(kind, span.coarser);
    defaultReadout.output.textContent = formatDetailValue(kind, state.resolvedDefault);
    scaleFiner.textContent = `Finer · ${formatDetailValue(kind, envelope.finer)}`;
    scaleCoarser.textContent = `Coarser · ${formatDetailValue(kind, envelope.coarser)}`;
    markerNotes.replaceChildren(...state.markers.map(marker => {
      const line = document.createElement("span");
      line.className = "map-detail-panel__marker-note";
      line.style.setProperty("--marker-colour", marker.colour);
      line.classList.toggle("is-hollow", Boolean(marker.hollow));
      line.textContent = `${marker.label}: ${formatDetailValue(kind, marker.value)}${marker.hollow ? " (waived)" : ""}`;
      return line;
    }));
    markerNotes.hidden = state.markers.length === 0;

    recommended.input.checked = isRecommended;
    custom.input.checked = !isRecommended;
    recommended.text.textContent = kind === "raster"
      ? "Normal"
      : `Recommended (${formatDetailValue(kind, state.resolvedDefault)}${state.defaultLimitedByRange ? ", limited by the range" : ""})`;

    for (const control of pills) control.disabled = !ready;
    restore.disabled = !ready || state.sessionOverride === null;

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

  function onTrackInput(id: string, rawPosition: number): void {
    const state = controller.getState();
    if (!state) return;
    editing = true;
    const kind = state.policy.kind;
    if (id.startsWith(MARKER_PREFIX)) {
      // A requirement is not clamped into the range: it is not a preference.
      const marker = state.markers.find(item => `${MARKER_PREFIX}${item.id}` === id);
      marker?.onChange?.(detailValueAtPosition(kind, rawPosition));
      return;
    }
    if (id === DEFAULT) {
      const position = Math.min(positions.coarser, Math.max(positions.finer, rawPosition));
      const value = detailValueAtPosition(kind, position);
      withPolicy(policy => selectCustomDefault(policy, value));
      return;
    }
    // A thumb stops at the other end rather than passing it.
    const position = id === FINER ? Math.min(rawPosition, positions.coarser) : Math.max(rawPosition, positions.finer);
    const value = detailValueAtPosition(kind, position);
    withPolicy(policy => policy.kind === "raster"
      ? editRasterRange(policy, id === FINER ? { fineOffset: value } : { coarseOffset: value })
      : editGoogleRange(policy, id === FINER ? { finestErrorPx: value } : { coarsestErrorPx: value }));
  }
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
  function endEdit(): void {
    editing = false;
    shown = undefined;
    update();
  }
  const onRestore = (): void => controller.clearSessionOverride();
  const onReset = (): void => controller.resetPolicy();

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
      track.destroy();
      recommended.input.removeEventListener("change", onDefaultChoice);
      custom.input.removeEventListener("change", onDefaultChoice);
      restore.removeEventListener("click", onRestore);
      reset.removeEventListener("click", onReset);
      element.remove();
    },
  };
}
