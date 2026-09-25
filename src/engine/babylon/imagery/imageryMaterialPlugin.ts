import {
  MaterialDefines,
  MaterialPluginBase,
  ShaderLanguage,
  type AbstractMesh,
  type Material,
  type Scene,
  type UniformBuffer,
} from "@babylonjs/core";
import { IMAGERY_GUTTER, IMAGERY_MAX_SAMPLED_LOD, IMAGERY_PAGE_SIZE, IMAGERY_SLOT_SIZE } from "./imageryAtlasLayout";
import type { ImageryAtlas } from "./imageryAtlas";

class ImageryAtlasDefines extends MaterialDefines {
  IMAGERY_ATLAS = false;
  /** 2: textureGrad; 1: WebGL 1 with EXT_shader_texture_lod; 0: implicit derivatives only. */
  IMAGERY_GRAD_MODE = 2;
}

const MAX_TEXELS_PER_PIXEL = 2 ** IMAGERY_MAX_SAMPLED_LOD;
const CONSTANTS = {
  slot: IMAGERY_SLOT_SIZE.toFixed(1),
  gutter: IMAGERY_GUTTER.toFixed(1),
  page: IMAGERY_PAGE_SIZE.toFixed(1),
  maxTexels: MAX_TEXELS_PER_PIXEL.toFixed(1),
};

// The page table is sampled once per fragment; derivatives come from the
// patch-local UV, so level boundaries between neighbouring pages do not
// disturb the mip level, and precision stays per patch at any zoom.
const GLSL_FRAGMENT_DEFINITIONS = `
#ifdef IMAGERY_ATLAS
uniform sampler2D imageryAtlas;
uniform sampler2D imageryPageTable;
varying vec2 vImageryUV;
vec4 imageryEntry(vec2 uv, out vec2 node, out float cellsLog2) {
  cellsLog2 = imageryTable.z;
  node = vec2(0.0);
  if (cellsLog2 < 0.0) {
    return vec4(mod(imageryFallback.x, 256.0), floor(imageryFallback.x / 256.0), imageryFallback.y, imageryFallback.z * 255.0);
  }
  float cells = exp2(cellsLog2);
  vec2 cell = clamp(floor(uv * cells), vec2(0.0), vec2(cells - 1.0));
  node = cell;
  return floor(texture2D(imageryPageTable, (imageryTable.xy + cell + 0.5) / imageryTable.w) * 255.0 + 0.5);
}
vec4 imagerySample(vec2 uv, vec2 dx, vec2 dy) {
  vec2 cell;
  float cellsLog2;
  vec4 entry = imageryEntry(uv, cell, cellsLog2);
  if (entry.a < 128.0) return vec4(0.16, 0.18, 0.2, 1.0);
  float slot = entry.r + entry.g * 256.0;
  float dz = entry.b - imageryPatch.x;
  vec2 local;
  if (dz >= 0.0) {
    float scale = exp2(dz);
    vec2 node = cellsLog2 >= 0.0
      ? floor(cell / exp2(cellsLog2 - dz))
      : clamp(floor(uv * scale), vec2(0.0), vec2(scale - 1.0));
    local = clamp(uv * scale - node, 0.0, 1.0);
  } else {
    float n = exp2(-dz);
    local = (mod(imageryPatch.yz, vec2(n)) + uv) / n;
  }
  vec2 slotXY = vec2(mod(slot, imageryAtlasInfo.z), floor(slot / imageryAtlasInfo.z));
  vec2 atlasUV = (slotXY * ${CONSTANTS.slot} + ${CONSTANTS.gutter} + local * ${CONSTANTS.page}) / imageryAtlasInfo.xy;
  float texelsPerUV = exp2(dz) * ${CONSTANTS.page};
  vec2 gx = dx * texelsPerUV;
  vec2 gy = dy * texelsPerUV;
  float widest = max(length(gx), length(gy));
  float clampToLod = widest > ${CONSTANTS.maxTexels} ? ${CONSTANTS.maxTexels} / widest : 1.0;
  gx = gx * clampToLod / imageryAtlasInfo.xy;
  gy = gy * clampToLod / imageryAtlasInfo.xy;
#if IMAGERY_GRAD_MODE == 2
  return textureGrad(imageryAtlas, atlasUV, gx, gy);
#elif IMAGERY_GRAD_MODE == 1
  return texture2DGradEXT(imageryAtlas, atlasUV, gx, gy);
#else
  return texture2D(imageryAtlas, atlasUV);
#endif
}
#endif
`;

