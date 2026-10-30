/**
 * The red tint on the map surface inside an aircraft's shown loading region
 * (`TerrainRegionLease.setVisible`): where the ground cuts into the volume
 * whose detail readiness waits for. Each map material carries the plugin
 * from creation; the scene's one region is uniforms. Only the views show it:
 * render targets draw the map in its own colour.
 */
import { MaterialDefines, MaterialPluginBase, ShaderLanguage, type Material, type Scene, type UniformBuffer } from "@babylonjs/core";
import { isMaterialOfClass } from "./imagery/terrainLightPlugin.js";

/**
 * A region the map surface is tinted red inside: a sphere, and optionally a
 * cone from its center. Scene coordinates, metres.
 */
export interface TerrainRegionHighlightVolume {
  center: { x: number; y: number; z: number };
  radiusMeters: number;
  /** `axis` is a unit vector in the scene; the cone ends in a flat disk `lengthMeters` along it. */
  cone?: { axis: { x: number; y: number; z: number }; lengthMeters: number; halfAngleDeg: number };
}

/** The tint: half red inside, deeper where the surface meets the region's boundary. */
const RED_DISPLAY = "vec3(1.0, 0.16, 0.12)";
const RED_LINEAR = "vec3(1.0, 0.022, 0.012)";
const INSIDE_MIX = 0.5, BOUNDARY_MIX = 0.9;

class TerrainRegionHighlightDefines extends MaterialDefines {
  TERRAIN_REGION_HIGHLIGHT = false;
}

interface SceneHighlight {
  /**
   * Whether the scene's map shaders have the highlight: from the first region
   * set on, so clearing it and setting another are uniforms, never a
   * recompile that leaves the map undrawn for a frame.
   */
  compiled: boolean;
  volume: TerrainRegionHighlightVolume | null;
  plugins: Set<TerrainRegionHighlightPlugin>;
  /**
   * Whether the scene is drawing its render targets. They read the map's own
   * colour, as the sky's ground-light probe does, so they never see the tint.
   */
  drawingTargets: boolean;
}

const SCENE_HIGHLIGHTS = new WeakMap<Scene, SceneHighlight>();

function sceneHighlight(scene: Scene): SceneHighlight {
  let highlight = SCENE_HIGHLIGHTS.get(scene);
  if (!highlight) {
    const created: SceneHighlight = { compiled: false, volume: null, plugins: new Set(), drawingTargets: false };
    // A scene draws its render targets, and each camera its own, between these two.
    scene.onBeforeRenderTargetsRenderObservable.add(() => { created.drawingTargets = true; });
    scene.onAfterRenderTargetsRenderObservable.add(() => { created.drawingTargets = false; });
    highlight = created;
    SCENE_HIGHLIGHTS.set(scene, highlight);
  }
  return highlight;
}

const PLUGIN_NAME = "TerrainRegionHighlight";

const UNIFORMS = ["terrainRegionSphere", "terrainRegionCone", "terrainRegionShape"] as const;

/**
 * How far inside the region a point is, m; negative outside. The sphere's
 * depth is its distance to the sphere's surface. The cone's is the least of
 * its distance to the cone's side and to its end disk; the union takes the
 * greater of the two.
 */
const GLSL_DEPTH = `#ifdef TERRAIN_REGION_HIGHLIGHT
float terrainRegionDepth(vec3 positionW) {
  vec3 offset = positionW - terrainRegionSphere.xyz;
  float depth = terrainRegionSphere.w - length(offset);
  if (terrainRegionCone.w > 0.0) {
    float along = dot(offset, terrainRegionCone.xyz);
    float across = length(offset - along * terrainRegionCone.xyz);
    depth = max(depth, min((along * terrainRegionShape.x - across) * terrainRegionShape.y, terrainRegionCone.w - along));
  }
  return depth;
}
#endif`;

