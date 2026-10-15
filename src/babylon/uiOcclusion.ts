import { Constants, Mesh, ShaderMaterial, Vector4, VertexData, type Scene } from "@babylonjs/core";
import { cssRectToClip, type ClipRect, type CssBox } from "./uiCover.js";
import { worldViewportClientRect } from "../browser/worldViewport.js";

const VERTEX = `
attribute vec3 position;
uniform vec4 rect;
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

/** The world's part of the canvas, on the page. */
function worldBoxOf(canvas: HTMLCanvasElement): CssBox | null {
  if (!boxOf(canvas)) return null;
  const world = worldViewportClientRect(canvas);
  if (world.width < 1 || world.height < 1) return null;
  return { x: world.left, y: world.top, width: world.width, height: world.height };
}

/**
 * Opaque windows and the floating log over the world, in the clip space of
 * the world's viewport, and the toolbar's items while they are flush. In the
 * split presentation the world is only the uncovered area, so nothing covers it.
 */
export function coveredWorldClips(canvas: HTMLCanvasElement): ClipRect[] {
  const doc = canvas.ownerDocument;
  if (!doc || doc.documentElement.dataset.worldPresentation === "split") return [];
  const worldBox = worldBoxOf(canvas);
  if (!worldBox) return [];
  const elements = [...doc.querySelectorAll("[data-occlude-world]")];
  const log = doc.querySelector("#app-log");
  if (log && !log.closest("[data-occlude-world]")) elements.push(log);
  if (doc.documentElement.dataset.worldEdges === "flush") {
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
 * The split presentation does not use this: its world viewport is already only the uncovered area.
 */
export function attachWorldOcclusion(scene: Scene, canvas: HTMLCanvasElement): { dispose(): void } {
  const draws = scene.onBeforeDrawPhaseObservable;
  if (typeof draws?.add !== "function") return { dispose() {} };

  const material = new ShaderMaterial("world-occlusion", scene, { vertexSource: VERTEX, fragmentSource: FRAGMENT }, {
    attributes: ["position"],
    uniforms: ["rect", "depthSign"],
  });
  material.disableColorWrite = true;
  material.forceDepthWrite = true;
  material.depthFunction = Constants.ALWAYS;
  material.backFaceCulling = false;

  const mesh = new Mesh("world-occlusion", scene);
  const data = new VertexData();
  data.positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  data.indices = [0, 1, 2, 0, 2, 3];
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.layerMask = 0;

  const rect = new Vector4();
  let failed = false;
  const observer = draws.add(() => {
    if (failed) return;
    try {
      const covers = coveredWorldClips(canvas);
      if (covers.length === 0 || !material.isReady(mesh)) return;
      material.setFloat("depthSign", scene.getEngine().useReverseDepthBuffer ? 1 : -1);
      for (const cover of covers) {
        rect.set(cover.x, cover.y, cover.w, cover.h);
        material.setVector4("rect", rect);
        mesh.directRender();
      }
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
