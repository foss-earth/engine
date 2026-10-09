/** Keep the actual constructor identity. The implementation reads its material's
 * scene itself; only the original one-argument test-call type is narrowed here. */
import type { Material, MaterialDefines, UniformBuffer } from "@babylonjs/core";
import { createTerrainLightingAdapter, type TerrainLightTablePorts, type TerrainLightingAdapter, type TerrainLightingMaterialPlugin } from "../../src/babylon/imagery/terrainLightPlugin.js";
export interface TerrainLightingFixturePlugin extends TerrainLightingMaterialPlugin {
  prepareDefines(defines: MaterialDefines): void;
  bindForSubMesh(buffer: UniformBuffer): void;
}
export interface TerrainLightingFixtureAdapter extends Omit<TerrainLightingAdapter, "MaterialPlugin"> {
  readonly MaterialPlugin: new (material: Material) => TerrainLightingFixturePlugin;
}
export function createTerrainLightingFixture(ports: TerrainLightTablePorts): TerrainLightingFixtureAdapter {
  const adapter = createTerrainLightingAdapter(ports);
  return { ...adapter, MaterialPlugin: adapter.MaterialPlugin as TerrainLightingFixtureAdapter["MaterialPlugin"] };
}