const WGSL_DEPTH = `#ifdef TERRAIN_REGION_HIGHLIGHT
fn terrainRegionDepth(positionW: vec3f) -> f32 {
  let offset = positionW - uniforms.terrainRegionSphere.xyz;
  var depth = uniforms.terrainRegionSphere.w - length(offset);
  if (uniforms.terrainRegionCone.w > 0.0) {
    let along = dot(offset, uniforms.terrainRegionCone.xyz);
    let across = length(offset - along * uniforms.terrainRegionCone.xyz);
    depth = max(depth, min((along * uniforms.terrainRegionShape.x - across) * uniforms.terrainRegionShape.y, uniforms.terrainRegionCone.w - along));
  }
  return depth;
}
#endif`;

/**
 * Tints a map tile's final colour red where its surface is inside the
 * scene's highlighted region. Until a scene has one, the shader is unchanged.
 */
class TerrainRegionHighlightPlugin extends MaterialPluginBase {
  private readonly highlight: SceneHighlight;

  constructor(material: Material) {
    // After the terrain light (300): it tints the lit colour.
    super(material, PLUGIN_NAME, 400, new TerrainRegionHighlightDefines(), true, true);
    this.highlight = sceneHighlight(material.getScene());
    this.highlight.plugins.add(this);
  }

  /** Read from the material, as the terrain light does: the base class asks for the shader code before this class's fields are set. */
  private get finalColour(): string {
    return isMaterialOfClass(this._material, "PBRBaseMaterial") ? "finalColor" : "color";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: TerrainRegionHighlightDefines): void {
    defines.TERRAIN_REGION_HIGHLIGHT = this.highlight.compiled;
  }

  override getUniforms(shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL) {
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    return {
      ubo: UNIFORMS.map(name => ({ name, size: 4, type: "vec4" })),
      fragment: `#ifdef TERRAIN_REGION_HIGHLIGHT\n${UNIFORMS.map(name => wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`).join("\n")}\n#endif`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (!this.highlight.compiled) return;
    const volume = this.highlight.drawingTargets ? null : this.highlight.volume;
    // No region, or a render target: a sphere nothing is inside.
    if (!volume) {
      uniformBuffer.updateFloat4("terrainRegionSphere", 0, 0, 0, -1);
      uniformBuffer.updateFloat4("terrainRegionCone", 0, 0, 0, 0);
      return;
    }
    // With large-world rendering a shader's positions are relative to the eye.
    const eye = this._material.getScene().floatingOriginOffset;
    const { center, cone } = volume;
    uniformBuffer.updateFloat4("terrainRegionSphere", center.x - eye.x, center.y - eye.y, center.z - eye.z, volume.radiusMeters);
    const halfAngle = (cone?.halfAngleDeg ?? 0) * Math.PI / 180;
    uniformBuffer.updateFloat4("terrainRegionCone", cone?.axis.x ?? 0, cone?.axis.y ?? 0, cone?.axis.z ?? 0, cone?.lengthMeters ?? 0);
    // The boundary's deeper band: a few percent of the sphere, at least a quarter metre.
    uniformBuffer.updateFloat4("terrainRegionShape", Math.tan(halfAngle), Math.cos(halfAngle), Math.max(0.25, volume.radiusMeters * 0.04), 0);
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): { [pointName: string]: string } | null {
    if (shaderType !== "fragment") return null;
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    const colour = this.finalColour;
    const red = (value: string): string => (wgsl ? value.replace("vec3(", "vec3f(") : value);
    const shape = wgsl ? "uniforms.terrainRegionShape" : "terrainRegionShape";
    const tint = `mix(${INSIDE_MIX.toFixed(1)}, ${BOUNDARY_MIX.toFixed(1)}, 1.0 - smoothstep(0.0, ${shape}.z, terrainRegionInside))`;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? WGSL_DEPTH : GLSL_DEPTH,
      // After image processing: the colour is linear when a post-process does it, display-encoded otherwise.
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: wgsl
        ? `#ifdef TERRAIN_REGION_HIGHLIGHT
let terrainRegionInside = terrainRegionDepth(fragmentInputs.vPositionW);
if (terrainRegionInside > 0.0) {
#ifdef IMAGEPROCESSINGPOSTPROCESS
  ${colour} = vec4f(mix(${colour}.rgb, ${red(RED_LINEAR)}, ${tint}), ${colour}.a);
#else
  ${colour} = vec4f(mix(${colour}.rgb, ${red(RED_DISPLAY)}, ${tint}), ${colour}.a);
#endif
}
#endif`
        : `#ifdef TERRAIN_REGION_HIGHLIGHT
float terrainRegionInside = terrainRegionDepth(vPositionW);
if (terrainRegionInside > 0.0) {
#ifdef IMAGEPROCESSINGPOSTPROCESS
  ${colour}.rgb = mix(${colour}.rgb, ${RED_LINEAR}, ${tint});
#else
  ${colour}.rgb = mix(${colour}.rgb, ${RED_DISPLAY}, ${tint});
#endif
}
#endif`,
    };
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.highlight.plugins.delete(this);
    super.dispose(forceDisposeTextures);
  }

  override getClassName(): string {
    return "TerrainRegionHighlightMaterialPlugin";
  }
}