const WGSL_FRAGMENT_DEFINITIONS = `
#ifdef IMAGERY_ATLAS
var imageryAtlasSampler: sampler;
var imageryAtlas: texture_2d<f32>;
var imageryPageTableSampler: sampler;
var imageryPageTable: texture_2d<f32>;
varying vImageryUV: vec2f;
fn imageryModulo(value: vec2f, divisor: f32) -> vec2f {
  return value - divisor * floor(value / divisor);
}
fn imagerySample(uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let cellsLog2 = uniforms.imageryTable.z;
  var cell = vec2f(0.0);
  var entry: vec4f;
  if (cellsLog2 < 0.0) {
    let fallback = uniforms.imageryFallback;
    entry = vec4f(fallback.x - 256.0 * floor(fallback.x / 256.0), floor(fallback.x / 256.0), fallback.y, fallback.z * 255.0);
  } else {
    let cells = exp2(cellsLog2);
    cell = clamp(floor(uv * cells), vec2f(0.0), vec2f(cells - 1.0));
    let tableUV = (uniforms.imageryTable.xy + cell + vec2f(0.5)) / uniforms.imageryTable.w;
    entry = floor(textureSampleLevel(imageryPageTable, imageryPageTableSampler, tableUV, 0.0) * 255.0 + vec4f(0.5));
  }
  if (entry.a < 128.0) {
    return vec4f(0.16, 0.18, 0.2, 1.0);
  }
  let slot = entry.r + entry.g * 256.0;
  let dz = entry.b - uniforms.imageryPatch.x;
  var local: vec2f;
  if (dz >= 0.0) {
    let scale = exp2(dz);
    var node: vec2f;
    if (cellsLog2 >= 0.0) {
      node = floor(cell / exp2(cellsLog2 - dz));
    } else {
      node = clamp(floor(uv * scale), vec2f(0.0), vec2f(scale - 1.0));
    }
    local = clamp(uv * scale - node, vec2f(0.0), vec2f(1.0));
  } else {
    let n = exp2(-dz);
    local = (imageryModulo(uniforms.imageryPatch.yz, n) + uv) / n;
  }
  let perRow = uniforms.imageryAtlasInfo.z;
  let slotXY = vec2f(slot - perRow * floor(slot / perRow), floor(slot / perRow));
  let atlasUV = (slotXY * ${CONSTANTS.slot} + vec2f(${CONSTANTS.gutter}) + local * ${CONSTANTS.page}) / uniforms.imageryAtlasInfo.xy;
  let texelsPerUV = exp2(dz) * ${CONSTANTS.page};
  var gx = dx * texelsPerUV;
  var gy = dy * texelsPerUV;
  let widest = max(length(gx), length(gy));
  let clampToLod = select(1.0, ${CONSTANTS.maxTexels} / widest, widest > ${CONSTANTS.maxTexels});
  gx = gx * clampToLod / uniforms.imageryAtlasInfo.xy;
  gy = gy * clampToLod / uniforms.imageryAtlasInfo.xy;
  return textureSampleGrad(imageryAtlas, imageryAtlasSampler, atlasUV, gx, gy);
}
#endif
`;

/**
 * Samples terrain colour from the paged imagery atlas instead of a per-tile
 * texture. Every terrain patch has its own instance with its tile and
 * page-table block; the shader is the same for all of them, so moving pages
 * or the slider never compiles or allocates anything per tile.
 */
export class ImageryAtlasMaterialPlugin extends MaterialPluginBase {
  private atlas: ImageryAtlas | null = null;
  private patch: [number, number, number] = [0, 0, 0];
  private tableBlock: [number, number, number] = [0, 0, -1];
  private fallback: [number, number, number] = [0, 0, 0];

