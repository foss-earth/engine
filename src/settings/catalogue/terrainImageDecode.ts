import type { ParameterSpec, SettingsRegistry } from "@foss-earth/ui/settings";
import type { TerrainImageDecodeLimits } from "../../browser/terrainImageDecoder.js";
export const TERRAIN_IMAGE_MAX_TILE_SIDE_ID = "map.terrain.maxDecodedTileSide";
export const TERRAIN_IMAGE_DECODE_PARAMETERS: readonly ParameterSpec[] = [{
  id: TERRAIN_IMAGE_MAX_TILE_SIDE_ID, label: "Largest decoded terrain tile", unit: "px", kind: "number",
  description: "Largest square native terrain image accepted for Terrarium height readback. A smaller limit rejects larger source tiles before allocating their canvas and heights.",
  bounds: () => ({ min: 1, max: 1024 }), step: 1, scale: "linear", default: 1024,
  defaultReason: "The original native terrain decoder rejected square tiles larger than 1024 pixels.",
  home: { tab: "map", section: "loading", level: "all" }, appliesLive: true,
  source: "src/terrain/terrainTiles.ts",
}];
/** Required named setting, registered by the one host catalogue composition. */
export function createTerrainImageDecodeLimits(settings: SettingsRegistry): () => TerrainImageDecodeLimits {
  return () => { const value = settings.get(TERRAIN_IMAGE_MAX_TILE_SIDE_ID); if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1024) throw new Error("Terrain maximum decoded tile side must be 1–1024 whole pixels."); return { maxTileSide: value }; };
}
