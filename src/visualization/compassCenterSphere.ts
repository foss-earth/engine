/**
 * The compass center's sphere (`input.showCompassCenter`): a faint lit ball in
 * the world, where the view turns about while it turns about the compass.
 *
 * It is a sphere impostor, not a sphere mesh or a sprite. One quad of four
 * vertices faces the camera, and its fragment shader shades a ball on it from
 * the quad's own coordinates: no texture to draw, upload or keep, no triangles
 * beyond two, and the same crisp rim at any size. The vertex shader faces it
 * and sizes it, so a frame only moves the mesh and sets its opacity. It stands
 * at the front of the ball, so ground behind the center does not cut it while
 * buildings and hills in front still hide it. It never writes depth. Hidden, it
 * is disabled: the frame neither draws it nor culls it.
 */
import { Color4, Mesh, ShaderLanguage, ShaderMaterial, Vector2, VertexData, type Scene, type Vector3 } from "@babylonjs/core";

/** Radius on screen, CSS pixels. */
export const COMPASS_CENTER_SPHERE_RADIUS_PX = 26;
/** How opaque the ball's body is. Its rim and highlight are a little more, so its edge reads on any ground. */
export const COMPASS_CENTER_SPHERE_OPACITY = 0.22;
/** The navigation anchors' gold. */
const COLOR: readonly [number, number, number] = [0xfd / 255, 0xe6 / 255, 0x8a / 255];