  constructor(material: Material) {
    super(material, "ImageryAtlas", 200, new ImageryAtlasDefines(), true, true);
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  setAtlas(atlas: ImageryAtlas | null): void {
    const changed = (this.atlas === null) !== (atlas === null);
    this.atlas = atlas;
    if (changed) this.markAllDefinesAsDirty();
  }

  /** The terrain tile this material draws. */
  setPatch(z: number, x: number, y: number): void {
    this.patch = [z, x, y];
  }

  /** The patch's page-table block origin and depth, or a single fallback page when it has no block. */
  setTable(block: { x: number; y: number; cellsLog2: number } | null, fallback: { slot: number; level: number } | null): void {
    this.tableBlock = block ? [block.x, block.y, block.cellsLog2] : [0, 0, -1];
    this.fallback = fallback ? [fallback.slot, fallback.level, 1] : [0, 0, 0];
  }

  override prepareDefines(defines: ImageryAtlasDefines, scene: Scene): void {
    const engine = scene.getEngine() as unknown as { isWebGPU?: boolean; webGLVersion?: number; getCaps(): { textureLOD?: boolean; standardDerivatives?: boolean } };
    defines.IMAGERY_ATLAS = this.atlas !== null;
    const caps = engine.getCaps();
    defines.IMAGERY_GRAD_MODE = engine.isWebGPU || engine.webGLVersion !== 1 ? 2 : caps.textureLOD && caps.standardDerivatives ? 1 : 0;
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (this.atlas && mesh.isVerticesDataPresent("uv") && !attributes.includes("uv")) attributes.push("uv");
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("imageryAtlas", "imageryPageTable");
  }

  override getUniforms(shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL) {
    return {
      ubo: [
        { name: "imageryPatch", size: 4, type: "vec4" },
        { name: "imageryTable", size: 4, type: "vec4" },
        { name: "imageryAtlasInfo", size: 4, type: "vec4" },
        { name: "imageryFallback", size: 4, type: "vec4" },
      ],
      fragment: shaderLanguage === ShaderLanguage.WGSL
        ? `#ifdef IMAGERY_ATLAS
uniform imageryPatch: vec4f;
uniform imageryTable: vec4f;
uniform imageryAtlasInfo: vec4f;
uniform imageryFallback: vec4f;
#endif`
        : `#ifdef IMAGERY_ATLAS
uniform vec4 imageryPatch;
uniform vec4 imageryTable;
uniform vec4 imageryAtlasInfo;
uniform vec4 imageryFallback;
#endif`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const atlas = this.atlas;
    if (!atlas) return;
    const { layout } = atlas;
    uniformBuffer.updateFloat4("imageryPatch", this.patch[0], this.patch[1], this.patch[2], 0);
    uniformBuffer.updateFloat4("imageryTable", this.tableBlock[0], this.tableBlock[1], this.tableBlock[2], layout.tableSize);
    uniformBuffer.updateFloat4("imageryAtlasInfo", layout.width, layout.height, layout.slotsPerRow, 0);
    uniformBuffer.updateFloat4("imageryFallback", this.fallback[0], this.fallback[1], this.fallback[2], 0);
    uniformBuffer.setTexture("imageryAtlas", atlas.texture);
    uniformBuffer.setTexture("imageryPageTable", atlas.table);
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): { [pointName: string]: string } | null {
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return shaderType === "vertex"
        ? {
          CUSTOM_VERTEX_DEFINITIONS: `#ifdef IMAGERY_ATLAS
#ifndef UV1
attribute uv: vec2f;
#endif
varying vImageryUV: vec2f;
#endif`,
          CUSTOM_VERTEX_MAIN_END: `#ifdef IMAGERY_ATLAS
vertexOutputs.vImageryUV = vertexInputs.uv;
#endif`,
        }
        : {
          CUSTOM_FRAGMENT_DEFINITIONS: WGSL_FRAGMENT_DEFINITIONS,
          CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef IMAGERY_ATLAS
let imageryDx = dpdx(fragmentInputs.vImageryUV);
let imageryDy = dpdy(fragmentInputs.vImageryUV);
#endif`,
          CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#ifdef IMAGERY_ATLAS
baseColor = imagerySample(fragmentInputs.vImageryUV, imageryDx, imageryDy);
#endif`,
        };
    }
    return shaderType === "vertex"
      ? {
        CUSTOM_VERTEX_DEFINITIONS: `#ifdef IMAGERY_ATLAS
#ifndef UV1
attribute vec2 uv;
#endif
varying vec2 vImageryUV;
#endif`,
        CUSTOM_VERTEX_MAIN_END: `#ifdef IMAGERY_ATLAS
vImageryUV = uv;
#endif`,
      }
      : {
        CUSTOM_FRAGMENT_EXTENSION: `#if defined(IMAGERY_ATLAS) && IMAGERY_GRAD_MODE == 1
#extension GL_OES_standard_derivatives : enable
#extension GL_EXT_shader_texture_lod : enable
#endif`,
        CUSTOM_FRAGMENT_DEFINITIONS: GLSL_FRAGMENT_DEFINITIONS,
        CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef IMAGERY_ATLAS
vec2 imageryDx = dFdx(vImageryUV);
vec2 imageryDy = dFdy(vImageryUV);
#endif`,
        CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#ifdef IMAGERY_ATLAS
baseColor = imagerySample(vImageryUV, imageryDx, imageryDy);
#endif`,
      };
  }

  override getClassName(): string {
    return "ImageryAtlasMaterialPlugin";
  }
}
