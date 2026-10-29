import {
  MaterialDefines,
  MaterialPluginBase,
  ShaderLanguage,
  StandardMaterial,
  type BaseTexture,
  type Material,
  type Scene,
  type UniformBuffer,
} from "@babylonjs/core";
import { WGS84_E2 } from "../../camera/cameraMath.js";


type Rgb = [number, number, number];
type Vec3 = readonly [number, number, number];
export interface TerrainLightTablePorts {
  GROUND_LIGHT_TABLE: { fromDeg: number; fineToDeg: number; fineStepDeg: number; coarseStepDeg: number; fadeDeg: number };
  GROUND_LIGHT_SAMPLES: number;
  GROUND_LIGHT_LEAST_SINE: number;
  MERCATOR_MAX_LAT_DEG: number;
  NIGHT_RADIANCE_UNITS: number;
  groundLightAt(table: Float32Array, mu: number, out?: Rgb): Rgb;
}
export interface TerrainLightingMaterialPlugin extends MaterialPluginBase {
  getUniforms(shaderLanguage?: ShaderLanguage): {
    ubo: Array<{ name: string; size: number; type: string; arraySize?: number }>;
    fragment: string;
  };
}
export interface TerrainLightingAdapter {
  readonly MaterialPlugin: new (material: Material) => TerrainLightingMaterialPlugin;
  setTerrainLighting(scene: Scene, lighting: TerrainLighting | null): boolean;
  setTerrainNightLightMap(scene: Scene, map: TerrainNightLightMap | null): boolean;
  getTerrainNightLightMap(scene: Scene): TerrainNightLightMap | null;
  setTerrainLocalLights(scene: Scene, lights: readonly TerrainLocalLight[]): boolean;
  getTerrainLighting(scene: Scene): TerrainLighting | null;
  getTerrainLocalLights(scene: Scene): readonly TerrainLocalLight[];
  terrainLightFactor(lighting: TerrainLighting, local: readonly TerrainLocalLight[], position: Vec3, nightRadiance?: number): Rgb;
  isUnlitMaterial(material: Material): boolean;
  followTerrainLight(material: Material): boolean;
  createMaterialPlugin(material: Material): TerrainLightingMaterialPlugin;
}

export interface TerrainLighting {
  perPoint: boolean;
  /** The Earth's centre in the scene's coordinates, m: a pixel's up is its direction from here. */
  centre: Vec3;
  /** Unit vectors in the scene towards the Sun and the Moon. */
  sunDirection: Vec3;
  moonDirection: Vec3;
  /** Multiplies the table for the Sun: its illuminance above the air in each band, over white, × reflectance / π. */
  sunScale: Readonly<Rgb>;
  /** The same for the Moon; zero where it is not modelled. */
  moonScale: Readonly<Rgb>;
  /** Added everywhere: the night sky's light on the ground, or, when not per point, the whole factor. */
  ambient: Readonly<Rgb>;
  /**
   * The natural logarithm of the light on level ground at sea level, the
   * body's own and the sky's, per unit of its illuminance above the air and
   * over `groundLightWeight` of its height: four floats a sample (red,
   * green, blue and one unused), at `groundLightTableElevationDeg` of each
   * index (src/sky/skyState.ts).
   */
  table: Float32Array;
  /** The night lights, read from the map `setTerrainNightLightMap` sets; none when null or absent. */
  night?: TerrainNightLighting | null;
}
export interface TerrainNightLighting {
  /** Unit vectors in the scene along the Earth's x, y and z axes, which place a pixel on the map. */
  axes: readonly [Vec3, Vec3, Vec3];
  /** Added to the factor on linear colour per nW/(cm² sr): the lamps' illuminance per unit, over white, × reflectance / π, in each band. */
  light: Readonly<Rgb>;
  /** Added to the linear colour per nW/(cm² sr): the luminance the satellite saw per unit, over white, in each band. */
  picture: Readonly<Rgb>;
  /** Radiance taken as no lamp's, nW/(cm² sr). */
  floor: number;
  /**
   * The sine of the Sun's height at or below which lamps are on, as a
   * photocell switches them where daylight has fallen to its level: each
   * place's lamps are on or off, never between. Absent, they are on everywhere.
   */
  switchSine?: number;
}
export interface TerrainNightLightMap {
  texture: BaseTexture;
  zoom: number;
  x: number;
  y: number;
  tiles: number;
}
export interface TerrainLocalLight {
  /** In the scene's coordinates, m. */
  position: Vec3;
  /** Unit vector along the beam's axis, in the scene. */
  direction: Vec3;
  /** Full intensity within the inner half-angle, none beyond the outer: their cosines. */
  cosInner: number;
  cosOuter: number;
  /** Intensity on the axis in each band, cd, over white, × reflectance / π: a factor on linear colour at one metre. */
  factor: Readonly<Rgb>;
}
export const DISPLAY_GAMMA = 2.2;
export const TERRAIN_LOCAL_LIGHTS_MAX = 4;
/**
 * Whether a material is of Babylon's class with this name, or of a class derived from it, by each class's own
 * `getClassName()`. It stands for `instanceof` with the PBR classes, which imported here would bring all of
 * Babylon's PBR material code into the page's startup, though only glTF models (3D Tiles, loaded later) use it.
 */
