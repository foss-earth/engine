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
  ({ x: 300, y: 200, zoom: true, orbit: false, pinned: false, occluded: false, ...extra });

describe("navigation anchor markers", () => {
  it("adds a hidden group beside the canvas that takes no pointer input", () => {
    const { parent, root } = mount();
    expect(root.parentElement).toBe(parent);
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe("Zoom and rotation points");
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

  it("draws an occluded marker dashed and faint, and a visible one solid", () => {
    const { markers, svgs } = mount();
    markers.show([marker({ occluded: true })]);
    const svg = svgs()[0]!;
    expect(svg.style.opacity).toBe("0.5");
    expect(svg.getAttribute("aria-label")).toBe("Zoom point, hidden behind the ground");
    const lines = Array.from(svg.querySelectorAll("path")).filter(path => path.getAttribute("stroke") === "currentColor");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(path => path.getAttribute("stroke-dasharray") === "2.5 2.5")).toBe(true);
    markers.show([marker()]);
    expect(svg.style.opacity).toBe("1");
    expect(svg.querySelector("[stroke-dasharray]")).toBeNull();
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
    const cases: [zoom: boolean, orbit: boolean, pinned: boolean, label: string][] = [
      [true, false, false, "Zoom point"],
      [false, true, false, "Rotation point"],
      [true, true, false, "Zoom and rotation point"],
      [false, false, true, "Pinned point"],
      [true, false, true, "Pinned point, where zoom acts"],
      [false, true, true, "Pinned point, where rotation acts"],
      [true, true, true, "Pinned point, where zoom and rotation act"],
    ];
    for (const [zoom, orbit, pinned, label] of cases) {
      expect(describeNavigationAnchorMarker({ zoom, orbit, pinned, occluded: false })).toBe(label);
      expect(describeNavigationAnchorMarker({ zoom, orbit, pinned, occluded: true })).toBe(`${label}, hidden behind the ground`);
    }
  });
});
