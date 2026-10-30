import { FreeCamera, MeshBuilder, NullEngine, PBRMaterial, RenderTargetTexture, Scene, ShaderLanguage, StandardMaterial, Vector3, type Material,
  type UniformBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTerrainRegionHighlight, getTerrainRegionHighlight, setTerrainRegionHighlight, terrainRegionHighlightDepth,
  type TerrainRegionHighlightVolume } from "../src/babylon/terrainRegionHighlight.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function scene(options?: ConstructorParameters<typeof Scene>[1]): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine, options);
}

type Plugin = {
  priority: number;
  markAllDefinesAsDirty(): void;
  prepareDefines(defines: { TERRAIN_REGION_HIGHLIGHT: boolean }): void;
  getUniforms(language?: ShaderLanguage): { ubo: { name: string }[]; fragment: string };
  getCustomCode(shaderType: string, language?: ShaderLanguage): Record<string, string> | null;
  bindForSubMesh(buffer: UniformBuffer): void;
  isCompatible(language: ShaderLanguage): boolean;
  dispose(): void;
};
const pluginOf = (material: Material): Plugin => material.pluginManager!.getPlugin("TerrainRegionHighlight") as unknown as Plugin;

const sphere: TerrainRegionHighlightVolume = { center: { x: 10, y: 20, z: 30 }, radiusMeters: 15 };