export function isMaterialOfClass(material: Material, className: string): boolean {
  for (let proto: unknown = Object.getPrototypeOf(material); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const own = Object.getOwnPropertyDescriptor(proto, "getClassName")?.value as ((this: Material) => string) | undefined;
    if (own?.call(material) === className) return true;
  }
  return false;
}

/** Host scope owns one scene-light registry; sky table math is injected, never imported. */
export function createTerrainLightingAdapter(ports: TerrainLightTablePorts): TerrainLightingAdapter {
  const { GROUND_LIGHT_TABLE, GROUND_LIGHT_SAMPLES, GROUND_LIGHT_LEAST_SINE, MERCATOR_MAX_LAT_DEG, NIGHT_RADIANCE_UNITS, groundLightAt } = ports;
class TerrainLightDefines extends MaterialDefines {
  TERRAIN_LIGHT = false;
  /** The Sun's and the Moon's height found at each pixel's place, rather than one factor for all. */
  TERRAIN_LIGHT_PER_POINT = false;
  /** Local lights the shader evaluates, such as an aircraft's landing lights. */
  TERRAIN_LOCAL_LIGHTS = 0;
  /** Night lights read from a map of the radiance a satellite saw, at each pixel's place. */
  TERRAIN_NIGHT_LIGHTS = false;
}


/** Babylon's materials encode colour for the display with this exponent (`toGammaSpace`), and the standard material holds its colours so encoded. */


/** Local lights a terrain shader evaluates at most. */

/** The least width of a beam's soft edge, as a difference of cosines: a hundredth of a degree at the beam's edge. */
const BEAM_EDGE_COSINE = 1e-4;

/** A switch's sine no height of the Sun reaches: lamps on everywhere, for night lights without a switch. */
const LAMPS_ALWAYS_ON = 2;

const FINE_INTERVALS = (GROUND_LIGHT_TABLE.fineToDeg - GROUND_LIGHT_TABLE.fromDeg) / GROUND_LIGHT_TABLE.fineStepDeg;

/**
 * The light map imagery is shown under, for one scene. Every quantity is
 * already over the luminance the exposure shows as white, and times the
 * reflectance one unit of linear imagery colour stands for, over π: a factor
 * on linear colour.
 *
 * Per point, the shader finds the Sun's and the Moon's height at each
 * pixel's place and reads their light on level ground there from the table,
 * so the planet seen from afar has its day, twilight and night where they
 * are. Otherwise the whole map is shown under `ambient` alone: the light
 * below the viewpoint, right near it and cheaper, for a low flight on a slow
 * device.
 */


/**
 * How the radiance a satellite saw at a pixel's place, above a floor, shows
 * there (src/sky/nightLights.ts): as lamps' light on the imagery, added to
 * the factor, or as the satellite's own picture, added to the colour.
 */


/**
 * The night lights' map: radiance in a texture that wraps, holding a square
 * of `tiles` × `tiles` Web Mercator tiles of one zoom from column `x` and row
 * `y`, tile (x, y) in slot (x mod tiles, y mod tiles); red and green hold the
 * high and low bytes of radiance in `NIGHT_RADIANCE_UNITS`.
 */


/** A light that reaches the ground, such as a landing light: a beam with a soft edge, or every way when both cosines are -1. */


/**
 * The terrain light of one scene. Every terrain material of the scene reads
 * the same one; a standard material scales its display-encoded colour by the
 * factor's encoding, a PBR material its linear albedo by the factor.
 */
interface SceneTerrainLight {
  lighting: TerrainLighting | null;
  local: TerrainLocalLight[];
  nightMap: TerrainNightLightMap | null;
  plugins: Set<TerrainLightMaterialPlugin>;
}

const SCENE_LIGHTS = new WeakMap<Scene, SceneTerrainLight>();

function sceneLight(scene: Scene): SceneTerrainLight {
  let light = SCENE_LIGHTS.get(scene);
  if (!light) {
    light = { lighting: null, local: [], nightMap: null, plugins: new Set() };
    SCENE_LIGHTS.set(scene, light);
  }
  return light;
}

const PLUGIN_NAME = "TerrainLight";

/** Whether the shader reads the night lights: a light that has them, and a map to read. */
const hasNightLights = (light: SceneTerrainLight): boolean => Boolean(light.lighting?.night) && light.nightMap !== null;

/**
 * Sets the light every map tile of the scene is shown under, or null to show
 * imagery as it is, with a shader that has no trace of this. Switching
 * between none, per point and one factor, or night lights on and off,
 * recompiles; the light changing is uniforms. Returns whether anything
 * changed, so the caller draws a frame only then.
 */
function setTerrainLighting(scene: Scene, lighting: TerrainLighting | null): boolean {
  const light = sceneLight(scene);
  const previous = light.lighting;
  if (previous === lighting) return false;
  const hadNight = hasNightLights(light);
  light.lighting = lighting;
  if ((previous === null) !== (lighting === null) || (previous && lighting && previous.perPoint !== lighting.perPoint) || hadNight !== hasNightLights(light)) {
    for (const plugin of light.plugins) plugin.markAllDefinesAsDirty();
  }
  return true;
}

/**
 * Sets the night lights' map the scene's terrain reads, or null for none.
 * Its arriving or leaving recompiles while the light has night lights; a new
 * window or texture is uniforms. Returns whether anything changed.
 */
function setTerrainNightLightMap(scene: Scene, map: TerrainNightLightMap | null): boolean {
  const light = sceneLight(scene);
  const previous = light.nightMap;
  if (previous === map || (previous && map && previous.texture === map.texture && previous.zoom === map.zoom
    && previous.x === map.x && previous.y === map.y && previous.tiles === map.tiles)) return false;
  const hadNight = hasNightLights(light);
  light.nightMap = map;
  if (hadNight !== hasNightLights(light)) for (const plugin of light.plugins) plugin.markAllDefinesAsDirty();
  return true;
}

function getTerrainNightLightMap(scene: Scene): TerrainNightLightMap | null {
  return SCENE_LIGHTS.get(scene)?.nightMap ?? null;
}

/**
 * Sets the local lights terrain is lit by, at most `TERRAIN_LOCAL_LIGHTS_MAX`.
 * A change in their number recompiles; moving or dimming them is uniforms.
 * They show only while a terrain light is set. Returns whether anything
 * changed.
 */
function setTerrainLocalLights(scene: Scene, lights: readonly TerrainLocalLight[]): boolean {
  const light = sceneLight(scene);
  // A shader's smoothstep is undefined when its edges meet: a light every way gets an edge of its own.
  const next = lights.slice(0, TERRAIN_LOCAL_LIGHTS_MAX).map(local => ({ ...local, cosInner: Math.max(local.cosInner, local.cosOuter + BEAM_EDGE_COSINE) }));
  if (next.length === 0 && light.local.length === 0) return false;
  const recount = next.length !== light.local.length;
  light.local = next;
  if (recount) for (const plugin of light.plugins) plugin.markAllDefinesAsDirty();
  return true;
}

/** The light now set, or null: for tests and diagnostics. */
function getTerrainLighting(scene: Scene): TerrainLighting | null {
  return SCENE_LIGHTS.get(scene)?.lighting ?? null;
}

function getTerrainLocalLights(scene: Scene): readonly TerrainLocalLight[] {
  return SCENE_LIGHTS.get(scene)?.local ?? [];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const dot = (a: Vec3 | number[], b: Vec3 | number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The factor on linear imagery colour at a point of the scene, as the shader
 * computes it, for readings and tests: per point, the Sun's and the Moon's
 * light by their height there, plus the night sky's; then the local lights',
 * on level ground facing up from the Earth's centre; then the night lights',
 * for the radiance the map holds there, nW/(cm² sr), where the Sun is low
 * enough there for them to be switched on.
 */
function terrainLightFactor(lighting: TerrainLighting, local: readonly TerrainLocalLight[], position: Vec3, nightRadiance = 0): Rgb {
  const up = [position[0] - lighting.centre[0], position[1] - lighting.centre[1], position[2] - lighting.centre[2]];
  const length = Math.hypot(up[0], up[1], up[2]) || 1;
  up[0] /= length; up[1] /= length; up[2] /= length;
  const out: Rgb = [lighting.ambient[0], lighting.ambient[1], lighting.ambient[2]];
  if (lighting.night && dot(up, lighting.sunDirection) <= (lighting.night.switchSine ?? LAMPS_ALWAYS_ON)) {
    const above = Math.max(0, nightRadiance - lighting.night.floor);
    for (let band = 0; band < 3; band++) out[band] += above * lighting.night.light[band];
  }
  if (lighting.perPoint) {
    const sun = groundLightAt(lighting.table, dot(up, lighting.sunDirection));
    const moon = groundLightAt(lighting.table, dot(up, lighting.moonDirection));
    for (let band = 0; band < 3; band++) out[band] += sun[band] * lighting.sunScale[band] + moon[band] * lighting.moonScale[band];
  }
  for (const light of local) {
    const toLight = [light.position[0] - position[0], light.position[1] - position[1], light.position[2] - position[2]];
    const squared = Math.max(1, dot(toLight, toLight));
    const distance = Math.sqrt(squared);
    const l = [toLight[0] / distance, toLight[1] / distance, toLight[2] / distance];
    const spot = smoothstep(light.cosOuter, light.cosInner, -dot(l, light.direction));
    const facing = Math.max(0, dot(up, l));
    for (let band = 0; band < 3; band++) out[band] += (light.factor[band] * spot * facing) / squared;
  }
  return out;
}

/** Whether a material ignores the scene's lights: a standard material with its lighting off, or an unlit PBR one, as glTF's `KHR_materials_unlit` makes. */
function isUnlitMaterial(material: Material): boolean {
  return (material instanceof StandardMaterial && material.disableLighting)
    || (isMaterialOfClass(material, "PBRMaterial") && (material as Material & { unlit?: boolean }).unlit === true);
}

/**
 * The material policy for terrain whose materials its source decides, such
 * as Google 3D Tiles: an unlit material is shown under the scene's terrain
 * light, as 2D map imagery is, and a lit one is left to the scene's lights.
 * Returns whether it attached the light; at most once a material.
 */
function followTerrainLight(material: Material): boolean {
  if (!isUnlitMaterial(material) || material.pluginManager?.getPlugin(PLUGIN_NAME)) return false;
  new TerrainLightMaterialPlugin(material);
  return true;
}

/** A number as a GLSL or WGSL float literal. */
const float = (value: number): string => (Number.isInteger(value) ? `${value}.0` : `${value}`);

const T = GROUND_LIGHT_TABLE;
/** The table position of an elevation `e`, in both languages' syntax for this expression. */
const TABLE_X = `(e <= ${float(T.fineToDeg)} ? (e - ${float(T.fromDeg)}) / ${float(T.fineStepDeg)} : ${float(FINE_INTERVALS)} + (e - ${float(T.fineToDeg)}) / ${float(T.coarseStepDeg)})`;
/** The fade below the table's first sample, times what the table's light is held over (`groundLightWeight`). */
const SCALE = `(smoothstep(${float(T.fromDeg - T.fadeDeg)}, ${float(T.fromDeg)}, e) * max(mu, ${float(GROUND_LIGHT_LEAST_SINE)}))`;

/** The night lights' constants: latitude on the ellipsoid from a point on it, where Mercator ends, and radiance from the texture's two bytes. */
const NIGHT = {
  oneMinusE2: float(1 - WGS84_E2),
  maxLat: float((MERCATOR_MAX_LAT_DEG * Math.PI) / 180),
  twoPi: float(2 * Math.PI),
  quarterPi: float(Math.PI / 4),
  highByte: float((255 * 256) / NIGHT_RADIANCE_UNITS),
  lowByte: float(255 / NIGHT_RADIANCE_UNITS),
};

/**
 * GLSL: the radiance above the floor at a point of the ground, nW/(cm² sr).
 * Its latitude on the ellipsoid, exact on the surface, and longitude place it
 * on the Web Mercator map, in tiles of the window's zoom; the texture wraps,
 * and outside the window there is none. Where the Sun's height there has a
 * sine above the switch's, the lamps are off and there is none either.
 */
const GLSL_NIGHT = `#ifdef TERRAIN_NIGHT_LIGHTS
uniform sampler2D terrainNightMap;
float terrainNightRadiance(vec3 positionW) {
  vec3 p = positionW - terrainLightCentre.xyz;
  float x = dot(p, terrainNightAxisX.xyz);
  float y = dot(p, terrainNightAxisY.xyz);
  float lat = clamp(atan(dot(p, terrainNightAxisZ.xyz), ${NIGHT.oneMinusE2} * length(vec2(x, y))), -${NIGHT.maxLat}, ${NIGHT.maxLat});
  vec2 tile = vec2(atan(y, x) / ${NIGHT.twoPi} + 0.5, 0.5 - log(tan(${NIGHT.quarterPi} + 0.5 * lat)) / ${NIGHT.twoPi}) * terrainNightWindow.z;
  vec2 offset = tile - terrainNightWindow.xy;
  offset.x -= terrainNightWindow.z * floor(offset.x / terrainNightWindow.z);
  float inside = step(0.0, offset.y) * step(offset.x, terrainNightWindow.w) * step(offset.y, terrainNightWindow.w);
  vec4 texel = texture2D(terrainNightMap, tile / terrainNightWindow.w);
  float on = step(dot(p, terrainLightSun.xyz), terrainNightPicture.w * length(p));
  return max(texel.r * ${NIGHT.highByte} + texel.g * ${NIGHT.lowByte} - terrainNightLight.w, 0.0) * inside * on;
}
#endif`;

const WGSL_NIGHT = `#ifdef TERRAIN_NIGHT_LIGHTS
var terrainNightMapSampler: sampler;
var terrainNightMap: texture_2d<f32>;
fn terrainNightRadiance(positionW: vec3f) -> f32 {
  let p = positionW - uniforms.terrainLightCentre.xyz;
  let x = dot(p, uniforms.terrainNightAxisX.xyz);
  let y = dot(p, uniforms.terrainNightAxisY.xyz);
  let lat = clamp(atan2(dot(p, uniforms.terrainNightAxisZ.xyz), ${NIGHT.oneMinusE2} * length(vec2f(x, y))), -${NIGHT.maxLat}, ${NIGHT.maxLat});
  let area = uniforms.terrainNightWindow;
  let tile = vec2f(atan2(y, x) / ${NIGHT.twoPi} + 0.5, 0.5 - log(tan(${NIGHT.quarterPi} + 0.5 * lat)) / ${NIGHT.twoPi}) * area.z;
  var offset = tile - area.xy;
  offset.x = offset.x - area.z * floor(offset.x / area.z);
  let inside = step(0.0, offset.y) * step(offset.x, area.w) * step(offset.y, area.w);
  let texel = textureSampleLevel(terrainNightMap, terrainNightMapSampler, tile / area.w, 0.0);
  let on = step(dot(p, uniforms.terrainLightSun.xyz), uniforms.terrainNightPicture.w * length(p));
  return max(texel.r * ${NIGHT.highByte} + texel.g * ${NIGHT.lowByte} - uniforms.terrainNightLight.w, 0.0) * inside * on;
}
#endif`;

/**
 * GLSL. WebGL 1 may index a uniform array only by a loop's index, so there
 * the table is walked; WebGL 2 indexes it directly.
 */
function glslDefinitions(walkTable: boolean): string {
  const read = walkTable
    ? `  float base = 0.0;
  vec3 lower = terrainLightTable[0].rgb;
  vec3 upper = terrainLightTable[1].rgb;
  for (int i = 0; i < ${GROUND_LIGHT_SAMPLES - 1}; i++) {
    if (float(i) <= x) { base = float(i); lower = terrainLightTable[i].rgb; upper = terrainLightTable[i + 1].rgb; }
  }`
    : `  int index = int(min(floor(x), ${float(GROUND_LIGHT_SAMPLES - 2)}));
  float base = float(index);
  vec3 lower = terrainLightTable[index].rgb;
  vec3 upper = terrainLightTable[index + 1].rgb;`;
  return `#ifdef TERRAIN_LIGHT
#ifdef TERRAIN_LIGHT_PER_POINT
vec3 terrainGroundLight(float mu) {
  float e = degrees(asin(clamp(mu, -1.0, 1.0)));
  float x = clamp(${TABLE_X}, 0.0, ${float(GROUND_LIGHT_SAMPLES - 1)});
${read}
  return exp(mix(lower, upper, clamp(x - base, 0.0, 1.0))) * ${SCALE};
}
#endif
vec3 terrainLightAt(vec3 positionW) {
  vec3 up = normalize(positionW - terrainLightCentre.xyz);
  vec3 light = terrainLightAmbient.rgb;
#ifdef TERRAIN_LIGHT_PER_POINT
  light += terrainGroundLight(dot(up, terrainLightSun.xyz)) * terrainLightSunScale.rgb
    + terrainGroundLight(dot(up, terrainLightMoon.xyz)) * terrainLightMoonScale.rgb;
#endif
#if TERRAIN_LOCAL_LIGHTS > 0
  for (int i = 0; i < TERRAIN_LOCAL_LIGHTS; i++) {
    vec3 toLight = terrainLocalPosition[i].xyz - positionW;
    float squared = max(dot(toLight, toLight), 1.0);
    vec3 l = toLight * inversesqrt(squared);
    float spot = smoothstep(terrainLocalDirection[i].w, terrainLocalFactor[i].w, -dot(l, terrainLocalDirection[i].xyz));
    light += terrainLocalFactor[i].rgb * (spot * max(dot(up, l), 0.0) / squared);
  }
#endif
  return light;
}
${GLSL_NIGHT}
#endif`;
}

const WGSL_DEFINITIONS = `#ifdef TERRAIN_LIGHT
#ifdef TERRAIN_LIGHT_PER_POINT
fn terrainGroundLight(mu: f32) -> vec3f {
  let e = degrees(asin(clamp(mu, -1.0, 1.0)));
  var x: f32 = ${float(FINE_INTERVALS)} + (e - ${float(T.fineToDeg)}) / ${float(T.coarseStepDeg)};
  if (e <= ${float(T.fineToDeg)}) { x = (e - ${float(T.fromDeg)}) / ${float(T.fineStepDeg)}; }
  x = clamp(x, 0.0, ${float(GROUND_LIGHT_SAMPLES - 1)});
  let index = min(i32(floor(x)), ${GROUND_LIGHT_SAMPLES - 2});
  let lower = uniforms.terrainLightTable[index].rgb;
  let upper = uniforms.terrainLightTable[index + 1].rgb;
  return exp(mix(lower, upper, vec3f(clamp(x - f32(index), 0.0, 1.0)))) * ${SCALE};
}
#endif
fn terrainLightAt(positionW: vec3f) -> vec3f {
  let up = normalize(positionW - uniforms.terrainLightCentre.xyz);
  var light = uniforms.terrainLightAmbient.rgb;
#ifdef TERRAIN_LIGHT_PER_POINT
  light = light + terrainGroundLight(dot(up, uniforms.terrainLightSun.xyz)) * uniforms.terrainLightSunScale.rgb
    + terrainGroundLight(dot(up, uniforms.terrainLightMoon.xyz)) * uniforms.terrainLightMoonScale.rgb;
#endif
#if TERRAIN_LOCAL_LIGHTS > 0
  for (var i = 0; i < TERRAIN_LOCAL_LIGHTS; i++) {
    let toLight = uniforms.terrainLocalPosition[i].xyz - positionW;
    let squared = max(dot(toLight, toLight), 1.0);
    let l = toLight * inverseSqrt(squared);
    let spot = smoothstep(uniforms.terrainLocalDirection[i].w, uniforms.terrainLocalFactor[i].w, -dot(l, uniforms.terrainLocalDirection[i].xyz));
    light = light + uniforms.terrainLocalFactor[i].rgb * (spot * max(dot(up, l), 0.0) / squared);
  }
#endif
  return light;
}
${WGSL_NIGHT}
#endif`;

/** The plugin's uniforms, all vec4: names, and array lengths for the arrays. */
const UNIFORMS: ReadonlyArray<readonly [string, number]> = [
  ["terrainLightCentre", 0],
  ["terrainLightSun", 0],
  ["terrainLightMoon", 0],
  ["terrainLightSunScale", 0],
  ["terrainLightMoonScale", 0],
  ["terrainLightAmbient", 0],
  ["terrainLightTable", GROUND_LIGHT_SAMPLES],
  ["terrainLocalPosition", TERRAIN_LOCAL_LIGHTS_MAX],
  ["terrainLocalDirection", TERRAIN_LOCAL_LIGHTS_MAX],
  ["terrainLocalFactor", TERRAIN_LOCAL_LIGHTS_MAX],
  ["terrainNightAxisX", 0],
  ["terrainNightAxisY", 0],
  ["terrainNightAxisZ", 0],
  // The window: its first column and row, the tiles across the world at its zoom, and its tiles across.
  ["terrainNightWindow", 0],
  // The lamps' light per unit of radiance in rgb, and the floor in w.
  ["terrainNightLight", 0],
  // The satellite's picture per unit of radiance in rgb, and in w the sine of the Sun's height lamps are on at or below.
  ["terrainNightPicture", 0],
];

/**
 * The last components written into one uniform buffer. Every terrain submesh
 * binds the same light, so a later bind skips `updateFloat4` and
 * `updateFloatArray` when every component is `Object.is` to that write. The
 * first bind on a buffer writes them all. Arrays are copied: the local-light
 * arrays are filled in place, and the ground-light table can be updated in
 * place. A new buffer is a different key and cannot see this entry.
 *
 * Without storage of its own, Babylon forwards those writes to the effect
 * currently bound (`_currentEffect`). A new effect is empty, so the entry is
 * dropped and the next bind writes every uniform again.
 */
interface TerrainUniformWrite {
  effect: object | null;
  float4: Map<string, [number, number, number, number]>;
  arrays: Map<string, Float32Array>;
}

const TERRAIN_UNIFORM_WRITES = new WeakMap<UniformBuffer, TerrainUniformWrite>();

function boundEffect(buffer: UniformBuffer): object | null {
  return (buffer as UniformBuffer & { _currentEffect?: object | null })._currentEffect ?? null;
}

function uniformWrite(buffer: UniformBuffer): TerrainUniformWrite {
  const effect = boundEffect(buffer);
  const existing = TERRAIN_UNIFORM_WRITES.get(buffer);
  if (existing && existing.effect === effect) return existing;
  const write: TerrainUniformWrite = { effect, float4: new Map(), arrays: new Map() };
  TERRAIN_UNIFORM_WRITES.set(buffer, write);
  return write;
}

function sameFloat4(cached: readonly [number, number, number, number], x: number, y: number, z: number, w: number): boolean {
  return Object.is(cached[0], x) && Object.is(cached[1], y) && Object.is(cached[2], z) && Object.is(cached[3], w);
}

function sameFloats(cached: Float32Array, value: ArrayLike<number>): boolean {
  if (cached.length !== value.length) return false;
  for (let index = 0; index < cached.length; index++) if (!Object.is(cached[index], value[index])) return false;
  return true;
}

function writeFloat4(buffer: UniformBuffer, write: TerrainUniformWrite, name: string, x: number, y: number, z: number, w: number): void {
  const previous = write.float4.get(name);
  if (previous && sameFloat4(previous, x, y, z, w)) return;
  buffer.updateFloat4(name, x, y, z, w);
  if (previous) {
    previous[0] = x;
    previous[1] = y;
    previous[2] = z;
    previous[3] = w;
  } else write.float4.set(name, [x, y, z, w]);
}

function writeFloatArray(buffer: UniformBuffer, write: TerrainUniformWrite, name: string, value: Float32Array): void {
  const previous = write.arrays.get(name);
  if (previous && sameFloats(previous, value)) return;
  buffer.updateFloatArray(name, value);
  if (previous && previous.length === value.length) previous.set(value);
  else write.arrays.set(name, new Float32Array(value));
}

/**
 * Shows a terrain tile's imagery under the scene's terrain light, whichever
 * way the imagery reaches the tile: its own texture, the paged atlas, whose
 * plugin runs before this one, or a glTF material's albedo. Without a light
 * the shader is unchanged.
 */
class TerrainLightMaterialPlugin extends MaterialPluginBase {
  private readonly light: SceneTerrainLight;
  private readonly localArrays = {
    position: new Float32Array(TERRAIN_LOCAL_LIGHTS_MAX * 4),
    direction: new Float32Array(TERRAIN_LOCAL_LIGHTS_MAX * 4),
    factor: new Float32Array(TERRAIN_LOCAL_LIGHTS_MAX * 4),
  };

  constructor(material: Material) {
    // After the imagery atlas plugin (200), so it scales the colour that plugin samples.
    super(material, PLUGIN_NAME, 300, new TerrainLightDefines(), true, true);
    this.light = sceneLight(material.getScene());
    this.light.plugins.add(this);
  }

  /**
   * A PBR material's colour is linear where this scales it; a standard
   * material's is display-encoded. Read from the material, which the base
   * class holds before it registers the plugin's shader code: this class's
   * own fields are not yet set then, and a field read there chose the
   * standard material's injection point for every material, PBR included.
   */
  private get linearColour(): boolean {
    return isMaterialOfClass(this._material, "PBRBaseMaterial");
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: TerrainLightDefines): void {
    const lighting = this.light.lighting;
    defines.TERRAIN_LIGHT = lighting !== null;
    defines.TERRAIN_LIGHT_PER_POINT = lighting?.perPoint ?? false;
    defines.TERRAIN_LOCAL_LIGHTS = lighting ? this.light.local.length : 0;
    defines.TERRAIN_NIGHT_LIGHTS = hasNightLights(this.light);
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("terrainNightMap");
  }

  override getUniforms(shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL) {
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    const declare = ([name, length]: readonly [string, number]): string => wgsl
      ? `uniform ${name}: ${length > 0 ? `array<vec4f, ${length}>` : "vec4f"};`
      : `uniform vec4 ${name}${length > 0 ? `[${length}]` : ""};`;
    return {
      ubo: UNIFORMS.map(([name, length]) => ({ name, size: 4, type: "vec4", ...(length > 0 ? { arraySize: length } : {}) })),
      fragment: `#ifdef TERRAIN_LIGHT\n${UNIFORMS.map(declare).join("\n")}\n#endif`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const lighting = this.light.lighting;
    if (!lighting) return;
    const cached = uniformWrite(uniformBuffer);
    const vec = (name: string, value: Vec3 | Readonly<Rgb>): void => writeFloat4(uniformBuffer, cached, name, value[0], value[1], value[2], 0);
    // With large-world rendering a shader's positions are relative to the eye: places are given the same way, as Babylon's own lights are.
    const eye = this._material.getScene().floatingOriginOffset;
    vec("terrainLightCentre", [lighting.centre[0] - eye.x, lighting.centre[1] - eye.y, lighting.centre[2] - eye.z]);
    vec("terrainLightSun", lighting.sunDirection);
    vec("terrainLightMoon", lighting.moonDirection);
    vec("terrainLightSunScale", lighting.sunScale);
    vec("terrainLightMoonScale", lighting.moonScale);
    vec("terrainLightAmbient", lighting.ambient);
    writeFloatArray(uniformBuffer, cached, "terrainLightTable", lighting.table);
    const { position, direction, factor } = this.localArrays;
    position.fill(0);
    direction.fill(0);
    factor.fill(0);
    this.light.local.forEach((light, index) => {
      position.set([light.position[0] - eye.x, light.position[1] - eye.y, light.position[2] - eye.z, 0], index * 4);
      direction.set([light.direction[0], light.direction[1], light.direction[2], light.cosOuter], index * 4);
      factor.set([light.factor[0], light.factor[1], light.factor[2], light.cosInner], index * 4);
    });
    writeFloatArray(uniformBuffer, cached, "terrainLocalPosition", position);
    writeFloatArray(uniformBuffer, cached, "terrainLocalDirection", direction);
    writeFloatArray(uniformBuffer, cached, "terrainLocalFactor", factor);
    const night = lighting.night;
    const map = this.light.nightMap;
    if (!night || !map) return;
    vec("terrainNightAxisX", night.axes[0]);
    vec("terrainNightAxisY", night.axes[1]);
    vec("terrainNightAxisZ", night.axes[2]);
    writeFloat4(uniformBuffer, cached, "terrainNightWindow", map.x, map.y, 2 ** map.zoom, map.tiles);
    writeFloat4(uniformBuffer, cached, "terrainNightLight", night.light[0], night.light[1], night.light[2], night.floor);
    writeFloat4(uniformBuffer, cached, "terrainNightPicture", night.picture[0], night.picture[1], night.picture[2], night.switchSine ?? LAMPS_ALWAYS_ON);
    uniformBuffer.setTexture("terrainNightMap", map.texture);
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): { [pointName: string]: string } | null {
    if (shaderType !== "fragment") return null;
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    const engine = this._material.getScene().getEngine() as { isWebGPU?: boolean; webGLVersion?: number };
    const walkTable = !engine.isWebGPU && engine.webGLVersion === 1;
    const definitions = { CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? WGSL_DEFINITIONS : glslDefinitions(walkTable) };
    const position = wgsl ? "fragmentInputs.vPositionW" : "vPositionW";
    const at = `terrainLightAt(${position})`;
    const u = wgsl ? "uniforms." : "";
    // With night lights, the lamps' light joins the factor and the satellite's picture is added after it.
    const night = `${wgsl ? "let" : "float"} terrainNight = terrainNightRadiance(${position});`;
    const lit = `(${at} + terrainNight * ${u}terrainNightLight.rgb)`;
    const shown = `terrainNight * ${u}terrainNightPicture.rgb`;
    const gamma = float(DISPLAY_GAMMA);
    const inverse = float(1 / DISPLAY_GAMMA);
    // The PBR shader's albedo, before any light or the unlit path reads it.
    if (this.linearColour) {
      return {
        ...definitions,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef TERRAIN_LIGHT
#ifdef TERRAIN_NIGHT_LIGHTS
${night}
surfaceAlbedo = surfaceAlbedo * ${lit} + ${shown};
#else
${wgsl ? `surfaceAlbedo = surfaceAlbedo * ${at};` : `surfaceAlbedo *= ${at};`}
#endif
#endif`,
      };
    }
    // The standard material holds colour display-encoded, and decodes it before exposure: a sum is made of decoded colour.
    return {
      ...definitions,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#ifdef TERRAIN_LIGHT
#ifdef TERRAIN_NIGHT_LIGHTS
${night}
${wgsl
    ? `baseColor = vec4f(pow(pow(baseColor.rgb, vec3f(${gamma})) * ${lit} + ${shown}, vec3f(${inverse})), baseColor.a);`
    : `baseColor.rgb = pow(pow(baseColor.rgb, vec3(${gamma})) * ${lit} + ${shown}, vec3(${inverse}));`}
#else
${wgsl
    ? `baseColor = vec4f(baseColor.rgb * pow(${at}, vec3f(${inverse})), baseColor.a);`
    : `baseColor.rgb *= pow(${at}, vec3(${inverse}));`}
#endif
#endif`,
    };
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.light.plugins.delete(this);
    super.dispose(forceDisposeTextures);
  }

  override getClassName(): string {
    return "TerrainLightMaterialPlugin";
  }
}

  return { MaterialPlugin: TerrainLightMaterialPlugin, setTerrainLighting, setTerrainNightLightMap, getTerrainNightLightMap, setTerrainLocalLights,
    getTerrainLighting, getTerrainLocalLights, terrainLightFactor, isUnlitMaterial, followTerrainLight,
    createMaterialPlugin: material => new TerrainLightMaterialPlugin(material),
  };
}
