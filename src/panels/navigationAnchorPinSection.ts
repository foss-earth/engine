import type { GlobeNavigationAnchors, NavigationAnchorStatus, PinnedPoint } from "../input/navigationAnchors.js";

export interface NavigationAnchorPinSectionPorts {
  document: Document;
  anchors: GlobeNavigationAnchors;
}

export interface NavigationAnchorPinSectionHandle {
  element: HTMLElement;
  destroy(): void;
}

/** "36.1000°N 112.1400°W, 812m above the ellipsoid": latitude and longitude as the position readout writes them. */
export function formatPinnedPoint(pin: Pick<PinnedPoint, "latDeg" | "lonDeg" | "heightMeters">): string {
  const lat = `${Math.abs(pin.latDeg).toFixed(4)}°${pin.latDeg >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(pin.lonDeg).toFixed(4)}°${pin.lonDeg >= 0 ? "E" : "W"}`;
  return `${lat} ${lon}, ${Math.round(pin.heightMeters)}m above the ellipsoid`;
}

const PIN_SOURCES: Record<PinnedPoint["source"], string> = {
  surface: "on the map surface",
  ellipsoid: "on the ellipsoid: no map surface was there",
  target: "the compass target when pinned",
};

/** What the section says under the buttons, or "" for nothing. */
export function navigationAnchorPinMessage(status: NavigationAnchorStatus): string {
  if (status.pinningBlocked) {
    return status.pin ? `${status.pinningBlocked} The pin stays, and Clear pin still works.` : status.pinningBlocked;
  }
  if (status.selection === "armed") return "Click or tap a place on the map to pin it. Esc cancels.";
  if (status.selection === "missed") return "No map surface there. Click or tap another place, or press Esc to cancel.";
  if (status.tracking) return "While a point is tracked, zoom and rotation act about it. The pin is used again when tracking ends.";
  return "";
}

/**
 * Controls → Orbit's pinned point: whether one is pinned and where, and Pick
 * point, Pin compass target and Clear pin. The pin is this globe session's:
 * never saved, exported or put in the URL. Pinning and clearing move no
 * camera and change none of the zoom and rotation choices.
 */
export function createNavigationAnchorPinSection(ports: NavigationAnchorPinSectionPorts): NavigationAnchorPinSectionHandle {
  const { document, anchors } = ports;
  const element = document.createElement("div");
  element.className = "foss-earth-navigation-pin-section";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Pinned point");
  const heading = document.createElement("div");
  heading.className = "foss-earth-choices__heading";
  heading.textContent = "Pinned point";
  const where = document.createElement("p");
  where.className = "foss-earth-choices__note";
  const button = (text: string): HTMLButtonElement => {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "foss-earth-choice foss-earth-parameter__action";
    action.textContent = text;
    return action;
  };
  const pick = button("Pick point");
  pick.setAttribute("aria-pressed", "false");
  const pinTarget = button("Pin compass target");
  const clear = button("Clear pin");
  const actions = document.createElement("div");
  actions.className = "foss-earth-choices";
  actions.append(pick, pinTarget, clear);
  const message = document.createElement("p");
  message.className = "foss-earth-choices__note";
  message.setAttribute("role", "status");
  element.append(heading, where, actions, message);

  const render = (): void => {
    const status = anchors.status();
    where.textContent = status.pin
      ? `${formatPinnedPoint(status.pin)}, ${PIN_SOURCES[status.pin.source]}.`
      : "No point is pinned. Choices set to Pinned point use the compass target.";
    const armed = status.selection !== "off";
    pick.setAttribute("aria-pressed", String(armed));
    pick.disabled = status.pinningBlocked !== null;
    pinTarget.disabled = status.pinningBlocked !== null;
    clear.disabled = status.pin === null;
    const text = navigationAnchorPinMessage(status);
    if (message.textContent !== text) message.textContent = text;
    message.hidden = text === "";
  };

  pick.addEventListener("click", () => { anchors.togglePick(); });
  pinTarget.addEventListener("click", () => { anchors.pinTarget(); });
  clear.addEventListener("click", () => { anchors.clearPin(); });
  const unsubscribe = anchors.subscribe(render);
  render();

  return {
    element,
    destroy(): void {
      unsubscribe();
      // Without the section nothing says Pick point is armed, so it is cancelled with it.
      if (anchors.status().selection !== "off") anchors.cancelPick();
    },
  };
}
