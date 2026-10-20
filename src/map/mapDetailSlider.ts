import {
  describeDetailValue,
  detailPosition,
  detailRange,
  detailValueAtPosition,
  formatDetailValue,
  GOOGLE_DETAIL_STEP,
  RASTER_DETAIL_STEP,
  type DetailLimit,
  type DetailState,
  type DetailTrackMarker,
} from "../terrain/mapDetailPolicy.js";
import { describeLoadedTiles, layoutDetailDistribution, type DetailBinLayout } from "../terrain/detailDistribution.js";
import { MAP_DETAIL_LOADED_PRESENTATION_ID } from "../settings/catalogue/map.js";
import type { MapDetailController } from "./mapDetailController.js";
import { CONSTRAINT_LIMIT, describeImageryConstraint } from "./mapDetailExplanations.js";

export interface MapDetailSliderOptions {
  document: Document;
  /** The app's detail controller; the Map tab's editor observes the same one. */
  controller: MapDetailController;
  /** What the host calls its detail setting, for the rail's label. Defaults to "Map detail". */
  name?: string;
}

export interface MapDetailSliderHandle {
  element: HTMLElement;
  /** Re-reads the controller. Cheap; unchanged state touches nothing. */
  update(): void;
  destroy(): void;
}

const LIMIT_TEXT: Record<DetailLimit, string> = {
  consumer: "held finer by the app",
  source: "limited by the map source",
  backend: "limited by this renderer",
  memory: "limited by the memory budget",
  loading: "still loading",
  "frame-time": "coarsened to hold the frame time",
};

/**
 * What limits the request, or null when nothing does: a sentence for each
 * limit the renderer explained with its values, and the general wording for
 * the rest, such as loading.
 */
