/**
 * The Select area tab: which area, its corners, and how high it extends.
 * Clicking the map adds a corner while Add corner is pressed; a drag still
 * moves the camera. Typing a latitude and longitude adds one too.
 */
import type { createHelpTooltip, createIconButton } from "@foss-earth/ui/browser";
import type { GlobeNavigationAnchors } from "../input/navigationAnchors.js";
import { EARTH_AREA_MAX_HEIGHT_METERS, earthAreaHeight, earthAreaPoint, earthAreaStatusMessage, formatEarthAreaPoint } from "./earthArea.js";
import type { EarthAreaStore } from "./earthAreaStore.js";

export interface EarthAreaPanelOptions {
  document: Document;
  store: EarthAreaStore;
  /** While Pick point is armed, corner placement steps aside, and the other way around. */
  anchors?: Pick<GlobeNavigationAnchors, "cancelPick" | "subscribe" | "status"> | null;
  createIconButton: typeof createIconButton;
  createHelpTooltip: typeof createHelpTooltip;
}

export interface EarthAreaPanelHandle {
  element: HTMLElement;
  destroy(): void;
}

function field(document: Document, label: string, chars: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.className = "foss-earth-parameter__field";
  input.style.setProperty("--field-chars", chars);
  input.setAttribute("aria-label", label);
  return input;
}

function group(document: Document, label: string, titled = true): { box: HTMLElement; row: HTMLElement } {
  const box = document.createElement("div");
  box.className = "foss-earth-parameter--inline";
  const row = document.createElement("div");
  row.className = "foss-earth-parameter__header foss-earth-choices";
  if (titled) {
    const title = document.createElement("div");
    title.className = "foss-earth-choices__heading foss-earth-choices__heading--inline";
    title.textContent = label;
    row.append(title);
  }
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", label);
  box.append(row);
  return { box, row };
}

/**
 * The contents of the Select area tab. One area is being edited. Its corners
 * are an ordered list of latitude and longitude, and its height, if any, is
 * how high the whole area extends above the ground.
 */
