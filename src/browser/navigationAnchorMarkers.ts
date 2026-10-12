/**
 * Markers for the points zoom and rotation act about, over the globe canvas
 * (`input.showNavigationAnchors`): a reticle where a zoom acts, turning
 * arrows where a rotation does, both where they share a point, and a pin
 * above the pinned point. Shapes and labels tell them apart, not colour. They
 * take no pointer input. The runtime says where they are, each frame drawn.
 */

/** One marker: where it is, in client CSS pixels, and what acts there. */
export interface NavigationAnchorMarkerView {
  readonly x: number;
  readonly y: number;
  readonly zoom: boolean;
  readonly orbit: boolean;
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
const DOT = "M -2.5 0 A 2.5 2.5 0 1 0 2.5 0 A 2.5 2.5 0 1 0 -2.5 0 Z";
const PIN = "M 0 -1 C -2 -7 -7 -10 -7 -15 A 7 7 0 1 1 7 -15 C 7 -10 2 -7 0 -1 Z M -2.4 -15 A 2.4 2.4 0 1 0 2.4 -15 A 2.4 2.4 0 1 0 -2.4 -15 Z";

/** What a marker says to assistive technology: "Pinned point, where zoom and rotation act". */
export function describeNavigationAnchorMarker(marker: Pick<NavigationAnchorMarkerView, "zoom" | "orbit" | "pinned" | "occluded">): string {
  const acts = marker.zoom && marker.orbit ? "zoom and rotation act" : marker.zoom ? "zoom acts" : marker.orbit ? "rotation acts" : "";
  const what = marker.pinned ? (acts ? `Pinned point, where ${acts}` : "Pinned point")
    : marker.zoom && marker.orbit ? "Zoom and rotation point" : marker.zoom ? "Zoom point" : "Rotation point";
  return marker.occluded ? `${what}, hidden behind the ground` : what;
}

function kindOf(marker: NavigationAnchorMarkerView): string {
  return `${marker.zoom ? "z" : ""}${marker.orbit ? "o" : ""}${marker.pinned ? "p" : ""}${marker.occluded ? "-" : ""}`;
}

export function attachNavigationAnchorMarkers(canvas: HTMLCanvasElement): NavigationAnchorMarkers {
  const doc = canvas.ownerDocument;
  const host = canvas.parentElement ?? doc.body;
  const root = doc.createElement("div");
  root.setAttribute("data-foss-earth-navigation-anchors", "");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Zoom and rotation points");
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
    if (marker.pinned) shapes.push({ d: PIN, fill: true });
    if (!marker.pinned || marker.zoom || marker.orbit) shapes.push({ d: DOT, fill: true });
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