/**
 * Lets a map material show the scene's highlighted region. At most once a
 * material; returns whether it attached.
 */
export function attachTerrainRegionHighlight(material: Material): boolean {
  if (material.pluginManager?.getPlugin(PLUGIN_NAME)) return false;
  new TerrainRegionHighlightPlugin(material);
  return true;
}

/**
 * Sets the region the scene's map surface is tinted red inside, or null for
 * none. The first region a scene is given recompiles its map materials;
 * after that, setting, moving and clearing one are uniforms. Returns whether
 * anything changed.
 */
export function setTerrainRegionHighlight(scene: Scene, volume: TerrainRegionHighlightVolume | null): boolean {
  const highlight = sceneHighlight(scene);
  const copy = (point: { x: number; y: number; z: number }) => ({ x: point.x, y: point.y, z: point.z });
  // Copied field by field: a Babylon vector keeps its coordinates behind accessors.
  const next: TerrainRegionHighlightVolume | null = volume && { center: copy(volume.center), radiusMeters: volume.radiusMeters,
    ...(volume.cone ? { cone: { axis: copy(volume.cone.axis), lengthMeters: volume.cone.lengthMeters, halfAngleDeg: volume.cone.halfAngleDeg } } : {}) };
  if (JSON.stringify(next) === JSON.stringify(highlight.volume)) return false;
  highlight.volume = next;
  if (next && !highlight.compiled) {
    highlight.compiled = true;
    for (const plugin of highlight.plugins) plugin.markAllDefinesAsDirty();
  }
  return true;
}

/**
 * How far inside the region a point of the scene is, m, negative outside, as
 * the shader computes it: for readings and tests.
 */
export function terrainRegionHighlightDepth(volume: TerrainRegionHighlightVolume, point: { x: number; y: number; z: number }): number {
  const offset = [point.x - volume.center.x, point.y - volume.center.y, point.z - volume.center.z] as const;
  let depth = volume.radiusMeters - Math.hypot(...offset);
  const cone = volume.cone;
  if (cone && cone.lengthMeters > 0) {
    const along = offset[0] * cone.axis.x + offset[1] * cone.axis.y + offset[2] * cone.axis.z;
    const across = Math.hypot(offset[0] - along * cone.axis.x, offset[1] - along * cone.axis.y, offset[2] - along * cone.axis.z);
    const halfAngle = cone.halfAngleDeg * Math.PI / 180;
    depth = Math.max(depth, Math.min((along * Math.tan(halfAngle) - across) * Math.cos(halfAngle), cone.lengthMeters - along));
  }
  return depth;
}

/** The region now set, or null: for tests and diagnostics. */
export function getTerrainRegionHighlight(scene: Scene): TerrainRegionHighlightVolume | null {
  return SCENE_HIGHLIGHTS.get(scene)?.volume ?? null;
}
