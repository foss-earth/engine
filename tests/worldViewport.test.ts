// @vitest-environment jsdom
import { GeospatialCamera, NullEngine, NullEngineOptions, Scene, ShaderLanguage, ShaderMaterial, Vector3, Viewport } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { clientRay, projectEcefToClient } from "../src/babylon/anchorPan.js";
import { attachWorldOcclusion, coveredWorldClips } from "../src/babylon/uiOcclusion.js";
import { applyWorldViewport, attachWorldViewport, cameraViewportFromTop, worldRenderRect } from "../src/babylon/worldViewport.js";
import {
  commitWorldViewport,
  gateWorldInput,
  isInWorldViewport,
  requestedWorldViewport,
  setWorldViewportSource,
  worldViewportClientRect,
  worldViewportHeight,
  worldViewportRect,
} from "../src/browser/worldViewport.js";

// The world shares a full-shell canvas with other surfaces: the host says
// which part is the world's, the frame draws it there, and conversions and
// input use the same rectangle.

const WIDTH = 800, HEIGHT = 600;

/** A canvas laid out at `box` on the page, `width` × `height` CSS pixels before any transform. */
function canvasAt(box = { left: 0, top: 0, width: WIDTH, height: HEIGHT }, width = WIDTH, height = HEIGHT): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: width });
  Object.defineProperty(canvas, "clientHeight", { value: height });
  canvas.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON() {} }) as DOMRect;
  document.body.append(canvas);
  return canvas;
}

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.worldPresentation;
});

