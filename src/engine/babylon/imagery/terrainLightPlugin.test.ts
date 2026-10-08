import { FreeCamera, NullEngine, PBRMaterial, Scene, ShaderLanguage, StandardMaterial, Vector3, type BaseTexture, type Material, type UniformBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEG_TO_RAD, geodeticToEcef, WGS84_E2 } from "../../../camera/cameraMath";
import { mercatorXY, nightPixelAt } from "../../../sky/nightLights";
import { GROUND_LIGHT_LEAST_SINE, GROUND_LIGHT_SAMPLES, groundLightTableElevationDeg, groundLightWeight } from "../../../sky/skyState";
import {
  followTerrainLight, getTerrainLighting, getTerrainLocalLights, getTerrainNightLightMap, isUnlitMaterial, setTerrainLighting,
  setTerrainLocalLights, setTerrainNightLightMap, terrainLightFactor, TerrainLightMaterialPlugin, type TerrainLighting, type TerrainLocalLight,
  type TerrainNightLighting, type TerrainNightLightMap,
} from "./terrainLightPlugin";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function scene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

const DEG = Math.PI / 180;

/** A table that holds e^(elevation / 10°): easy to read back, times what the table's light is held over. */
function table(): Float32Array {
  const values = new Float32Array(GROUND_LIGHT_SAMPLES * 4);
  for (let index = 0; index < GROUND_LIGHT_SAMPLES; index++) {
    const value = groundLightTableElevationDeg(index) / 10;
    values.set([value, value, value, 0], index * 4);
  }
  return values;
}

/** Lighting with the Earth's centre at the origin and the Sun along +Z. */
function lighting(overrides: Partial<TerrainLighting> = {}): TerrainLighting {
  return {
    perPoint: true,
    centre: [0, 0, 0],
    sunDirection: [0, 0, 1],
    moonDirection: [0, 0, -1],
    sunScale: [1, 1, 1],
    moonScale: [0, 0, 0],
    ambient: [0.001, 0.001, 0.001],
    table: table(),
    ...overrides,
  };
}

/** A point on a sphere of radius 6.4e6 where the Sun along +Z stands at an elevation, degrees. */
const pointUnderSun = (elevationDeg: number): [number, number, number] =>
  [6.4e6 * Math.cos(elevationDeg * DEG), 0, 6.4e6 * Math.sin(elevationDeg * DEG)];

/** Night lights in the Earth's own axes, the lamps' light and picture distinct in each band, above a floor of 0.5. */
const NIGHT: TerrainNightLighting = {
  axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  light: [0.1, 0.2, 0.3],
  picture: [0.01, 0.02, 0.03],
  floor: 0.5,
};

/** A night lights' map: the texture is only passed on, so any object stands for it. */
function nightMap(overrides: Partial<TerrainNightLightMap> = {}): TerrainNightLightMap {
  return { texture: { name: "night-lights" } as BaseTexture, zoom: 6, x: 11, y: 19, tiles: 8, ...overrides };
}

/** The shader code Babylon builds from a material's plugins, given a template with every injection point. */
function injected(material: Material): string {
  const manager = material.pluginManager as unknown as { _injectCustomCode(eventData: unknown, existing: unknown): (shaderType: string, code: string) => string };
  return manager._injectCustomCode({}, undefined)("fragment", [
    "#define CUSTOM_FRAGMENT_DEFINITIONS",
    "void main() {",
    "#define CUSTOM_FRAGMENT_UPDATE_DIFFUSE",
    "#define CUSTOM_FRAGMENT_BEFORE_LIGHTS",
    "}",
  ].join("\n"));
}