export function describeDetailStatus(state: DetailState): string | null {
  const explained = new Set(state.constraints.map(constraint => CONSTRAINT_LIMIT[constraint.cause]));
  const parts = state.limits.filter(limit => limit === "loading" || !explained.has(limit)).map(limit => LIMIT_TEXT[limit]);
  if (state.pending && !state.limits.includes("loading")) parts.unshift("loading");
  const sentences = state.constraints.map(constraint => describeImageryConstraint(constraint));
  if (parts.length > 0) {
    const text = parts.join(", ");
    sentences.unshift(text.charAt(0).toUpperCase() + text.slice(1) + ".");
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}

function rangePercent(position: number, finer: number, coarser: number): number {
  if (Math.abs(coarser - finer) < 1e-9) return 50;
  return Math.max(0, Math.min(100, ((position - finer) / (coarser - finer)) * 100));
}

/**
 * A small rail beside the map's credit that sets a temporary detail target for
 * this session: finer to the left, coarser to the right. Both ends are
 * ordinary values; "Restore saved detail" in the Map tab returns to the saved
 * default. A tick marks that default. Tile distribution draws the detail actually
 * on screen; the I-beam is the previous marker, chosen with
 * "Loaded detail on the rail". Either one stays visible when it meets the thumb.
 * Distribution mode draws the handle as a white ring with an empty centre.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
let distributionSerial = 0;

function loadedPresentation(controller: MapDetailController): "distribution" | "marker" {
  if (!controller.settings.spec(MAP_DETAIL_LOADED_PRESENTATION_ID)) return "distribution";
  return controller.settings.get(MAP_DETAIL_LOADED_PRESENTATION_ID) === "marker" ? "marker" : "distribution";
}

// The rail updates as tiles load. Chrome lays the page out again for a range's
// min, max or step, and restyles it for `hidden = true`, even when the element
// holds the value already, so these writes are skipped when they change nothing.
function setAttr(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) element.hidden = hidden;
}
export function createMapDetailSlider(options: MapDetailSliderOptions): MapDetailSliderHandle {
  const { controller, document } = options;
  const name = options.name ?? "Map detail";
  const element = document.createElement("span");
  element.className = "map-detail-control";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", name);
  const rail = document.createElement("span");
  rail.className = "map-detail-control__rail";
  const validRange = document.createElement("span");
  validRange.className = "map-detail-control__valid-range";
  validRange.setAttribute("aria-hidden", "true");
  const defaultTick = document.createElement("span");
  defaultTick.className = "map-detail-control__default-tick";
  defaultTick.setAttribute("aria-hidden", "true");
  const loadedMarker = document.createElement("span");
  loadedMarker.className = "map-detail-control__loaded-marker";
  loadedMarker.setAttribute("aria-hidden", "true");
  const distribution = document.createElementNS(SVG_NS, "svg");
  distribution.classList.add("map-detail-control__distribution");
  distribution.setAttribute("aria-hidden", "true");
  distribution.setAttribute("pointer-events", "none");
  const gradientId = `map-detail-distribution-${++distributionSerial}`;
  const defs = document.createElementNS(SVG_NS, "defs");
  const gradient = document.createElementNS(SVG_NS, "linearGradient");
  gradient.id = gradientId;
  gradient.setAttribute("gradientUnits", "userSpaceOnUse");
  gradient.setAttribute("x1", "0");
  gradient.setAttribute("y1", "0");
  gradient.setAttribute("x2", "41");
  gradient.setAttribute("y2", "0");
  for (const [offset, color] of [["0%", "#46db8f"], ["55%", "#f6d365"], ["100%", "#ff6b6b"]] as const) {
    const stop = document.createElementNS(SVG_NS, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", color);
    gradient.append(stop);
  }
  defs.append(gradient);
  distribution.append(defs);
  const slider = document.createElement("input");
  slider.className = "map-detail-control__slider";
  slider.type = "range";
  slider.setAttribute("aria-label", `${name} for this session`);
  const markerTicks = document.createElement("span");
  markerTicks.className = "map-detail-control__markers";
  markerTicks.setAttribute("aria-hidden", "true");
  rail.append(validRange, distribution, defaultTick, loadedMarker, markerTicks, slider);
  element.append(rail);

  let shown: DetailState | null | undefined;
  let markerLayout = "";
  let shownMarkers: readonly DetailTrackMarker[] = [];
  let dragging = false;
  let painted = "";
  const barNodes: SVGRectElement[] = [];
  let resizeFrame = 0;
  const railWidth = (): number => {
    const width = rail.getBoundingClientRect().width;
    return width > 0 ? width : 41;
  };
  const paintDistribution = (presentation: "distribution" | "marker", layout: DetailBinLayout | null, width: number): void => {
    if (presentation !== "distribution" || !layout || layout.bars.every(bar => bar.height === 0)) {
      distribution.setAttribute("hidden", "");
      if (painted === "hidden") return;
      painted = "hidden";
      while (barNodes.length) barNodes.pop()!.remove();
      return;
    }
    const signature = `${width}|${layout.bars.map(bar => [bar.x, bar.y, bar.width, bar.height, bar.overflow].join(",")).join(";")}`;
    distribution.removeAttribute("hidden");
    if (signature === painted) return;
    painted = signature;
    setAttr(gradient, "x2", String(width));
    setAttr(distribution, "viewBox", `0 0 ${width} 28`);
    while (barNodes.length < layout.bars.length) {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("fill", `url(#${gradientId})`);
      barNodes.push(rect);
      distribution.append(rect);
    }
    while (barNodes.length > layout.bars.length) barNodes.pop()!.remove();
    layout.bars.forEach((bar, index) => {
      const rect = barNodes[index];
      setAttr(rect, "x", String(bar.x));
      setAttr(rect, "y", String(bar.y));
      setAttr(rect, "width", String(bar.width));
      setAttr(rect, "height", String(bar.height));
      if (bar.overflow > 0) {
        setAttr(rect, "stroke", "#061422");
        setAttr(rect, "stroke-width", "1");
      } else {
        rect.removeAttribute("stroke");
        rect.removeAttribute("stroke-width");
      }
    });
  };
  const update = (): void => {
    const state = controller.getState();
    if (state === shown) return;
    shown = state;
    const ready = state?.availability === "ready";
    const presentation = loadedPresentation(controller);
    element.classList.toggle("is-unavailable", !ready);
    element.classList.toggle("is-pending", Boolean(ready && state?.pending));
    element.classList.toggle("is-limited", Boolean(ready && state && state.limits.some(limit => limit !== "loading")));
    element.classList.toggle("is-distribution", presentation === "distribution");
    if (!state) {
      slider.disabled = true;
      setHidden(defaultTick, true);
      setHidden(loadedMarker, true);
      paintDistribution(presentation, null, railWidth());
      markerTicks.replaceChildren();
      shownMarkers = [];
      slider.removeAttribute("aria-valuetext");
      element.title = `${name} is not available for this map.`;
      slider.title = element.title;
      return;
    }
    const kind = state.policy.kind;
    const range = detailRange(state.policy);
    const finer = detailPosition(kind, range.finer);
    const coarser = detailPosition(kind, range.coarser);
    setAttr(slider, "min", String(finer));
    setAttr(slider, "max", String(coarser));
    setAttr(slider, "step", String(kind === "raster" ? RASTER_DETAIL_STEP : GOOGLE_DETAIL_STEP));
    if (!dragging) slider.value = String(detailPosition(kind, state.requestedTarget));
    // Equal ends leave nothing to choose, but the value stays readable.
    slider.disabled = !ready || Math.abs(coarser - finer) < 1e-9;
    const status = ready ? describeDetailStatus(state) : null;
    const valueText = describeDetailValue(kind, state.requestedTarget);
    const active = state.activeTarget;
    const activeText = ready && active !== null && active !== state.requestedTarget
      ? `Current target: ${describeDetailValue(kind, active)}`
      : null;
    const loaded = state.loadedTarget;
    const hasLoaded = ready && loaded !== null && !Number.isNaN(loaded);
    const loadedText = hasLoaded
      ? `Loaded detail: ${Number.isFinite(loaded)
        ? kind === "google" ? formatDetailValue(kind, loaded) : describeDetailValue(kind, loaded)
        : "beyond measurable range"}`
      : null;
    const width = railWidth();
    let bins: DetailBinLayout | null = null;
    if (presentation === "distribution" && state.distribution && ready) {
      bins = layoutDetailDistribution({
        kind, finer: range.finer, coarser: range.coarser, widthPx: width, distribution: state.distribution,
      });
    }
    const distributionText = presentation !== "distribution" ? null
      : state.distribution ? describeLoadedTiles(kind, state.distribution, bins ?? { ceiling: 1, finerOverflow: 0, coarserOverflow: 0 })
      : "Loaded detail distribution is not available.";
    slider.setAttribute("aria-valuetext", [valueText, activeText, presentation === "distribution" ? distributionText : loadedText, status].filter(Boolean).join(". "));

    setHidden(defaultTick, false);
    defaultTick.style.left = `${rangePercent(detailPosition(kind, state.resolvedDefault), finer, coarser)}%`;

    // Delivery may be coarser than the selectable range while tiles arrive.
    // Clamp only its position; the tooltip preserves the measured value.
    // Distribution mode keeps this marker in the tree and hides it.
    setHidden(loadedMarker, presentation !== "marker" || !hasLoaded);
    if (presentation === "marker" && hasLoaded) {
      const position = detailPosition(kind, loaded);
      loadedMarker.style.left = `${rangePercent(position, finer, coarser)}%`;
      loadedMarker.classList.toggle("is-beyond-range", position < finer - 1e-9 || position > coarser + 1e-9);
    }
    paintDistribution(presentation, bins, width);

    // Hosts' markers that explain the rail, such as a flight's minimum while it holds.
    const railMarkers = ready ? state.markers.filter(marker => marker.onRail) : [];
    const layout = `${kind}:${finer}:${coarser}`;
    // Loaded detail can change with each view update. Stable host ticks need no
    // new nodes while the I-beam moves.
    if (layout !== markerLayout || railMarkers.length !== shownMarkers.length
      || railMarkers.some((marker, index) => marker !== shownMarkers[index])) {
      markerLayout = layout;
      shownMarkers = railMarkers;
      markerTicks.replaceChildren(...railMarkers.map(marker => {
        const tick = document.createElement("span");
        tick.className = "map-detail-control__marker";
        const position = detailPosition(kind, marker.value);
        tick.style.left = `${rangePercent(position, finer, coarser)}%`;
        tick.style.setProperty("--marker-colour", marker.colour);
        tick.classList.toggle("is-hollow", Boolean(marker.hollow));
        tick.classList.toggle("is-beyond-range", position < finer - 1e-9 || position > coarser + 1e-9);
        return tick;
      }));
    }

    if (!ready) {
      element.title = state.availability === "initializing"
        ? `${name} is starting.`
        : state.reason ?? `${name} is not available for this map yet.`;
    } else {
      const lines = [
        `${name}: ${valueText}${state.sessionOverride === null ? " (saved default)" : " for this session"}.`,
        `Saved default: ${formatDetailValue(kind, state.resolvedDefault)}${state.defaultLimitedByRange ? ", limited by the range" : ""}.`,
      ];
      if (activeText) lines.push(`${activeText}.`);
      if (presentation === "distribution" && distributionText) lines.push(distributionText);
      else if (loadedText) lines.push(`I-beam · ${loadedText} (${kind === "raster" ? "visible-area estimate" : "largest visible geometry error"}).`);
      if (kind === "raster" && state.effectiveTarget === null) lines.push("Imagery is still loading or limited.");
      for (const marker of railMarkers) lines.push(`${marker.label}: ${formatDetailValue(kind, marker.value)}${marker.hollow ? ", waived" : ""}.`);
      if (status) lines.push(status);
      lines.push("Left is finer, right is coarser. The Map tab restores the saved detail.");
      element.title = lines.join("\n");
    }
    slider.title = element.title;
  };

  const onInput = (): void => {
    const state = controller.getState();
    if (!state || state.availability !== "ready") return;
    controller.setSessionOverride(detailValueAtPosition(state.policy.kind, Number(slider.value)));
  };
  const onPointerDown = (): void => { dragging = true; };
  const onPointerUp = (): void => {
    dragging = false;
    shown = undefined;
    update();
  };
  slider.addEventListener("input", onInput);
  slider.addEventListener("pointerdown", onPointerDown);
  slider.addEventListener("pointerup", onPointerUp);
  slider.addEventListener("pointercancel", onPointerUp);
  const unsubscribe = controller.subscribe(() => update());
  const unsubscribeSettings = controller.settings.subscribe(changed => {
    if (!changed.has(MAP_DETAIL_LOADED_PRESENTATION_ID)) return;
    shown = undefined;
    update();
  });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      shown = undefined;
      update();
    });
  });
  resize?.observe(rail);
  update();

  return {
    element,
    update,
    destroy(): void {
      unsubscribe();
      unsubscribeSettings();
      resize?.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      slider.removeEventListener("input", onInput);
      slider.removeEventListener("pointerdown", onPointerDown);
      slider.removeEventListener("pointerup", onPointerUp);
      slider.removeEventListener("pointercancel", onPointerUp);
      element.remove();
    },
  };
}