export function createEarthAreaPanel(options: EarthAreaPanelOptions): EarthAreaPanelHandle {
  const { document, store } = options;
  const element = document.createElement("div");
  element.className = "foss-earth-earth-area";

  const areas = group(document, "Area");
  areas.row.setAttribute("role", "radiogroup");
  const pills = document.createElement("span");
  pills.className = "foss-earth-parameter__pills";
  const create = options.createIconButton(document, { icon: "plus", label: "New area" });
  const removeArea = options.createIconButton(document, { icon: "trash", label: "Delete area" });
  areas.row.append(pills, create, removeArea);

  const corners = group(document, "Corners");
  const addCorner = options.createIconButton(document, { icon: "crosshair", label: "Add corner" });
  addCorner.setAttribute("aria-pressed", "false");
  const undo = options.createIconButton(document, { icon: "undo", label: "Undo corner" });
  const clear = options.createIconButton(document, { icon: "reset", label: "Clear corners" });
  const status = document.createElement("p");
  status.className = "foss-earth-choices__note";
  status.setAttribute("role", "status");
  const list = document.createElement("ol");
  list.className = "foss-earth-earth-area__corners";
  corners.row.append(addCorner, undo, clear, status, list);

  const typed = group(document, "Add a corner by latitude and longitude", false);
  const lat = field(document, "Latitude", "9");
  const lon = field(document, "Longitude", "10");
  const addTyped = options.createIconButton(document, { icon: "plus", label: "Add this latitude and longitude" });
  const latLabel = document.createElement("span");
  latLabel.textContent = "Lat";
  const lonLabel = document.createElement("span");
  lonLabel.textContent = "Lon";
  typed.row.append(latLabel, lat, lonLabel, lon, addTyped);

  const heightGroup = group(document, "Height");
  const height = field(document, "Height in metres", "6");
  const unit = document.createElement("span");
  unit.textContent = "m";
  const helpText = document.createElement("p");
  helpText.textContent = "How high this area extends above the ground, in metres. Leave it empty to keep the area on the ground. The most it can extend is 100 km.";
  const helpContent = document.createElement("div");
  helpContent.append(helpText);
  const help = options.createHelpTooltip({ label: "Explain height", content: helpContent });
  heightGroup.row.append(height, unit, help.element);

  element.append(areas.box, corners.box, typed.box, heightGroup.box);
  addCorner.dataset.earthArea = "add-corner";
  undo.dataset.earthArea = "undo";
  clear.dataset.earthArea = "clear";
  create.dataset.earthArea = "new";
  removeArea.dataset.earthArea = "delete";
  lat.dataset.earthArea = "lat";
  lon.dataset.earthArea = "lon";
  addTyped.dataset.earthArea = "add-typed";
  height.dataset.earthArea = "height";
  status.dataset.earthArea = "status";
  list.dataset.earthArea = "corners";

  let problem: string | null = null;
  let cornerKey = "";
  let areaCount = -1;

  const render = (): void => {
    const snap = store.snapshot();
    const area = snap.areas[snap.active];
    const points = area?.points ?? [];
    if (areaCount !== snap.areas.length) {
      areaCount = snap.areas.length;
      pills.replaceChildren();
      snap.areas.forEach((_, index) => {
        const label = document.createElement("label");
        label.className = "foss-earth-choice";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "foss-earth-earth-area";
        input.value = String(index);
        input.setAttribute("aria-label", `Area ${index + 1}`);
        input.addEventListener("change", () => { if (input.checked) store.select(index); });
        const text = document.createElement("span");
        text.textContent = String(index + 1);
        label.append(input, text);
        pills.append(label);
      });
    }
    const selected = pills.querySelectorAll("input")[snap.active] as HTMLInputElement | undefined;
    if (selected && !selected.checked) selected.checked = true;
    const blocked = options.anchors?.status().pinningBlocked ?? null;
    addCorner.disabled = blocked !== null;
    addCorner.title = blocked ?? "Add corner";
    addCorner.setAttribute("aria-pressed", String(snap.placing));
    undo.disabled = points.length === 0;
    clear.disabled = points.length === 0;
    removeArea.disabled = snap.areas.length === 1 && points.length === 0 && area?.heightMeters === undefined;
    const key = points.map(point => `${point.latDeg},${point.lonDeg}`).join(";");
    if (key !== cornerKey) {
      cornerKey = key;
      list.replaceChildren();
      points.forEach((point, index) => {
        const item = document.createElement("li");
        item.className = "foss-earth-earth-area__corner";
        const text = document.createElement("span");
        text.textContent = `${index + 1}  ${formatEarthAreaPoint(point)}`;
        const remove = options.createIconButton(document, { icon: "close", label: `Remove corner ${index + 1}` });
        remove.addEventListener("click", () => store.removePoint(index));
        item.append(text, remove);
        list.append(item);
      });
    }
    if (document.activeElement !== height) height.value = area?.heightMeters === undefined ? "" : String(area.heightMeters);
    const message = problem ?? earthAreaStatusMessage(area, snap.placing, snap.missed);
    if (status.textContent !== message) status.textContent = message;
  };

  create.addEventListener("click", () => store.addArea());
  removeArea.addEventListener("click", () => store.deleteActive());
  undo.addEventListener("click", () => store.undoPoint());
  clear.addEventListener("click", () => store.clearPoints());
  addCorner.addEventListener("click", () => {
    if (store.snapshot().placing) store.cancelPlacement();
    else { options.anchors?.cancelPick(); store.togglePlacement(); }
  });
  const commitTyped = (): void => {
    const point = earthAreaPoint(Number(lat.value), Number(lon.value));
    if (!point) {
      problem = "A corner needs a latitude from -90 to 90 and a longitude from -180 to 180.";
      render();
      return;
    }
    const before = store.snapshot().areas[store.snapshot().active]?.points.length ?? 0;
    problem = null;
    store.addPoint(point);
    if ((store.snapshot().areas[store.snapshot().active]?.points.length ?? 0) === before) problem = "This area has as many corners as it can.";
    else { lat.value = ""; lon.value = ""; }
    render();
  };
  addTyped.addEventListener("click", commitTyped);
  const onTypedKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitTyped();
  };
  lat.addEventListener("keydown", onTypedKey);
  lon.addEventListener("keydown", onTypedKey);
  const commitHeight = (): void => {
    const next = earthAreaHeight(height.value);
    if (next === null) {
      problem = `Height is a number of metres, up to ${EARTH_AREA_MAX_HEIGHT_METERS / 1000} km.`;
      render();
      help.open();
      return;
    }
    problem = null;
    if (next === undefined) height.value = "";
    store.setHeight(next);
    render();
  };
  height.addEventListener("change", commitHeight);
  height.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitHeight();
  });

  const stopStore = store.subscribe(() => { problem = null; render(); });
  const stopAnchors = options.anchors?.subscribe(() => {
    if (options.anchors?.status().selection !== "off") store.cancelPlacement();
    render();
  }) ?? (() => {});
  render();

  return {
    element,
    destroy() {
      stopStore();
      stopAnchors();
      help.destroy();
      if (store.snapshot().placing) store.cancelPlacement();
    },
  };
}