describe("world viewport source", () => {
  it("is the whole canvas without a source, and again once the source is removed", () => {
    const canvas = canvasAt();
    expect(requestedWorldViewport(canvas)).toEqual({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const stop = setWorldViewportSource(canvas, () => ({ x: 0, y: 200, width: WIDTH, height: 400 }));
    expect(worldViewportRect(canvas)).toEqual({ x: 0, y: 200, width: WIDTH, height: 400 });
    expect(worldViewportHeight(canvas)).toBe(400);
    stop();
    expect(worldViewportRect(canvas)).toEqual({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  });

  it("clamps what the source asks for to the canvas, and ignores what is not finite", () => {
    const canvas = canvasAt();
    let asked = { x: -20, y: 500, width: 900, height: 300 };
    setWorldViewportSource(canvas, () => asked);
    expect(requestedWorldViewport(canvas)).toEqual({ x: 0, y: 500, width: WIDTH, height: 100 });
    asked = { x: 0, y: Number.NaN, width: 10, height: 10 };
    expect(requestedWorldViewport(canvas)).toEqual({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  });

  it("uses what a frame drew until the next frame, over what the source asks for now", () => {
    const canvas = canvasAt();
    let top = 200;
    setWorldViewportSource(canvas, () => ({ x: 0, y: top, width: WIDTH, height: HEIGHT - top }));
    commitWorldViewport(canvas, { x: 0, y: 200, width: WIDTH, height: 400 });
    top = 300;
    expect(worldViewportRect(canvas).y).toBe(200);
    expect(requestedWorldViewport(canvas).y).toBe(300);
  });

  it("is placed on the page through the canvas's CSS scaling", () => {
    // Laid out at 800 × 600 and drawn at half size, 10 px from the corner.
    const canvas = canvasAt({ left: 10, top: 10, width: 400, height: 300 });
    setWorldViewportSource(canvas, () => ({ x: 0, y: 200, width: WIDTH, height: 400 }));
    expect(worldViewportClientRect(canvas)).toEqual({ left: 10, top: 110, width: 400, height: 200 });
    expect(isInWorldViewport(canvas, 100, 109)).toBe(false);
    expect(isInWorldViewport(canvas, 100, 110)).toBe(true);
    expect(isInWorldViewport(canvas, 100, 309)).toBe(true);
    expect(isInWorldViewport(canvas, 100, 310)).toBe(false);
  });

  it("counts every point as the world's without a source", () => {
    const canvas = canvasAt();
    expect(isInWorldViewport(canvas, -5, -5)).toBe(true);
  });
});

describe("gateWorldInput", () => {
  function gated() {
    const canvas = canvasAt();
    setWorldViewportSource(canvas, () => ({ x: 0, y: 200, width: WIDTH, height: 400 }));
    const received: string[] = [];
    for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "mousedown", "mouseup", "click"]) {
      canvas.addEventListener(type, () => received.push(type));
    }
    const stop = gateWorldInput(canvas);
    return { canvas, received, stop };
  }
  const pointer = (type: string, clientY: number, pointerId = 1) => {
    const event = new MouseEvent(type, { clientX: 100, clientY, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    return event;
  };

  it("passes a press on the world and its whole gesture", () => {
    const { canvas, received } = gated();
    canvas.dispatchEvent(pointer("pointerdown", 300));
    canvas.dispatchEvent(pointer("pointermove", 100));
    canvas.dispatchEvent(pointer("pointerup", 100));
    expect(received).toEqual(["pointerdown", "pointermove", "pointerup"]);
  });

  it("stops a press outside the world and the rest of that pointer's gesture, even over the world", () => {
    const { canvas, received } = gated();
    canvas.dispatchEvent(pointer("pointerdown", 100));
    canvas.dispatchEvent(pointer("pointermove", 300));
    canvas.dispatchEvent(pointer("pointerup", 300));
    expect(received).toEqual([]);
    // The next press, on the world, passes.
    canvas.dispatchEvent(pointer("pointerdown", 300));
    expect(received).toEqual(["pointerdown"]);
  });

  it("keeps the page from scrolling under a wheel outside the world, which the world does not get", () => {
    const { canvas, received } = gated();
    const outside = new WheelEvent("wheel", { clientX: 100, clientY: 50, deltaY: 40, bubbles: true, cancelable: true });
    canvas.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
    expect(received).toEqual([]);
    canvas.dispatchEvent(new WheelEvent("wheel", { clientX: 100, clientY: 450, deltaY: 40, bubbles: true, cancelable: true }));
    expect(received).toEqual(["wheel"]);
  });

  it("leaves input alone once removed, and input on other elements always", () => {
    const { canvas, received, stop } = gated();
    const other = document.createElement("div");
    let reached = false;
    other.addEventListener("pointerdown", () => { reached = true; });
    document.body.append(other);
    other.dispatchEvent(pointer("pointerdown", 100));
    expect(reached).toBe(true);
    stop();
    canvas.dispatchEvent(pointer("mousedown", 100));
    canvas.dispatchEvent(pointer("click", 100));
    expect(received).toEqual(["mousedown", "click"]);
  });
});

describe("worldRenderRect", () => {
  it("rounds each edge on its own, so neighbours meet without a gap", () => {
    // 1.5 device pixels per CSS pixel: the band's edge at 133.5 CSS px lands on 200.25.
    const below = worldRenderRect({ x: 0, y: 133.5, width: 800, height: 466.5 }, 800, 600, 1200, 900);
    expect(below).toEqual({ x: 0, y: 200, width: 1200, height: 700 });
  });

  it("keeps the world at least one pixel, inside the canvas", () => {
    expect(worldRenderRect({ x: 0, y: 600, width: 800, height: 0 }, 800, 600, 800, 600)).toEqual({ x: 0, y: 599, width: 800, height: 1 });
  });
});

function sceneRig(renderWidth = WIDTH, renderHeight = HEIGHT) {
  const engine = new NullEngine({ ...new NullEngineOptions(), renderWidth, renderHeight, useHighPrecisionMatrix: true });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new GeospatialCamera("world", scene, { planetRadius: 6378137 });
  camera.fov = 0.8;
  camera.radius = 2_000_000;
  scene.activeCamera = camera;
  return { engine, scene, camera };
}

describe("applyWorldViewport", () => {
  it("points the camera at the world's part, measured from the bottom, and draws whole pixels", () => {
    const { scene, camera, engine } = sceneRig(1200, 900);
    const canvas = canvasAt();
    setWorldViewportSource(canvas, () => ({ x: 0, y: 133.5, width: WIDTH, height: 466.5 }));
    applyWorldViewport(scene, canvas);
    // The world is the bottom 700 of 900 rows. Babylon truncates or floors its pixel viewport.
    const viewport = camera.viewport.toGlobal(1200, 900);
    expect([Math.floor(viewport.x), Math.floor(viewport.y), Math.floor(viewport.width), Math.floor(viewport.height)]).toEqual([0, 0, 1200, 700]);
    expect(cameraViewportFromTop(camera, 1200, 900).y).toBeCloseTo(200, 2);
    // What the frame drew, in CSS pixels, is what input and conversions use.
    expect(worldViewportRect(canvas)).toEqual({ x: 0, y: 200 / 1.5, width: WIDTH, height: 700 / 1.5 });
    engine.dispose();
  });

  it("gives the camera the whole canvas without a source, and keeps the viewport object while nothing changes", () => {
    const { scene, camera, engine } = sceneRig();
    const canvas = canvasAt();
    camera.viewport = new Viewport(0, 0.5, 1, 0.5);
    applyWorldViewport(scene, canvas);
    expect([camera.viewport.x, camera.viewport.y, camera.viewport.width, camera.viewport.height]).toEqual([0, 0, 1, 1]);
    const same = camera.viewport;
    applyWorldViewport(scene, canvas);
    expect(camera.viewport).toBe(same);
    engine.dispose();
  });

  it("applies before each render once attached, and gives the whole canvas back when disposed", () => {
    const { scene, camera, engine } = sceneRig();
    const canvas = canvasAt();
    setWorldViewportSource(canvas, () => ({ x: 0, y: 300, width: WIDTH, height: 300 }));
    const attached = attachWorldViewport(scene, canvas);
    scene.render();
    expect(camera.viewport.height).toBeCloseTo(0.5, 4);
    attached.dispose();
    setWorldViewportSource(canvas, null);
    expect(worldViewportRect(canvas)).toEqual({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    engine.dispose();
  });
});

describe("rays and projection in a world viewport", () => {
  it("send the world viewport's centre down the camera's axis, and come back to the same point", () => {
    const { scene, camera, engine } = sceneRig();
    const canvas = canvasAt();
    // The world is the bottom three quarters: its centre is 375 px from the top, not 300 or 225.
    setWorldViewportSource(canvas, () => ({ x: 0, y: 150, width: WIDTH, height: 450 }));
    applyWorldViewport(scene, canvas);
    camera.getViewMatrix(true);
    camera.getProjectionMatrix(true);
    const ray = clientRay(scene, camera, canvas, 400, 375);
    expect(ray).not.toBeNull();
    const forward = camera.getDirection(new Vector3(0, 0, scene.useRightHandedSystem ? -1 : 1)).normalize();
    expect(Vector3.Dot(ray!.direction, forward)).toBeGreaterThan(1 - 1e-6);
    const point = ray!.origin.add(ray!.direction.scale(1000));
    const back = projectEcefToClient(point, scene, camera, canvas);
    expect(back!.x).toBeCloseTo(400, 3);
    expect(back!.y).toBeCloseTo(375, 3);
    // A point lower on the screen projects lower on the page.
    const lower = clientRay(scene, camera, canvas, 400, 500)!;
    const lowerBack = projectEcefToClient(lower.origin.add(lower.direction.scale(1000)), scene, camera, canvas)!;
    expect(lowerBack.y).toBeCloseTo(500, 3);
    engine.dispose();
  });
});

describe("coveredWorldClips", () => {
  it("places windows in the clip space of the world's part of the canvas", () => {
    const canvas = canvasAt();
    setWorldViewportSource(canvas, () => ({ x: 0, y: 200, width: WIDTH, height: 400 }));
    const panel = document.createElement("div");
    panel.dataset.occludeWorld = "true";
    // Covers the top half of the world: rows 200 to 400 of the canvas.
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400, x: 0, y: 0, right: 400, bottom: 400, toJSON() {} }) as DOMRect;
    document.body.append(panel);
    const [clip] = coveredWorldClips(canvas);
    expect(clip).toEqual({ x: -1, y: 0, w: 1, h: 1 });
  });

  it("covers nothing in the split presentation, whose world is only the uncovered part", () => {
    document.documentElement.dataset.worldPresentation = "split";
    const canvas = canvasAt();
    const panel = document.createElement("div");
    panel.dataset.occludeWorld = "true";
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400, x: 0, y: 0, right: 400, bottom: 400, toJSON() {} }) as DOMRect;
    document.body.append(panel);
    expect(coveredWorldClips(canvas)).toEqual([]);
  });

  it("reads the canvas layout once", () => {
    const canvas = canvasAt();
    setWorldViewportSource(canvas, () => ({ x: 0, y: 200, width: WIDTH, height: 400 }));
    let reads = 0;
    const read = canvas.getBoundingClientRect.bind(canvas);
    canvas.getBoundingClientRect = () => { reads += 1; return read(); };
    coveredWorldClips(canvas);
    expect(reads).toBe(1);
  });
});

describe("attachWorldOcclusion", () => {
  it("draws its quad with WGSL on WebGPU, which then needs no GLSL compiler, and with GLSL elsewhere", () => {
    for (const webGpu of [false, true]) {
      const engine = new NullEngine();
      if (webGpu) Object.defineProperty(engine, "isWebGPU", { value: true });
      const scene = new Scene(engine), occlusion = attachWorldOcclusion(scene, canvasAt());
      try {
        const material = scene.materials.find(candidate => candidate.name === "world-occlusion") as ShaderMaterial;
        const { vertexSource, fragmentSource } = material.shaderPath as { vertexSource: string; fragmentSource: string };
        // The effect is compiled in the language the options give.
        expect(material.options.shaderLanguage ?? ShaderLanguage.GLSL).toBe(webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL);
        expect([vertexSource.includes("@vertex"), fragmentSource.includes("@fragment")]).toEqual([webGpu, webGpu]);
        expect([material.options.attributes, material.options.uniforms]).toEqual([["position"], ["rect", "depthSign"]]);
      } finally { occlusion.dispose(); scene.dispose(); engine.dispose(); }
    }
  });
});
