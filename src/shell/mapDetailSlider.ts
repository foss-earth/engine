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
} from "../terrain/mapDetailPolicy";
import type { MapDetailController } from "./mapDetailController";

export interface MapDetailSliderOptions {
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
};

/** A sentence about what limits the request, or null when nothing does. */
export function describeDetailStatus(state: DetailState): string | null {
  const parts = state.limits.map(limit => LIMIT_TEXT[limit]);
  if (state.pending && !state.limits.includes("loading")) parts.unshift("loading");
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

function rangePercent(position: number, finer: number, coarser: number): number {
  if (Math.abs(coarser - finer) < 1e-9) return 50;
  return Math.max(0, Math.min(100, ((position - finer) / (coarser - finer)) * 100));
}

/**
 * A small rail beside the map's credit that sets a temporary detail target for
 * this session: finer to the left, coarser to the right. Both ends are
 * ordinary values; "Restore saved detail" in the Map tab returns to the saved
 * default. A tick marks that default. For Google 3D Tiles a blue marker shows
 * the renderer's target when an app holds it finer than the rail.
 */
export function createMapDetailSlider(options: MapDetailSliderOptions): MapDetailSliderHandle {
  const { controller } = options;
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
  const activeMarker = document.createElement("span");
  activeMarker.className = "map-detail-control__active-marker";
  activeMarker.setAttribute("aria-hidden", "true");
  const slider = document.createElement("input");
  slider.className = "map-detail-control__slider";
  slider.type = "range";
  slider.setAttribute("aria-label", `${name} for this session`);
  rail.append(validRange, defaultTick, activeMarker, slider);
  element.append(rail);

  let shown: DetailState | null | undefined;
  let dragging = false;
  const update = (): void => {
    const state = controller.getState();
    if (state === shown) return;
    shown = state;
    const ready = state?.availability === "ready";
    element.classList.toggle("is-unavailable", !ready);
    element.classList.toggle("is-pending", Boolean(ready && state?.pending));
    element.classList.toggle("is-limited", Boolean(ready && state && state.limits.some(limit => limit !== "loading")));
    if (!state) {
      slider.disabled = true;
      defaultTick.hidden = true;
      activeMarker.hidden = true;
      slider.removeAttribute("aria-valuetext");
      element.title = `${name} is not available for this map.`;
      slider.title = element.title;
      return;
    }
    const kind = state.policy.kind;
    const range = detailRange(state.policy);
    const finer = detailPosition(kind, range.finer);
    const coarser = detailPosition(kind, range.coarser);
    slider.min = String(finer);
    slider.max = String(coarser);
    slider.step = String(kind === "raster" ? RASTER_DETAIL_STEP : GOOGLE_DETAIL_STEP);
    if (!dragging) slider.value = String(detailPosition(kind, state.requestedTarget));
    // Equal ends leave nothing to choose, but the value stays readable.
    slider.disabled = !ready || Math.abs(coarser - finer) < 1e-9;
    const status = ready ? describeDetailStatus(state) : null;
    const valueText = describeDetailValue(kind, state.requestedTarget);
    slider.setAttribute("aria-valuetext", status ? `${valueText}. ${status}` : valueText);

    defaultTick.hidden = false;
    defaultTick.style.left = `${rangePercent(detailPosition(kind, state.resolvedDefault), finer, coarser)}%`;

    // The marker is a policy target, shown only where one scalar exists and it
    // differs from the thumb. It never claims the imagery has loaded.
    const effective = state.effectiveTarget;
    activeMarker.hidden = !ready || effective === null || effective === state.requestedTarget;
    if (effective !== null) {
      activeMarker.style.left = `${rangePercent(detailPosition(kind, effective), finer, coarser)}%`;
      activeMarker.classList.toggle("is-beyond-range", detailPosition(kind, effective) < finer - 1e-9);
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
      if (!activeMarker.hidden && effective !== null) lines.push(`Blue marker: the renderer is held at ${formatDetailValue(kind, effective)}.`);
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
  update();

  return {
    element,
    update,
    destroy(): void {
      unsubscribe();
      slider.removeEventListener("input", onInput);
      slider.removeEventListener("pointerdown", onPointerDown);
      slider.removeEventListener("pointerup", onPointerUp);
      slider.removeEventListener("pointercancel", onPointerUp);
      element.remove();
    },
  };
}