describe("the shown region's red tint on the map", () => {
  it("is on each map material once, and compiled into the scene's shaders from the first region on", () => {
    const target = scene();
    const material = new StandardMaterial("tile", target);
    expect(attachTerrainRegionHighlight(material)).toBe(true);
    expect(attachTerrainRegionHighlight(material)).toBe(false);
    const plugin = pluginOf(material);
    const dirty = vi.spyOn(plugin, "markAllDefinesAsDirty");
    const defines = { TERRAIN_REGION_HIGHLIGHT: true };
    plugin.prepareDefines(defines);
    expect(defines.TERRAIN_REGION_HIGHLIGHT).toBe(false);
    expect(setTerrainRegionHighlight(target, null)).toBe(false);
    expect(setTerrainRegionHighlight(target, sphere)).toBe(true);
    expect(dirty).toHaveBeenCalledOnce();
    expect(setTerrainRegionHighlight(target, { ...sphere, center: { ...sphere.center } })).toBe(false);
    // Moving, clearing and setting it again are uniforms: no frame without the map while a shader compiles.
    expect(setTerrainRegionHighlight(target, { ...sphere, radiusMeters: 20 })).toBe(true);
    expect(setTerrainRegionHighlight(target, null)).toBe(true);
    expect(getTerrainRegionHighlight(target)).toBeNull();
    expect(setTerrainRegionHighlight(target, sphere)).toBe(true);
    expect(dirty).toHaveBeenCalledOnce();
    plugin.prepareDefines(defines);
    expect(defines.TERRAIN_REGION_HIGHLIGHT).toBe(true);
    // A material made afterwards has it from the start.
    const later = new StandardMaterial("later", target);
    attachTerrainRegionHighlight(later);
    pluginOf(later).prepareDefines(defines);
    expect(defines.TERRAIN_REGION_HIGHLIGHT).toBe(true);
    // Each scene has its own.
    expect(getTerrainRegionHighlight(scene())).toBeNull();
  });

  it("keeps a copy of a region given as Babylon vectors", () => {
    const target = scene();
    const center = new Vector3(1, 2, 3);
    setTerrainRegionHighlight(target, { center, radiusMeters: 5, cone: { axis: new Vector3(0, 1, 0), lengthMeters: 100, halfAngleDeg: 15 } });
    center.x = 99;
    expect(getTerrainRegionHighlight(target)).toEqual({ center: { x: 1, y: 2, z: 3 }, radiusMeters: 5, cone: { axis: { x: 0, y: 1, z: 0 }, lengthMeters: 100, halfAngleDeg: 15 } });
  });

  it("tints the final colour of standard and PBR materials, in both shader languages, all of it inside its define", () => {
    const target = scene();
    const standard = new StandardMaterial("raster", target), pbr = new PBRMaterial("google", target);
    attachTerrainRegionHighlight(standard); attachTerrainRegionHighlight(pbr);
    expect(pluginOf(standard).getCustomCode("vertex")).toBeNull();
    for (const [material, colour] of [[standard, "color"], [pbr, "finalColor"]] as const) {
      const plugin = pluginOf(material);
      expect(plugin.isCompatible(ShaderLanguage.GLSL)).toBe(true);
      expect(plugin.isCompatible(ShaderLanguage.WGSL)).toBe(true);
      for (const language of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
        const code = plugin.getCustomCode("fragment", language)!;
        expect(Object.keys(code).sort()).toEqual(["CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR", "CUSTOM_FRAGMENT_DEFINITIONS"]);
        for (const text of Object.values(code)) {
          expect(text.startsWith("#ifdef TERRAIN_REGION_HIGHLIGHT\n")).toBe(true);
          expect(text.endsWith("\n#endif")).toBe(true);
        }
        expect(code.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain(language === ShaderLanguage.WGSL
          ? `${colour} = vec4f(mix(${colour}.rgb, vec3f(` : `${colour}.rgb = mix(${colour}.rgb, vec3(`);
        expect(code.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR).toContain(language === ShaderLanguage.WGSL
          ? "terrainRegionDepth(fragmentInputs.vPositionW)" : "terrainRegionDepth(vPositionW)");
      }
      expect(plugin.getUniforms(ShaderLanguage.GLSL).fragment).toContain("uniform vec4 terrainRegionSphere;");
      expect(plugin.getUniforms(ShaderLanguage.WGSL).fragment).toContain("uniform terrainRegionSphere: vec4f;");
      expect(plugin.getUniforms().ubo.map(uniform => uniform.name)).toEqual(["terrainRegionSphere", "terrainRegionCone", "terrainRegionShape"]);
      // After the terrain light, whose colour it tints.
      expect(plugin.priority).toBeGreaterThan(300);
    }
  });

  it("binds the region relative to the eye, and a sphere nothing is inside once it is cleared", () => {
    const target = scene({ useFloatingOrigin: true });
    target.activeCamera = new FreeCamera("eye", new Vector3(1, 1, 1), target);
    target.activeCamera.getViewMatrix(true);
    const material = new StandardMaterial("tile", target);
    attachTerrainRegionHighlight(material);
    const buffer = { updateFloat4: vi.fn() };
    pluginOf(material).bindForSubMesh(buffer as unknown as UniformBuffer);
    expect(buffer.updateFloat4).not.toHaveBeenCalled();
    setTerrainRegionHighlight(target, { ...sphere, cone: { axis: { x: 0, y: 1, z: 0 }, lengthMeters: 100, halfAngleDeg: 45 } });
    pluginOf(material).bindForSubMesh(buffer as unknown as UniformBuffer);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainRegionSphere", 9, 19, 29, 15);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainRegionCone", 0, 1, 0, 100);
    const shape = buffer.updateFloat4.mock.calls.find(([name]) => name === "terrainRegionShape")!;
    expect(shape[1]).toBeCloseTo(1, 9); expect(shape[2]).toBeCloseTo(Math.SQRT1_2, 9); expect(shape[3]).toBeCloseTo(0.6, 9);
    buffer.updateFloat4.mockClear();
    setTerrainRegionHighlight(target, null);
    pluginOf(material).bindForSubMesh(buffer as unknown as UniformBuffer);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainRegionSphere", 0, 0, 0, -1);
    expect(buffer.updateFloat4).toHaveBeenCalledWith("terrainRegionCone", 0, 0, 0, 0);
  });

  it("leaves the map its own colour in render targets, where the sky's ground-light probe reads it", async () => {
    const target = scene({ useFloatingOrigin: true });
    target.activeCamera = new FreeCamera("eye", new Vector3(1, 1, -6), target);
    const tile = MeshBuilder.CreateGround("tile", { width: 10, height: 10 }, target);
    tile.material = new StandardMaterial("tile", target);
    attachTerrainRegionHighlight(tile.material);
    setTerrainRegionHighlight(target, sphere);
    const probe = new RenderTargetTexture("probe", 4, target);
    const below = new FreeCamera("probe", new Vector3(0, 20, 0), target);
    below.setTarget(Vector3.Zero());
    probe.activeCamera = below;
    probe.renderList = [tile];
    target.customRenderTargets.push(probe);
    // Which camera each bind drew for, and the sphere's radius it bound.
    const bound: string[] = [];
    const plugin = pluginOf(tile.material);
    const bind = plugin.bindForSubMesh.bind(plugin);
    vi.spyOn(plugin, "bindForSubMesh").mockImplementation(() => bind({ updateFloat4: (name: string, ...values: number[]) => {
      if (name === "terrainRegionSphere") bound.push(`${target.activeCamera!.name} ${values[3]}`);
    } } as unknown as UniformBuffer));
    // The material loads its shaders before it draws.
    await target.whenReadyAsync();
    for (let frame = 0; frame < 3; frame++) target.render();
    expect(new Set(bound)).toEqual(new Set(["probe -1", "eye 15"]));
  });

  it("measures depth inside the sphere and the cone, as the shader does", () => {
    const volume: TerrainRegionHighlightVolume = { center: { x: 0, y: 0, z: 0 }, radiusMeters: 10,
      cone: { axis: { x: 1, y: 0, z: 0 }, lengthMeters: 100, halfAngleDeg: 45 } };
    expect(terrainRegionHighlightDepth(volume, { x: 0, y: 0, z: 0 })).toBe(10);
    expect(terrainRegionHighlightDepth(volume, { x: 0, y: 0, z: 9 })).toBeCloseTo(1, 9);
    // Behind the aircraft only the sphere counts.
    expect(terrainRegionHighlightDepth(volume, { x: -12, y: 0, z: 0 })).toBeCloseTo(-2, 9);
    // On the axis halfway, the side is 50·sin 45° away and the end 50.
    expect(terrainRegionHighlightDepth(volume, { x: 50, y: 0, z: 0 })).toBeCloseTo(50 * Math.SQRT1_2, 9);
    expect(terrainRegionHighlightDepth(volume, { x: 99, y: 0, z: 0 })).toBeCloseTo(1, 9);
    expect(terrainRegionHighlightDepth(volume, { x: 101, y: 0, z: 0 })).toBeCloseTo(-1, 9);
    expect(terrainRegionHighlightDepth(volume, { x: 50, y: 49, z: 0 })).toBeGreaterThan(0);
    expect(terrainRegionHighlightDepth(volume, { x: 50, y: 51, z: 0 })).toBeLessThan(0);
    expect(terrainRegionHighlightDepth({ ...volume, cone: undefined }, { x: 50, y: 0, z: 0 })).toBe(-40);
  });

  it("forgets a material taken away", () => {
    const target = scene();
    const material = new StandardMaterial("tile", target);
    attachTerrainRegionHighlight(material);
    const plugin = pluginOf(material), dirty = vi.spyOn(plugin, "markAllDefinesAsDirty");
    plugin.dispose();
    setTerrainRegionHighlight(target, sphere);
    expect(dirty).not.toHaveBeenCalled();
  });
});
