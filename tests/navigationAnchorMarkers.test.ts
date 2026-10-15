// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { attachNavigationAnchorMarkers, describeNavigationAnchorMarker, type NavigationAnchorMarkerView } from "../src/browser/navigationAnchorMarkers.js";

afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const parent = document.createElement("div");
  const canvas = document.createElement("canvas");
  parent.append(canvas);
  document.body.append(parent);
  const markers = attachNavigationAnchorMarkers(canvas);
  const root = parent.querySelector<HTMLElement>("[data-foss-earth-navigation-anchors]")!;
  root.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650, x: 100, y: 50, toJSON: () => ({}) });
  const svgs = () => Array.from(root.querySelectorAll<SVGSVGElement>("svg"));
  return { parent, canvas, markers, root, svgs };
}

const marker = (extra: Partial<NavigationAnchorMarkerView> = {}): NavigationAnchorMarkerView =>
  ({ x: 300, y: 200, zoom: true, orbit: false, grab: false, held: true, zoomHeld: true, pinned: false, occluded: false, ...extra });

describe("navigation anchor markers", () => {
  it("adds a hidden group beside the canvas that takes no pointer input", () => {
    const { parent, root } = mount();
    expect(root.parentElement).toBe(parent);
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe("Navigation points");
    expect(root.style.pointerEvents).toBe("none");
    expect(root.hidden).toBe(true);
  });

  it("places each marker's centre at its client point, relative to the group", () => {
    const { root, markers, svgs } = mount();
    markers.show([marker(), marker({ x: 500, y: 450, zoom: false, orbit: true })]);
    expect(root.hidden).toBe(false);
    const [first, second] = svgs();
    expect(first!.style.transform).toBe("translate(178px, 128px)");
    expect(second!.style.transform).toBe("translate(378px, 378px)");
    expect(first!.getAttribute("viewBox")).toBe("-22 -22 44 44");
    expect(first!.getAttribute("role")).toBe("img");
    expect(first!.style.pointerEvents).toBe("none");
    expect(first!.getAttribute("aria-label")).toBe("Zoom point");
    expect(second!.getAttribute("aria-label")).toBe("Rotation point");
  });

  it("hides the group for no markers, and shows it again", () => {
    const { root, markers, svgs } = mount();
    markers.show([marker()]);
    markers.show([]);
    expect(root.hidden).toBe(true);
    markers.show([marker({ x: 120, y: 80 })]);
    expect(root.hidden).toBe(false);
    expect(svgs()).toHaveLength(1);
    expect(svgs()[0]!.style.transform).toBe("translate(-2px, 8px)");
  });

  it("paints an X pattern on an occluded marker's coloured ink and leaves its colour alone", () => {
    const { markers, svgs } = mount();
    const cross = (svg: SVGSVGElement): Element | null => svg.querySelector("pattern");
    markers.show([marker({ occluded: true })]);
    const svg = svgs()[0]!;
    expect(svg.style.opacity).toBe("1");
    expect(svg.style.color).toBe("");
    expect(svg.getAttribute("aria-label")).toBe("Zoom point, hidden behind the ground");
    const pattern = cross(svg);
    expect(pattern?.getAttribute("width")).toBe("3");
    expect(pattern?.querySelector("path")?.getAttribute("d")).toBe("M 0 0 L 3 3 M 3 0 L 0 3");
    const paint = `url(#${pattern?.id})`;
    const ink = Array.from(svg.querySelectorAll(":scope > path")).filter(path => path.getAttribute("stroke") === paint);
    expect(ink.length).toBeGreaterThan(0);
    expect(ink.every(path => path.getAttribute("stroke-width") === "1.75")).toBe(true);
    expect(svg.querySelector("rect")).toBeNull();
    expect(Array.from(svg.querySelectorAll("path")).some(path => path.getAttribute("stroke") === "currentColor")).toBe(true);
    markers.show([marker({ zoom: false, grab: true, held: false, occluded: true })]);
    expect(svg.style.color).toBe("var(--foss-earth-navigation-anchor-coast-color,#a3a3a3)");
    expect(cross(svg)).not.toBeNull();
    markers.show([marker()]);
    expect(svg.style.color).toBe("");
    expect(cross(svg)).toBeNull();
  });

  it("draws a halo under each shape: reticle and dot for zoom, turning arrows too for both, a pin alone for the pin", () => {
    const { markers, svgs } = mount();
    const count = (view: Partial<NavigationAnchorMarkerView>): number => {
      markers.show([marker(view)]);
      return svgs()[0]!.querySelectorAll("path").length;
    };
    expect(count({ zoom: true })).toBe(4);
    expect(count({ zoom: true, orbit: true })).toBe(6);
    expect(count({ zoom: false, pinned: true })).toBe(2);
    expect(count({ zoom: true, orbit: true, pinned: true })).toBe(8);
    expect(count({ zoom: false, grab: true })).toBe(4);
    const paths = svgs()[0]!.querySelectorAll("path");
    expect(Array.from(paths).some(path => path.getAttribute("d")?.startsWith("M 0 -6 V -13"))).toBe(true);
  });

  it("reuses its elements, hides surplus ones, and redraws only when a marker's kind changes", () => {
    const { markers, svgs } = mount();
    markers.show([marker(), marker({ x: 400, zoom: false, pinned: true })]);
    const [first, second] = svgs();
    const shapes = first!.firstChild;
    markers.show([marker({ x: 310, y: 210 })]);
    expect(svgs()).toEqual([first, second]);
    expect(first!.firstChild).toBe(shapes);
    expect(first!.style.transform).toBe("translate(188px, 138px)");
    expect(second!.style.display).toBe("none");
    markers.show([marker({ orbit: true }), marker({ zoom: false, pinned: true })]);
    expect(svgs()).toEqual([first, second]);
    expect(first!.firstChild).not.toBe(shapes);
    expect(first!.getAttribute("aria-label")).toBe("Zoom and rotation point");
    expect(second!.style.display).toBe("");
    expect(second!.getAttribute("aria-label")).toBe("Pinned point");
    const redrawn = first!.firstChild;
    markers.show([marker({ zoom: false, grab: true })]);
    expect(first!.firstChild).not.toBe(redrawn);
    expect(first!.getAttribute("aria-label")).toBe("Grabbed point");
    expect(second!.style.display).toBe("none");
  });

  it("keeps a held grab in the anchor colour, and draws a gliding one in the coast colour", () => {
    const { markers, svgs } = mount();
    markers.show([marker({ zoom: false, grab: true, held: true })]);
    const svg = svgs()[0]!;
    expect(svg.style.color).toBe("");
    expect(svg.getAttribute("aria-label")).toBe("Grabbed point");
    markers.show([marker({ zoom: false, grab: true, held: false })]);
    expect(svg.style.color).toBe("var(--foss-earth-navigation-anchor-coast-color,#a3a3a3)");
    expect(svg.getAttribute("aria-label")).toBe("Grabbed point, gliding");
    markers.show([marker({ zoom: true, grab: false, zoomHeld: true })]);
    expect(svg.style.color).toBe("");
    expect(svg.getAttribute("aria-label")).toBe("Zoom point");
    markers.show([marker({ zoom: true, grab: false, zoomHeld: false })]);
    expect(svg.style.color).toBe("var(--foss-earth-navigation-anchor-coast-color,#a3a3a3)");
    expect(svg.getAttribute("aria-label")).toBe("Zoom point, gliding");
  });

  it("removes its group on destroy", () => {
    const { parent, markers } = mount();
    markers.show([marker()]);
    markers.destroy();
    expect(parent.querySelector("[data-foss-earth-navigation-anchors]")).toBeNull();
    expect(parent.querySelector("canvas")).not.toBeNull();
  });

  it("joins the body when the canvas has no parent", () => {
    const canvas = document.createElement("canvas");
    const markers = attachNavigationAnchorMarkers(canvas);
    expect(document.body.querySelector("[data-foss-earth-navigation-anchors]")).not.toBeNull();
    markers.destroy();
    expect(document.body.querySelector("[data-foss-earth-navigation-anchors]")).toBeNull();
  });
});