// In view space, so large-world rendering's eye-relative `world` and `view` keep it exact at any distance from the Earth's center.
const VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform vec2 radiusClip;
varying vec2 vUV;
void main(void) {
  vec3 centre = (view * vec4(world[3].xyz, 1.0)).xyz;
  float depth = length(centre);
  float radius = radiusClip.y * depth / projection[1][1];
  vec4 clip = projection * vec4(centre * max(0.0, 1.0 - radius / depth), 1.0);
  clip.xy += position.xy * radiusClip * clip.w;
  vUV = position.xy;
  gl_Position = clip;
}
`;

const FRAGMENT = `
precision highp float;
varying vec2 vUV;
uniform vec4 color;
uniform float edge;
void main(void) {
  float d2 = dot(vUV, vUV);
  float d = sqrt(d2);
  float cover = clamp((1.0 - d) / edge, 0.0, 1.0);
  vec3 n = vec3(vUV, sqrt(max(0.0, 1.0 - d2)));
  float diffuse = max(dot(n, vec3(-0.4472, 0.5466, 0.7079)), 0.0);
  float shine = pow(max(dot(n, vec3(-0.2425, 0.2964, 0.9238)), 0.0), 24.0);
  vec3 rgb = color.rgb * (0.75 + 0.25 * diffuse) + vec3(0.8 * shine);
  gl_FragColor = vec4(rgb, min(1.0, color.a * cover * (0.8 + 0.6 * smoothstep(0.85, 1.0, d) + shine)));
}
`;

// The same shaders in WGSL. WebGPU compiles GLSL only with glslang and twgsl, which nothing else here needs.
const VERTEX_WGSL = /* wgsl */ `
attribute position : vec3<f32>;
uniform world : mat4x4<f32>;
uniform view : mat4x4<f32>;
uniform projection : mat4x4<f32>;
uniform radiusClip : vec2<f32>;
varying vUV : vec2<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let centre = (uniforms.view * vec4<f32>(uniforms.world[3].xyz, 1.0)).xyz;
  let depth = length(centre);
  let radius = uniforms.radiusClip.y * depth / uniforms.projection[1][1];
  var clip = uniforms.projection * vec4<f32>(centre * max(0.0, 1.0 - radius / depth), 1.0);
  clip = vec4<f32>(clip.xy + vertexInputs.position.xy * uniforms.radiusClip * clip.w, clip.zw);
  vertexOutputs.vUV = vertexInputs.position.xy;
  vertexOutputs.position = clip;
}
`;

const FRAGMENT_WGSL = /* wgsl */ `
varying vUV : vec2<f32>;
uniform color : vec4<f32>;
uniform edge : f32;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let d2 = dot(input.vUV, input.vUV);
  let d = sqrt(d2);
  let cover = clamp((1.0 - d) / uniforms.edge, 0.0, 1.0);
  let n = vec3<f32>(input.vUV, sqrt(max(0.0, 1.0 - d2)));
  let diffuse = max(dot(n, vec3<f32>(-0.4472, 0.5466, 0.7079)), 0.0);
  let shine = pow(max(dot(n, vec3<f32>(-0.2425, 0.2964, 0.9238)), 0.0), 24.0);
  let rgb = uniforms.color.rgb * (0.75 + 0.25 * diffuse) + vec3<f32>(0.8 * shine);
  fragmentOutputs.color = vec4<f32>(rgb, min(1.0, uniforms.color.a * cover * (0.8 + 0.6 * smoothstep(0.85, 1.0, d) + shine)));
}
`;

export interface CompassCenterSphere {
  /**
   * Stands the ball at `point`, in scene space, at `level` (0 to 1) of its
   * opacity, or hides it for null or a level of 0. Called before the frame is drawn.
   */
  show(point: Vector3 | null, level: number): void;
  dispose(): void;
}

export function createCompassCenterSphere(scene: Scene, canvas: HTMLCanvasElement): CompassCenterSphere {
  const webGpu = scene.getEngine().isWebGPU;
  const material = new ShaderMaterial("compass-center-sphere", scene,
    webGpu ? { vertexSource: VERTEX_WGSL, fragmentSource: FRAGMENT_WGSL } : { vertexSource: VERTEX, fragmentSource: FRAGMENT }, {
      attributes: ["position"],
      uniforms: ["world", "view", "projection", "radiusClip", "color", "edge"],
      needAlphaBlending: true,
      shaderLanguage: webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;

  const mesh = new Mesh("compass-center-sphere", scene);
  const data = new VertexData();
  data.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  data.indices = [0, 1, 2, 0, 2, 3];
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  // Placed by its shader, not by its vertices: there is nothing for the frustum test to measure.
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  mesh.setEnabled(false);
  // Compiled now, so the first turn does not wait for it.
  void material.forceCompilationAsync(mesh).catch(() => { /* The scene can already be gone. */ });

  const radiusClip = new Vector2();
  const color = new Color4(COLOR[0], COLOR[1], COLOR[2], 0);
  let disposed = false;

  function hide(): void {
    if (mesh.isEnabled()) mesh.setEnabled(false);
  }

  return {
    show(point, level) {
      if (disposed) return;
      const camera = scene.activeCamera;
      const opacity = COMPASS_CENTER_SPHERE_OPACITY * Math.max(0, Math.min(1, level));
      const width = canvas.clientWidth * (camera?.viewport.width ?? 1);
      const height = canvas.clientHeight * (camera?.viewport.height ?? 1);
      if (!point || !camera || !(opacity > 0) || !(width > 0) || !(height > 0) || ![point.x, point.y, point.z].every(Number.isFinite)) {
        hide();
        return;
      }
      if (!mesh.position.equals(point)) mesh.position.copyFrom(point);
      radiusClip.set(2 * COMPASS_CENTER_SPHERE_RADIUS_PX / width, 2 * COMPASS_CENTER_SPHERE_RADIUS_PX / height);
      material.setVector2("radiusClip", radiusClip);
      // One device pixel of rim, as a share of the radius.
      material.setFloat("edge", 1 / (COMPASS_CENTER_SPHERE_RADIUS_PX * (scene.getEngine().getRenderHeight() / canvas.clientHeight || 1)));
      color.a = opacity;
      material.setColor4("color", color);
      if (!mesh.isEnabled()) mesh.setEnabled(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.dispose();
      material.dispose();
    },
  };
}
