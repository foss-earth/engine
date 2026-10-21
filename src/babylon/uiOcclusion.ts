import { Constants, Mesh, ShaderLanguage, ShaderMaterial, VertexBuffer, type Scene } from "@babylonjs/core";
import { cssRectToClip, type ClipRect, type CssBox } from "./uiCover.js";
import { worldViewportClientRect } from "../browser/worldViewport.js";

// Each cover is one quad, all drawn at once. Its corners carry the cover's
// rectangle, the value one draw per cover used to set as a uniform.
const VERTEX = `
attribute vec3 position;
attribute vec4 rect;
uniform float depthSign;
void main(void) {
  vec2 clip = rect.xy + position.xy * rect.zw;
  gl_Position = vec4(clip, depthSign, 1.0);
}
`;

const FRAGMENT = `
void main(void) {
  gl_FragColor = vec4(0.0);
}
`;

// The same quad in WGSL. WebGPU compiles GLSL only with glslang and twgsl,
// 2.6 MiB downloaded and compiled that no other shader here needs.
const VERTEX_WGSL = /* wgsl */ `
attribute position : vec3<f32>;
attribute rect : vec4<f32>;
uniform depthSign : f32;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let clip = vertexInputs.rect.xy + vertexInputs.position.xy * vertexInputs.rect.zw;
  vertexOutputs.position = vec4<f32>(clip, uniforms.depthSign, 1.0);
}
`;

const FRAGMENT_WGSL = /* wgsl */ `
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = vec4<f32>(0.0);
}
`;

function boxOf(element: Element): CssBox | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * The toolbar's items, which are opaque only while the windows and the
 * toolbar are flush with the screen's edges (`data-world-edges="flush"`).
 */
export const FLUSH_TOOLBAR_COVERS = ".hud-bar :is(.hud-chip, .hud-circle-button)";

/** Shown on the page: an item the toolbar keeps measurable but hidden covers nothing. */
function shown(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(element, { visibilityProperty: true });
  return !element.closest("[data-hud-overflow-hidden], [hidden]");
}

/** The world's part of the canvas, on the page. One layout read of the canvas. */
function worldBoxOf(canvas: HTMLCanvasElement): CssBox | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const world = worldViewportClientRect(canvas, rect);
  if (world.width < 1 || world.height < 1) return null;
  return { x: world.left, y: world.top, width: world.width, height: world.height };
}

/**
 * Opaque windows and the floating log over the world, in the clip space of
 * the world's viewport, and the toolbar's items while they are flush. Split
 * keeps the windows above the world, with only the bottom toolbar covering it.
 */
export function coveredWorldClips(canvas: HTMLCanvasElement): ClipRect[] {
  const doc = canvas.ownerDocument;
  if (!doc) return [];
  const split = doc.documentElement.dataset.worldPresentation === "split";
  const flush = doc.documentElement.dataset.worldEdges === "flush";
  if (split && !flush) return [];
  const worldBox = worldBoxOf(canvas);
  if (!worldBox) return [];
  const elements: Element[] = split ? [] : [...doc.querySelectorAll("[data-occlude-world]")];
  if (!split) {
    const log = doc.querySelector("#app-log");
    if (log && !log.closest("[data-occlude-world]")) elements.push(log);
  }
  if (flush) {
    for (const item of doc.querySelectorAll(FLUSH_TOOLBAR_COVERS)) if (shown(item)) elements.push(item);
  }
  const clips: ClipRect[] = [];
  for (const element of elements) {
    const box = boxOf(element);
    if (!box) continue;
    const clip = cssRectToClip(box, worldBox);
    if (clip) clips.push(clip);
  }
  return clips;
}

/**
 * Draws the opaque UI into the depth buffer before the world, so fragments under those windows are rejected.
 * A camera viewport is one rectangle and cannot punch several windows out of a full-screen pass.
 * Split's world viewport excludes its windows; only its opaque bottom toolbar needs this mask.
 * A stereo camera, such as a VR headset's eyes, sees past the page's windows and toolbar.
 */
export function attachWorldOcclusion(scene: Scene, canvas: HTMLCanvasElement): { dispose(): void } {
  const draws = scene.onBeforeDrawPhaseObservable;
  if (typeof draws?.add !== "function") return { dispose() {} };

  const webGpu = scene.getEngine().isWebGPU;
  const material = new ShaderMaterial("world-occlusion", scene,
    webGpu ? { vertexSource: VERTEX_WGSL, fragmentSource: FRAGMENT_WGSL } : { vertexSource: VERTEX, fragmentSource: FRAGMENT }, {
      attributes: ["position", "rect"],
      uniforms: ["depthSign"],
      shaderLanguage: webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    });
  material.disableColorWrite = true;
  material.forceDepthWrite = true;
  material.depthFunction = Constants.ALWAYS;
  material.backFaceCulling = false;

  const mesh = new Mesh("world-occlusion", scene);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.layerMask = 0;
  // Each quad's rectangle once per corner: the ones drawn, and the ones the
  // next draw needs. A new shape starts unset, so its first draw sets it.
  let shown = new Float32Array(0), wanted = shown;
  const shape = (quads: number): void => {
    const positions: number[] = [], indices: number[] = [];
    for (let quad = 0; quad < quads; quad++) {
      const first = 4 * quad;
      positions.push(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
    shown = new Float32Array(16 * quads).fill(NaN);
    wanted = new Float32Array(16 * quads);
    mesh.setVerticesData(VertexBuffer.PositionKind, positions);
    mesh.setVerticesData("rect", shown, true, 4);
    mesh.setIndices(indices);
  };
  shape(1);
  let failed = false;
  const observer = draws.add(() => {
    if (failed) return;
    const camera = scene.activeCamera;
    if (camera && (camera.isRigCamera || camera.rigCameras.length > 0)) return;
    try {
      const covers = coveredWorldClips(canvas);
      if (covers.length === 0) return;
      if (16 * covers.length !== shown.length) shape(covers.length);
      if (!material.isReady(mesh)) return;
      let changed = false;
      for (let quad = 0; quad < covers.length; quad++) {
        const { x, y, w, h } = covers[quad];
        for (let at = 16 * quad; at < 16 * quad + 16; at += 4) {
          wanted[at] = x; wanted[at + 1] = y; wanted[at + 2] = w; wanted[at + 3] = h;
          changed ||= wanted[at] !== shown[at] || wanted[at + 1] !== shown[at + 1] || wanted[at + 2] !== shown[at + 2] || wanted[at + 3] !== shown[at + 3];
        }
      }
      if (changed) {
        [shown, wanted] = [wanted, shown];
        mesh.updateVerticesData("rect", shown);
      }
      material.setFloat("depthSign", scene.getEngine().useReverseDepthBuffer ? 1 : -1);
      mesh.directRender();
    } catch {
      failed = true;
    }
  });

  return {
    dispose() {
      draws.remove(observer);
      mesh.dispose();
      material.dispose();
    },
  };
}