describe("describeNavigationAnchorMarker", () => {
  it("names what acts at the point, the pin, and whether the ground hides it", () => {
    const cases: [zoom: boolean, orbit: boolean, grab: boolean, pinned: boolean, label: string][] = [
      [true, false, false, false, "Zoom point"],
      [false, true, false, false, "Rotation point"],
      [true, true, false, false, "Zoom and rotation point"],
      [false, false, false, true, "Pinned point"],
      [true, false, false, true, "Pinned point, where zoom acts"],
      [false, true, false, true, "Pinned point, where rotation acts"],
      [true, true, false, true, "Pinned point, where zoom and rotation act"],
      [false, false, true, false, "Grabbed point"],
      [true, false, true, false, "Grabbed point, where zoom acts"],
      [false, true, true, false, "Grabbed point, where rotation acts"],
      [true, true, true, false, "Grabbed point, where zoom and rotation act"],
      [false, false, true, true, "Pinned point, where the grab acts"],
    ];
    for (const [zoom, orbit, grab, pinned, label] of cases) {
      expect(describeNavigationAnchorMarker({ zoom, orbit, grab, pinned, occluded: false })).toBe(label);
      expect(describeNavigationAnchorMarker({ zoom, orbit, grab, pinned, occluded: true })).toBe(`${label}, hidden behind the ground`);
    }
  });
});