describe("terrain light", () => {
  it("is one light for the scene: switching it on, off or between per point and one factor recompiles, and nothing else does", () => {
    const target = scene();
    const plugin = new TerrainLightMaterialPlugin(new StandardMaterial("terrain", target));
    const dirty = vi.spyOn(plugin, "markAllDefinesAsDirty");
    expect(getTerrainLighting(target)).toBeNull();
    expect(setTerrainLighting(target, null)).toBe(false);
    const day = lighting();
    expect(setTerrainLighting(target, day)).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(setTerrainLighting(target, day)).toBe(false);
    // Dusk deepening is a new light of the same kind: uniforms, not a shader.
    expect(setTerrainLighting(target, lighting({ sunScale: [0.5, 0.5, 0.5] }))).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(setTerrainLighting(target, lighting({ perPoint: false }))).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(2);
    expect(setTerrainLighting(target, null)).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(3);
    // Each scene has its own.
    const other = scene();
    setTerrainLighting(other, day);
    expect(getTerrainLighting(target)).toBeNull();
  });

  it("registers its shader code for the material it is on, PBR or standard, before its own fields exist", () => {
    // Babylon collects a plugin's injection points while the base class is being constructed. A PBR
    // material's must be the albedo's, which the unlit path of Google 3D Tiles reads; reading a field
    // there once gave every material the standard one's, and unlit tiles stayed lit at night.
    const target = scene();
    const pbr = new PBRMaterial("tile", target);
    pbr.unlit = true;
    expect(followTerrainLight(pbr)).toBe(true);
    const pbrCode = injected(pbr);
    expect(pbrCode).toContain("surfaceAlbedo *= terrainLightAt(vPositionW);");
    expect(pbrCode).toContain("vec3 terrainGroundLight(float mu)");
    expect(pbrCode).not.toContain("baseColor.rgb *=");
    const standard = new StandardMaterial("raster", target);
    new TerrainLightMaterialPlugin(standard);
    const standardCode = injected(standard);
    expect(standardCode).toContain(`baseColor.rgb *= pow(terrainLightAt(vPositionW), vec3(${1 / 2.2}));`);
    expect(standardCode).not.toContain("surfaceAlbedo");
  });

  it("leaves the shader untouched without a light, and declares its uniforms in both shader languages", () => {
    const target = scene();
    const plugin = new TerrainLightMaterialPlugin(new StandardMaterial("terrain", target));
    const defines = { TERRAIN_LIGHT: true, TERRAIN_LIGHT_PER_POINT: true, TERRAIN_LOCAL_LIGHTS: 3, TERRAIN_NIGHT_LIGHTS: true };
    plugin.prepareDefines(defines as never);
    expect(defines).toEqual({ TERRAIN_LIGHT: false, TERRAIN_LIGHT_PER_POINT: false, TERRAIN_LOCAL_LIGHTS: 0, TERRAIN_NIGHT_LIGHTS: false });
    setTerrainLighting(target, lighting());
    setTerrainLocalLights(target, [{ position: [0, 0, 0], direction: [0, -1, 0], cosInner: 0.9, cosOuter: 0.8, factor: [1, 1, 1] }]);
    plugin.prepareDefines(defines as never);
    expect(defines).toEqual({ TERRAIN_LIGHT: true, TERRAIN_LIGHT_PER_POINT: true, TERRAIN_LOCAL_LIGHTS: 1, TERRAIN_NIGHT_LIGHTS: false });

    expect(plugin.getCustomCode("vertex")).toBeNull();
    for (const language of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const code = plugin.getCustomCode("fragment", language)!;
      expect(Object.keys(code).sort()).toEqual(["CUSTOM_FRAGMENT_DEFINITIONS", "CUSTOM_FRAGMENT_UPDATE_DIFFUSE"]);
      // All of it inside the define: without a light the shader is as it was.
      for (const text of Object.values(code)) {
        expect(text.startsWith("#ifdef TERRAIN_LIGHT\n")).toBe(true);
        expect(text.endsWith("\n#endif")).toBe(true);
      }
    }
    expect(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!.CUSTOM_FRAGMENT_UPDATE_DIFFUSE)
      .toContain("baseColor = vec4f(baseColor.rgb * pow(terrainLightAt(fragmentInputs.vPositionW)");
    const uniforms = plugin.getUniforms(ShaderLanguage.GLSL);
    expect(uniforms.ubo.find(uniform => uniform.name === "terrainLightTable")).toEqual({ name: "terrainLightTable", size: 4, type: "vec4", arraySize: GROUND_LIGHT_SAMPLES });
    expect(uniforms.fragment).toContain(`uniform vec4 terrainLightTable[${GROUND_LIGHT_SAMPLES}];`);
    expect(plugin.getUniforms(ShaderLanguage.WGSL).fragment).toContain(`uniform terrainLightTable: array<vec4f, ${GROUND_LIGHT_SAMPLES}>;`);
    expect(plugin.isCompatible(ShaderLanguage.GLSL)).toBe(true);
    expect(plugin.isCompatible(ShaderLanguage.WGSL)).toBe(true);
    // It runs after the imagery atlas plugin, whose colour it scales.
    expect(plugin.priority).toBeGreaterThan(200);
  });

  it("walks the table on WebGL 1, which may index a uniform array only by a loop's index, and reads it directly elsewhere", () => {
    const target = scene();
    const plugin = new TerrainLightMaterialPlugin(new StandardMaterial("terrain", target));
    const engine = target.getEngine() as unknown as { webGLVersion: number };
    Object.defineProperty(engine, "webGLVersion", { value: 1, configurable: true });
    const walked = plugin.getCustomCode("fragment", ShaderLanguage.GLSL)!.CUSTOM_FRAGMENT_DEFINITIONS;
    expect(walked).toContain(`for (int i = 0; i < ${GROUND_LIGHT_SAMPLES - 1}; i++)`);
    Object.defineProperty(engine, "webGLVersion", { value: 2, configurable: true });
    const indexed = plugin.getCustomCode("fragment", ShaderLanguage.GLSL)!.CUSTOM_FRAGMENT_DEFINITIONS;
    expect(indexed).toContain("terrainLightTable[index].rgb");
    expect(indexed).not.toContain(`for (int i = 0; i < ${GROUND_LIGHT_SAMPLES - 1}; i++)`);
    // Each of them, and the WGSL, gives the table's light back what it is held over: the sine of the body's height.
    const held = `* max(mu, ${GROUND_LIGHT_LEAST_SINE}));`;
    for (const code of [walked, indexed, plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!.CUSTOM_FRAGMENT_DEFINITIONS]) expect(code).toContain(held);
  });

  it("lights each point by the Sun's height there, from the table, faded out below its first sample", () => {
    const light = lighting();
    const at = (elevation: number) => terrainLightFactor(light, [], pointUnderSun(elevation))[0];
    // The table's e^(elevation / 10), times the sine of the height above its fine steps and of their end below, plus the
    // night sky; between samples, the logarithm is interpolated.
    const weight = (elevation: number) => groundLightWeight(Math.sin(elevation * DEG));
    expect(weight(30)).toBeCloseTo(0.5, 12);
    expect(weight(4.5)).toBe(GROUND_LIGHT_LEAST_SINE);
    expect(weight(-40)).toBe(GROUND_LIGHT_LEAST_SINE);
    expect(GROUND_LIGHT_LEAST_SINE).toBeCloseTo(Math.sin(12 * DEG), 12);
    expect(at(30)).toBeCloseTo(Math.exp(3) * 0.5 + 0.001, 6);
    expect(at(4.5)).toBeCloseTo(Math.exp(0.45) * GROUND_LIGHT_LEAST_SINE + 0.001, 6);
    expect(at(5.25)).toBeCloseTo(Math.exp(0.525) * GROUND_LIGHT_LEAST_SINE + 0.001, 6);
    expect(at(-17.9)).toBeCloseTo(Math.exp(-1.8) * GROUND_LIGHT_LEAST_SINE + 0.001, 2);
    expect(at(-25)).toBeCloseTo(0.001, 9);
    // The Moon is the same table at its own height, at its own scale; one factor everywhere is the ambient alone.
    const withMoon = lighting({ moonDirection: [0, 0, 1], moonScale: [2, 2, 2] });
    expect(terrainLightFactor(withMoon, [], pointUnderSun(30))[0] / (3 * Math.exp(3) * 0.5 + 0.001)).toBeCloseTo(1, 6);
    const single = lighting({ perPoint: false, ambient: [0.25, 0.5, 1] });
    expect(terrainLightFactor(single, [], pointUnderSun(30))).toEqual([0.25, 0.5, 1]);
    expect(terrainLightFactor(single, [], pointUnderSun(-60))).toEqual([0.25, 0.5, 1]);
  });

  it("adds local lights by the inverse square, their beam's edge and the ground's slope towards them", () => {
    const ground = pointUnderSun(-60);
    const up: [number, number, number] = [ground[0] / 6.4e6, ground[1] / 6.4e6, ground[2] / 6.4e6];
    const above = (meters: number): [number, number, number] => [ground[0] + up[0] * meters, ground[1] + up[1] * meters, ground[2] + up[2] * meters];
    const night = lighting({ ambient: [0, 0, 0] });
    const beam = (position: [number, number, number], cosInner: number, cosOuter: number): TerrainLocalLight => ({
      position, direction: [-up[0], -up[1], -up[2]], cosInner, cosOuter, factor: [100, 100, 100],
    });
    // Straight down from 10 m: 100 / 10².
    expect(terrainLightFactor(night, [beam(above(10), 0.99, 0.95)], ground)[0]).toBeCloseTo(1, 6);
    expect(terrainLightFactor(night, [beam(above(20), 0.99, 0.95)], ground)[0]).toBeCloseTo(0.25, 6);
    // 50 m along level ground: outside the beam, nothing; from a lamp lighting every way, the inverse square times the slope's cosine.
    const off = [ground[0], ground[1] + 50, ground[2]] as [number, number, number];
    expect(terrainLightFactor(night, [beam(above(10), 0.99, 0.95)], off)[0]).toBe(0);
    const target = scene();
    setTerrainLocalLights(target, [beam(above(10), -1, -1)]);
    const [lamp] = getTerrainLocalLights(target);
    expect(lamp.cosInner).toBeGreaterThan(lamp.cosOuter);
    const squared = 10 * 10 + 50 * 50;
    expect(terrainLightFactor(night, [lamp], off)[0]).toBeCloseTo((100 / squared) * (10 / Math.sqrt(squared)), 6);
    expect(getTerrainLocalLights(scene())).toHaveLength(0);
  });

  it("binds the light's uniforms to every terrain material, and its local lights after them", () => {
    const target = scene();
    const plugin = new TerrainLightMaterialPlugin(new StandardMaterial("a", target));
    const buffer = { updateFloat4: vi.fn(), updateFloatArray: vi.fn() };
    plugin.bindForSubMesh(buffer as unknown as UniformBuffer);
    expect(buffer.updateFloat4).not.toHaveBeenCalled();
    const light = lighting({ sunScale: [3, 2, 1] });
    setTerrainLighting(target, light);
    setTerrainLocalLights(target, [{ position: [1, 2, 3], direction: [0, -1, 0], cosInner: 0.9, cosOuter: 0.8, factor: [4, 5, 6] }]);
    plugin.bindForSubMesh(buffer as unknown as UniformBuffer);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainLightSunScale", 3, 2, 1, 0);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainLightCentre", 0, 0, 0, 0);
    expect(buffer.updateFloatArray).toHaveBeenCalledWith("terrainLightTable", light.table);
    const factors = buffer.updateFloatArray.mock.calls.find(([name]) => name === "terrainLocalFactor")![1] as Float32Array;
    expect([...factors.slice(0, 4)].map(value => Math.round(value * 10) / 10)).toEqual([4, 5, 6, 0.9]);
    // With large-world rendering the shader's positions are relative to the eye, and so are the places given to it.
    const large = new Scene(target.getEngine(), { useFloatingOrigin: true });
    const largePlugin = new TerrainLightMaterialPlugin(new StandardMaterial("b", large));
    setTerrainLighting(large, lighting({ centre: [10, 20, 30] }));
    setTerrainLocalLights(large, [{ position: [1, 2, 3], direction: [0, -1, 0], cosInner: 0.9, cosOuter: 0.8, factor: [4, 5, 6] }]);
    large.activeCamera = new FreeCamera("eye", new Vector3(1, 1, 1), large);
    large.activeCamera.getViewMatrix(true);
    const offset = { updateFloat4: vi.fn(), updateFloatArray: vi.fn() };
    largePlugin.bindForSubMesh(offset as unknown as UniformBuffer);
    expect(offset.updateFloat4).toHaveBeenCalledWith("terrainLightCentre", 9, 19, 29, 0);
    expect([...(offset.updateFloatArray.mock.calls.find(([name]) => name === "terrainLocalPosition")![1] as Float32Array).slice(0, 3)]).toEqual([0, 1, 2]);
    // A tile taken away is forgotten.
    const dirty = vi.spyOn(plugin, "markAllDefinesAsDirty");
    plugin.dispose();
    setTerrainLighting(target, null);
    expect(dirty).not.toHaveBeenCalled();
  });

  it("puts unlit materials from a source such as Google 3D Tiles under the light once, and leaves lit ones to the scene's lights", () => {
    const target = scene();
    const unlit = new PBRMaterial("unlit tile", target);
    unlit.unlit = true;
    const unlitStandard = new StandardMaterial("unlit standard", target);
    unlitStandard.disableLighting = true;
    const lit = new PBRMaterial("lit tile", target);
    expect(isUnlitMaterial(unlit)).toBe(true);
    expect(isUnlitMaterial(unlitStandard)).toBe(true);
    expect(isUnlitMaterial(lit)).toBe(false);
    expect(isUnlitMaterial(new StandardMaterial("lit standard", target))).toBe(false);

    expect(followTerrainLight(unlit)).toBe(true);
    expect(followTerrainLight(unlit)).toBe(false);
    expect(followTerrainLight(unlitStandard)).toBe(true);
    expect(followTerrainLight(lit)).toBe(false);
    expect(unlit.pluginManager?.getPlugin("TerrainLight")).toBeInstanceOf(TerrainLightMaterialPlugin);
    expect(lit.pluginManager?.getPlugin("TerrainLight") ?? null).toBeNull();
  });

  it("reads night lights only with a light that has them and a map, and recompiles only when that changes", () => {
    const target = scene();
    const plugin = new TerrainLightMaterialPlugin(new StandardMaterial("terrain", target));
    const dirty = vi.spyOn(plugin, "markAllDefinesAsDirty");
    const defines = { TERRAIN_LIGHT: false, TERRAIN_LIGHT_PER_POINT: false, TERRAIN_LOCAL_LIGHTS: 0, TERRAIN_NIGHT_LIGHTS: false };
    setTerrainLighting(target, lighting());
    expect(dirty).toHaveBeenCalledTimes(1);
    const map = nightMap();
    // A map without night lights in the light, or the light's without a map, is no shader's business.
    expect(setTerrainNightLightMap(target, map)).toBe(true);
    expect(getTerrainNightLightMap(target)).toBe(map);
    expect(dirty).toHaveBeenCalledTimes(1);
    plugin.prepareDefines(defines as never);
    expect(defines.TERRAIN_NIGHT_LIGHTS).toBe(false);
    expect(setTerrainLighting(target, lighting({ night: NIGHT }))).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(2);
    plugin.prepareDefines(defines as never);
    expect(defines.TERRAIN_NIGHT_LIGHTS).toBe(true);
    // The same map again is nothing; a window moved or a new texture is uniforms.
    expect(setTerrainNightLightMap(target, nightMap({ texture: map.texture }))).toBe(false);
    expect(setTerrainNightLightMap(target, nightMap({ texture: map.texture, x: 12 }))).toBe(true);
    expect(setTerrainLighting(target, lighting({ night: { ...NIGHT, floor: 1 } }))).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(2);
    expect(setTerrainNightLightMap(target, null)).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(3);
    plugin.prepareDefines(defines as never);
    expect(defines.TERRAIN_NIGHT_LIGHTS).toBe(false);
    const samplers: string[] = [];
    plugin.getSamplers(samplers);
    expect(samplers).toEqual(["terrainNightMap"]);
  });

  it("adds the lamps' light to the factor and the satellite's picture after it, in both shader languages", () => {
    const target = scene();
    const standard = new TerrainLightMaterialPlugin(new StandardMaterial("raster", target));
    const pbr = new TerrainLightMaterialPlugin(new PBRMaterial("tile", target));
    const glsl = standard.getCustomCode("fragment", ShaderLanguage.GLSL)!;
    expect(glsl.CUSTOM_FRAGMENT_UPDATE_DIFFUSE).toContain(`#ifdef TERRAIN_NIGHT_LIGHTS
float terrainNight = terrainNightRadiance(vPositionW);
baseColor.rgb = pow(pow(baseColor.rgb, vec3(2.2)) * (terrainLightAt(vPositionW) + terrainNight * terrainNightLight.rgb) + terrainNight * terrainNightPicture.rgb, vec3(${1 / 2.2}));
#else`);
    // Without night lights, the shader is as it was.
    expect(glsl.CUSTOM_FRAGMENT_UPDATE_DIFFUSE).toContain(`#else\nbaseColor.rgb *= pow(terrainLightAt(vPositionW), vec3(${1 / 2.2}));\n#endif`);
    expect(pbr.getCustomCode("fragment", ShaderLanguage.GLSL)!.CUSTOM_FRAGMENT_BEFORE_LIGHTS)
      .toContain("surfaceAlbedo = surfaceAlbedo * (terrainLightAt(vPositionW) + terrainNight * terrainNightLight.rgb) + terrainNight * terrainNightPicture.rgb;");
    const wgsl = standard.getCustomCode("fragment", ShaderLanguage.WGSL)!;
    expect(wgsl.CUSTOM_FRAGMENT_UPDATE_DIFFUSE).toContain("let terrainNight = terrainNightRadiance(fragmentInputs.vPositionW);");
    expect(wgsl.CUSTOM_FRAGMENT_UPDATE_DIFFUSE).toContain("+ terrainNight * uniforms.terrainNightPicture.rgb, vec3f(");
    expect(pbr.getCustomCode("fragment", ShaderLanguage.WGSL)!.CUSTOM_FRAGMENT_BEFORE_LIGHTS)
      .toContain("surfaceAlbedo = surfaceAlbedo * (terrainLightAt(fragmentInputs.vPositionW) + terrainNight * uniforms.terrainNightLight.rgb) + terrainNight * uniforms.terrainNightPicture.rgb;");
    // The map and its reading are declared only with night lights; red and green are radiance's high and low bytes in thousandths.
    expect(glsl.CUSTOM_FRAGMENT_DEFINITIONS).toContain("#ifdef TERRAIN_NIGHT_LIGHTS\nuniform sampler2D terrainNightMap;");
    expect(wgsl.CUSTOM_FRAGMENT_DEFINITIONS).toContain("#ifdef TERRAIN_NIGHT_LIGHTS\nvar terrainNightMapSampler: sampler;\nvar terrainNightMap: texture_2d<f32>;");
    for (const code of [glsl.CUSTOM_FRAGMENT_DEFINITIONS, wgsl.CUSTOM_FRAGMENT_DEFINITIONS]) {
      expect(code).toContain("texel.r * 65.28 + texel.g * 0.255");
      expect(code).toContain(`${1 - WGS84_E2} * length(`);
    }
    for (const name of ["terrainNightAxisX", "terrainNightWindow", "terrainNightLight", "terrainNightPicture"]) {
      expect(standard.getUniforms(ShaderLanguage.GLSL).fragment).toContain(`uniform vec4 ${name};`);
    }
  });

  it("places a point of the ground on the night lights' map as the tiles do, and wraps it into its slot", () => {
    // The shader's mapping, step by step: a point in the Earth's axes, its latitude on the ellipsoid and longitude, in tiles of the zoom.
    const zoom = 6;
    const insides: boolean[] = [];
    // One window over Minneapolis, one across the antimeridian at the top of the map.
    for (const window of [{ x: 12, y: 19, tiles: 8 }, { x: 60, y: 0, tiles: 8 }]) for (const [latDeg, lonDeg] of [[44.98, -93.27], [-34.6, -58.4], [0, 0], [60, 179.9], [84, -179.9]]) {
      const { x, y, z } = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, 0);
      const lat = Math.atan2(z, (1 - WGS84_E2) * Math.hypot(x, y));
      const tile = [(Math.atan2(y, x) / (2 * Math.PI) + 0.5) * 2 ** zoom, (0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * 2 ** zoom];
      const [mx, my] = mercatorXY(latDeg, lonDeg);
      expect(tile[0] % 2 ** zoom).toBeCloseTo(mx * 2 ** zoom, 9);
      expect(tile[1]).toBeCloseTo(my * 2 ** zoom, 9);
      const pixel = nightPixelAt(latDeg, lonDeg, zoom);
      expect([Math.floor(tile[0]) % 2 ** zoom, Math.floor(tile[1])]).toEqual([pixel.tile.x, pixel.tile.y]);
      // The texture repeats: the coordinate over the tiles across lands in the tile's slot, x mod tiles and y mod tiles.
      const u = tile[0] / window.tiles;
      expect(Math.floor((u - Math.floor(u)) * window.tiles)).toBe(pixel.tile.x % window.tiles);
      // Within the window or not: columns wrap at the antimeridian, rows do not.
      const offset = [((tile[0] - window.x) % 2 ** zoom + 2 ** zoom) % 2 ** zoom, tile[1] - window.y];
      const inside = offset[1] >= 0 && offset[0] <= window.tiles && offset[1] <= window.tiles;
      expect(inside).toBe(((pixel.tile.x - window.x + 64) % 64) < window.tiles && pixel.tile.y >= window.y && pixel.tile.y < window.y + window.tiles);
      insides.push(inside);
    }
    // Minneapolis in the first, 84° N 179.9° W in the second.
    expect(insides.filter(Boolean)).toHaveLength(2);
  });

  it("binds the night lights' uniforms and map with the light, and only when it has both", () => {
    const target = scene();
    const plugin = new TerrainLightMaterialPlugin(new StandardMaterial("a", target));
    const buffer = { updateFloat4: vi.fn(), updateFloatArray: vi.fn(), setTexture: vi.fn() };
    setTerrainLighting(target, lighting({ night: NIGHT }));
    plugin.bindForSubMesh(buffer as unknown as UniformBuffer);
    expect(buffer.setTexture).not.toHaveBeenCalled();
    expect(buffer.updateFloat4.mock.calls.some(([name]) => String(name).startsWith("terrainNight"))).toBe(false);
    const map = nightMap();
    setTerrainNightLightMap(target, map);
    plugin.bindForSubMesh(buffer as unknown as UniformBuffer);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainNightAxisY", 0, 1, 0, 0);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainNightWindow", 11, 19, 64, 8);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainNightLight", 0.1, 0.2, 0.3, 0.5);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainNightPicture", 0.01, 0.02, 0.03, 0);
    expect(buffer.setTexture).toHaveBeenCalledExactlyOnceWith("terrainNightMap", map.texture);
  });

  it("adds the lamps' light above the floor to the factor it computes for readings", () => {
    const night = lighting({ ambient: [0, 0, 0], night: NIGHT });
    const ground = pointUnderSun(-60);
    expect(terrainLightFactor(night, [], ground)).toEqual([0, 0, 0]);
    expect(terrainLightFactor(night, [], ground, 0.4)).toEqual([0, 0, 0]);
    const lit = terrainLightFactor(night, [], ground, 10.5);
    expect(lit[0]).toBeCloseTo(1, 12);
    expect(lit[1]).toBeCloseTo(2, 12);
    expect(lit[2]).toBeCloseTo(3, 12);
    // Without night lights a radiance changes nothing.
    expect(terrainLightFactor(lighting({ ambient: [0, 0, 0] }), [], ground, 10.5)).toEqual([0, 0, 0]);
  });
});
