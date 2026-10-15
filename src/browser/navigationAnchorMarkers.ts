/**
 * Markers for the points navigation acts about, over the globe canvas
 * (`input.showNavigationAnchors`): outward arrows where a drag grabs the
 * ground, a reticle where a zoom acts, turning arrows where a rotation does,
 * and a pin above the pinned point. Shapes and labels tell them apart. A grab
 * still under the finger, and a zoom whose events are still arriving, keep the
 * anchor colour. Once a point is only waiting out its glide, it turns gray.
 * They take no pointer input. The runtime says where they are, each frame drawn.
 */

/** One marker: where it is, in client CSS pixels, and what acts there. */
export interface NavigationAnchorMarkerView {
  readonly x: number;
  readonly y: number;
  readonly zoom: boolean;
  readonly orbit: boolean;
  /** A grab holds this ground, or is still gliding from having held it. */
  readonly grab: boolean;
  /** The finger is still down on this grab. False while the point only waits out the glide. */
  readonly held: boolean;
  /** Zoom events are still arriving. False while this zoom only waits out its glide. */
  readonly zoomHeld: boolean;
  readonly pinned: boolean;
  /** Ground or a building nearer the eye hides the point: the marker is drawn faint. */
  readonly occluded: boolean;
}

export interface NavigationAnchorMarkers {
  /** Shows these markers, and no others. */
  show(markers: readonly NavigationAnchorMarkerView[]): void;
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Half the marker box, CSS pixels: the point is at its centre. */
const HALF = 22;
const RETICLE = "M -7 0 A 7 7 0 1 0 7 0 A 7 7 0 1 0 -7 0 M 0 -9 V -13 M 9 0 H 13 M 0 9 V 13 M -9 0 H -13";
const TURN = "M -9.5 -4 A 10.3 10.3 0 0 1 4 -9.5 M 9.5 4 A 10.3 10.3 0 0 1 -4 9.5 M 1 -12.5 L 4 -9.5 L 0.5 -6.8 M -1 12.5 L -4 9.5 L -0.5 6.8";
/** Four outward arrows around the centre: the ground a drag has grabbed. */
const GRAB = "M 0 -6 V -13 M -3 -10 L 0 -13 L 3 -10 M 0 6 V 13 M -3 10 L 0 13 L 3 10 M -6 0 H -13 M -10 -3 L -13 0 L -10 3 M 6 0 H 13 M 10 -3 L 13 0 L 10 3";
const DOT = "M -2.5 0 A 2.5 2.5 0 1 0 2.5 0 A 2.5 2.5 0 1 0 -2.5 0 Z";
const PIN = "M 0 -1 C -2 -7 -7 -10 -7 -15 A 7 7 0 1 1 7 -15 C 7 -10 2 -7 0 -1 Z M -2.4 -15 A 2.4 2.4 0 1 0 2.4 -15 A 2.4 2.4 0 1 0 -2.4 -15 Z";

function joinActs(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What a marker says to assistive technology: "Pinned point, where zoom and rotation act". */
export function describeNavigationAnchorMarker(marker: Pick<NavigationAnchorMarkerView, "zoom" | "orbit" | "grab" | "pinned" | "occluded"> & { held?: boolean; zoomHeld?: boolean }): string {
  const motions = [marker.zoom ? "zoom" : "", marker.orbit ? "rotation" : ""].filter(Boolean);
  const motion = motions.length === 2 ? "zoom and rotation" : motions[0] ?? "";
  let what: string;
  if (marker.pinned) {
    const acts = [motion, marker.grab ? "the grab" : ""].filter(Boolean);
    const plural = acts.length > 1 || motion === "zoom and rotation";
    what = acts.length > 0 ? `Pinned point, where ${joinActs(acts)} ${plural ? "act" : "acts"}` : "Pinned point";
  } else if (marker.grab && !motion) what = marker.held === false ? "Grabbed point, gliding" : "Grabbed point";
  else if (marker.grab) what = motion === "zoom and rotation" ? "Grabbed point, where zoom and rotation act" : `Grabbed point, where ${motion} acts`;
  else if (motion === "zoom and rotation") what = "Zoom and rotation point";
  else if (marker.zoom) what = marker.zoomHeld === false ? "Zoom point, gliding" : "Zoom point";
  else what = "Rotation point";
  return marker.occluded ? `${what}, hidden behind the ground` : what;
}

function kindOf(marker: NavigationAnchorMarkerView): string {
  return `${marker.zoom ? (marker.zoomHeld ? "Z" : "z") : ""}${marker.orbit ? "o" : ""}${marker.grab ? (marker.held ? "H" : "g") : ""}${marker.pinned ? "p" : ""}${marker.occluded ? "-" : ""}`;
}

export function attachNavigationAnchorMarkers(canvas: HTMLCanvasElement): NavigationAnchorMarkers {
  const doc = canvas.ownerDocument;
  const host = canvas.parentElement ?? doc.body;
  const root = doc.createElement("div");
  root.setAttribute("data-foss-earth-navigation-anchors", "");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Navigation points");
  root.style.cssText = [
    "position:absolute",
    "inset:0",
    "pointer-events:none",
    "overflow:hidden",
    "z-index:40",
    "color:var(--foss-earth-navigation-anchor-color,#fde68a)",
  ].join(";");
  root.hidden = true;
  host.append(root);
  const shown: { element: SVGSVGElement; kind: string }[] = [];

  function path(d: string, stroke: string, width: number, fill = "none"): SVGPathElement {
    const element = doc.createElementNS(SVG_NS, "path");
    element.setAttribute("d", d);
    element.setAttribute("fill", fill);
    element.setAttribute("stroke", stroke);
    element.setAttribute("stroke-width", String(width));
    element.setAttribute("stroke-linecap", "round");
    element.setAttribute("stroke-linejoin", "round");
    return element;
  }

  /** The marker's shapes, each over a dark halo so it shows on any ground. */
  function draw(element: SVGSVGElement, marker: NavigationAnchorMarkerView): void {
    const shapes: { d: string; fill: boolean }[] = [];
    if (marker.zoom) shapes.push({ d: RETICLE, fill: false });
    if (marker.orbit) shapes.push({ d: TURN, fill: false });
    if (marker.grab) shapes.push({ d: GRAB, fill: false });
    if (marker.pinned) shapes.push({ d: PIN, fill: true });
    if (!marker.pinned || marker.zoom || marker.orbit || marker.grab) shapes.push({ d: DOT, fill: true });
    const halo = shapes.map(shape => path(shape.d, "rgba(15, 23, 42, 0.7)", 3.5, shape.fill ? "rgba(15, 23, 42, 0.7)" : "none"));
    const line = shapes.map(shape => path(shape.d, "currentColor", 1.75, shape.fill ? "currentColor" : "none"));
    if (marker.occluded) for (const element of line) element.setAttribute("stroke-dasharray", "2.5 2.5");
    element.replaceChildren(...halo, ...line);
    element.style.opacity = marker.occluded ? "0.5" : "1";
    element.setAttribute("aria-label", describeNavigationAnchorMarker(marker));
  }

  function create(): SVGSVGElement {
    const element = doc.createElementNS(SVG_NS, "svg");
    element.setAttribute("width", String(2 * HALF));
    element.setAttribute("height", String(2 * HALF));
    element.setAttribute("viewBox", `${-HALF} ${-HALF} ${2 * HALF} ${2 * HALF}`);
    element.setAttribute("role", "img");
    element.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none";
    root.append(element);
    return element;
  }

  return {
    show(markers) {
      if (markers.length === 0) {
        if (!root.hidden) root.hidden = true;
        return;
      }
      root.hidden = false;
      const origin = root.getBoundingClientRect();
      markers.forEach((marker, index) => {
        const entry = shown[index] ?? (shown[index] = { element: create(), kind: "" });
        const kind = kindOf(marker);
        if (entry.kind !== kind) {
          draw(entry.element, marker);
          entry.kind = kind;
        }
        entry.element.style.display = "";
        const grabLive = marker.grab && marker.held;
        const zoomLive = marker.zoom && marker.zoomHeld;
        const coasting = ((marker.grab && !marker.held) || (marker.zoom && !marker.zoomHeld)) && !grabLive && !zoomLive;
        entry.element.style.color = coasting ? "var(--foss-earth-navigation-anchor-coast-color,#a3a3a3)" : "";
        entry.element.style.transform = `translate(${marker.x - origin.left - HALF}px, ${marker.y - origin.top - HALF}px)`;
      });
      for (const entry of shown.slice(markers.length)) entry.element.style.display = "none";
    },
    destroy() {
      root.remove();
      shown.length = 0;
    },
  };
}
